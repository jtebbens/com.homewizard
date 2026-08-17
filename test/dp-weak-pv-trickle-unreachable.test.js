'use strict';

// Weak-PV surplus is never weighed against exporting.
//
// pvCoverage[t] = max(0, pvW - consW) / maxChargePowerW, and the DP only credits a free
// PV SoC gain when pvCoverage >= pvStrongCoverage (= 400 / maxChargePowerW, i.e. a hard
// 400 W net-surplus floor). Below that floor pvSocGainG = 0, so vPreserve degenerates to
// dp[socG] — exactly what vStandby is. The argmax breaks ties with a strict `>`, so
// preserve (code 0) always wins and the forward pass never sees code === 3 (standby).
//
// Both weak-PV branches in the forward pass require code === 3:
//   pvTrickle    (optimization-engine.js:441)
//   pvExportWins (optimization-engine.js:444)
// and `weakReachable` (:438) additionally requires pvCoverage < pvStrongCoverage — the
// very condition that forces the tie. So the branch written for this case cannot fire.
//
// `dp_weak_pv_tie_standby` (default on) breaks that tie the other way, so the forward pass
// sees code === 3 again and the store-vs-export test runs. The first half of this file pins
// the flag-off behaviour (what shipped between b6432af and the flag), the second half pins
// what the flag restores.

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

// Horizon starts at midday so slot 0 carries the PV surplus under test (_flattenDebug
// only records the four action values at t === 0). A very high evening peak makes
// storing unambiguously better than exporting, so any refusal to store is structural
// and not an economic verdict.
const H = 3_600_000;
const BASE = new Date('2026-06-01T12:00:00+02:00').getTime();
const CHEAP = 0.10;
const PEAK = 1.00;

// A real cycle cost matters here: with free grid charging in the same slot, a free PV kWh
// is worth exactly the slot price (it displaces a purchase) — the same as exporting it — so
// preserve and standby would tie for a reason that has nothing to do with the 400 W floor.
// Charging wear breaks that degeneracy, so the weak-PV tie below is attributable to the floor.
const SETTINGS = {
  battery_efficiency: 0.90,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  dp_weak_pv_tie_standby: false,
};

// Same inputs, tie broken toward standby (the shipped default).
const SETTINGS_ON = { ...SETTINGS, dp_weak_pv_tie_standby: true };

const MAX_CHARGE_W = 2000;          // → pvStrongCoverage = 400 / 2000 = 0.20
const CONS_W = 500;

/**
 * Build a 12-slot horizon with a single PV slot at t=0 producing `pvW`.
 * Evening peak at t=6..9 gives the battery somewhere profitable to discharge.
 */
const eveningPeak = t => ((t >= 6 && t <= 9) ? PEAK : CHEAP);

function run(pvW, soc = 50, settings = SETTINGS, priceFn = eveningPeak, pvAt = 0) {
  const prices = [];
  const pv = [];
  const cons = [];
  for (let t = 0; t < 12; t++) {
    prices.push({ timestamp: new Date(BASE + t * H).toISOString(), price: priceFn(t) });
    pv.push({ timestamp: new Date(BASE + t * H).toISOString(), pvPowerW: t === pvAt ? pvW : 0 });
    cons.push(CONS_W);
  }
  const eng = new OptimizationEngine(settings);
  // compute(prices, soc, capacityKwh, maxChargeW, maxDischargeW, pv, rte, cons,
  //         minDischargePrice, consumptionMargin, pvKwhTomorrow, terminalPvKwhTomorrow,
  //         pvCloudFactor, refillConfidence)
  eng.compute(prices, soc, 5, MAX_CHARGE_W, 2000, pv, null, cons, 0, 1.0, 0, 0, 1.0, 1.0);
  return { eng, slots: eng._schedule.slots };
}

// Net surplus 200 W → pvCoverage 0.10, below the 0.20 strong threshold.
const WEAK_PV_W = CONS_W + 200;
// Net surplus 500 W → pvCoverage 0.25, above it.
const STRONG_PV_W = CONS_W + 500;

