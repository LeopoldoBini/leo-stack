// simulador.mjs — corre el motor de verdad (workflows/prd-pipeline.js) contra un
// GitHub y un git de mentira, con agentes falsos que responden por su label.
//
// El motor es un script de Workflow: cuerpo top-level con `await` y `return`, y
// los hooks agent/parallel/log/phase/budget como globales. Acá se envuelve el
// archivo tal cual en una AsyncFunction que recibe esos hooks, así que lo que se
// prueba es el motor y no una copia.
//
// Dos entradas:
//   nucleoPuro(nombres)  evalúa SOLO el bloque «NÚCLEO PURO» del motor y devuelve
//                        esas funciones: si una desaparece o depende de algo de
//                        afuera del bloque, el test revienta.
//   correrMotor(...)     corre el motor entero contra un mundo (crearMundo).

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const MOTOR = fileURLToPath(new URL('../workflows/prd-pipeline.js', import.meta.url))
const fuente = () => readFileSync(MOTOR, 'utf8')

export function nucleoPuro(nombres) {
  const src = fuente()
  const ini = src.indexOf('// ─── NÚCLEO PURO')
  const fin = src.indexOf('// ─── FIN DEL NÚCLEO PURO')
  if (ini < 0 || fin < 0) throw new Error('el motor perdió los marcadores del núcleo puro')
  return new Function(`${src.slice(ini, fin)}\nreturn { ${nombres.join(', ')} }`)()
}

// El runtime de Workflow prohíbe Date.now(), new Date() sin argumentos y
// Math.random() (romperían el resume). El simulador los hace explotar igual.
const DateDelWorkflow = new Proxy(Date, {
  get(t, p) {
    if (p === 'now') return () => { throw new Error('Date.now() no existe en un Workflow') }
    return Reflect.get(t, p)
  },
  construct(t, a) {
    if (a.length === 0) throw new Error('new Date() sin argumentos no existe en un Workflow')
    return new t(...a)
  },
})
const MathDelWorkflow = Object.create(Math, {
  random: { value: () => { throw new Error('Math.random() no existe en un Workflow') } },
})

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

export const ARGS_BASE = Object.freeze({
  ts: '2026-10-18T00:00:00-03:00',
  runLabel: 'sim-1018',
  repo: '/repo',
  scope: '#1,#2',
  base: 'main',
  rama: 'batch/sim',
  models: { T0: 'opus', T1: 'opus', T2: 'sonnet', T3: 'haiku' },
  tiers: { scout: 'T2', validator: 'T2', implementer: 'T1', serializer: 'T2', resolver: 'T1', reviewer: 'T1', judge: 'T1', applier: 'T1' },
  readCli: '/plugin/scripts/pipeline-read.sh',
  scopeInicial: null,
  validateHook: null,
  testGlobs: ['**/*.test.*'],
  labels: { ready: 'ready-for-agent', agentPr: 'afk-agent-pr' },
  maxParallel: 3,
  maxWaves: 8,
  budgetTotal: null,
  minBudgetWave: 300000,
})

// correrMotor({ mundo, args }) → { resultado, logs, llamadas }
// `llamadas` guarda cada agent() en orden de invocación: { label, model, effort,
// agentType, isolation, prompt, respuesta, inicio, fin } (inicio/fin en ms de
// reloj real, para los tests de despacho continuo).
export async function correrMotor({ mundo, args = {}, budget } = {}) {
  const A = { ...ARGS_BASE, ...args }
  const src = fuente().replace(/^export const meta/m, 'const meta')
  const AsyncFunction = (async () => {}).constructor
  const cuerpo = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'log', 'phase', 'budget', 'workflow', 'Date', 'Math', src)
  const logs = []
  const llamadas = []
  const t0 = performance.now()
  const agent = async (prompt, opts = {}) => {
    const reg = { ...opts, prompt, inicio: performance.now() - t0 }
    llamadas.push(reg)
    const ms = mundo.duracion?.(opts.label, prompt) ?? 0
    if (ms) await esperar(ms)
    const r = await mundo.responder(prompt, opts)
    reg.fin = performance.now() - t0
    reg.respuesta = r
    return r === undefined ? null : structuredClone(r)
  }
  const parallel = (thunks) =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
  const pipeline = () => { throw new Error('el motor no usa pipeline()') }
  const b = budget ?? { total: null, spent: () => 0, remaining: () => Infinity }
  const resultado = await cuerpo(A, agent, parallel, pipeline, (m) => logs.push(m), (f) => logs.push(`[fase] ${f}`), b, undefined, DateDelWorkflow, MathDelWorkflow)
  return { resultado, logs, llamadas }
}

