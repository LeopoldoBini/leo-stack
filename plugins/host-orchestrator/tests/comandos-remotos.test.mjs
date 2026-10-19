// Tests de los comandos de shell con los que el motor muta el remoto:
//
//   scripts/mergear-pr.sh         el merge de un PR aprobado, con su reintento
//   comandoDeMarcarPr (motor)     la etiqueta merge-blocked, nunca sobre un PR MERGED
//   comandoDeMarcarIssue (motor)  la etiqueta agent-blocked con su motivo
//   comandoDePublicarPr (motor)   push + PR con título y cuerpo escritos por modelos
//
// Todo texto que escribió un modelo o una persona llega al remoto tal cual: el shell
// no ejecuta backticks ni `$(` (eso lo prueban los textos con `touch pwned`).
// Se corren de verdad, con bash (y zsh, el shell del Bash tool en la Mac), contra un
// `git`, un `gh` y un `sleep` falsos en el PATH que anotan cada llamada.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nucleoPuro, correrMotor, crearMundo, conLabel } from './simulador.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/mergear-pr.sh', import.meta.url))
const H = 'a'.repeat(40) // el commit medido, HEAD del worktree
const B = 'b'.repeat(40) // la integradora que el PR ya trae
const BASE_MODIFICADA = 'GraphQL: Base branch was modified. Review and try the merge again. (mergePullRequest)'

const GH = `#!/usr/bin/env bash
D="$ESCENARIO"
echo "gh $*" >> "$D/llamadas"
case "$1 $2" in
  "pr merge")
    n=$(( $(cat "$D/merges" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/merges"
    r=$(sed -n "\${n}p" "$D/respuestas"); [ -n "$r" ] || r=$(tail -n 1 "$D/respuestas")
    case "$r" in
      base) echo '${BASE_MODIFICADA}' >&2; exit 1 ;;
      ok) echo MERGED > "$D/estado"; echo "Squashed and merged pull request #$3"; exit 0 ;;
      ok-sin-borrar) echo MERGED > "$D/estado"; echo "failed to delete local branch $3" >&2; exit 1 ;;
      otro) echo "Pull request #$3 is not mergeable: the base branch policy prohibits the merge." >&2; exit 1 ;;
    esac ;;
  "pr view") [ -f "$D/estado" ] && cat "$D/estado" || exit 1 ;;
  "pr edit") exit 0 ;;
  "pr comment") printf '%s' "$5" > "$D/cuerpo"; exit 0 ;;
  "issue edit") exit 0 ;;
  "issue comment") printf '%s' "$5" > "$D/cuerpo-issue"; exit 0 ;;
  "pr create")
    shift 2
    while [ $# -gt 0 ]; do
      case "$1" in
        --title) printf '%s' "$2" > "$D/titulo"; shift ;;
        --body-file) cat "$2" > "$D/cuerpo-pr"; shift ;;
      esac
      shift
    done ;;
esac
`
const GIT = `#!/usr/bin/env bash
D="$ESCENARIO"
echo "git $*" >> "$D/llamadas"
case "$1" in
  rev-parse) case "$2" in HEAD) echo ${H} ;; origin/*) echo ${B} ;; esac ;;
  push) [ -f "$D/push-falla" ] && { echo "! [rejected] HEAD -> branch (fetch first)" >&2; exit 1; }; exit 0 ;;
  worktree) exit 0 ;;
  ls-remote) printf '%s\\trefs/heads/batch/sim\\n' "$(cat "$D/remota" 2>/dev/null || echo ${B})" ;;
  merge-base) [ "$2" = --is-ancestor ] && [ "$3" = "${B}" ] && [ "$4" = "${H}" ] ;;
esac
`
const SLEEP = `#!/usr/bin/env bash
echo "sleep $*" >> "$ESCENARIO/llamadas"
`

const temporales = []
after(() => { for (const d of temporales) rmSync(d, { recursive: true, force: true }) })

