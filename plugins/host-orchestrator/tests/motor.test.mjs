// Tests del motor (workflows/prd-pipeline.js).
//
//   node --test plugins/host-orchestrator/tests/
//
// Dos niveles: las reglas puras, evaluadas sobre el bloque «NÚCLEO PURO» del
// motor, y corridas enteras del motor contra el mundo de mentira del simulador.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { nucleoPuro, correrMotor, crearMundo, conLabel } from './simulador.mjs'

const P = nucleoPuro(['gate', 'lockfilesAjenos', 'aBaseline', 'tocaVedados', 'vetoDeWorkflows', 'crearRegistro', 'crearMemoria'])

// Leo saca la etiqueta que puso el motor: en el primer scout después de que quedó puesta.
const destrabaIssue = (n) => (label, m) => { if (label.startsWith('scout:') && m.bloqueos.includes(n) && !m.destrabadas?.has(n)) { (m.destrabadas ??= new Set()).add(n); m.issue.get(n).labels.delete('agent-blocked') } }
const destrabaPr = (pr) => (label, m) => { if (label.startsWith('scout:') && m.prs.get(pr)?.labels.has('merge-blocked') && !m.destrabados?.has(pr)) { (m.destrabados ??= new Set()).add(pr); m.prs.get(pr).labels.delete('merge-blocked') } }

const BASE = { metrics: { typecheck_errors: 3 }, tests_failed: 1, failing_test_files: ['a.test.ts'], lockfiles_ajenos: [] }
const med = (o = {}) => ({ status: 'ok', metrics: { typecheck_errors: 3 }, tests_failed: 1, failing_test_files: ['a.test.ts'], lockfiles_ajenos: [], diff_toca_tests: true, tests_del_diff_verdes: true, ...o })

test('gate: igual al baseline y con tests propios verdes, pasa', () => {
  assert.deepEqual(P.gate(med(), BASE), { pass: true, motivos: [] })
})

test('gate: una medición inválida nunca es éxito', () => {
  assert.equal(P.gate(med({ status: 'error', error: 'oom' }), BASE).pass, false)
  assert.equal(P.gate(null, BASE).pass, false)
})

test('gate: el ratchet no deja empeorar ninguna métrica ni sumar rojos', () => {
  assert.match(P.gate(med({ metrics: { typecheck_errors: 4 } }), BASE).motivos.join(), /empeoró/)
  assert.match(P.gate(med({ tests_failed: 2, failing_test_files: ['a.test.ts', 'b.test.ts'] }), BASE).motivos.join(), /b\.test\.ts/)
})

test('gate: sin tests en el diff no pasa, salvo que no se exijan', () => {
  assert.equal(P.gate(med({ diff_toca_tests: false }), BASE).pass, false)
  assert.equal(P.gate(med({ diff_toca_tests: false }), BASE, { exigirTests: false }).pass, true)
})

test('lockfilesAjenos: solo los de carpetas con dos managers', () => {
  assert.deepEqual(P.lockfilesAjenos(['pnpm-lock.yaml', 'package-lock.json', 'web/package-lock.json']), ['package-lock.json', 'pnpm-lock.yaml'])
  assert.deepEqual(P.lockfilesAjenos(['pnpm-lock.yaml', 'web/package-lock.json']), [])
})

test('corrida simulada: dos issues independientes terminan DONE con PR final', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {} } })
  const { resultado } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE')
  assert.equal(resultado.pr_final_draft, 999)
  assert.deepEqual([...mundo.mergeadas].sort(), [1, 2])
})

// ── Ítem 1: un trabajo no se despacha dos veces en una corrida sin un hecho nuevo ──

const rechazoWorkflow = 'remote rejected: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope'