// ── The tie that disables the standby branch ─────────────────────────────────
test('weak PV: vPreserve equals vStandby exactly (tie → preserve wins argmax)', () => {
  const { eng } = run(WEAK_PV_W);
  const d = eng._flattenDebug;
  assert.ok(d, 'expected _flattenDebug to be populated at t=0');
  assert.ok(d.vStandby != null, `expected a standby value at t=0, got ${d.vStandby}`);
  assert.strictEqual(d.vPreserve, d.vStandby,
    `expected vPreserve === vStandby at weak PV, got preserve=${d.vPreserve} standby=${d.vStandby}`);
  assert.strictEqual(d.chosenAction, 'preserve',
    `expected the tie to resolve to preserve, got ${d.chosenAction}`);
});

// Under net metering (export_price_ratio 1.0) the tie is not specific to weak PV: the DP's
// SoC gradient equals the charge cost (price + cycleCost/2) whenever grid charging is the
// marginal source, and preserve is debited exactly exportVal + cycleCost/2 = the same amount.
// Dropping the export ratio (the post-2027 shape) makes storing strictly better than
// exporting and breaks the degeneracy — this is the control that the machinery does work.
// exportValue() ignores the ratio unless the tariff model is the asymmetric one — under
// saldering it always returns the full slot price (lib/price-formulas.js:34-37).
const SETTINGS_2027 = { ...SETTINGS, tariff_model: 'asymmetric_2027', export_price_ratio: 0.3 };

test('strong PV + export below price: preserve strictly beats standby', () => {
  const { eng } = run(STRONG_PV_W, 50, SETTINGS_2027);
  const d = eng._flattenDebug;
  assert.ok(d, 'expected _flattenDebug to be populated at t=0');
  assert.ok(d.vPreserve > d.vStandby,
    `expected preserve to win once exporting pays less than the slot price, `
    + `got preserve=${d.vPreserve} standby=${d.vStandby}`);
});

// The bite: the same economics that make storing clearly right above the floor cannot
// reach a slot below it. The floor is applied before any value is computed.
test('weak PV + export below price: surplus goes unstored (floor overrides economics)', () => {
  const { eng, slots } = run(WEAK_PV_W, 50, SETTINGS_2027);
  const d = eng._flattenDebug;
  assert.strictEqual(d.vPreserve, d.vStandby,
    `expected the weak-PV tie to survive a favourable export ratio, `
    + `got preserve=${d.vPreserve} standby=${d.vStandby}`);
  assert.strictEqual(slots.filter(s => s.action === 'trickle').length, 0,
    'expected no trickle slot even when storing clearly beats exporting');
  // Some SoC does arrive here, but from the grid (the DP picks `charge`), not from the
  // surplus: 200 W for one hour is 0.2 kWh = 4.0 pp on a 5 kWh battery. Anything well
  // under that means the free PV went to the meter while the battery bought instead.
  const gainPp = slots[1].socProjected - slots[0].socProjected;
  assert.ok(gainPp < 1.0,
    `expected the 4.0 pp of free PV surplus to go unstored, got a ${gainPp.toFixed(1)} pp gain`);
});

// ── The consequence: no branch evaluates storing the weak surplus ────────────
test('weak PV: trickle never fires, though storing beats exporting 10:1', () => {
  const { slots } = run(WEAK_PV_W);
  const s0 = slots[0];
  assert.ok(s0.pvCoverage > 0, `expected a real PV surplus at t=0, got coverage ${s0.pvCoverage}`);
  assert.ok(s0.pvStoreValue > s0.price,
    `scenario is only meaningful when storing wins: store=${s0.pvStoreValue} vs export=${s0.price}`);
  const trickled = slots.filter(s => s.action === 'trickle');
  assert.strictEqual(trickled.length, 0,
    `expected no trickle slot under the 400 W floor, got ${trickled.length}`);
});

test('weak PV: slot 0 stores nothing (SoC flat across the surplus slot)', () => {
  const { slots } = run(WEAK_PV_W);
  assert.strictEqual(slots[0].action, 'preserve',
    `expected preserve at the weak-PV slot, got ${slots[0].action}`);
  assert.strictEqual(slots[1].socProjected, slots[0].socProjected,
    `expected SoC to stay flat across a preserve-with-zero-gain slot, `
    + `got ${slots[0].socProjected}% → ${slots[1].socProjected}%`);
});

// ── The hard 400 W edge ──────────────────────────────────────────────────────
test('400 W floor is a cliff: 399 W surplus stores nothing, 401 W stores', () => {
  const below = run(CONS_W + 399);
  const above = run(CONS_W + 401);
  const gain = r => r.slots[1].socProjected - r.slots[0].socProjected;
  assert.strictEqual(gain(below), 0,
    `expected zero SoC gain at 399 W surplus, got ${gain(below)} pp`);
  assert.ok(gain(above) > 0,
    `expected a positive SoC gain at 401 W surplus, got ${gain(above)} pp`);
});

