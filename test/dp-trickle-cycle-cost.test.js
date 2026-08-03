'use strict';

// Regression: the forward pass answered "is storing this PV surplus better than exporting it?"
// twice — once for the pvStoreWins override (optimization-engine.js:337-339) and once for the
// weak-PV trickle branch (:371). ba3ee05 netted cycle cost off the first but missed the second,
// so trickle kept firing on spreads the store-vs-export gate already rejected.
//
// Live 2026-08-03 plan for the next afternoon: peak €0.396, RTE 0.7300 → the trickle branch
// compared €0.289 against the slot price and charged at €0.269-0.276, while the same plan
// flagged €0.296 as pvExportWins. Netting wear moves that boundary to €0.214, so all three
// slots should have exported.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// t0 carries a real PV surplus; the only future peak is t2. No downstream pvStrong slot, so
// trickleSuffixMaxPrice keeps its value instead of being zeroed.
//   raw   : 0.40 × 0.72 = €0.288 > price €0.27  → trickle (the bug)
//   netted: 0.288 − 0.075 = €0.213 < €0.27      → export
function run(peakPrice) {
  const oe = new OE({ battery_efficiency: 0.72, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 });
  const base = new Date('2026-08-04T12:00:00.000Z').getTime();
  const mk = (h, price) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), price });
  const prices = [mk(0, 0.27), mk(1, 0.30), mk(2, peakPrice), mk(3, 0.10), mk(4, 0.10), mk(5, 0.10)];
  const pv = [700, 0, 0, 0, 0, 0];
  const pvF = pv.map((w, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: w }));
  const cons = [50, 50, 50, 50, 50, 50];
  oe.compute(prices, 50, 2.688, 800, 800, pvF, 0.72, cons, 0.10, 1.0, 0, 0, 0.60, 1.0);
  return oe._schedule.slots;
}

console.log('\nOptimizationEngine — weak-PV trickle must price battery wear\n');

test('thin spread does not trickle once cycle cost is netted', () => {
  const t0 = run(0.40)[0];
  assert.ok(t0.pvCoverage > 0, `precondition: PV surplus present, got cov=${t0.pvCoverage}`);
  assert.ok(t0.pvTrickleMaxValue > 0,
    `precondition: trickle cap alive (no downstream pvStrong), got ${t0.pvTrickleMaxValue}`);
  // The raw comparison the branch used to make: 0.288 > 0.27 → would trickle.
  assert.ok(t0.pvTrickleMaxValue > t0.price,
    `precondition: raw store €${t0.pvTrickleMaxValue?.toFixed(3)} beats price €${t0.price} — without this the test proves nothing`);
  // THE BUG: wear (€0.075) exceeds the €0.018 spread, so this must not charge.
  assert.notStrictEqual(t0.action, 'trickle',
    `Expected export, got trickle: raw €${t0.pvTrickleMaxValue?.toFixed(3)} vs price €${t0.price}, netted €${(t0.pvTrickleMaxValue - 0.075).toFixed(3)}`);
});

test('fat spread still trickles', () => {
  const t0 = run(0.70)[0];
  // 0.70 × 0.72 − 0.075 = €0.429, comfortably above €0.27 — the fix must not disable trickle.
  assert.ok(t0.pvCoverage > 0, `precondition: PV surplus present, got cov=${t0.pvCoverage}`);
  assert.strictEqual(t0.action, 'trickle',
    `Expected trickle on a fat spread, got '${t0.action}'`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