test('publicación bloqueada: se implementa una sola vez, se reintenta solo la publicación y queda para Leo', async () => {
  const mundo = crearMundo({ issues: { 207: {}, 1: {} }, fallas: { publicar: (n) => (n === 207 ? rechazoWorkflow : null) } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#207$/).length, 1, 'la issue se implementó más de una vez')
  assert.equal(conLabel(llamadas, /^serializer:publish-i207/).length, 2, 'una publicación + un reintento de solo la publicación')
  assert.deepEqual(mundo.bloqueos, [207])
  assert.ok(resultado.bloqueadas.some((b) => b.startsWith('#207') && /publicación/.test(b)))
  const marca = conLabel(llamadas, /^serializer:block-i207$/)[0]
  assert.match(marca.prompt, /wf_sim-207-1/, 'el comentario nombra el worktree conservado')
  assert.match(marca.prompt, /CONSERVÁ el worktree/)
})

test('implementer muerto: si el scout la vuelve a ofrecer, no se re-despacha y queda para Leo', async () => {
  const mundo = crearMundo({ issues: { 3: {}, 1: {} }, fallas: { implementer: (n) => (n === 3 ? 'muere' : null) } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#3$/).length, 1)
  assert.deepEqual(mundo.bloqueos, [3])
  assert.ok(resultado.bloqueadas.some((b) => b.startsWith('#3')))
})

test('hecho nuevo: si alguien saca la etiqueta que puso el motor, se despacha otra vez', async () => {
  const mundo = crearMundo({
    issues: { 4: {} },
    fallas: { implementer: (n, intento) => (intento === 1 ? { bloqueado: 'TICKET_AMBIGUOUS: falta el criterio' } : null) },
    alInvocar: destrabaIssue(4),
  })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#4$/).length, 2)
  assert.equal(resultado.status, 'DONE')
})

test('merge que falla: el PR no se reintenta en cada vuelta, queda merge-blocked para Leo', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { merge: () => 'gh: required status check "ci" is failing' } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^serializer:integrar-pr/).length, 1)
  assert.ok(mundo.prs.get(500).labels.has('merge-blocked'))
  assert.ok(resultado.para_leo.some((l) => /#1 IN_REVIEW/.test(l)))
})

test('registro: un trabajo se despacha una vez; vuelve a despacharse solo si el motor lo había bloqueado', () => {
  const r = P.crearRegistro()
  assert.equal(r.decidir('i1'), 'despachar')
  r.intento('i1', { ultimo: 'x' })
  assert.equal(r.decidir('i1'), 'para_leo')
  r.bloqueado('i1')
  assert.equal(r.decidir('i1'), 'despachar', 'sacarle la etiqueta del motor es un hecho nuevo')
  r.intento('i1')
  assert.equal(r.decidir('i1'), 'para_leo')
  assert.equal(r.dato('i1').intentos, 2)
})

test('vetoDeWorkflows: veda salvo ssh o token clásico con scope workflow', () => {
  assert.equal(P.vetoDeWorkflows({ via: 'ssh' }).vedar, false)
  assert.equal(P.vetoDeWorkflows({ via: 'https', tipo: 'clasico', scopes: 'gist, repo, workflow' }).vedar, false)
  assert.equal(P.vetoDeWorkflows({ via: 'https', tipo: 'clasico', scopes: 'repo, read:org' }).vedar, true)
  assert.equal(P.vetoDeWorkflows({ via: 'https', tipo: 'clasico', scopes: '' }).vedar, true)
  assert.equal(P.vetoDeWorkflows({ via: 'https', tipo: 'fine-grained', scopes: null }).vedar, true)
  assert.equal(P.vetoDeWorkflows(undefined).vedar, true)
})

test('tocaVedados: globs con ** y *, y carpetas sin comodín', () => {
  const archivos = ['.github/workflows/ci.yml', 'src/a.ts', 'legacy/x/y.ts', 'docs/a.md']
  assert.deepEqual(P.tocaVedados(archivos, ['.github/workflows/**']), ['.github/workflows/ci.yml'])
  assert.deepEqual(P.tocaVedados(archivos, ['legacy']), ['legacy/x/y.ts'])
  assert.deepEqual(P.tocaVedados(archivos, ['docs/*.md', 'src/*.js']), ['docs/a.md'])
  assert.deepEqual(P.tocaVedados(archivos, []), [])
})

test('gate: un diff que toca un path vedado no pasa', () => {
  const m = med({ archivos_del_diff: ['src/a.ts', '.github/workflows/ci.yml'] })
  assert.match(P.gate(m, BASE, { vedados: ['.github/workflows/**'] }).motivos.join(), /vedados: \.github\/workflows\/ci\.yml/)
  assert.equal(P.gate(med(), BASE, { vedados: ['x/**'] }).pass, false, 'sin la lista de archivos no se puede afirmar que no los toca')
})

test('token sin permiso de workflows: el implementer recibe el veto y el gate frena el diff que toca CI', async () => {
  const mundo = crearMundo({
    issues: { 9: {} },
    token: { via: 'https', tipo: 'fine-grained', scopes: null },
    fallas: { implementer: () => ({ toca: ['.github/workflows/ci.yml'] }) },
  })
  const { resultado, llamadas, logs } = await correrMotor({ mundo })
  assert.match(conLabel(llamadas, /^implementer:#9$/)[0].prompt, /PATHS VEDADOS[^\n]*\.github\/workflows\/\*\*/)
  assert.equal(conLabel(llamadas, /^serializer:publish-i9/).length, 0, 'no se publica')
  assert.ok(resultado.bloqueadas.some((b) => /#9 gate FAIL.*vedados/.test(b)))
  assert.ok(logs.some((l) => /push: .*fine-grained.*vedado/.test(l)))
})

// ── Ítem 2: worktrees del motor dentro de la convención wf_* y re-medición ──

test('todo worktree que crea el motor tiene carpeta wf_* (los tests del repo aíslan sus recursos por ese prefijo)', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE')
  const carpetas = new Set(llamadas.flatMap((c) => [...c.prompt.matchAll(/\.host-orchestrator\/wt\/([A-Za-z0-9._-]+)/g)].map((m) => m[1])))
  assert.ok(carpetas.size >= 2, `se esperaban la integradora y un PR, hubo: ${[...carpetas]}`)
  for (const c of carpetas) if (!c.startsWith('<')) assert.match(c, /^wf_/, `la carpeta ${c} cae en la base compartida`)
})

test('medición inválida: se re-mide una vez antes de frenar (baseline, PR y gate de la issue)', async () => {
  const mundo = crearMundo({
    issues: { 1: {}, 2: { deps: [1] } },
    fallas: { medicion: (etiqueta, intento) => (intento === 1 && /^(baseline-w1|pr500|i2)$/.test(etiqueta) ? 'invalida' : null) },
  })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE', JSON.stringify(resultado.bloqueadas))
  assert.equal(conLabel(llamadas, /^retry:/).length, 0, 'una medición rota no re-despacha al implementer')
  assert.ok(!mundo.prs.get(500).labels.has('merge-blocked'))
})

// ── Ítem 3: dependencias iguales al lockfile antes de trabajar o medir ──

test('deps al día: el Setup, el implementer y cada medición corren deps-al-dia sobre su árbol', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  const { llamadas } = await correrMotor({ mundo })
  const deps = /bash \/plugin\/scripts\/deps-al-dia\.sh /
  assert.match(conLabel(llamadas, /^serializer:setup-rama$/)[0].prompt, deps)
  assert.match(conLabel(llamadas, /^implementer:#1$/)[0].prompt, deps)
  const validators = conLabel(llamadas, /^validator:/)
  assert.ok(validators.length >= 2)
  for (const v of validators) assert.match(v.prompt, /1b\. cd \S+ && bash \/plugin\/scripts\/deps-al-dia\.sh \./, v.label)
})

// ── Ítem 4: cada árbol se mide una sola vez por corrida ──

const ARBOL = 'a'.repeat(40)
test('memoria: guarda solo mediciones ok de un árbol limpio y completa las ya medidas', () => {
  const m = P.crearMemoria()
  const medida = { status: 'ok', arbol: ARBOL, limpio: true, metrics: { typecheck_errors: 2 }, tests_failed: 1, failing_test_files: ['a.test.ts'], tests_fuente: 'suite', lockfiles: ['package-lock.json'] }
  assert.equal(m.guardar({ ...medida, status: 'error' }), false)
  assert.equal(m.guardar({ ...medida, limpio: false }), false, 'con cambios sin commitear el árbol no describe lo medido')
  assert.equal(m.guardar({ ...medida, arbol: 'HEAD' }), false, 'un id que no es de git no se guarda')
  assert.equal(m.guardar({ ...medida, ya_medido: true }), false)
  assert.equal(m.guardar(medida), true)
  assert.deepEqual(m.arboles(), [ARBOL])
  const c = m.completar({ status: 'ok', ya_medido: true, arbol: ARBOL, limpio: true, metrics: {}, tests_failed: 0, failing_test_files: [], tests_del_diff: ['x.test.ts'] })
  assert.equal(c.tests_failed, 1)
  assert.deepEqual(c.failing_test_files, ['a.test.ts'])
  assert.deepEqual(c.tests_del_diff, ['x.test.ts'], 'lo del diff es de esta medición, no del árbol')
  assert.equal(m.completar({ ya_medido: true, arbol: 'b'.repeat(40), limpio: true }), null)
  assert.equal(m.completar({ ya_medido: true, arbol: ARBOL, limpio: false }), null, 'sobre cambios sin commitear no se completa')
  m.olvidar(ARBOL)
  assert.equal(m.medicion(ARBOL), null)
})

test('cadena 1←2←3: cada árbol se mide una vez (gate de la issue → pre-merge → baseline siguiente)', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] }, 3: { deps: [2] } } })
  const { resultado } = await correrMotor({ mundo, args: { maxParallel: 1 } })
  assert.equal(resultado.status, 'DONE')
  const arboles = mundo.mediciones.map((m) => m.arbol)
  assert.equal(new Set(arboles).size, arboles.length, `un árbol se midió dos veces: ${JSON.stringify(mundo.mediciones.map((m) => [m.etiqueta, m.issues]))}`)
  assert.equal(arboles.length, 4, 'el baseline vacío y el árbol de cada issue')
})

test('un medidor que dice "ya medido" sobre un árbol que el motor no tiene no cuenta como medición', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { yaMedidoFalso: (etiqueta, intento) => etiqueta === 'i1' && intento === 1 } })
  const { resultado, logs } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE')
  assert.ok(mundo.mediciones.some((m) => m.etiqueta === 'i1'), 'el árbol de la issue se midió de verdad')
  assert.ok(logs.some((l) => /i1 inválida.*no es el esperado/.test(l)))
})

