'use strict';

// Overnight PV-refill reserve: when the PV forecast is uncertain (low refillConfidence),
// the DP must hold a SoC buffer through overnight non-PV slots that precede a strong-PV
// refill, so the evening peak stays served if the next day's PV under-delivers. At full
// confidence the floor collapses to minSoc → behaviour identical to the no-param call.

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

// Full-day scenario starting at local midnight: overnight (0–6) moderate price,
// strong PV midday (9–15), evening peak (18–22). The night precedes the PV refill,
// so its slots are the ones the reserve should protect; the evening peak is after the
// last PV slot, so it must remain freely dischargeable regardless of confidence.
const base = new Date('2026-06-01T00:00:00+02:00').getTime();
const H = 3_600_000;
const prices = [], pv = [], cons = [];
for (let t = 0; t < 24; t++) {
  let p = 0.15;
  if (t >= 0 && t <= 6)  p = 0.20; // night, discharge-worthy
  if (t >= 18 && t <= 22) p = 0.45; // evening peak
  prices.push({ timestamp: new Date(base + t * H).toISOString(), price: p });
  pv.push({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: (t >= 9 && t <= 15) ? 3000 : 0 });
  cons.push(600);
}
const SETTINGS = { battery_efficiency: 0.90, min_soc: 10, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };

function run(refillConfidence) {
  const eng = new OptimizationEngine(SETTINGS);
  // compute(prices, soc, capacityKwh, maxChargeW, maxDischargeW, pv, rte, cons,
  //         minDischargePrice, consumptionMargin, pvKwhTomorrow, terminalPvKwhTomorrow,
  //         pvCloudFactor, refillConfidence)
  const args = [prices, 80, 5, 2000, 2000, pv, null, cons, 0, 1.0, 0, 0, 1.0];
  if (refillConfidence !== undefined) args.push(refillConfidence);
  eng.compute(...args);
  return eng._schedule.slots;
}

const nightMin = (slots) => Math.min(...slots.slice(0, 7).map(s => s.socProjected));

// ── Low confidence holds an overnight buffer above min_soc ───────────────────
test('low confidence → overnight SoC stays above min_soc floor', () => {
  const slots = run(0.0);
  // span = (100-10), reserve = 0.5*span = 45 → floor ≈ 55%. Allow grid rounding slack.
  assert.ok(nightMin(slots) >= 50,
    `expected overnight min ≥ 50%, got ${nightMin(slots).toFixed(1)}%`);
});

// ── Evening peak still fully served under low confidence ─────────────────────
test('low confidence → evening peak still discharges', () => {
  const slots = run(0.0);
  const evening = slots.slice(18, 23).map(s => s.action);
  assert.ok(evening.every(a => a === 'discharge'),
    `expected all evening slots to discharge, got ${evening.join(',')}`);
});

// ── High confidence drains overnight below the low-confidence floor ──────────
test('high confidence → overnight drains deeper than low confidence', () => {
  assert.ok(nightMin(run(1.0)) < nightMin(run(0.0)),
    'high-confidence overnight min should be below low-confidence min');
});

// ── Full confidence == default (no param): no behavioural change ─────────────
test('refillConfidence=1.0 identical to omitted param', () => {
  const a = run(1.0).map(s => `${s.action}:${s.socProjected.toFixed(1)}`).join('|');
  const b = run(undefined).map(s => `${s.action}:${s.socProjected.toFixed(1)}`).join('|');
  assert.strictEqual(a, b);
});

// ── Price-blind floor regression ─────────────────────────────────────────────
// Minimised live miss (shrunk from optimizer-properties invariant 15): a slot
// PRECEDES the PV window and is the strict price-max of the remaining horizon, yet
// the price-blind floor used to hold it back to insure a CHEAPER future. The reserve
// is only spendable after the PV window, so hoarding through this slot is strictly
// value-destroying regardless of how PV resolves — it must discharge.
//
// Horizon: [0.22, 0.22, PV, PV, 0.05]. Slot 1 (0.22) is the strict max ahead
// (everything after is ≤ 0.10). With a price-blind floor at confidence 0 the DP held
// slot 1; the price-aware floor must discharge it. Slot 0 (also 0.22, but 0.22 later
// equals it) may legitimately defer, so only slot 1 is asserted.
const RESERVE_SETTINGS = { battery_efficiency: 0.50, min_soc: 0, max_soc: 85, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
const base2 = new Date('2026-06-08T16:00:00+02:00').getTime();
const priceVals2 = [0.22, 0.22, 0.10, 0.10, 0.05];
const pvVals2    = [0, 0, 1200, 1200, 0]; // PV surplus ≥ charge power → strongPvAhead
const prices2 = priceVals2.map((p, t) => ({ timestamp: new Date(base2 + t * H).toISOString(), price: p }));
const pv2     = pvVals2.map((w, t) => ({ timestamp: new Date(base2 + t * H).toISOString(), pvPowerW: w }));
const cons2   = priceVals2.map(() => 500);

function run2(refillConfidence) {
  const eng = new OptimizationEngine(RESERVE_SETTINGS);
  eng.compute(prices2, 60, 1, 400, 400, pv2, null, cons2, 0, 1.0, 0, 0, 1.0, refillConfidence);
  return eng._schedule.slots;
}

test('low confidence → strict-max pre-PV slot still discharges (not hoarded)', () => {
  const slots = run2(0.0);
  assert.strictEqual(slots[1].action, 'discharge',
    `expected strict-max pre-PV slot to discharge, got ${slots[1].action}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
