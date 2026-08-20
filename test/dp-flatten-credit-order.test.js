'use strict';

// Flatten credit ignores WHEN the refill arrives (traced live 2026-08-20 15:09 Amsterdam).
//
// pvKwhStorableFromT is a suffix sum over the whole horizon, so on a 33-hour plan it counts
// TOMORROW's sun. The flatten reads it as "PV refills the pack anyway, so the SoC arriving here
// is worthless" and collapses the SoC dimension of dp[] — even when a price peak sits between
// now and that refill. The battery then dumps its last kWh at the first slot above the discharge
// floor instead of holding it for the peak.
//
// Live instance: credit 5.57 kWh of which 5.47 kWh came from the next day (first strong-PV slot
// 21-08 08:00), against 2.58 kWh needed; today contributed 0.10 kWh. Result: discharge at €0.227
// while €0.375 sat 5.5 hours ahead and the stored energy had cost €0.315.
//
// The fix credits only PV that arrives strictly BEFORE the highest-priced slot still ahead.

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

const SETTINGS = {
  battery_efficiency: 0.733,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  tariff_model: 'saldering',
  dp_flatten_pv_shift: true, // live setting since 2026-08-17
};

const CAP = 2.69;
const POWER = 800;
const T0 = Date.now();
const H = 3_600_000;

// Late afternoon: today's PV is spent, the evening peak is still ahead, and tomorrow's PV only
// starts at idx 14. pvStrong = 400/800 = 0.5 coverage, so only the 1000 W slots count as storable.
//   idx 0-4   today, no usable PV      → gate can open
//   idx 5-6   evening peak €0.375      → the slots the last kWh should serve
//   idx 7-13  night                    → no PV
//   idx 14-18 tomorrow, 1000 W PV      → 5 × 0.8 = 4.0 kWh of "refill", all AFTER the peak
const PV_W = [
  120, 80, 40, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  1000, 1000, 1000, 1000, 1000, 0,
];
const CONS_W = [
  400, 400, 400, 400, 400,
  600, 600, 400, 300, 300, 300, 300, 300, 300,
  100, 100, 100, 100, 100, 300,
];
// Slot 0 at €0.227 is the cheapest slot the discharge floor still allows; €0.375 at idx 5-6 is
// the peak the battery should wait for. Tomorrow's own peak (idx 19) stays below it, so the
// highest-priced slot ahead is always the one BEFORE tomorrow's PV.
const PRICE = [
  0.227, 0.234, 0.245, 0.252, 0.271,
  0.375, 0.372, 0.300, 0.250, 0.220, 0.210, 0.205, 0.200, 0.210,
  0.150, 0.140, 0.130, 0.140, 0.160, 0.290,
];

const prices = PRICE.map((p, i) => ({ timestamp: new Date(T0 + i * H).toISOString(), price: p }));
const pvForecast = PV_W.map((w, i) => ({ timestamp: new Date(T0 + i * H).toISOString(), pvPowerW: w }));

function run() {
  const eng = new OptimizationEngine({ ...SETTINGS });
  eng.compute(prices, 4 /* SoC 4% */, CAP, POWER, POWER, pvForecast, 0.733, CONS_W,
    0 /* minDischargePrice */, 1.0 /* consumptionMargin */, 4.0 /* pvKwhTomorrow */,
    4.0 /* terminalPvKwh */, 1.0 /* pvCloudFactor */, 1.0 /* refillConfidence */,
    false /* pvTimingRobust */, 0 /* maxChargePrice → no forced top-up */);
  return { slots: eng._schedule.slots, debug: eng._flattenDebug };
}

// ── 1. The scenario really is the one under test ────────────────────────────
test('scenario check — every storable PV slot lies after the peak slot', () => {
  const peakIdx = PRICE.indexOf(Math.max(...PRICE));
  const firstStrongPv = PV_W.findIndex((w, i) => (w - CONS_W[i]) / POWER >= 0.5);
  assert.ok(firstStrongPv > peakIdx,
    `scenario broken: first strong-PV slot ${firstStrongPv} must come after peak slot ${peakIdx}`);
});

// ── 2. The bug: at the live SoC the DP values dumping above holding ─────────
// Asserted on the backward pass's own value comparison, not on the plan path: in this small
// scenario the post-DP reorder still moves the discharge to the peak, which the live run could
// not do (its reorder window was [0..3), far short of the peak). The defect is the collapsed
// value function, so that is what the test pins.
test('DP does not prefer discharging at slot 0 over holding for the peak', () => {
  const { debug } = run();
  assert.notStrictEqual(debug.chosenAction, 'discharge',
    `at €${PRICE[0]} with €${Math.max(...PRICE)} still ahead the DP must not prefer discharge `
    + `(vPreserve=${debug.vPreserve} vDischarge=${debug.vDischarge})`);
});

// ── 3. The mechanism: credit counted before the peak is what may drive it ───
test('flatten credit counts only PV arriving before the peak', () => {
  const { debug } = run();
  assert.ok(debug.pvKwhBeforePeak != null,
    'flatten debug must expose the order-checked credit (pvKwhBeforePeak)');
  assert.ok(debug.pvKwhBeforePeak < 0.01,
    `all storable PV arrives after the peak, so the credit must be ~0, got ${debug.pvKwhBeforePeak}`);
});

// ── 4. The gate is shut where the refill comes too late ────────────────────
// Only at slots BEFORE the peak: past it, tomorrow's PV does arrive ahead of tomorrow's own
// best price (idx 19), so firing there is correct under the new rule. On HEAD the flatten
// fired on all 13 open slots, slot 0 included.
test('flatten gate is shut at slot 0 and fires on fewer slots than before', () => {
  const { debug } = run();
  assert.strictEqual(debug.flattenGateOpen, false,
    'no storable PV lands before the peak, so the gate must be shut at slot 0');
  assert.ok(debug.flatFiredSlots < 13,
    `expected fewer firing slots than the 13 on HEAD, got ${debug.flatFiredSlots}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