// ── Ítem 5: los roles mecánicos corren con el agente liviano ──

test('scout, validator y serializer salen como operador (solo Bash); el implementer con su tipo', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } } })
  const { llamadas } = await correrMotor({ mundo })
  const mecanicos = conLabel(llamadas, /^(scout|validator|serializer):/)
  assert.ok(mecanicos.length > 5)
  for (const c of mecanicos) assert.equal(c.agentType, 'host-orchestrator:operador', c.label)
  for (const c of conLabel(llamadas, /^implementer:/)) assert.equal(c.agentType, 'host-orchestrator:parallel-implementer')
})

// ── Ítem 7: lo habilitado se recalcula después de mergear ──

test('cadena 1←2←3: lo que un merge destraba se despacha apenas entra, sin esperar a nadie', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] }, 3: { deps: [2] } } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE', `quedó ${resultado.status}: ${resultado.pendientes}`)
  const i = (label) => llamadas.findIndex((c) => c.label === label)
  assert.ok(i('serializer:integrar-pr500') < i('implementer:#2'))
  assert.ok(i('serializer:integrar-pr501') < i('implementer:#3'))
})

// ── Hallazgos de la revisión de la Entrega 1 ──

test('el medidor no puede prestarle a un PR rojo la medición verde de otro árbol', async () => {
  // El gate pre-merge del PR de #2 responde "ya medido" con el árbol de la integradora
  // (verde), pero el árbol del PR rompe un test. Antes el motor completaba con los
  // números verdes y mergeaba el rojo.
  const mundo = crearMundo({
    issues: { 1: {}, 2: {} },
    fallas: {
      rojo: (n, etiqueta) => (n === 2 && etiqueta !== 'i2' ? ['src/roto.test.ts'] : []),
      yaMedidoFalso: (etiqueta, intento, { arbolIntegracion }) => (etiqueta === 'pr501' && intento === 1 ? arbolIntegracion : false),
    },
  })
  const { resultado } = await correrMotor({ mundo })
  assert.ok(!mundo.mergeadas.includes(2), 'el PR rojo se mergeó')
  assert.ok(mundo.prs.get(501).labels.has('merge-blocked'))
  assert.notEqual(resultado.status, 'DONE')
})

test('un rojo espurio no queda fijo: destrabado el PR, el árbol se vuelve a medir', async () => {
  // #1 y #2 salen juntas; al integrar #2 sobre #1 el árbol es nuevo y su medición da
  // un rojo espurio. Leo saca merge-blocked: el árbol se mide de nuevo, no se reusa.
  const mundo = crearMundo({
    issues: { 1: {}, 2: {} },
    fallas: { rojo: (n, etiqueta, intento) => (etiqueta === 'pr501' && intento === 1 ? ['src/flaky.test.ts'] : []) },
    alInvocar: destrabaPr(501),
  })
  const { resultado } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE', JSON.stringify(resultado.para_leo))
  assert.equal(mundo.mediciones.filter((m) => m.etiqueta === 'pr501').length, 2)
})

test('un worktree con cambios sin commitear no pasa el gate de la issue', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { sucio: (etiqueta) => etiqueta === 'i1' } })
  const { llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^retry:#1$/).length, 1, 'el implementer recibe el motivo y reintenta')
  assert.match(conLabel(llamadas, /^retry:#1$/)[0].prompt, /sin commitear/)
})

test('un re-despacho por hecho nuevo usa otra branch (la anterior sigue en su worktree conservado)', async () => {
  const mundo = crearMundo({
    issues: { 4: {} },
    fallas: { implementer: (n, intento) => (intento === 1 ? { bloqueado: 'TICKET_AMBIGUOUS' } : null) },
    alInvocar: destrabaIssue(4),
  })
  await correrMotor({ mundo })
  assert.deepEqual(mundo.branches, ['issue-4', 'issue-4-v2'])
})

test('publicación destrabada: se republica el worktree conservado, sin reimplementar', async () => {
  const mundo = crearMundo({
    issues: { 207: {} },
    fallas: { publicar: (n, intento) => (intento <= 2 ? rechazoWorkflow : null) },
    alInvocar: destrabaIssue(207),
  })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#207$/).length, 1)
  assert.equal(resultado.status, 'DONE')
  assert.match(conLabel(llamadas, /^serializer:publish-i207$/).at(-1).prompt, /wf_sim-207-1/)
})

test('si el medidor no puede medir, el implementer no se reintenta: queda para Leo como problema del medidor', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { medicion: (etiqueta) => (etiqueta === 'i1' ? 'invalida' : null) } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^retry:/).length, 0)
  assert.ok(resultado.bloqueadas.some((b) => /#1 el medidor no pudo medir/.test(b)))
})

test('merge cuyo serializer muere: el PR vuelve MERGE_READY y queda para Leo, no se reintenta', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { merge: () => 'muere' } })
  const { llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^serializer:integrar-pr500$/).length, 1)
  assert.ok(mundo.prs.get(500).labels.has('merge-blocked'))
})

test('el gate de la issue compara contra la integradora ya mergeada, no contra la de antes de los merges', async () => {
  // old.test.ts está rojo hasta que entra #1; #2 lo vuelve a romper. Contra el
  // baseline de antes de los merges (con old.test.ts rojo) el rojo de #2 pasaba.
  const mundo = crearMundo({
    issues: { 1: {}, 2: { deps: [1] } },
    fallas: { rojosDe: (c) => (!c.includes(1) || c.includes(2) ? ['old.test.ts'] : []) },
  })
  const { resultado } = await correrMotor({ mundo, args: { maxParallel: 1 } })
  assert.ok(resultado.bloqueadas.some((b) => /#2 gate FAIL.*old\.test\.ts/.test(b)), JSON.stringify(resultado.bloqueadas))
})

test('si la etiqueta no se pudo poner, la vuelta del trabajo tampoco se despacha', async () => {
  const mundo = crearMundo({ issues: { 3: {} }, fallas: { implementer: () => 'muere', marcar: () => true } })
  const { llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#3$/).length, 1)
  assert.ok(mundo.marcas.length >= 1, 'el motor intenta marcarla, no reimplementarla')
})

test('bloqueadas sale sin repetidos', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {} }, fallas: { implementer: (n) => (n === 2 ? { bloqueado: 'x' } : null) } })
  const { resultado } = await correrMotor({ mundo })
  assert.equal(new Set(resultado.bloqueadas).size, resultado.bloqueadas.length)
})

// ── Entrega 2: despacho continuo, revisión por PR, Haiku en lo mecánico ──

const Q = nucleoPuro(['crearCandado', 'crearTimbre', 'crearVigia', 'tierEfectivo', 'arbolAprobado', 'crearMemoria'])
const esperar = (ms) => new Promise((r) => setTimeout(r, ms))
const solapan = (xs) => xs.some((a, i) => xs.some((b, j) => i < j && a.inicio < b.fin && b.inicio < a.fin))
const maxSimultaneos = (xs) => Math.max(0, ...xs.map((a) => xs.filter((b) => b.inicio <= a.inicio && a.inicio < b.fin).length))

