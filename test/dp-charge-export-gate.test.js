'use strict';

// Reproduction — live miss 2026-08-20 11:45 CEST (app v3.19.1, branch feat/sat-accuracy-diag).
// Arrays transcribed verbatim from the live policy_optimizer_schedule of the 11:15Z run
// (43 × 15-min slots, 11:15Z → 21:45Z).
//
// What happened: the DP emitted 'charge' on the 11:45 slot (€0.1998, pvCoverage 0.886) and the
// runtime mapper took its `price <= maxChargePrice` shortcut:
//   [MAPPING][CHARGE] cheap hour €0.200 <= max_charge_price €0.206 -> to_full
//   Successfully applied: to_full          (SoC 0% -> 2%)
// The sum on that slot: buy 0.200 kWh at €0.1998 = €0.0400; return 0.72 × 0.200 kWh at the
// €0.3753 evening peak = €0.0540; cycle cost 0.075 × 0.200 = €0.0150 -> net -€0.0010.
//
// The same store-vs-export test that this slot fails (store €0.195 <= export €0.200) DID veto
// 11:30, 12:15 and 14:00 in the very same schedule. It never runs on charge slots: in
// optimization-engine.js the pvStoreWins / pvTrickle / pvExportWins overrides are all gated on
// `code === 3` (standby), so `code === 1` (charge) is never tested.
//
// Second symptom, same root cause: the forward pass advances socG off `code`, not off `action`
// (optimization-engine.js ~:518), so the three vetoed charge slots still raised socProjected.
// The stored plan peaked at 29.6% while only the one executed slot is worth 7.4% — 22.2pp phantom.
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

const Q = 900_000; // 15 min
const base = new Date('2026-08-20T11:15:00Z').getTime();

const priceVals = [
  0.2167, 0.2084, 0.1998, 0.2128, 0.2114, 0.2206, 0.2206, 0.2265, 0.2342, 0.245, 0.2515, 0.2193,
  0.248, 0.2707, 0.2877, 0.2797, 0.2925, 0.3122, 0.3257, 0.3019, 0.3197, 0.3444, 0.3468, 0.3452,
  0.3571, 0.3637, 0.3752, 0.3669, 0.3713, 0.3743, 0.3753, 0.3737, 0.3701, 0.3669, 0.3598, 0.3652,
  0.3608, 0.3584, 0.3488, 0.3488, 0.3439, 0.3377, 0.3306,
];
const pvVals = [
  967, 1055, 1144, 1232, 1019, 806, 593, 380, 496, 612, 727, 843,
  740, 637, 533, 430, 382, 333, 285, 236, 221, 206, 191, 176,
  132, 88, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0,
];
const consVals = [
  400, 416, 435, 430, 599, 488, 431, 392, 396, 398, 300, 389,
  397, 387, 344, 338, 425, 411, 377, 345, 342, 348, 345, 333,
  326, 311, 328, 303, 289, 302, 302, 349, 356, 357, 366, 369,
  463, 350, 345, 323, 300, 308, 317,
];

assert.strictEqual(priceVals.length, pvVals.length);
assert.strictEqual(priceVals.length, consVals.length);

const prices = priceVals.map((p, t) => ({ timestamp: new Date(base + t * Q).toISOString(), price: p }));
const pv     = pvVals.map((w, t)   => ({ timestamp: new Date(base + t * Q).toISOString(), pvPowerW: w }));
const cons   = consVals.slice();

// Live device settings, read off the Homey on 2026-08-20 (min_discharge_price 0.22,
// respect_minmax false -> the DP floor resolves to cycle_cost / efficiency = 0.104).
// dp_flatten_pv_shift is the live value since 2026-08-17 12:00 CEST, not the schema default.
const SETTINGS = {
  battery_efficiency: 0.72,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  dp_flatten_pv_shift: true,
};
const MIN_DISCHARGE_PRICE = 0.104;
const MAX_CHARGE_PRICE    = 0.206; // dynamic ceiling from the live [MAPPING] line
const PV_KWH_TOMORROW     = 5.8;   // "SHADOW[... pvTom=5.8kWh conf=0.88 ...]"
const TERMINAL_PV_KWH     = 5.8;
const REFILL_CONFIDENCE   = 0.88;

function run() {
  const eng = new OptimizationEngine(SETTINGS);
  eng.compute(prices, 0, 2.688, 800, 800, pv, null, cons,
    MIN_DISCHARGE_PRICE, 1.15, PV_KWH_TOMORROW, TERMINAL_PV_KWH, 1.0,
    REFILL_CONFIDENCE, false, MAX_CHARGE_PRICE);
  return eng._schedule.slots;
}

const slots = run();

const label = (t) => new Date(base + t * Q).toLocaleTimeString('nl-NL',
  { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

const charges = slots
  .map((s, t) => ({ t, ...s }))
  .filter((s) => s.action === 'charge');
console.log('  charge slots:',
  charges.map((s) => `${label(s.t)} €${s.price.toFixed(3)} store€${(s.pvStoreValue ?? 0).toFixed(3)}`).join(' | ') || '(none)');

// ── Mechanism invariant ──────────────────────────────────────────────────────
// A charge slot with PV on it stores energy that could otherwise have been exported.
// Under saldering export earns the slot price, so charging is only defensible when the
// store value (best reachable future price × RTE − cycle cost) exceeds that price.
// pvStoreValue is the DP's own number, the same one both mappers read.
test('no charge on a PV slot where storing is worth less than exporting', () => {
  const bad = charges.filter((s) => s.pvCoverage > 0
    && s.pvStoreValue != null
    && s.pvStoreValue <= s.price);
  if (bad.length === 0) return;
  const worst = bad.reduce((a, b) => (a.price - a.pvStoreValue > b.price - b.pvStoreValue ? a : b));
  assert.fail(
    `${bad.length} charge slot(s) below break-even, worst ${label(worst.t)}: ` +
    `store €${worst.pvStoreValue.toFixed(4)} <= price €${worst.price.toFixed(4)} ` +
    `(−€${(worst.price - worst.pvStoreValue).toFixed(4)}/kWh, pvCoverage ${worst.pvCoverage.toFixed(3)})`);
});

// ── Targeted reproduction ────────────────────────────────────────────────────
// Index 2 = 13:45 local (11:45Z), €0.1998, pvCoverage 0.886 — the slot the live run charged.
test('11:45Z slot does not charge (store €0.195 <= export €0.200)', () => {
  const s = slots[2];
  assert.notStrictEqual(s.action, 'charge',
    `slot 2 (€${s.price.toFixed(4)}) is '${s.action}', store €${(s.pvStoreValue ?? 0).toFixed(4)}`);
});

// ── socProjected must match the actions ──────────────────────────────────────
// The forward pass advances socG off `code`; if a charge is overridden without skipping that
// advance, the plan draws SoC rising on a slot that never charges. socProjected has ONE writer
// (the DP), so this has to hold here — buildPlanningSchedule may not repair it downstream.
test('socProjected never rises across a slot that is not charging', () => {
  for (let t = 1; t < slots.length; t++) {
    const prev = slots[t - 1];
    const rise = slots[t].socProjected - prev.socProjected;
    if (rise <= 0.01) continue;
    const charging = prev.action === 'charge' || prev.action === 'preserve' || prev.action === 'trickle';
    assert.ok(charging,
      `SoC rises ${rise.toFixed(1)}pp into ${label(t)} while ${label(t - 1)} is '${prev.action}'`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