// ---------------------------------------------------------------------------
// crearMundo — GitHub + git de mentira.
//
//   issues: { <n>: { deps: [<n>...], titulo? } }   todas con ready-for-agent
//   fallas: hooks para romper cosas a propósito:
//     publicar(n, intento)          → string = detalle del 'blocked'; falsy = publica
//     implementer(n, intento)       → 'muere' | { bloqueado } | { toca: [paths] } | falsy
//     medicion(etiqueta, intento)   → 'invalida' | falsy
//     merge(pr, intento)            → string = detalle del 'blocked'
//     rojo(n)                       → paths de test que el árbol de la issue rompe
//   token: lo que reporta el chequeo de push del setup
//   hook: true → el validator reporta tests_fuente 'hook'
//   duraciones: { [prefijo de label]: ms }
// ---------------------------------------------------------------------------
export function crearMundo({ issues, fallas = {}, token = { via: 'https', tipo: 'clasico', scopes: 'repo, workflow' }, hook = false, duraciones = {}, alInvocar } = {}) {
  const issue = new Map(Object.entries(issues).map(([n, d]) => [Number(n), { deps: d.deps ?? [], titulo: d.titulo ?? `issue ${n}`, labels: new Set(['ready-for-agent']) }]))
  const prs = new Map() // num → { issue, branch, merged, labels:Set, arbol }
  const mergeadas = [] // issues mergeadas a la rama integradora, en orden
  const wts = new Map() // path de worktree → { arbol, issue, toca }
  const veces = {} // contador por clave
  const contar = (k) => (veces[k] = (veces[k] ?? 0) + 1)
  let proximoPr = 500
  // Árboles y commits como los de git (40 hex). El conjunto de issues que
  // contiene un árbol se recupera por el mapa inverso.
  const conjuntoDe = new Map()
  const sha = (x) => createHash('sha1').update(x).digest('hex')
  const arbol = (set) => {
    const lista = [...new Set(set)].sort((a, b) => a - b)
    const id = sha(`arbol:${lista.join(',')}`)
    conjuntoDe.set(id, lista)
    conjuntoDe.set(sha(`commit:${id}`), lista)
    return id
  }
  const commitDe = (id) => sha(`commit:${id}`)
  const arbolIntegracion = () => arbol(mergeadas)
  const prDeIssue = (n) => [...prs.entries()].find(([, p]) => p.issue === n)
  const mergeada = (n) => prDeIssue(n)?.[1].merged === true

  function scout() {
    const lista = []
    for (const [n, i] of issue) {
      const pr = prDeIssue(n)
      let bucket
      const extra = {}
      if (pr && pr[1].merged) bucket = 'DONE'
      else if (i.labels.has('agent-blocked')) bucket = 'HUMAN_GATED'
      else if (pr && !pr[1].labels.has('merge-blocked')) { bucket = 'MERGE_READY'; extra.pr_number = pr[0]; extra.pr_branch = pr[1].branch }
      else if (pr) { bucket = 'IN_REVIEW'; extra.pr_number = pr[0]; extra.pr_branch = pr[1].branch }
      else if (i.deps.some((d) => !mergeada(d))) bucket = 'BLOCKED_BY_DEP'
      else if (i.labels.has('ready-for-agent')) bucket = 'IMPLEMENTABLE'
      else bucket = 'HUMAN_GATED'
      lista.push({ number: n, title: i.titulo, bucket, ...extra, ...(i.deps.length ? { blocked_by: i.deps } : {}) })
    }
    const c = (b) => lista.filter((x) => x.bucket === b).length
    const all_done = c('MERGE_READY') + c('IMPLEMENTABLE') + c('IN_REVIEW') === 0 && c('DONE') > 0
    return { all_done, issues: lista, specs: [], notas: 'mundo simulado', ...(mundo.paralelo != null ? { paralelo: mundo.paralelo } : {}) }
  }

  const dondeDe = (prompt) => prompt.match(/Cada comando empieza con `cd (\S+) &&`/)?.[1]
  const esIntegracion = (path) => /\/\.host-orchestrator\/wt\/(wf_)?batch-sim$/.test(path ?? '')

  function validator(label, prompt) {
    const etiqueta = label.slice('validator:'.length).replace(/~.*$/, '')
    const intento = contar(`med:${etiqueta}`)
    if (fallas.medicion?.(etiqueta, intento) === 'invalida') return { status: 'error', error: 'vitest murió (simulado)', metrics: {}, tests_failed: -1, failing_test_files: [], lockfiles: [] }
    const donde = dondeDe(prompt)
    const wt = esIntegracion(donde) ? { arbol: arbolIntegracion() } : wts.get(donde)
    if (!wt) return { status: 'error', error: `worktree desconocido: ${donde}`, metrics: {}, tests_failed: -1, failing_test_files: [], lockfiles: [] }
    const conocidos = (prompt.match(/Árboles ya medidos en esta corrida: ([^\n]*)/)?.[1] ?? '').split(/\s+/).filter(Boolean)
    const base = { arbol: wt.arbol, limpio: true, commit: commitDe(wt.arbol) }
    const diff = /Mecánica del diff/.test(prompt)
      ? { diff_toca_tests: true, tests_del_diff: ['src/x.test.ts'], archivos_del_diff: ['src/x.ts', 'src/x.test.ts', ...(wt.toca ?? [])], ...(hook ? {} : { tests_del_diff_verdes: true }) }
      : {}
    if (conocidos.includes(wt.arbol)) return { status: 'ok', ya_medido: true, ...base, metrics: {}, tests_failed: 0, failing_test_files: [], lockfiles: [], ...diff }
    if (fallas.yaMedidoFalso?.(etiqueta, intento)) return { status: 'ok', ya_medido: true, ...base, metrics: {}, tests_failed: 0, failing_test_files: [], lockfiles: [], ...diff }
    mundo.mediciones.push({ etiqueta, arbol: wt.arbol, issues: conjuntoDe.get(wt.arbol) })
    const rojos = [...new Set(conjuntoDe.get(wt.arbol).flatMap((n) => fallas.rojo?.(n) ?? []))]
    return {
      status: 'ok', ...base, metrics: { typecheck_errors: 0 }, tests_failed: rojos.length, failing_test_files: rojos,
      tests_fuente: hook ? 'hook' : 'suite', lockfiles: ['package-lock.json'], ...diff,
    }
  }

  function implementer(label, prompt) {
    const n = Number(label.match(/#(\d+)/)[1])
    const intento = contar(`impl:${n}`)
    mundo.despachos.push(n)
    const f = fallas.implementer?.(n, intento)
    if (f === 'muere') return null
    if (f?.bloqueado) return { worktree: `/repo/.claude/worktrees/wf_sim-${n}-${intento}`, branch: `issue-${n}`, resumen: 'no pude', bloqueado: f.bloqueado }
    const path = `/repo/.claude/worktrees/wf_sim-${n}-${intento}`
    const base = prompt.match(/git checkout -B issue-\d+ (\S+)/)?.[1]
    const desde = conjuntoDe.get(base) ?? mergeadas
    wts.set(path, { arbol: arbol([...desde, n]), issue: n, toca: f?.toca })
    return { worktree: path, branch: `issue-${n}`, resumen: `implementé #${n}` }
  }

  function serializer(label, prompt) {
    const tarea = label.slice('serializer:'.length).replace(/~.*$/, '')
    let m
    if (tarea === 'setup-rama') return { status: 'ok', detalle: 'rama lista', token }
    if (/^refresh/.test(tarea)) return { status: 'ya_estaba', detalle: 'al día' }
    if ((m = tarea.match(/^publish-i(\d+)$/))) {
      const n = Number(m[1])
      const intento = contar(`pub:${n}`)
      const motivo = fallas.publicar?.(n, intento)
      if (motivo) return { status: 'blocked', detalle: motivo }
      const ya = prDeIssue(n)
      if (ya) return { status: 'ya_estaba', pr_number: ya[0], detalle: 'PR ya existía' }
      const wt = prompt.match(/worktree (\S+), branch/)?.[1]
      const num = proximoPr++
      prs.set(num, { issue: n, branch: `issue-${n}`, merged: false, labels: new Set(['afk-agent-pr']), arbol: wts.get(wt)?.arbol })
      return { status: 'ok', pr_number: num, detalle: `PR #${num}` }
    }
    if ((m = tarea.match(/^prep-pr(\d+)$/))) {
      const num = Number(m[1])
      const pr = prs.get(num)
      if (pr.merged) return { status: 'ya_estaba', detalle: 'ya mergeado' }
      const path = prompt.match(/Worktree efímero en (\S+)/)?.[1]
      pr.arbol = arbol([...conjuntoDe.get(pr.arbol), ...mergeadas])
      wts.set(path, { arbol: pr.arbol, issue: pr.issue })
      return { status: 'ok', detalle: path }
    }
    if ((m = tarea.match(/^merge-pr(\d+)$/))) {
      const num = Number(m[1])
      const intento = contar(`merge:${num}`)
      const motivo = fallas.merge?.(num, intento)
      if (motivo) return { status: 'blocked', detalle: motivo }
      const pr = prs.get(num)
      if (!pr.merged) { pr.merged = true; mergeadas.push(pr.issue) }
      return { status: 'ok', pr_number: num, detalle: 'mergeado' }
    }
    if ((m = tarea.match(/^block-i(\d+)$/))) { issue.get(Number(m[1])).labels.add('agent-blocked'); mundo.bloqueos.push(Number(m[1])); return { status: 'ok', detalle: 'etiquetada' } }
    if ((m = tarea.match(/^(gatefail|block)-pr(\d+)$/))) { prs.get(Number(m[2])).labels.add('merge-blocked'); return { status: 'ok', detalle: 'merge-blocked' } }
    if (tarea === 'review-publish') return { status: 'ok', pr_number: 900, detalle: 'review mergeado' }
    if (tarea === 'pr-final') return { status: 'ok', pr_number: 999, detalle: 'PR final draft' }
    return { status: 'ok', detalle: `sin efecto (${tarea})` }
  }

  function review(label) {
    if (label === 'review:particion') return { analisis: 'mapa', unidades: [{ nombre: 'u1', paths: ['src'] }] }
    if (label === 'review:judge') return { aplicar: [], rechazadas: [], humano: [] }
    if (label.startsWith('review:applier')) return { worktree: '/repo/.claude/worktrees/wf_review', branch: 'review/sim', aplicadas: 0, falladas: [], resumen: '' }
    return mundo.hallazgos?.(label) ?? { findings: [] }
  }

  const mundo = {
    mediciones: [],
    despachos: [],
    bloqueos: [],
    paralelo: null,
    veces,
    prs,
    issue,
    mergeadas,
    duracion(label) {
      const k = Object.keys(duraciones).find((p) => label.startsWith(p))
      return k ? duraciones[k] : 0
    },
    responder(prompt, opts) {
      const label = opts.label ?? ''
      alInvocar?.(label, mundo)
      if (label.startsWith('scout:')) return scout()
      if (label.startsWith('validator:')) return validator(label, prompt)
      if (label.startsWith('implementer:')) return implementer(label, prompt)
      if (label.startsWith('retry:')) return { worktree: 'x', branch: 'x', resumen: 'retry' }
      if (label.startsWith('serializer:')) return serializer(label, prompt)
      if (label.startsWith('review:')) return review(label)
      if (label.startsWith('resolver:')) return { action: 'MERGE', resolution: 'RESOLVED', resumen: 'ok' }
      throw new Error(`el mundo no sabe responder a ${label}`)
    },
  }
  return mundo
}

// Utilidades de lectura sobre las llamadas registradas.
export const conLabel = (llamadas, re) => llamadas.filter((c) => re.test(c.label ?? ''))