test('candado: de a una, en orden de llegada, y una que falla no traba a las siguientes', async () => {
  const c = Q.crearCandado()
  const traza = []
  const tarea = (n, ms, falla) => () => esperar(ms).then(() => { traza.push(n); if (falla) throw new Error('x') })
  await Promise.allSettled([c.con(tarea(1, 15)), c.con(tarea(2, 1, true)), c.con(tarea(3, 1))])
  assert.deepEqual(traza, [1, 2, 3])
})

test('timbre: un aviso sin nadie esperando queda guardado', async () => {
  const t = Q.crearTimbre()
  t.avisar()
  await t.esperar() // no cuelga
  let desperto = false
  const espera = t.esperar().then(() => { desperto = true })
  await esperar(1)
  assert.equal(desperto, false)
  t.avisar()
  await espera
  assert.equal(desperto, true)
})

const lectura = (o) => ({ cinco_h: 20, cinco_h_reinicia: 10_000 + 4 * 3600, semanal: 30, semanal_reinicia: 10_000 + 5 * 86400, medida: 10_000, leida: 10_000, ...o })
test('vigía: sin lectura no baja; arriba del umbral de 5 h o de la reserva semanal, un carril', () => {
  assert.equal(Q.crearVigia().leer(undefined, 3).P, 3)
  assert.equal(Q.crearVigia().leer(lectura({ cinco_h: 86 }), 3).P, 1)
  assert.equal(Q.crearVigia().leer(lectura({ semanal: 91 }), 3).P, 1)
  assert.equal(Q.crearVigia({ reservaSemanal: 20 }).leer(lectura({ semanal: 81 }), 3).P, 1)
  assert.equal(Q.crearVigia().leer(lectura({ cinco_h: 86, cinco_h_reinicia: 9_000 }), 3).P, 3, 'ventana ya vencida: la lectura no dice nada')
})

test('vigía: con la velocidad medida, los carriles que llegan al reinicio sin pasar el tope', () => {
  // Leo, 18/10: semanal al 46 % con 5 días por delante, ~1,3 %/h por carril → ni un
  // carril llega sin pasar el 90 %: queda en 1 (nunca en 0).
  const v = Q.crearVigia()
  const t0 = 10_000
  v.enCurso(1)
  v.leer(lectura({ semanal: 45, leida: t0, medida: t0 }), 3)
  const r = (v.enCurso(1), v.leer(lectura({ semanal: 46.3, leida: t0 + 3600, medida: t0 + 3600, semanal_reinicia: t0 + 5 * 86400 }), 3))
  assert.equal(r.P, 1)
  assert.match(r.motivo, /semanal/)
  // 5 h: 20 % → 26 % en una hora con 2 carriles (3 %/h c/u), 3 h al reinicio: (85−26)/(3×3) = 6,5 → no limita a 3
  const w = Q.crearVigia()
  w.enCurso(2)
  w.leer(lectura({ cinco_h: 20, leida: t0, medida: t0, semanal: 10 }), 3)
  assert.equal((w.enCurso(2), w.leer(lectura({ cinco_h: 26, leida: t0 + 3600, medida: t0 + 3600, cinco_h_reinicia: t0 + 4 * 3600, semanal: 10 }), 3)).P, 3)
  // …pero a 15 %/h por carril, sí: (85−50)/(15×3) → 0 → 1
  const x = Q.crearVigia()
  x.enCurso(2)
  x.leer(lectura({ cinco_h: 20, leida: t0, medida: t0, semanal: 10 }), 3)
  assert.equal((x.enCurso(2), x.leer(lectura({ cinco_h: 50, leida: t0 + 3600, medida: t0 + 3600, cinco_h_reinicia: t0 + 4 * 3600, semanal: 10 }), 3)).P, 1)
  // con menos de media hora de datos no estima velocidad
  const y = Q.crearVigia()
  y.enCurso(1)
  y.leer(lectura({ cinco_h: 20, leida: t0, medida: t0, semanal: 10 }), 3)
  assert.equal((y.enCurso(1), y.leer(lectura({ cinco_h: 60, leida: t0 + 600, medida: t0 + 600, semanal: 10 }), 3)).P, 3)
})

test('tiers: lo mecánico en T3; el validator en T3 solo con los tests del hook; args lo sube', () => {
  assert.equal(Q.tierEfectivo('scout', {}), 'T3')
  assert.equal(Q.tierEfectivo('serializer', {}), 'T3')
  assert.equal(Q.tierEfectivo('validator', {}), 'T2')
  assert.equal(Q.tierEfectivo('validator', {}, { testsDelHook: true }), 'T3')
  assert.equal(Q.tierEfectivo('serializer', { serializer: 'T2' }), 'T2')
  assert.equal(Q.tierEfectivo('validator', { validator: 'T2' }, { testsDelHook: true }), 'T2')
  assert.equal(Q.tierEfectivo('implementer', {}), 'T1')
})

test('arbolAprobado: solo un árbol medido que pasa la no-regresión contra la base', () => {
  const m = Q.crearMemoria()
  const verde = 'a'.repeat(40)
  const rojo = 'b'.repeat(40)
  const base = { metrics: { typecheck_errors: 0 }, tests_failed: 0, failing_test_files: [], lockfiles_ajenos: [] }
  m.guardar({ status: 'ok', arbol: verde, limpio: true, metrics: { typecheck_errors: 0 }, tests_failed: 0, failing_test_files: [], lockfiles: [] })
  m.guardar({ status: 'ok', arbol: rojo, limpio: true, metrics: { typecheck_errors: 0 }, tests_failed: 1, failing_test_files: ['x.test.ts'], lockfiles: [] })
  assert.equal(Q.arbolAprobado(m, base, verde), verde)
  assert.equal(Q.arbolAprobado(m, base, rojo), null)
  assert.equal(Q.arbolAprobado(m, base, 'c'.repeat(40)), null)
  assert.equal(Q.arbolAprobado(m, base, undefined), null)
})

test('sin barrera: una implementación lenta no frena a la cadena que corre al lado', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {}, 3: { deps: [2] } }, duraciones: { 'implementer:#1': 80, 'implementer:#2': 5, 'implementer:#3': 5 } })
  const { resultado, llamadas } = await correrMotor({ mundo, args: { maxParallel: 2 } })
  assert.equal(resultado.status, 'DONE')
  const uno = conLabel(llamadas, /^implementer:#1$/)[0]
  const tres = conLabel(llamadas, /^implementer:#3$/)[0]
  assert.ok(tres.inicio < uno.fin, '#3 esperó a que terminara #1: hay barrera')
})

test('nunca más carriles que P, ni que issues habilitadas', async () => {
  const issues = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, {}]))
  const mundo = crearMundo({ issues, duraciones: { 'implementer:': 10 } })
  const { llamadas } = await correrMotor({ mundo, args: { maxParallel: 2 } })
  assert.equal(maxSimultaneos(conLabel(llamadas, /^implementer:/)), 2)
  const solo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, duraciones: { 'implementer:': 10 } })
  const r2 = await correrMotor({ mundo: solo, args: { maxParallel: 3 } })
  assert.equal(maxSimultaneos(conLabel(r2.llamadas, /^implementer:/)), 1)
})

