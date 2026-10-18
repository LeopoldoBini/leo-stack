// Tests del motor (workflows/prd-pipeline.js).
//
//   node --test plugins/host-orchestrator/tests/
//
// Dos niveles: las reglas puras, evaluadas sobre el bloque «NÚCLEO PURO» del
// motor, y corridas enteras del motor contra el mundo de mentira del simulador.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nucleoPuro, correrMotor, crearMundo, conLabel } from './simulador.mjs'

const P = nucleoPuro(['gate', 'lockfilesAjenos', 'aBaseline'])

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
