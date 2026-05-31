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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