function escenario({ respuestas = [], estado = 'OPEN', remota = null, pushFalla = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ho-merge-'))
  temporales.push(d)
  for (const [n, c] of Object.entries({ gh: GH, git: GIT, sleep: SLEEP })) {
    mkdirSync(join(d, 'bin'), { recursive: true })
    writeFileSync(join(d, 'bin', n), c)
    chmodSync(join(d, 'bin', n), 0o755)
  }
  mkdirSync(join(d, 'repo', '.host-orchestrator', 'wt', 'wf_pr-500'), { recursive: true })
  writeFileSync(join(d, 'respuestas'), respuestas.join('\n') + '\n')
  if (estado) writeFileSync(join(d, 'estado'), `${estado}\n`)
  if (remota !== null) writeFileSync(join(d, 'remota'), remota)
  if (pushFalla) writeFileSync(join(d, 'push-falla'), '')
  const env = { ...process.env, ESCENARIO: d, PATH: `${join(d, 'bin')}:${process.env.PATH}` }
  const llamadas = () => (existsSync(join(d, 'llamadas')) ? readFileSync(join(d, 'llamadas'), 'utf8').trim().split('\n') : [])
  return { d, env, llamadas, repo: join(d, 'repo'), wt: join(d, 'repo', '.host-orchestrator', 'wt', 'wf_pr-500') }
}

function mergear(e) {
  const r = spawnSync('bash', [SCRIPT, e.wt, e.repo, 'batch/sim', '500', 'issue-1'], { env: e.env, encoding: 'utf8' })
  const lineas = r.stdout.trim().split('\n')
  const ll = e.llamadas()
  return {
    codigo: r.status,
    salida: r.stdout,
    ultima: lineas[lineas.length - 1],
    merges: ll.filter((l) => l.startsWith('gh pr merge')),
    esperas: ll.filter((l) => l.startsWith('sleep')).map((l) => Number(l.split(' ')[1])),
  }
}

test('mergear-pr: "Base branch was modified" justo después del push se reintenta con espera y el mismo commit', () => {
  const r = mergear(escenario({ respuestas: ['base', 'base', 'ok'] }))
  assert.equal(r.ultima, 'MERGEADO')
  assert.equal(r.codigo, 0)
  assert.equal(r.merges.length, 3)
  for (const m of r.merges) assert.match(m, new RegExp(`--squash --delete-branch --match-head-commit ${H}$`))
  assert.deepEqual(r.esperas, [5, 10])
})

test('mergear-pr: si GitHub sigue sin recalcular, a lo sumo cuatro reintentos (5/10/20/30 s) y NO_MERGEADO', () => {
  const r = mergear(escenario({ respuestas: ['base'] }))
  assert.equal(r.ultima, 'NO_MERGEADO')
  assert.equal(r.codigo, 1)
  assert.equal(r.merges.length, 5)
  assert.deepEqual(r.esperas, [5, 10, 20, 30])
  assert.match(r.salida, /Base branch was modified/, 'el error queda en la salida, para el detalle del bloqueo')
})

test('mergear-pr: otro error no se reintenta', () => {
  const r = mergear(escenario({ respuestas: ['otro'] }))
  assert.equal(r.ultima, 'NO_MERGEADO')
  assert.equal(r.merges.length, 1)
  assert.deepEqual(r.esperas, [])
  assert.match(r.salida, /not mergeable/)
})

test('mergear-pr: si la integradora se movió de verdad, no se reintenta (el árbol que entraría ya no es el medido)', () => {
  const r = mergear(escenario({ respuestas: ['base', 'ok'], remota: 'c'.repeat(40) }))
  assert.equal(r.ultima, 'NO_MERGEADO')
  assert.equal(r.merges.length, 1)
  assert.deepEqual(r.esperas, [5], 'la base se mira después de esperar, justo antes de reintentar')
  assert.match(r.salida, /se movió/)
})

test('mergear-pr: si no se puede leer la integradora remota, no se reintenta (y no lo llama "se movió")', () => {
  const r = mergear(escenario({ respuestas: ['base', 'ok'], remota: '' }))
  assert.equal(r.ultima, 'NO_MERGEADO')
  assert.equal(r.merges.length, 1)
  assert.match(r.salida, /no se pudo leer/)
  assert.doesNotMatch(r.salida, /se movió/)
})

test('mergear-pr: el veredicto es el estado de GitHub — gh pr merge que falla después de mergear da MERGEADO', () => {
  const r = mergear(escenario({ respuestas: ['ok-sin-borrar'] }))
  assert.equal(r.ultima, 'MERGEADO')
  assert.equal(r.merges.length, 1)
})

test('mergear-pr: si el push falla, no se mergea', () => {
  const r = mergear(escenario({ respuestas: ['ok'], pushFalla: true }))
  assert.equal(r.ultima, 'NO_MERGEADO')
  assert.equal(r.merges.length, 0)
})

// ── La marca merge-blocked ──

const { comandoDeMarcarPr, comandoDeMarcarIssue, comandoDePublicarPr } = nucleoPuro(['comandoDeMarcarPr', 'comandoDeMarcarIssue', 'comandoDePublicarPr'])
// Un texto como los que escriben los modelos: backticks, `$(`, comillas de los dos tipos.
const PELIGROSO = "arreglé `touch pwned1` y $(touch pwned2) en it's \"citado\" — ${HOME}"
// Cada comando hace `cd` antes: un `touch` ejecutado caería en el escenario, el repo o el worktree.
const sinEjecutar = (e) => [e.d, e.repo, e.wt].every((dir) => ['pwned1', 'pwned2', 'pwned3'].every((f) => !existsSync(join(dir, f))))
const shells = ['bash', 'zsh'].filter((s) => spawnSync(s, ['-c', 'true']).status === 0)
const marcar = (e, sh, comentario = 'integración bloqueada (pipeline sim-1018)') => {
  const salida = execFileSync(sh, ['-c', comandoDeMarcarPr({ repo: e.repo, pr: 500, comentario })], { env: e.env, encoding: 'utf8', cwd: e.d }).trim()
  const ll = e.llamadas()
  return { salida, etiquetas: ll.filter((l) => l.startsWith('gh pr edit')), comentarios: ll.filter((l) => l.startsWith('gh pr comment')) }
}

for (const sh of shells) {
  test(`marcar PR (${sh}): a un PR que GitHub reporta MERGED no se le pone etiqueta ni comentario`, () => {
    const r = marcar(escenario({ estado: 'MERGED' }), sh)
    assert.equal(r.salida, 'YA_MERGEADO')
    assert.deepEqual(r.etiquetas, [])
    assert.deepEqual(r.comentarios, [])
  })

  test(`marcar PR (${sh}): abierto, lleva la etiqueta y el comentario tal cual, sin que el shell ejecute nada del motivo`, () => {
    const e = escenario({ estado: 'OPEN' })
    const motivo = "integración bloqueada: GraphQL: it's `touch pwned1` y $(touch pwned2) \"citado\"\notra línea (pipeline sim-1018)"
    const r = marcar(e, sh, motivo)
    assert.equal(r.salida, 'MARCADO')
    assert.equal(r.etiquetas.length, 1)
    assert.match(r.etiquetas[0], /--add-label merge-blocked/)
    assert.equal(readFileSync(join(e.d, 'cuerpo'), 'utf8'), motivo.replace('\n', ' '))
    assert.ok(!existsSync(join(e.d, 'pwned1')) && !existsSync(join(e.d, 'pwned2')))
  })

  test(`marcar PR (${sh}): si el estado no se puede leer, no se marca`, () => {
    const r = marcar(escenario({ estado: null }), sh)
    assert.equal(r.salida, 'ESTADO_ILEGIBLE')
    assert.deepEqual(r.etiquetas, [])
  })

  test(`marcar issue (${sh}): el motivo llega tal cual, sin que el shell ejecute nada`, () => {
    const e = escenario()
    const comentario = `pipeline sim-1018: publicación bloqueada: ${PELIGROSO}\notra línea.`
    execFileSync(sh, ['-c', comandoDeMarcarIssue({ repo: e.repo, issue: 207, comentario })], { env: e.env, cwd: e.d })
    assert.ok(e.llamadas().some((l) => l === 'gh issue edit 207 --add-label agent-blocked'))
    assert.equal(readFileSync(join(e.d, 'cuerpo-issue'), 'utf8'), comentario.replace('\n', ' '))
    assert.ok(sinEjecutar(e))
  })

  test(`publicar PR (${sh}): título y cuerpo de modelo llegan tal cual, sin que el shell ejecute nada`, () => {
    const e = escenario()
    const titulo = `feat: ${PELIGROSO} $(touch pwned3)`
    const cuerpo = `Closes #12\n\n${PELIGROSO}\n\n## Recursos verificados\n- tabla \`x\` — $(touch pwned3), 2026-10-18\n\nPR del pipeline sim. 🤖`
    execFileSync(sh, ['-c', comandoDePublicarPr({ worktree: e.wt, branch: 'review/sim-pr5', base: 'batch/sim', labels: ['afk-agent-pr', 'review-fix'], titulo, cuerpo, conHead: true })], { env: e.env, cwd: e.d })
    const ll = e.llamadas()
    assert.ok(ll.includes('git push -u origin review/sim-pr5'))
    assert.match(ll.find((l) => l.startsWith('gh pr create')), /^gh pr create --base batch\/sim --head review\/sim-pr5 --label afk-agent-pr --label review-fix --title /)
    assert.equal(readFileSync(join(e.d, 'titulo'), 'utf8'), titulo)
    assert.equal(readFileSync(join(e.d, 'cuerpo-pr'), 'utf8'), `${cuerpo}\n`)
    assert.ok(sinEjecutar(e))
  })
}

// ── Los comandos que el motor manda de verdad, sacados del prompt y corridos ──


// El comando de un paso del prompt: la línea que empieza con `cd <path> && ` + `inicio`.
// El path del mundo simulado no existe en disco: se cambia por el del escenario.
const comandoDelPrompt = (prompt, inicio, cd) => {
  const linea = prompt.split('\n').map((l) => l.trim()).find((l) => new RegExp(`^cd \\S+ && ${inicio}`).test(l))
  assert.ok(linea, `el prompt no trae el comando que empieza con ${inicio}`)
  return linea.replace(/^cd \S+ && /, `cd ${cd} && `)
}

test('publicar: el comando que el motor manda lleva el resumen del implementer tal cual al cuerpo del PR', async () => {
  const resumen = `implementé \`parsearPliego()\` con $(touch pwned1) y it's "ok"`
  const mundo = crearMundo({ issues: { 1: { titulo: 'feat: `touch pwned2` $(touch pwned3)' } } })
  const orig = mundo.responder.bind(mundo)
  mundo.responder = (prompt, opts) => {
    const r = orig(prompt, opts)
    return opts.label === 'implementer:#1' ? { ...r, resumen, recursos_verificados: ['tabla `pliegos` — $(touch pwned1), 2026-10-18'] } : r
  }
  const { llamadas } = await correrMotor({ mundo })
  const prompt = conLabel(llamadas, /^serializer:publish-i1$/)[0].prompt
  for (const sh of shells) {
    const e = escenario()
    execFileSync(sh, ['-c', comandoDelPrompt(prompt, 'git push -u origin issue-1', e.wt)], { env: e.env, cwd: e.d })
    assert.equal(readFileSync(join(e.d, 'titulo'), 'utf8'), 'feat: `touch pwned2` $(touch pwned3)', sh)
    const cuerpo = readFileSync(join(e.d, 'cuerpo-pr'), 'utf8')
    assert.match(cuerpo, /^Closes #1\n/, sh)
    assert.ok(cuerpo.includes(`\n${resumen}\n`), `${sh}: ${cuerpo}`)
    assert.ok(cuerpo.includes('\n## Recursos verificados\n- tabla `pliegos` — $(touch pwned1), 2026-10-18\n'), `${sh}: ${cuerpo}`)
    assert.match(cuerpo, /PR del pipeline sim-1018\. 🤖 Generated with \[Claude Code\]/, sh)
    assert.ok(sinEjecutar(e), sh)
  }
})

test('marcar issue: el comando que el motor manda lleva el rechazo de GitHub (con backticks) tal cual', async () => {
  const rechazo = 'remote rejected: refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope $(touch pwned1)'
  const mundo = crearMundo({ issues: { 207: {} }, fallas: { publicar: () => rechazo } })
  const { llamadas } = await correrMotor({ mundo })
  const prompt = conLabel(llamadas, /^serializer:block-i207$/)[0].prompt
  for (const sh of shells) {
    const e = escenario()
    execFileSync(sh, ['-c', comandoDelPrompt(prompt, 'gh issue edit 207', e.repo)], { env: e.env, cwd: e.d })
    assert.ok(readFileSync(join(e.d, 'cuerpo-issue'), 'utf8').includes(rechazo), sh)
    assert.ok(sinEjecutar(e), sh)
  }
})

test('publicar arreglos: los títulos que escribió el aplicador llegan tal cual al cuerpo del PR', async () => {
  const titulo = 'off-by-one en `contar()` y $(touch pwned1)'
  const mundo = crearMundo({ issues: { 1: {} } })
  mundo.hallazgos = (pr) => (pr === 500 ? [{ titulo, ubicacion: 'src/a.ts:3', severidad: 'media', por_que: 'x', fix: 'y', decision: 'aplicar', razon: 'bug real' }] : [])
  const { llamadas } = await correrMotor({ mundo })
  const prompt = conLabel(llamadas, /^serializer:publish-arreglos-pr500$/)[0].prompt
  for (const sh of shells) {
    const e = escenario()
    execFileSync(sh, ['-c', comandoDelPrompt(prompt, 'git push -u origin review/', e.wt)], { env: e.env, cwd: e.d })
    assert.ok(readFileSync(join(e.d, 'cuerpo-pr'), 'utf8').includes(`\n- ${titulo}\n`), sh)
    assert.ok(e.llamadas().find((l) => l.startsWith('gh pr create')).includes('--head review/sim-1018-pr500 --label afk-agent-pr --label review-fix'), sh)
    assert.ok(sinEjecutar(e), sh)
  }
})
