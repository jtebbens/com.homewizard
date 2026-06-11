'use strict';

// Daily PV bias double-count regression (PV-pipeline-collapse chunk 2).
//
// The bug this guards: solar yield factors learn W_actual per W/m² of FORECAST
// radiation, so once converged (≥10 slots) they already absorb any systematic
// forecast bias. getDailyPvBiasFactor() then multiplied the same correction on
// top (clear-bucket EMA trained to 1.54 against best_match radiation), inflating
// clear-day forecasts ~50%. getRadiationBiasFactor() already had the convergence
// guard; getDailyPvBiasFactor() lacked it.

const assert = require('assert');
const LearningEngine = require('../lib/learning-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function makeEngine({ learnedSlots, data }) {
  const homey = { log: () => {} };
  const engine = new LearningEngine(homey, {});
  const yields = new Array(96).fill(null);
  for (let i = 0; i < learnedSlots; i++) yields[32 + i] = 0.8;
  engine.data = { solar_yield_factors: yields, ...data };
  return engine;
}

const clearBiasData = { pv_daily_bias_clear: 1.54, pv_daily_bias_clear_samples: 6 };

// ── Bug reproduction: converged yields + clear-bucket EMA 1.54 ───────────────
test('clear day (kt) with converged yields → factor 1.0, not 1.54', () => {
  const e = makeEngine({ learnedSlots: 20, data: clearBiasData });
  const f = e.getDailyPvBiasFactor(null, 0.70);
  assert.ok(f < 1.10, `expected <1.10, got ${f}`);
});

test('clear day (cloud% fallback) with converged yields → factor 1.0', () => {
  const e = makeEngine({ learnedSlots: 20, data: clearBiasData });
  const f = e.getDailyPvBiasFactor(10, null);
  assert.ok(f < 1.10, `expected <1.10, got ${f}`);
});

test('overcast bucket with converged yields → factor 1.0', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias_overcast: 0.70, pv_daily_bias_overcast_samples: 6 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(90, null), 1.0);
});

test('mixed-EMA fallback with converged yields → factor 1.0', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias: 1.30, pv_daily_bias_samples: 8 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(50, null), 1.0);
});

// ── Early-learning behaviour preserved: <10 slots → bias still applies ───────
test('clear day with only 5 learned slots → bias 1.54 still applies', () => {
  const e = makeEngine({ learnedSlots: 5, data: clearBiasData });
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.70), 1.54);
});

test('boundary: exactly 9 learned slots → bias applies, 10 → guard kicks in', () => {
  const e9 = makeEngine({ learnedSlots: 9, data: clearBiasData });
  assert.strictEqual(e9.getDailyPvBiasFactor(null, 0.70), 1.54);
  const e10 = makeEngine({ learnedSlots: 10, data: clearBiasData });
  assert.strictEqual(e10.getDailyPvBiasFactor(null, 0.70), 1.0);
});

// ── No samples → neutral regardless of yield state ───────────────────────────
test('no bias samples, few yields → 1.0', () => {
  const e = makeEngine({ learnedSlots: 3, data: {} });
  assert.strictEqual(e.getDailyPvBiasFactor(10, null), 1.0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
