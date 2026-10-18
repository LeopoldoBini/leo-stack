// Tests del motor (workflows/prd-pipeline.js).
//
//   node --test plugins/host-orchestrator/tests/
//
// Dos niveles: las reglas puras, evaluadas sobre el bloque «NÚCLEO PURO» del
// motor, y corridas enteras del motor contra el mundo de mentira del simulador.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nucleoPuro, correrMotor, crearMundo, conLabel } from './simulador.mjs'

const P = nucleoPuro(['gate', 'lockfilesAjenos', 'aBaseline', 'tocaVedados', 'vetoDeWorkflows', 'crearRegistro'])

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
    alInvocar: (label, m) => { if (label === 'scout:w2') m.issue.get(4).labels.delete('agent-blocked') },
  })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^implementer:#4$/).length, 2)
  assert.equal(resultado.status, 'DONE')
})

test('merge que falla: el PR no se reintenta en cada wave, queda merge-blocked para Leo', async () => {
  const mundo = crearMundo({ issues: { 1: {} }, fallas: { merge: () => 'gh: required status check "ci" is failing' } })
  const { resultado, llamadas } = await correrMotor({ mundo })
  assert.equal(conLabel(llamadas, /^serializer:merge-pr/).length, 1)
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
