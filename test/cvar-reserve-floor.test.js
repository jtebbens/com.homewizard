'use strict';

// CVaR refill-reserve floor height (dp_cvar_reserve).
//
// The legacy height is (1 - refillConfidence) * 0.5 * span, which INVERTS: more forecast
// uncertainty raises the floor, so it ends up above the post-peak SoC and never binds
// (measured: all ~64 live runs at floor 24-38% held 0.00 kWh). The CVaR height instead asks
// what the evening needs that PV will plausibly fail to deliver, so demonstrable coverage
// collapses it to zero and a genuinely uncovered evening raises it.
//
// These tests pin the closed form. The behavioural guards (monotonicity under coverage and
// under spread) live as properties 55/56 in test/optimizer-properties.test.js.

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`[${name}] ... PASS`);
  } catch (err) {
    failed++;
    console.log(`[${name}] ... FAIL`);
    console.log(`  ${err.message}`);
  }
}

// 2.688 kWh pack, min_soc 0 / max_soc 100 → usable span == capacity.
const CAP = 2.688;
const GRID_TOTAL = 1000;
const base = {
  usableSpanKwh: CAP,
  capacityKwh: CAP,
  gridTotal: GRID_TOTAL,
  maxFrac: 0.5,
};
const addG = over => OptimizationEngine.cvarReserveAddG({ ...base, ...over });
const pct = g => (g / GRID_TOTAL) * 100;

test('coverage far above the evening need → floor collapses to zero', () => {
  // 6 kWh of storable PV against a 1.5 kWh evening: even a deep CVaR haircut leaves plenty.
  const g = addG({ eveningNeedKwh: 1.5, refillMeanKwh: 6.0 });
  assert.strictEqual(g, 0, `expected no floor, got ${pct(g).toFixed(1)}%`);
});

test('no refill at all → floor covers the evening need, capped at maxFrac of span', () => {
  const g = addG({ eveningNeedKwh: 2.0, refillMeanKwh: 0 });
  // need 2.0 kWh > maxFrac * span (1.344) → clamped
  assert.strictEqual(g, Math.round((0.5 * CAP / CAP) * GRID_TOTAL), `got ${pct(g).toFixed(1)}%`);
});

test('uncovered evening below the cap is passed through, not clamped', () => {
  const g = addG({ eveningNeedKwh: 0.5, refillMeanKwh: 0 });
  assert.strictEqual(g, Math.round((0.5 / CAP) * GRID_TOTAL), `got ${pct(g).toFixed(1)}%`);
});

test('a wider downside sigma raises the floor when coverage is marginal', () => {
  const marginal = { eveningNeedKwh: 2.0, refillMeanKwh: 2.0 };
  const lo = addG({ ...marginal, sigmaRel: 0.01 });
  const hi = addG({ ...marginal, sigmaRel: 0.20 });
  assert.ok(hi > lo, `sigma 0.20 (${pct(hi).toFixed(1)}%) must exceed sigma 0.01 (${pct(lo).toFixed(1)}%)`);
});

test('the fitted sigma leaves a margin: need == refill still reserves something', () => {
  // Downside semi-deviation 0.038 at k=1.40 is a ~5.3% haircut on the forecast refill, so an
  // evening exactly covered on the point estimate is NOT treated as covered.
  const g = addG({ eveningNeedKwh: 2.0, refillMeanKwh: 2.0 });
  assert.ok(g > 0, 'a marginally covered evening must still reserve');
  assert.ok(pct(g) < 10, `margin must stay small, got ${pct(g).toFixed(1)}%`);
});

test('more coverage never raises the floor (monotone in refill)', () => {
  const fixed = { eveningNeedKwh: 2.0 };
  let prev = Infinity;
  for (const refillMeanKwh of [0, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0]) {
    const g = addG({ ...fixed, refillMeanKwh });
    assert.ok(g <= prev, `refill ${refillMeanKwh} raised the floor (${pct(g).toFixed(1)}% > ${pct(prev).toFixed(1)}%)`);
    prev = g;
  }
});

test('k = 0 is risk-neutral: the point estimate, no insurance margin', () => {
  // need == refill exactly → a risk-neutral reserve is zero however wide the spread.
  const g = addG({ eveningNeedKwh: 2.0, refillMeanKwh: 2.0, k: 0 });
  assert.strictEqual(g, 0, `k=0 must not reserve anything, got ${pct(g).toFixed(1)}%`);
});

test('deeper k reserves more', () => {
  const s = { eveningNeedKwh: 2.0, refillMeanKwh: 2.0 };
  assert.ok(addG({ ...s, k: 1.76 }) > addG({ ...s, k: 0.80 }), 'worst-10% must reserve more than worst-50%');
});

test('no evening need → no floor, whatever the forecast says', () => {
  assert.strictEqual(addG({ eveningNeedKwh: 0, refillMeanKwh: 0 }), 0);
});

test('degenerate inputs return 0 rather than NaN', () => {
  assert.strictEqual(addG({ eveningNeedKwh: 2, refillMeanKwh: 1, usableSpanKwh: 0 }), 0);
  assert.strictEqual(addG({ eveningNeedKwh: 2, refillMeanKwh: 1, capacityKwh: 0 }), 0);
});

// ── flag wiring ───────────────────────────────────────────────────────────────────────

test('dp_cvar_reserve defaults to off and is flippable via updateSettings', () => {
  const e = new OptimizationEngine({});
  assert.strictEqual(e.cvarReserve, false, 'must default to off');
  e.updateSettings({ dp_cvar_reserve: true });
  assert.strictEqual(e.cvarReserve, true, 'updateSettings must mirror the flag');
  assert.strictEqual(new OptimizationEngine({ dp_cvar_reserve: true }).cvarReserve, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
