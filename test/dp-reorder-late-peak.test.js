'use strict';

// Reproduction — live miss 2026-06-08 16:45 run (app v3.15.103).
// Non-monotone evening peak: the battery (1× 2.69 kWh) cannot cover the whole
// 17:00→22:00 ramp. The backward-DP forward pass discharged the FIVE EARLIEST
// eligible slots chronologically (17:00 €0.284 … 20:00 €0.383) draining to 0% by
// 21:00, leaving 21:00 €0.359 — the THIRD-highest price in the window — as preserve.
//
// The post-DP price-reorder (optimization-engine.js ~283) exists to fix exactly this:
// it should reassign discharge to the highest-priced eligible slots {18,19,20,21,22}
// and DROP the cheaper 17:00. Observed live: it did not — 21:00 stayed preserve while
// cheaper 17:00 discharged. Strict economic-dominance violation: a cheaper slot
// discharges while a strictly-pricier eligible slot in the same window is held.
//
// This test must FAIL before the fix and PASS after.

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

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

const H = 3_600_000;
// On-hour start 17:00 local (active slot t0 has PV<cons → pvCoverage[0]==0, matching the
// live 16:45 run where the morning-block gate must NOT fire).
const base = new Date('2026-06-08T17:00:00+02:00').getTime();

// Hour-by-hour values transcribed from the live diagnose planning table (17:00 → +1 23:00).
const priceVals = [
  0.284, 0.308, 0.362, 0.383, 0.359, 0.322, 0.282, 0.280, 0.272, 0.263, 0.258,
  0.256, 0.262, 0.281, 0.288, 0.277, 0.249, 0.218, 0.195, 0.159, 0.137, 0.133,
  0.134, 0.163, 0.212, 0.259, 0.284, 0.311, 0.319, 0.308, 0.287,
];
const pvVals = [
  460, 237, 41, 27, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 34, 285, 820, 2736, 2409, 3097, 1582, 1628, 2372,
  1719, 859, 573, 369, 239, 351, 0, 0, 0,
];
const consVals = [
  549, 555, 560, 500, 659, 679, 793, 697, 691, 611, 800,
  1008, 380, 375, 373, 396, 460, 528, 581, 570, 872, 586,
  927, 523, 472, 636, 441, 462, 558, 684, 857,
];

const prices = priceVals.map((p, t) => ({ timestamp: new Date(base + t * H).toISOString(), price: p }));
const pv     = pvVals.map((w, t)   => ({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: w }));
const cons   = consVals.slice();

// Live config: 1× 2.69 kWh, 800/800 W, RTE 0.729, cycle €0.075, min 0 / max 100, saldering.
const SETTINGS = {
  battery_efficiency: 0.7288981736991123,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
};
const MIN_DISCHARGE_PRICE = 0.220;
const PV_CLOUD_FACTOR = 0.88;

function run() {
  const eng = new OptimizationEngine(SETTINGS);
  // compute(prices, soc, capacityKwh, maxChargeW, maxDischargeW, pv, rte, cons,
  //         minDischargePrice, consumptionMargin, pvKwhTomorrow, terminalPvKwhTomorrow,
  //         pvCloudFactor, refillConfidence)
  // pvKwhTomorrow=0 (cloudy, below threshold), refillConfidence=1.0 (no reserve hold → drains to 0%, as live).
  eng.compute(prices, 89, 2.69, 800, 800, pv, null, cons,
    MIN_DISCHARGE_PRICE, 1.0, 0, 0, PV_CLOUD_FACTOR, 1.0);
  return eng._schedule.slots;
}

const slots = run();
const dump = slots.slice(0, 7)
  .map((s, t) => `${new Date(base + t * H).getUTCHours()}h €${s.price.toFixed(3)} ${s.action} ${s.socProjected.toFixed(0)}%`)
  .join(' | ');
console.log('  evening window:', dump);

// Index 4 = 21:00 €0.359, the 3rd-highest price in the 17:00–22:00 window.
const LATE_PEAK = 4;

// ── Economic-dominance invariant ─────────────────────────────────────────────
// 21:00 €0.359 is strictly pricier than 17:00 €0.284 / 18:00 €0.308 which the DP
// discharged. Under a fixed energy budget, no cheaper eligible slot in the window
// may discharge while this strictly-pricier eligible slot is held in preserve.
test('strict-max-ahead: 21:00 (€0.359) not held while cheaper slots discharge', () => {
  const cheaperDischarges = slots.slice(0, LATE_PEAK).some(
    (s) => s.action === 'discharge' && s.price < slots[LATE_PEAK].price);
  if (cheaperDischarges) {
    assert.strictEqual(slots[LATE_PEAK].action, 'discharge',
      `21:00 €${slots[LATE_PEAK].price.toFixed(3)} is preserve while a cheaper slot discharges — ` +
      `reorder failed to lift discharge to the pricier slot`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
