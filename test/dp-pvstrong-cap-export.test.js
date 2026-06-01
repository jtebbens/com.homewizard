'use strict';

// Regression: an afternoon slot with a weak-but-real PV surplus must NOT be flagged
// pvExportWins when a reachable future peak makes storing more valuable than exporting,
// even if the NEXT slot is pvStrong (which resets trickleSuffixMaxPrice to 0).
//
// Live bug (2026-06-01 14:00): the cloud/uncertainty haircut (pvCloudFactor ≈ 0.60) pushed
// the slot's pvCoverage just under pvStrongCoverage (0.5), so pvStoreWins was blocked. The
// downstream 15:00 pvStrong hour zeroed trickleSuffixMaxPrice, so pvTrickle was also blocked.
// Result: pvExportWins=true → runtime refused to charge from a live 2069W surplus and exported
// 1.7 kWh, even though the uncapped store value (evening peak × RTE = €0.374) beat the price
// (€0.25) and the battery never saturated (plan peaked at 85%). The trickle cap wrongly assumed
// the pvStrong refill would fill the battery, making the post-peak unreachable.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function run() {
  const oe = new OE({ battery_efficiency: 0.72, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 });
  const base = new Date('2026-06-01T12:00:00.000Z').getTime();
  const mk = (h, price) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), price });
  // t0 afternoon weak-PV (cloud), t1 pvStrong-but-modest refill, t2 evening peak, then low.
  const prices = [mk(0, 0.25), mk(1, 0.26), mk(2, 0.52), mk(3, 0.10), mk(4, 0.10), mk(5, 0.10)];
  const pv = [700, 1200, 0, 0, 0, 0];
  const pvF = pv.map((w, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: w }));
  const cons = [50, 50, 50, 50, 50, 50];
  // pvCloudFactor = 0.60 (uncertainty haircut), starting SoC 50% (battery has room at the peak).
  oe.compute(prices, 50, 2.688, 800, 800, pvF, 0.72, cons, 0.10, 1.0, 0, 0, 0.60, 1.0);
  return oe._schedule.slots;
}

console.log('\nOptimizationEngine — pvStrong cap must not force export of a reachable surplus\n');

test('afternoon surplus with reachable peak is not flagged pvExportWins (cloud haircut + downstream pvStrong)', () => {
  const slots = run();
  const t0 = slots[0];
  // Preconditions reproducing the live trap:
  assert.ok(t0.pvCoverage > 0 && t0.pvCoverage < 0.5,
    `precondition: weak surplus, cov in (0,0.5), got ${t0.pvCoverage.toFixed(3)}`);
  assert.ok((t0.pvStoreValue ?? 0) > t0.price,
    `precondition: uncapped store beats price, got store=${(t0.pvStoreValue ?? 0).toFixed(3)} vs price=${t0.price}`);
  assert.strictEqual(t0.pvTrickleMaxValue, 0,
    `precondition: trickle cap zeroed by downstream pvStrong, got ${t0.pvTrickleMaxValue}`);
  // Battery is not saturated before/at the peak → the surplus is reachable, storing wins.
  const peak = slots[2];
  assert.ok(peak.socProjected < 99,
    `precondition: battery has room at peak, got ${peak.socProjected.toFixed(1)}%`);
  // THE BUG: storing beats exporting, yet the slot is flagged export.
  assert.strictEqual(t0.pvExportWins, false,
    `Expected NOT pvExportWins (store €${(t0.pvStoreValue ?? 0).toFixed(3)} > price €${t0.price}, battery not full), got pvExportWins=true → live surplus exported`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