test('P por defecto es 3', async () => {
  const issues = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, {}]))
  const { llamadas } = await correrMotor({ mundo: crearMundo({ issues, duraciones: { 'implementer:': 10 } }), args: { maxParallel: undefined } })
  assert.equal(maxSimultaneos(conLabel(llamadas, /^implementer:/)), 3)
})

test('la perilla y el vigía de cuota bajan P en caliente', async () => {
  const issues = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, {}]))
  const conPerilla = crearMundo({ issues, duraciones: { 'implementer:': 10 }, alInvocar: (label, m) => { if (label === 'implementer:#1') m.paralelo = 1 } })
  const r1 = await correrMotor({ mundo: conPerilla, args: { maxParallel: 3 } })
  const despues = conLabel(r1.llamadas, /^implementer:#[4-6]$/)
  assert.ok(maxSimultaneos(despues) <= 1, 'con la perilla en 1 no se abren carriles nuevos de a varios')
  const conCuota = crearMundo({ issues, duraciones: { 'implementer:': 10 } })
  conCuota.cuota = () => lectura({ cinco_h: 90 })
  const r2 = await correrMotor({ mundo: conCuota, args: { maxParallel: 3, cuota: '/home/leo/.cache/claude-cuota.json' } })
  assert.equal(maxSimultaneos(conLabel(r2.llamadas, /^implementer:/)), 1)
  assert.match(conLabel(r2.llamadas, /^scout:/)[0].prompt, /--cuota \/home\/leo\/\.cache\/claude-cuota\.json/)
})

test('el candado: dos serializers nunca corren a la vez, aunque los pidan carriles distintos', async () => {
  const issues = Object.fromEntries([1, 2, 3, 4].map((n) => [n, {}]))
  const mundo = crearMundo({ issues, duraciones: { 'serializer:': 3, 'implementer:': 4 } })
  mundo.hallazgos = () => [{ titulo: 'x', ubicacion: 'a.ts:1', severidad: 'media', por_que: 'y', fix: 'z', decision: 'aplicar', razon: 'bug' }]
  const { resultado, llamadas } = await correrMotor({ mundo, args: { maxParallel: 3 } })
  assert.equal(resultado.status, 'DONE')
  assert.equal(solapan(conLabel(llamadas, /^serializer:/)), false)
})

test('integrar: un PR cuyo árbol no cambió entra con un agente; uno que cambió, con integrar + medir + integrar', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {} } })
  const { llamadas } = await correrMotor({ mundo, args: { maxParallel: 2 } })
  const primero = Math.min(...[500, 501].filter((n) => mundo.prs.get(n).merged).map((n) => mundo.integraciones.indexOf(n)))
  assert.ok(primero >= 0)
  const porPr = (n) => mundo.integraciones.filter((x) => x === n).length
  assert.deepEqual([porPr(500), porPr(501)].sort(), [1, 2])
  assert.equal(conLabel(llamadas, /^serializer:(prep|merge)-pr/).length, 0, 'sin prep ni merge aparte')
  assert.equal(mundo.mediciones.filter((m) => /^pr/.test(m.etiqueta)).length, 1, 'solo el árbol nuevo se mide')
  assert.equal(conLabel(llamadas, /^resolver:/).length, 0, 'sin conflicto, sin Opus')
})

test('refresh solo si la base se movió', async () => {
  const quieta = crearMundo({ issues: { 1: {}, 2: { deps: [1] } } })
  const r1 = await correrMotor({ mundo: quieta })
  assert.equal(conLabel(r1.llamadas, /^serializer:refresh/).length, 0)
  const movida = crearMundo({ issues: { 1: {} } })
  movida.basePorIntegrar = 2
  const r2 = await correrMotor({ mundo: movida })
  assert.equal(conLabel(r2.llamadas, /^serializer:refresh/).length, 1)
  assert.equal(r2.resultado.status, 'DONE')
})

test('la base después de un merge confirmado sale de la memoria: no se mide la integradora', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] }, 3: { deps: [2] } } })
  await correrMotor({ mundo })
  assert.deepEqual(mundo.mediciones.filter((m) => /^base-/.test(m.etiqueta)).map((m) => m.etiqueta), ['base-inicial'])
})

const hallazgo = (decision, titulo = `h-${decision}`) => ({ titulo, ubicacion: 'src/a.ts:3', severidad: 'media', por_que: 'porque', fix: 'el arreglo', decision, razon: decision === 'aplicar' ? 'bug real' : 'debajo del umbral' })
test('revisión por PR: revisor + aplicador; los arreglos salen como PR, entran por la cola y el registro queda en el PR', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  mundo.hallazgos = (pr) => (pr === 500 ? [hallazgo('aplicar', 'off-by-one'), hallazgo('seguimiento', 'nombre'), hallazgo('humano', 'cambia el payload')] : [])
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE')
  assert.equal(conLabel(llamadas, /^revisor:/).length, 1, 'un solo revisor por PR, sin flota')
  assert.equal(conLabel(llamadas, /^review:/).length, 0)
  assert.equal(conLabel(llamadas, /^aplicador:pr500$/).length, 1)
  const fix = [...mundo.prs.entries()].find(([, p]) => p.fixDe === 500)
  assert.ok(fix && fix[1].merged, 'el PR de arreglos entró por la cola de merge')
  assert.equal(conLabel(llamadas, new RegExp(`^revisor:pr${fix[0]}$`)).length, 0, 'los arreglos no se vuelven a revisar')
  const reg = resultado.revisiones.find((r) => r.pr === 500)
  assert.deepEqual(reg.aplicados, ['off-by-one'])
  assert.equal(reg.pr_arreglos, fix[0])
  assert.match(mundo.registros.find((r) => r.pr === 500).texto, /off-by-one[\s\S]*Aplicados: off-by-one/)
  assert.ok(mundo.prs.get(500).labels.has('pipeline-revisado'))
  assert.ok(resultado.seguimientos.some((s) => s.titulo === 'nombre'))
  assert.ok(resultado.para_leo.some((l) => /cambia el payload/.test(l)))
  const final = conLabel(llamadas, /^serializer:pr-final$/)[0]
  assert.match(final.prompt, /## Revisión por PR[\s\S]*PR #500: 3 hallazgo\(s\), 1 aplicado/)
  assert.ok(llamadas.indexOf(final) > llamadas.indexOf(conLabel(llamadas, /^serializer:registro-revision-pr500$/)[0]), 'el PR final sale con la cola de revisión vacía')
})

test('la revisión corre al lado: no frena la cadena de dependencias', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, duraciones: { 'revisor:': 60, 'implementer:': 5 } })
  const { llamadas } = await correrMotor({ mundo })
  const rev1 = conLabel(llamadas, /^revisor:pr500$/)[0]
  const impl2 = conLabel(llamadas, /^implementer:#2$/)[0]
  assert.ok(impl2.inicio < rev1.fin, '#2 esperó a la revisión de #1')
})

