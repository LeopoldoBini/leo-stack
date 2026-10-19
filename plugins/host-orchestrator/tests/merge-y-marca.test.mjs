// Tests de los dos comandos de shell que deciden sobre un PR en el remoto:
//
//   scripts/mergear-pr.sh       el merge de un PR aprobado, con su reintento
//   comandoDeMarcarPr (motor)   la etiqueta merge-blocked, nunca sobre un PR MERGED
//
// Se corren de verdad, con bash (y zsh, el shell del Bash tool en la Mac), contra un
// `git`, un `gh` y un `sleep` falsos en el PATH que anotan cada llamada.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nucleoPuro } from './simulador.mjs'

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

const { comandoDeMarcarPr } = nucleoPuro(['comandoDeMarcarPr'])
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
}