// ── Flag on (default): the tie falls to standby and the test runs again ──────
test('flag on — weak PV: the tie resolves to standby, not preserve', () => {
  const { eng } = run(WEAK_PV_W, 50, SETTINGS_ON);
  const d = eng._flattenDebug;
  assert.strictEqual(d.vPreserve, d.vStandby,
    `the tie itself must be untouched, got preserve=${d.vPreserve} standby=${d.vStandby}`);
  assert.strictEqual(d.chosenAction, 'standby',
    `expected the weak-PV tie to resolve to standby, got ${d.chosenAction}`);
});

test('flag on — weak PV: trickle fires when storing beats exporting', () => {
  const { slots } = run(WEAK_PV_W, 50, SETTINGS_ON);
  const s0 = slots[0];
  assert.ok(s0.pvStoreValue > s0.price,
    `scenario is only meaningful when storing wins: store=${s0.pvStoreValue} vs export=${s0.price}`);
  assert.strictEqual(s0.action, 'trickle',
    `expected the weak surplus to be trickled, got ${s0.action}`);
});

// Surplus on t=1: slot 0 is only partly ahead of us (slot0RemainingFrac shrinks its SoC
// step to fractions of a pp), so a full slot is the only place a stored kWh is legible.
test('flag on — weak PV: the trickled surplus shows up as SoC', () => {
  const on  = run(WEAK_PV_W, 50, SETTINGS_ON, eveningPeak, 1);
  const off = run(WEAK_PV_W, 50, SETTINGS, eveningPeak, 1);
  assert.strictEqual(on.slots[1].action, 'trickle',
    `expected a trickle slot at t=1, got ${on.slots[1].action}`);
  // 200 W for one hour = 0.2 kWh = 4.0 pp on a 5 kWh battery.
  const gain = s => s[2].socProjected - s[1].socProjected;
  assert.ok(gain(on.slots) > 1.0,
    `expected the free surplus to raise the projected SoC, got ${gain(on.slots).toFixed(1)} pp`);
  assert.strictEqual(gain(off.slots), 0,
    `expected the same surplus to go unstored with the flag off, got ${gain(off.slots)} pp`);
});

// The economic-dominance half: standby must win when exporting is worth more. A horizon
// whose only high price is the current slot leaves nothing worth storing for — the suffix
// max behind pvStoreValue is CHEAP, so exporting at PEAK now strictly beats banking it.
const peakNow = t => (t === 0 ? PEAK : CHEAP);

test('flag on — weak PV: exports when exporting beats storing (no hoarding)', () => {
  const { slots } = run(WEAK_PV_W, 50, SETTINGS_ON, peakNow);
  const s0 = slots[0];
  assert.ok(s0.pvStoreValue < s0.price,
    `scenario is only meaningful when exporting wins: store=${s0.pvStoreValue} vs export=${s0.price}`);
  assert.strictEqual(s0.action, 'standby',
    `expected the surplus to be exported, got ${s0.action}`);
  assert.strictEqual(s0.pvExportWins, true,
    'expected the DP to carry an explicit export verdict for this slot');
});

test('flag on — strong PV is untouched: preserve still strictly beats standby', () => {
  const { eng } = run(STRONG_PV_W, 50, { ...SETTINGS_2027, dp_weak_pv_tie_standby: true });
  const d = eng._flattenDebug;
  assert.ok(d.vPreserve > d.vStandby,
    `expected preserve to keep winning above the floor, got preserve=${d.vPreserve} standby=${d.vStandby}`);
  assert.strictEqual(d.chosenAction, 'preserve',
    `expected preserve above the floor, got ${d.chosenAction}`);
});

test('flag on — the 400 W cliff no longer swallows the surplus', () => {
  const below = run(CONS_W + 399, 50, SETTINGS_ON);
  const above = run(CONS_W + 401, 50, SETTINGS_ON);
  const gain = r => r.slots[1].socProjected - r.slots[0].socProjected;
  assert.ok(gain(below) > 0,
    `expected a 399 W surplus to be stored too, got ${gain(below)} pp`);
  assert.ok(gain(above) > 0,
    `expected the 401 W surplus to keep being stored, got ${gain(above)} pp`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