test('relanzamiento: un PR mergeado por otra corrida sin la etiqueta de revisado se revisa', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {} } })
  // #1 ya entró en una corrida anterior que se cortó antes de revisarlo
  const { resultado: previo } = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }) })
  assert.equal(previo.status, 'DONE')
  mundo.prs.set(400, { issue: 1, branch: 'issue-1', merged: true, labels: new Set(['afk-agent-pr']), arbol: null })
  mundo.mergeadas.push(1)
  const { llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^revisor:pr400$/).length, 1)
  assert.equal(conLabel(llamadas, /^implementer:#1$/).length, 0, 'lo mergeado no se reimplementa')
  // El PR final lista y cierra también lo que entró en la corrida anterior (lo ve el scout DONE).
  const final = conLabel(llamadas, /^serializer:pr-final$/)[0].prompt
  assert.ok(final.includes("'- #1 issue 1 — PR #400'"), 'la issue de la corrida anterior, con su PR')
  assert.ok(final.includes("'Closes #1'"))
})

test('Haiku por defecto en scout y serializer; el validator en Haiku solo después de ver los tests del hook', async () => {
  const sinHook = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }), args: { tiers: undefined } })
  for (const c of conLabel(sinHook.llamadas, /^(scout|serializer):/)) assert.equal(c.model, 'haiku', c.label)
  for (const c of conLabel(sinHook.llamadas, /^validator:/)) assert.equal(c.model, 'sonnet', c.label)
  const conHook = await correrMotor({ mundo: crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, hook: true }), args: { tiers: undefined, validateHook: 'scripts/wave-validate.sh' } })
  const v = conLabel(conHook.llamadas, /^validator:/)
  assert.equal(v[0].model, 'sonnet', 'la primera medición todavía no sabe si el hook trae los tests')
  assert.ok(v.slice(1).every((c) => c.model === 'haiku'))
  const vuelta = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }), args: { tiers: { scout: 'T2', serializer: 'T2' } } })
  for (const c of conLabel(vuelta.llamadas, /^(scout|serializer):/)) assert.equal(c.model, 'sonnet', 'args.tiers vuelve a Sonnet sin editar el motor')
})

test('implementer: tests de su área, no la suite; el agente declara caché de 1 h', async () => {
  const { llamadas } = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }) })
  const p = conLabel(llamadas, /^implementer:#1$/)[0].prompt
  assert.match(p, /tests de TU ÁREA/)
  assert.doesNotMatch(p, /typecheck \+ suite de tests del repo/)
  assert.match(p, /proveedores o recursos reales[^\n]*sí son tuyas/)
  const agente = readFileSync(new URL('../agents/parallel-implementer.md', import.meta.url), 'utf8')
  assert.match(agente.split('---')[1], /experimental:\s*\n\s+cacheTtl: 1h/)
})

// ── Hallazgos de la revisión de la Entrega 2 ──

const arreglo = (pr) => (n) => (n === pr ? [hallazgo('aplicar', 'off-by-one')] : [])
const mergeBlocked = (mundo) => [...mundo.prs.entries()].filter(([, p]) => p.labels.has('merge-blocked')).map(([k]) => k)

test('una dependiente nunca sale de una base que no tiene a su bloqueante (merge en curso)', async () => {
  // integrar mergea al empezar y reporta 60 ms después; mientras, un scout ve el
  // bloqueante DONE. Antes, la dependiente salía de la base vieja.
  const mundo = crearMundo({ issues: { 1: {}, 2: {}, 3: { deps: [2] } }, duraciones: { 'scout:': 20, 'serializer:integrar': 60 } })
  const { resultado } = await correrMotor({ mundo, args: { maxParallel: 3 } })
  assert.equal(resultado.status, 'DONE')
  const m3 = mundo.mediciones.find((m) => m.etiqueta === 'i3')
  assert.ok(m3.issues.includes(2), `#3 arrancó desde una base sin #2: ${JSON.stringify(m3.issues)}`)
})

test('fotos viejas: lo que terminó mientras corría el scout no se marca para Leo', async () => {
  const a = crearMundo({ issues: { 1: {}, 2: {}, 3: {} }, duraciones: { 'implementer:#1': 5, 'implementer:#2': 25, 'implementer:#3': 45, 'scout:': 30 } })
  const r1 = await correrMotor({ mundo: a, args: { maxParallel: 3 } })
  assert.deepEqual(a.bloqueos, [])
  assert.equal(r1.resultado.status, 'DONE')
  const b = crearMundo({ issues: { 1: {}, 2: {}, 3: {} }, duraciones: { 'implementer:#1': 5, 'implementer:#2': 8, 'implementer:#3': 60, 'serializer:integrar': 10, 'scout:': 30 } })
  const r2 = await correrMotor({ mundo: b, args: { maxParallel: 3 } })
  assert.deepEqual(mergeBlocked(b), [])
  assert.equal(r2.resultado.status, 'DONE')
})

test('un PR en conflicto con la rama llega al merge-resolver y entra', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { integrar: (num, intento) => (intento === 1 ? 'conflicto' : null) } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^resolver:pr500$/).length, 1)
  assert.ok(mundo.prs.get(500).merged)
  assert.equal(resultado.status, 'DONE')
})

test('arreglos de revisión cuyo integrar muere: el scout los vuelve a ofrecer y quedan para Leo, no se pierden', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { integrar: (num) => (num === 501 ? 'muere' : null) } })
  mundo.hallazgos = arreglo(500)
  const { resultado } = await correrMotor({ mundo })
  assert.ok(mundo.prs.get(501).labels.has('merge-blocked'))
  assert.ok(resultado.para_leo.some((l) => /#501/.test(l)), JSON.stringify(resultado.para_leo))
  assert.match(mundo.registros.find((r) => r.pr === 500)?.texto ?? '', /#501[^\n]*(bloquead|Leo)/)
})

test('arreglos de revisión merge-blocked: el PR revisado no dice "aplicado" y queda para Leo', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { integrar: (num) => (num === 501 ? 'push rechazado' : null) } })
  mundo.hallazgos = arreglo(500)
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.ok(resultado.para_leo.some((l) => /#501/.test(l)))
  const final = conLabel(llamadas, /^serializer:pr-final$/)[0]
  // Cada línea del cuerpo es un argumento entre comillas simples: la de #500 termina en la comilla.
  if (final) assert.doesNotMatch(final.prompt.match(/PR #500:[^']*/)?.[0] ?? '', /mergead/)
})

test('la etiqueta pipeline-revisado se pone cuando los arreglos ya entraron', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  mundo.hallazgos = arreglo(500)
  const { llamadas } = await correrMotor({ mundo })
  const i = (re) => llamadas.findIndex((c) => re.test(c.label))
  assert.ok(i(/^serializer:registro-revision-pr500$/) > i(/^serializer:integrar-pr501/), 'se registró antes de que entraran los arreglos')
  assert.match(mundo.registros.find((r) => r.pr === 500).texto, /#501[^\n]*mergead/)
})

test('relanzamiento con un PR de arreglos abierto: se integra, y el PR revisado no se vuelve a revisar', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  mundo.prs.set(400, { issue: 1, branch: 'issue-1', merged: true, labels: new Set(['afk-agent-pr']), arbol: null })
  mundo.mergeadas.push(1)
  mundo.prs.set(450, { issue: null, fixDe: 400, branch: 'review/viejo-pr400', merged: false, labels: new Set(['afk-agent-pr', 'review-fix']), arbol: null })
  // el árbol del PR de arreglos: lo que hay más su arreglo
  mundo.prs.get(450).arbol = mundo.arbolDe([1, 9400])
  const { llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^revisor:pr400$/).length, 0)
  assert.ok(mundo.prs.get(450).merged)
  assert.ok(mundo.prs.get(400).labels.has('pipeline-revisado'))
})

