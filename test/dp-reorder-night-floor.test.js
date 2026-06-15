'use strict';

// Reproduction — live 2026-06-14 21:29 run (app v3.16.0). Overnight→midday window,
// 1× 2.69 kWh, reserve floor active (cloudy next day → SoC held above minSoc).
//
// Observed: 0.48 kWh discharged at the CHEAPER 05:00 (€0.248) while the pricier
// 06:00 (€0.267) / 07:00 (€0.275) and — above all — the window's price-max 22:00
// (€0.287) were held in preserve. Strict economic-dominance violation.
//
// Root: the post-DP price-reorder assigns whole-slot discharges. The single priciest
// slot (22:00, 763 W net load) has a net-cap delta LARGER than the spend budget, so the
// rewrite drained past the DP's end-of-window SoC down to the reserve floor. The
// budget-neutral guard then reverted the entire reorder, leaving the DP's cheap
// {05:00, 08:00} placement. Fix: clamp every reorder slot to max(reserveFloor,
// dpEndTarget) so the priciest slot absorbs exactly the budget and the rewrite stays
// budget-neutral.
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
const base = new Date('2026-06-14T22:00:00+02:00').getTime();

//             22    23    00    01    02    03    04    05    06    07    08    09    10    11    12    13    14    15    16    17    18    19    20    21    22    23
const priceV = [0.287,0.277,0.263,0.249,0.241,0.244,0.241,0.248,0.267,0.275,0.282,0.258,0.186,0.140,0.134,0.132,0.131,0.133,0.139,0.190,0.251,0.292,0.314,0.323,0.319,0.296];
const pvV    = [0,    0,    0,    0,    0,    0,    0,    0,    11,   110,  272,  387,  479,  704,  904,  1158, 1686, 1495, 1083, 573,  360,  247,  171,  0,    0,    0];
const consV  = [763,  1173, 693,  709,  898,  877,  1044, 419,  321,  384,  356,  838,  627,  580,  516,  768,  1064, 621,  729,  492,  1154, 759,  468,  630,  924,  1113];

const prices = priceV.map((p, t) => ({ timestamp: new Date(base + t * H).toISOString(), price: p }));
const pv     = pvV.map((w, t)    => ({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: w }));
const cons   = consV.slice();

const SETTINGS = {
  battery_efficiency: 0.7294263929890545,
  min_soc: 0, max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
};

function run() {
  const eng = new OptimizationEngine(SETTINGS);
  // compute(prices, soc, capacityKwh, maxChargeW, maxDischargeW, pv, rte, cons,
  //         minDischargePrice, consumptionMargin, pvKwhTomorrow, terminalPvKwhTomorrow,
  //         pvCloudFactor, refillConfidence)
  // refillConfidence 0.7 → reserve floor active (matches the cloudy live run that held SoC).
  eng.compute(prices, 40, 2.69, 800, 800, pv, null, cons,
    0.118, 1.0, 2.8, 2.8, 0.80, 0.7);
  return eng._schedule.slots;
}

const slots = run();
const N_WINDOW = 12; // 22:00 → 09:00 (pre-midday-charge overnight block)
const dump = slots.slice(0, N_WINDOW)
  .map((s, t) => `${new Date(base + t * H).getUTCHours()}h €${s.price.toFixed(3)} ${s.action[0]}${s.socProjected.toFixed(0)}`)
  .join(' | ');
console.log('  window:', dump);

// ── Economic-dominance invariant ─────────────────────────────────────────────
// No eligible slot may discharge while a strictly-pricier eligible slot in the same
// overnight window is held in preserve. (The pricier slot here — 22:00 €0.287 — has
// ample net-load capacity to absorb the whole budget, so there is no zero-on-meter
// excuse for stranding discharge on cheaper slots.)
test('overnight: no cheaper slot discharges while a strictly-pricier slot is held', () => {
  for (let i = 0; i < N_WINDOW; i++) {
    if (slots[i].action !== 'discharge') continue;
    for (let j = 0; j < N_WINDOW; j++) {
      if (slots[j].action === 'discharge') continue;
      // j held in preserve while pricier than a discharging i → violation
      if (slots[j].price > slots[i].price + 1e-9) {
        assert.fail(
          `slot ${new Date(base + i * H).getUTCHours()}h €${slots[i].price.toFixed(3)} discharges ` +
          `while pricier ${new Date(base + j * H).getUTCHours()}h €${slots[j].price.toFixed(3)} is held`);
      }
    }
  }
});

// The window's price-max (22:00 €0.287) must carry the discharge.
test('overnight: discharge lands on the window price-max (22:00 €0.287)', () => {
  assert.strictEqual(slots[0].action, 'discharge',
    `22:00 €${slots[0].price.toFixed(3)} (window max) should discharge, got ${slots[0].action}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
