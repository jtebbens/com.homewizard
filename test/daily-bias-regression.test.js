'use strict';

// Daily PV bias per weather type.
//
// Yield factors are a single per-slot EMA blending all weather types. They capture
// the average panel efficiency but miss the weather-type residual: clear days have
// higher effective yf (more direct beam on tilted panels), overcast days lower.
// getDailyPvBiasFactor() corrects this with per-weather-type EMA ratios
// (actual/predicted), classified by KNMI clearness index (kt) or OM cloud%.
//
// Previously guarded by ≥10 yield slots (double-count concern). That guard was
// removed because yield factors capture the AVERAGE, daily bias captures the
// DEVIATION from that average — independent corrections, not double-counting.

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

const clearBiasData = { pv_daily_bias_clear: 1.08, pv_daily_bias_clear_samples: 6 };

// ── Weather-type bias applies regardless of yield convergence ───────────────
test('clear day (kt) with converged yields → clear bias applied', () => {
  const e = makeEngine({ learnedSlots: 20, data: clearBiasData });
  const f = e.getDailyPvBiasFactor(null, 0.70);
  assert.strictEqual(f, 1.08);
});

test('clear day (cloud% fallback) with converged yields → clear bias applied', () => {
  const e = makeEngine({ learnedSlots: 20, data: clearBiasData });
  const f = e.getDailyPvBiasFactor(10, null);
  assert.strictEqual(f, 1.08);
});

test('overcast bucket with converged yields → overcast bias applied', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias_overcast: 0.92, pv_daily_bias_overcast_samples: 6 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(90, null), 0.92);
});

test('mixed-EMA fallback with converged yields → mixed bias applied', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias: 1.05, pv_daily_bias_samples: 8 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(50, null), 1.05);
});

// ── Early-learning behaviour preserved: <10 slots → bias still applies ───────
test('clear day with only 5 learned slots → bias still applies', () => {
  const e = makeEngine({ learnedSlots: 5, data: clearBiasData });
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.70), 1.08);
});

test('yield convergence irrelevant — bias applies at any slot count', () => {
  const e5 = makeEngine({ learnedSlots: 5, data: clearBiasData });
  const e20 = makeEngine({ learnedSlots: 20, data: clearBiasData });
  assert.strictEqual(e5.getDailyPvBiasFactor(null, 0.70), e20.getDailyPvBiasFactor(null, 0.70));
});

// ── No samples → neutral regardless of yield state ───────────────────────────
test('no bias samples → 1.0', () => {
  const e = makeEngine({ learnedSlots: 20, data: {} });
  assert.strictEqual(e.getDailyPvBiasFactor(10, null), 1.0);
});

// ── kt classification thresholds ─────────────────────────────────────────────
test('kt 0.65 = clear boundary', () => {
  const e = makeEngine({ learnedSlots: 20, data: clearBiasData });
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.65), 1.08);
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.64), 1.0); // falls to mixed (no samples → 1.0)
});

test('kt < 0.30 = overcast', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias_overcast: 0.90, pv_daily_bias_overcast_samples: 5 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.29), 0.90);
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.30), 1.0); // mixed, no samples
});

// ── Sample threshold: <5 samples → neutral ──────────────────────────────────
test('clear bucket with <5 samples → 1.0 (insufficient data)', () => {
  const e = makeEngine({
    learnedSlots: 20,
    data: { pv_daily_bias_clear: 1.20, pv_daily_bias_clear_samples: 4 },
  });
  assert.strictEqual(e.getDailyPvBiasFactor(null, 0.70), 1.0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