test('un error fatal no deja PRs sanos merge-blocked', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: {} }, duraciones: { 'implementer:#2': 30 } })
  const orig = mundo.responder.bind(mundo)
  let n = 0
  mundo.basePorIntegrar = 1
  mundo.responder = (prompt, opts) => {
    if (/^serializer:refresh/.test(opts.label)) { n++; if (n >= 2) return { status: 'blocked', detalle: 'src/a.ts' } }
    if (/^resolver:refresh/.test(opts.label)) return { action: 'ABORT', resolution: 'INCOMPATIBLE', resumen: 'no' }
    const r = orig(prompt, opts)
    if (/^scout:/.test(opts.label) && n >= 1) mundo.basePorIntegrar = 1
    return r
  }
  const { resultado } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'BLOCKED')
  assert.deepEqual(mergeBlocked(mundo), [])
})

test('un merge que el motor no aprobó y empeora la integradora frena la corrida', async () => {
  for (const modo of [true, 'ya_estaba']) {
    const mundo = crearMundo({
      issues: { 1: {}, 2: {} },
      fallas: { desobedece: (num) => (num === 501 ? modo : false), rojosDe: (c) => (c.includes(1) && c.includes(2) ? ['src/choque.test.ts'] : []) },
    })
    const { resultado } = await correrMotor({ mundo, args: { maxParallel: 2 } })
    assert.notEqual(resultado.status, 'DONE', `modo ${modo}`)
    assert.ok(resultado.para_leo.some((l) => /empeoró con un merge que el motor no aprobó/.test(l)), JSON.stringify(resultado.para_leo))
  }
})

test('una revisión que no corrió no figura como limpia en el PR final', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => (/^revisor:/.test(opts.label) ? null : orig(prompt, opts))
  const { llamadas } = await correrMotor({ mundo })
  assert.match(conLabel(llamadas, /^serializer:pr-final$/)[0].prompt, /PR #500: la revisión no corrió/)
})

test('la base después de un merge confirmado no despacha ningún medidor', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] }, 3: { deps: [2] } } })
  const { llamadas } = await correrMotor({ mundo })
  assert.deepEqual(conLabel(llamadas, /^validator:base-/).map((c) => c.label), ['validator:base-inicial'])
})

test('el refresh corre antes de integrar cuando la base se movió', async () => {
  const mundo = crearMundo({ issues: { 1: {} } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => { if (opts.label === 'implementer:#1') mundo.basePorIntegrar = 1; return orig(prompt, opts) }
  const { llamadas } = await correrMotor({ mundo })
  const i = (re) => llamadas.findIndex((c) => re.test(c.label))
  assert.ok(i(/^serializer:refresh/) >= 0 && i(/^serializer:refresh/) < i(/^serializer:integrar-pr500/))
})

test('la implementación parte del commit fijo de la base, no de origin/<rama>', async () => {
  const { llamadas } = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }) })
  assert.match(conLabel(llamadas, /^implementer:#1$/)[0].prompt, /git checkout -B issue-1 [0-9a-f]{40}\n/)
})

test('arreglos que no pasan el gate no se publican', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { rojosDe: (c) => (c.includes(9500) ? ['src/regresion.test.ts'] : []) } })
  mundo.hallazgos = arreglo(500)
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^serializer:publish-arreglos/).length, 0)
  assert.ok(resultado.para_leo.some((l) => /no pasaron el gate/.test(l)))
})

test('sin budget no se empiezan revisiones, y el PR final lo dice', async () => {
  let gastado = 0
  const mundo = crearMundo({ issues: { 1: {} } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => { if (/^serializer:integrar/.test(opts.label)) gastado = 10_000_000; return orig(prompt, opts) }
  const budget = { total: 1_000_000, spent: () => gastado, remaining: () => Math.max(0, 1_000_000 - gastado) }
  const { resultado, llamadas } = await correrMotor({ mundo, budget, args: { budgetTotal: null } })
  assert.equal(conLabel(llamadas, /^revisor:/).length, 0)
  assert.ok(resultado.pendientes.some((p) => /revisión del PR #500/.test(p)))
})

test('una medición en Haiku que leyó la suite cruda se repite en Sonnet', async () => {
  // El hook trae los tests en la primera medición (→ Haiku) y deja de traerlos después.
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, hook: true })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => {
    const r = orig(prompt, opts)
    if (/^validator:/.test(opts.label) && opts.model === 'haiku' && r?.tests_fuente) return { ...r, tests_fuente: 'suite' }
    return r
  }
  const { llamadas } = await correrMotor({ mundo, args: { tiers: undefined, validateHook: 'scripts/wave-validate.sh' } })
  const haiku = conLabel(llamadas, /^validator:/).filter((c) => c.model === 'haiku' && c.respuesta?.tests_fuente === 'suite')
  assert.ok(haiku.length >= 1)
  for (const h of haiku) {
    const etiqueta = h.label.replace(/^validator:/, '').replace(/~.*$/, '')
    assert.ok(conLabel(llamadas, new RegExp(`^validator:${etiqueta}~m2$`)).some((c) => c.model === 'sonnet'), `${etiqueta} no se repitió en Sonnet`)
  }
})

test('vigía: una lectura vieja no se lee como "sin límite": se mantiene la última decisión', () => {
  const v = Q.crearVigia()
  assert.equal(v.leer(lectura({ cinco_h: 90, leida: 10_000, medida: 10_000 }), 3).P, 1)
  const vieja = v.leer(lectura({ cinco_h: 90, leida: 10_000 + 3 * 3600, medida: 10_000 }), 3)
  assert.equal(vieja.P, 1)
  assert.match(vieja.motivo, /hace 180 min/)
})

test('vigía: con horizonte corto, la semanal deja de limitar a un carril (decisión de Leo)', () => {
  const t0 = 10_000
  const con = (o) => { const v = Q.crearVigia(o); v.enCurso(1); v.leer(lectura({ semanal: 45, leida: t0, medida: t0 }), 3); v.enCurso(1); return v.leer(lectura({ semanal: 46.3, leida: t0 + 3600, medida: t0 + 3600 }), 3).P }
  assert.equal(con({}), 1, 'hasta el reinicio semanal')
  assert.equal(con({ horizonteHoras: 8 }), 3, 'mirando 8 h adelante')
})

// ── 4.16.1: merge que falla justo después del push, y tipos livianos para todos ──

test('integrar: el merge de un PR aprobado es mergear-pr.sh con su timeout, no un gh pr merge suelto', async () => {
  const { llamadas } = await correrMotor({ mundo: crearMundo({ issues: { 1: {} } }) })
  const p = conLabel(llamadas, /^serializer:integrar-pr500$/)[0].prompt
  assert.match(p, /bash \/plugin\/scripts\/mergear-pr\.sh \/repo\/\.host-orchestrator\/wt\/wf_pr-500 \/repo batch\/sim 500 issue-1\n/)
  assert.match(p, /timeout 300000/)
  assert.match(p, /MERGEADO → hacé el paso 6[\s\S]*NO_MERGEADO → status 'blocked'/)
  assert.doesNotMatch(p, /gh pr merge/, 'el reintento vive en el script: un gh pr merge en el prompt lo saltea')
})

test('un PR que GitHub reporta MERGED no queda merge-blocked: se da por integrado y la base se mide', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, fallas: { merge: (pr) => (pr === 500 ? { mergea: true, detalle: 'gh pr merge falló al borrar la branch' } : null) } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.deepEqual(mergeBlocked(mundo), [])
  assert.equal(resultado.status, 'DONE', JSON.stringify(resultado.para_leo))
  assert.ok(!resultado.merges.some((m) => m.resultado === 'merge-blocked'), JSON.stringify(resultado.merges))
  assert.ok(resultado.merges.some((m) => m.pr === 500 && m.resultado === 'ya_estaba'))
  assert.ok(mundo.mediciones.some((m) => m.etiqueta === 'base-pr500'), 'un merge que el motor no confirmó: la base se mide')
  assert.equal(conLabel(llamadas, /^revisor:pr500$/).length, 1)
  const marca = conLabel(llamadas, /^serializer:block-pr500$/)[0]
  assert.match(marca.prompt, /in MERGED\) echo YA_MERGEADO ;; OPEN\|CLOSED\) gh pr edit 500 --add-label merge-blocked/)
})

