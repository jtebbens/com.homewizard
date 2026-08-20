'use strict';

// Reproduction — live miss 2026-08-19 09:15 CEST run (app v3.19.1, branch feat/sat-accuracy-diag).
// Transcribed from the diagnose planning table (09:15 → 23:45 local, 15-min slots).
//
// Battery starts at 17% (~0.46 kWh). The DP plans:
//   12:45–13:30  discharge ~0.29 kWh at €0.288–0.292   → SoC 17% → 6%
//   19:30–19:45  discharge the rest at €0.392/€0.399    → SoC 6% → 0%
//   20:00–20:45  preserve at €0.373/0.384/0.388/0.393, battery EMPTY
//
// House load in 20:00–20:45 is 337/317/343/370 W = 0.34 kWh, so those four slots could
// have absorbed the 0.29 kWh spent at midday. No capacity limit, no PV in the way.
// Selling ~0.29 kWh at €0.29 while strictly pricier eligible slots (€0.373–0.393) go
// unserved is a strict economic-dominance violation under a fixed energy budget.
//
// Same invariant class as dp-reorder-late-peak.test.js, but the cheap slots sit OUTSIDE
// the post-DP evening reorder window, so that reorder cannot repair it.
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
const base = new Date('2026-08-19T09:15:00+02:00').getTime();

// 09:15 → 23:45 local, transcribed from the live diagnose table.
const priceVals = [
  0.349, 0.318, 0.305, 0.328, 0.318, 0.308, 0.311, 0.307, 0.308, 0.303, 0.298, 0.304,
  0.295, 0.294, 0.289, 0.292, 0.288, 0.292, 0.282, 0.287, 0.288, 0.285, 0.284, 0.284,
  0.287, 0.292, 0.296, 0.288, 0.294, 0.302, 0.312, 0.298, 0.308, 0.321, 0.341, 0.330,
  0.349, 0.363, 0.371, 0.358, 0.379, 0.392, 0.399, 0.373, 0.384, 0.388, 0.393, 0.388,
  0.386, 0.377, 0.369, 0.381, 0.374, 0.370, 0.361, 0.368, 0.361, 0.355, 0.343,
];
const pvVals = [
  237, 262, 286, 310, 435, 560, 684, 809, 836, 862, 889, 915,
  699, 483, 266, 50, 195, 339, 484, 628, 647, 667, 686, 705,
  654, 604, 553, 502, 464, 427, 389, 351, 314, 277, 240, 203,
  195, 187, 178, 170, 128, 85, 43, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const consVals = [
  355, 410, 334, 555, 325, 350, 487, 317, 306, 378, 290, 319,
  390, 326, 312, 380, 444, 406, 344, 389, 401, 367, 340, 388,
  398, 331, 437, 325, 406, 440, 397, 413, 381, 399, 399, 369,
  261, 259, 292, 324, 316, 309, 359, 337, 317, 343, 370, 368,
  379, 311, 279, 322, 333, 322, 296, 540, 349, 363, 348,
];

assert.strictEqual(priceVals.length, pvVals.length);
assert.strictEqual(priceVals.length, consVals.length);

const prices = priceVals.map((p, t) => ({ timestamp: new Date(base + t * Q).toISOString(), price: p }));
const pv     = pvVals.map((w, t)   => ({ timestamp: new Date(base + t * Q).toISOString(), pvPowerW: w }));
const cons   = consVals.slice();

// Live config from the diagnose header.
// dp_flatten_pv_shift is the live device value since 2026-08-17 12:00 CEST (log:
// "flatten-gate ... shift=true"). It is NOT the schema default, and it is the single
// input that decides this case: with shift=false the same arrays yield a morning
// charge to 46.6% and a full evening discharge run at €0.363-0.399 — no midday drain.
const SETTINGS = {
  battery_efficiency: 0.7322975508161732,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  dp_flatten_pv_shift: true,
};
const MIN_DISCHARGE_PRICE = 0.102; // "Ontlaad-drempel-range: €0.102-0.102"
const MAX_CHARGE_PRICE    = 0.223; // dynamic effective ceiling
const PV_KWH_TOMORROW     = 3.8;
const TERMINAL_PV_KWH     = 6.4;   // post-horizon → terminal factor 0
const REFILL_CONFIDENCE   = 0.66;

function run() {
  const eng = new OptimizationEngine(SETTINGS);
  eng.compute(prices, 17, 2.69, 800, 800, pv, null, cons,
    MIN_DISCHARGE_PRICE, 1.15, PV_KWH_TOMORROW, TERMINAL_PV_KWH, 1.0,
    REFILL_CONFIDENCE, false, MAX_CHARGE_PRICE);
  return eng._schedule.slots;
}

const slots = run();

const label = (t) => new Date(base + t * Q).toLocaleTimeString('nl-NL',
  { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

const discharges = slots
  .map((s, t) => ({ t, ...s }))
  .filter((s) => s.action === 'discharge');
console.log('  discharge slots:',
  discharges.map((s) => `${label(s.t)} €${s.price.toFixed(3)}`).join(' | ') || '(none)');

// ── Economic-dominance invariant ─────────────────────────────────────────────
// Under a fixed energy budget, no slot may discharge while a STRICTLY pricier slot
// later in the same horizon is held in preserve/standby with battery capacity that
// the earlier discharge consumed. Checked pairwise: cheapest discharge vs the
// priciest non-discharge slot that follows it.
test('no discharge at a price strictly below a later held slot', () => {
  if (discharges.length === 0) return; // nothing to violate

  const cheapest = discharges.reduce((a, b) => (b.price < a.price ? b : a));
  const laterHeld = slots
    .map((s, t) => ({ t, ...s }))
    .filter((s) => s.t > cheapest.t && s.action !== 'discharge' && s.price > cheapest.price);

  if (laterHeld.length === 0) return;
  const best = laterHeld.reduce((a, b) => (b.price > a.price ? b : a));

  assert.fail(
    `discharges ${label(cheapest.t)} at €${cheapest.price.toFixed(3)} while ` +
    `${label(best.t)} €${best.price.toFixed(3)} (${best.action}) is held later — ` +
    `€${(best.price - cheapest.price).toFixed(3)}/kWh left on the table`);
});

// ── Targeted reproduction of the observed miss ───────────────────────────────
// Index 14–17 = 12:45–13:30 (€0.288–0.292); index 43–46 = 20:00–20:45 (€0.373–0.393).
const MIDDAY = [14, 15, 16, 17];
const EVENING = [43, 44, 45, 46];

test('midday €0.29 block does not discharge while 20:00-20:45 sits empty', () => {
  const middayDischarge = MIDDAY.filter((t) => slots[t].action === 'discharge');
  const eveningHeld     = EVENING.filter((t) => slots[t].action !== 'discharge');
  if (middayDischarge.length > 0 && eveningHeld.length > 0) {
    assert.fail(
      `midday discharges at ${middayDischarge.map(label).join(',')} ` +
      `(€${MIDDAY.map((t) => slots[t].price.toFixed(3)).join('/')}) while ` +
      `${eveningHeld.map(label).join(',')} ` +
      `(€${eveningHeld.map((t) => slots[t].price.toFixed(3)).join('/')}) is held`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
