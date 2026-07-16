'use strict';

// Central SoC source guard: a WebSocket re-init briefly reports SoC=0% while the real SoC is
// high (88→0, 97→0 in one sample). sanitizeSoc rejects that collapse-to-zero at the source so
// every downstream consumer (CostModel RESET, policy cost-reset, SmartLowSoC, reserve-floor
// trigger, SoC-history) sees a sanitised value. See lib/soc-glitch-guard.js.

const assert = require('assert');
const { sanitizeSoc, createState } = require('../lib/soc-glitch-guard');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Feed a sequence of raw SoC values through one shared state; return the sanitised outputs.
function run(seq, opts = {}) {
  const state = createState();
  return seq.map(raw => sanitizeSoc(raw, state, opts).soc);
}

console.log('\nSoC source glitch guard:');

test('glitch 88→0 in one sample is held at 88', () => {
  assert.deepStrictEqual(run([88, 0]), [88, 88]);
});

test('persisted low (0,0,0) accepts as real after maxHoldSamples', () => {
  assert.deepStrictEqual(run([88, 0, 0, 0], { maxHoldSamples: 3 }), [88, 88, 88, 0]);
});

test('gradual drain 8→5→3→1→0 passes through unchanged (no false hold)', () => {
  assert.deepStrictEqual(run([8, 5, 3, 1, 0]), [8, 5, 3, 1, 0]);
});

test('transient glitch 88→0→88 recovers to 88', () => {
  assert.deepStrictEqual(run([88, 0, 88]), [88, 88, 88]);
});

test('first sample seeds without judging (even a low first read)', () => {
  assert.deepStrictEqual(run([2, 50]), [2, 50]);
});

test('null passes through untouched (downstream ?? 50 fallback preserved)', () => {
  const state = createState();
  assert.strictEqual(sanitizeSoc(null, state).soc, null);
  // and does not corrupt the running last-valid
  assert.strictEqual(sanitizeSoc(80, state).soc, 80);
  assert.strictEqual(sanitizeSoc(0, state).soc, 80);
});

test('minSoc raises the collapse threshold (minSoc=5 → raw 5 from high is a glitch)', () => {
  assert.deepStrictEqual(run([90, 5], { minSoc: 5 }), [90, 90]);
});

test('97→0 glitch (second observed case) is held', () => {
  assert.deepStrictEqual(run([97, 0]), [97, 97]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