test('ningún agente del motor sale genérico: revisor, aplicador y retry con su tipo; cada tipo con allowlist de tools', async () => {
  const mundo = crearMundo({
    issues: { 1: {} },
    fallas: {
      rojo: (n, etiqueta, intento) => (etiqueta === 'i1' && intento === 1 ? ['src/x.test.ts'] : []),
      integrar: (num, intento) => (num === 500 && intento === 1 ? 'conflicto' : null),
    },
  })
  mundo.hallazgos = (pr) => (pr === 500 ? [hallazgo('aplicar', 'off-by-one')] : [])
  const { llamadas } = await correrMotor({ mundo })
  const tipo = (re) => conLabel(llamadas, re).map((c) => c.agentType)
  assert.deepEqual(tipo(/^resolver:/), ['host-orchestrator:merge-resolver'])
  assert.deepEqual(tipo(/^retry:/), ['host-orchestrator:parallel-implementer'], 'el reintento de un ticket es trabajo de implementer')
  assert.deepEqual(tipo(/^revisor:/), ['host-orchestrator:revisor'])
  assert.deepEqual(tipo(/^aplicador:/), ['host-orchestrator:aplicador'])
  assert.match(conLabel(llamadas, /^retry:/)[0].prompt, /cada comando empieza con `cd \/repo\/\.claude\/worktrees\/wf_sim-1-1 &&`[\s\S]*schema; no XML/)
  const fm = (nombre) => readFileSync(new URL(`../agents/${nombre}.md`, import.meta.url), 'utf8').split('---')[1]
  const tools = (nombre) => fm(nombre).match(/^tools: (.+)$/m)?.[1].split(/,\s*/).sort()
  for (const c of llamadas) {
    assert.ok(c.agentType?.startsWith('host-orchestrator:'), `${c.label} salió genérico: arranca con todas las tools de la sesión`)
    const nombre = c.agentType.split(':')[1]
    assert.match(fm(nombre), new RegExp(`^name: ${nombre}$`, 'm'))
    assert.ok(tools(nombre)?.length, `${nombre} sin allowlist de tools`)
  }
  assert.deepEqual(tools('revisor'), ['Bash', 'Glob', 'Grep', 'Read'], 'el revisor solo lee')
  assert.deepEqual(tools('aplicador'), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
})

test('el motor decide por la línea del shell: un "ya_estaba" con la etiqueta puesta es merge-blocked, no un merge', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { merge: (pr) => (pr === 500 ? 'GraphQL: Base branch was modified' : null) } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => {
    // El primer intento pone la etiqueta y muere; el segundo la ve puesta y dice "ya estaba".
    if (opts.label === 'serializer:block-pr500') { mundo.prs.get(500).labels.add('merge-blocked'); return undefined }
    if (opts.label === 'serializer:block-pr500~r2') return { status: 'ya_estaba', salida: 'MARCADO', detalle: 'la etiqueta merge-blocked ya estaba puesta' }
    return orig(prompt, opts)
  }
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.ok(!resultado.merges.some((m) => m.pr === 500 && m.resultado === 'ya_estaba'), JSON.stringify(resultado.merges))
  assert.ok(resultado.merges.some((m) => m.pr === 500 && m.resultado === 'merge-blocked'))
  assert.equal(conLabel(llamadas, /^revisor:pr500$/).length, 0, 'un PR abierto no se revisa como mergeado')
  assert.equal(mundo.prs.get(500).merged, false)
})

test('un PR que entró mientras se marcaba: la dependiente no sale de una base sin su bloqueante', async () => {
  const mundo = crearMundo({
    issues: { 1: {}, 2: {}, 3: { deps: [1] } },
    fallas: { merge: (pr) => (pr === 500 ? { mergea: true, detalle: 'gh pr view falló' } : null) },
    duraciones: { 'implementer:#2': 40, 'serializer:integrar': 60, 'serializer:block-pr': 80, 'scout:': 20 },
  })
  const { resultado } = await correrMotor({ mundo })
  const m3 = mundo.mediciones.find((m) => m.etiqueta === 'i3')
  assert.ok(m3?.issues.includes(1), `#3 arrancó desde una base sin #1: ${JSON.stringify(m3?.issues)}`)
  assert.equal(resultado.status, 'DONE', JSON.stringify(resultado.para_leo))
})

test('despachador: un PR que vuelve sin hecho nuevo pero ya entró a mano se integra (base y revisión), no se marca', async () => {
  const mundo = crearMundo({ issues: { 1: {}, 2: { deps: [1] } }, fallas: { integrar: (num, intento) => (num === 500 && intento <= 2 ? 'muere' : null) } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => {
    // Alguien lo mergea a mano entre la foto del scout y la marca.
    if (/^serializer:block-pr500/.test(opts.label) && !mundo.prs.get(500).merged) { mundo.prs.get(500).merged = true; mundo.mergeadas.push(1) }
    return orig(prompt, opts)
  }
  const { resultado, llamadas, logs } = await correrMotor({ mundo })
  assert.equal(resultado.status, 'DONE', JSON.stringify(resultado.para_leo))
  assert.deepEqual(mergeBlocked(mundo), [])
  assert.ok(logs.some((l) => /^base pr500:/.test(l)), 'la base se fija con el PR adentro')
  assert.equal(conLabel(llamadas, /^revisor:pr500$/).length, 1)
  assert.ok(mundo.mediciones.find((m) => m.etiqueta === 'i2').issues.includes(1), '#2 sale de una base con #1')
})
