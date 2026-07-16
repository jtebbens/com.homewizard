'use strict';

// Topup forward-sim: the backward pass prices the lowSocGridTopUp heuristic
// (preserve/standby at a cheap firing slot with SoC < 40% is valued as a forced
// grid charge), so the forward pass must simulate the same SoC rise. Without it
// the projected trajectory diverges from the valued path and from the runtime,
// which really does charge (policy-engine lowSocGridTopUp → to_full).

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
const SETTINGS = { battery_efficiency: 0.90, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };

// 12 night slots, no PV. Slot 1 (€0.10) is ≤ maxChargePrice (€0.15) and the
// cheapest of the next 8h → topupFiringSlots[1] fires. Discharge is blocked
// everywhere (minDischargePrice €0.20) and charging is not profitable on its own
// (future prices €0.12, terminal value ~€0.09/kWh < €0.10 cost), so the DP's own
// optimum at slot 1 is preserve — exactly the case where the runtime heuristic
// overrides with a forced grid top-up.
function buildScenario(priceVals) {
  const base = new Date('2026-06-01T00:00:00+02:00').getTime();
  return priceVals.map((p, t) => ({ timestamp: new Date(base + t * H).toISOString(), price: p }));
}
const priceVals = [0.14, 0.10, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12];

// compute(prices, soc, capKwh, maxChargeW, maxDischargeW, pv, rte, cons,
//         minDischargePrice, consumptionMargin, pvKwhTomorrow, terminalPvKwhTomorrow,
//         pvCloudFactor, refillConfidence, pvTimingRobust, maxChargePrice)
function run({ soc = 20, maxChargePrice = 0.15, prices = buildScenario(priceVals) } = {}) {
  const eng = new OptimizationEngine(SETTINGS);
  const cons = prices.map(() => 500);
  eng.compute(prices, soc, 5, 2000, 2000, null, null, cons,
    0.20, 1.0, 0, 0, 1.0, 1.0, false, maxChargePrice);
  return eng._schedule.slots;
}

// chargeSocDeltaG = 2000W × 1h / 5kWh = 40% per slot → 20% → 60% at the firing slot.

test('firing slot below 40% SoC → forward pass simulates forced top-up', () => {
  const slots = run();
  assert.strictEqual(slots[1].topupForced, true,
    `expected topupForced on slot 1, got ${slots[1].topupForced} (action=${slots[1].action})`);
  assert.ok(slots[2].socProjected > slots[1].socProjected + 30,
    `expected SoC to rise ~40% across the firing slot, got ${slots[1].socProjected}% → ${slots[2].socProjected}%`);
});

test('forced top-up reports actionKwh and keeps the preserve label', () => {
  const slots = run();
  assert.strictEqual(slots[1].action, 'preserve');
  assert.ok(slots[1].actionKwh > 1.5 && slots[1].actionKwh <= 2.0,
    `expected ~2 kWh charged, got ${slots[1].actionKwh}`);
});

test('SoC ≥ 40% at the firing slot → no forced top-up', () => {
  const slots = run({ soc: 60 });
  assert.ok(!slots[1].topupForced, 'no topupForced expected at 60% SoC');
  assert.strictEqual(slots[2].socProjected, slots[1].socProjected,
    'SoC must stay flat across the slot');
});

test('maxChargePrice=0 disables the heuristic entirely', () => {
  const slots = run({ maxChargePrice: 0 });
  assert.ok(!slots[1].topupForced, 'no topupForced expected with maxChargePrice=0');
  assert.strictEqual(slots[2].socProjected, slots[1].socProjected,
    'SoC must stay flat across the slot');
});

test('negative-price preserve slot → no forced top-up (runtime early-outs to standby)', () => {
  // Slot 1 negative: still "fires" per the topup mirror (price ≤ maxChargePrice,
  // cheapest ahead), but the runtime preserve branch returns standby before the
  // top-up check at negative prices — the forward sim must mirror that.
  const negPrices = buildScenario([0.14, -0.05, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12]);
  const slots = run({ prices: negPrices });
  if (slots[1].action === 'preserve') {
    assert.ok(!slots[1].topupForced, 'no topupForced expected at negative price');
  }
});

test('only the cheapest-ahead slot fires, not every slot under maxChargePrice', () => {
  const slots = run();
  // Slot 0 (€0.14 ≤ maxChargePrice) has a cheaper slot within 8h → must not fire.
  assert.ok(!slots[0].topupForced, 'slot 0 must not topup (cheaper slot ahead)');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
