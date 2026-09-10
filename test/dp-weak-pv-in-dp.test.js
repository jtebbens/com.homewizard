'use strict';

// Weak PV surplus belongs in the DP, not in an overlay on top of it.
//
// Below PV_STRONG_SURPLUS_W the backward pass sets pvSocGainG = 0 (optimization-engine.js, the
// preserve block), so 'preserve' and 'standby' are the same transition reading the same dp[]
// element. The DP is indifferent: there is no store-vs-export choice to make. The choice was
// then rebuilt outside the DP — the forward pass's pvTrickle/weakReachable branch — which is
// what CLAUDE.md §Data Source Discipline forbids ("no forward-sim overrides that diverge from
// actual DP decisions").
//
// The premise under the 0 is refuted: live log 2026-09-10 11:00 Amsterdam shows the firmware
// charging from a 237 W surplus (zero_charge_only, 260-340 W, SoC 45% -> 47%). The real floor is
// 75 W (reference_battery_firmware_charge_floor_75w); 400 W is a tuning constant from 03286552.
//
// dp_weak_pv_in_dp credits the SoC gain from PV_CHARGE_FLOOR_W upward, so vPreserve carries the
// wear and the forgone export the strong band already carries, and the DP decides. These tests
// assert on actionSrc, not only on the action: an overlay reaching the same answer is still the
// wrong layer deciding.
//
// Saldering cannot express this question — export value equals the slot price there, so storing
// PV and buying grid win or lose together. The scenarios below use asymmetric_2027 with an
// export ratio, where the two come apart.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

const RTE = 0.7315;
const CYCLE = 0.075;
const CAP_KWH = 2.688;
const POWER_W = 800;
const CONS_W = 800;

// Hourly slots. pvCoverage = (pvW − consW) / maxChargePowerW, so 1000 W of PV against 800 W of
// load is a 200 W surplus = coverage 0.25: above the 75 W charge floor (0.094), below the 400 W
// pvStrong threshold (0.50). Squarely in the band the DP is currently blind to.
const PV_W = [1000, 1000, 0, 0, 0, 0, 0, 0];
const PEAK = 0.40;
const FLAT = 0.28;
const T0_PRICE = 0.30;
const PRICES = [T0_PRICE, FLAT, FLAT, FLAT, FLAT, PEAK, FLAT, FLAT];

// What the stored kWh can fetch: the peak at RTE, minus the discharge half-cycle.
// Storing also pays the charge half-cycle, so the whole round trip nets one full cycle.
const STORE_VALUE = PEAK * RTE - CYCLE; // ≈ €0.2176
// A grid charge at t0 must NOT pay, or the slot's action says nothing about store-vs-export:
// PEAK * RTE − ½cycle = €0.2551 < €0.30 + ½cycle. Verified as an assertion below.

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function runEngine({ weakPvInDp, exportRatio, shadow = false, pvW = PV_W }) {
  const settings = {
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'asymmetric_2027',
    export_price_ratio: exportRatio,
  };
  if (weakPvInDp != null) settings.dp_weak_pv_in_dp = weakPvInDp;
  if (shadow) settings.dp_weak_pv_shadow = true;
  const oe = new OE(settings);
  // Fixed base: the identity test below compares serialised plans, so the clock must not move.
  const base = Date.parse('2026-06-15T10:00:00.000Z');
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: pvW[h] }));
  const cons = prices.map(() => CONS_W);
  oe.compute(prices, 50, CAP_KWH, POWER_W, POWER_W, pvF, RTE, cons, 0, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return oe;
}

function runSlots(opts) {
  return runEngine(opts)._schedule.slots;
}

// --- premise: the scenario really is a store-vs-export question ------------------

test('premise: a grid charge at t0 does not pay, so t0 is only about the PV surplus', () => {
  const repayValue = PEAK * RTE - 0.5 * CYCLE;
  const repayCost = T0_PRICE + 0.5 * CYCLE;
  assert.ok(repayCost > repayValue,
    `grid charge must lose: cost €${repayCost.toFixed(4)} vs value €${repayValue.toFixed(4)}`);
});

// --- 1. storing beats exporting -------------------------------------------------

test('flag on, export ratio 0.30: the DP itself stores the weak surplus', () => {
  const s = runSlots({ weakPvInDp: true, exportRatio: 0.30 });
  const exportVal = T0_PRICE * 0.30;
  assert.ok(STORE_VALUE > exportVal,
    `scenario check: store €${STORE_VALUE.toFixed(4)} must beat export €${exportVal.toFixed(4)}`);
  assert.strictEqual(s[0].action, 'preserve', 't0 must store the surplus');
  assert.strictEqual(s[0].actionSrc, 'D',
    `the DP must own this decision, not an overlay (got '${s[0].actionSrc}')`);
  assert.ok(s[1].socProjected > s[0].socProjected,
    `SoC must rise across t0: ${s[0].socProjected} -> ${s[1].socProjected}`);
});

// --- 2. exporting beats storing -------------------------------------------------

test('flag on, export ratio 0.90: the DP itself exports the weak surplus', () => {
  const s = runSlots({ weakPvInDp: true, exportRatio: 0.90 });
  const exportVal = T0_PRICE * 0.90;
  assert.ok(exportVal > STORE_VALUE,
    `scenario check: export €${exportVal.toFixed(4)} must beat store €${STORE_VALUE.toFixed(4)}`);
  assert.strictEqual(s[0].action, 'standby', 't0 must export the surplus');
  assert.strictEqual(s[0].actionSrc, 'D',
    `the DP must own this decision, not an overlay (got '${s[0].actionSrc}')`);
  assert.ok(s[1].socProjected <= s[0].socProjected + 1e-9,
    `SoC must not rise across an exporting slot: ${s[0].socProjected} -> ${s[1].socProjected}`);
});

// --- 3. the flag really is a flag -----------------------------------------------

for (const ratio of [0.30, 0.90]) {
  test(`flag off is byte-identical to the default at export ratio ${ratio.toFixed(2)}`, () => {
    const off = runSlots({ weakPvInDp: false, exportRatio: ratio });
    const dflt = runSlots({ weakPvInDp: null, exportRatio: ratio });
    assert.strictEqual(JSON.stringify(off), JSON.stringify(dflt),
      'passing the flag as false must change nothing about the plan');
  });
}

// --- 4. the shadow pass: measures the flag without moving the plan ---------------

// Why a second engine instead of a second backward pass: scoring needs socProjected, and that
// only exists after the forward pass. So the shadow is a full clone compute() with the flag
// flipped, and both plans go through ONE scorer. Comparing dp[] values instead would be
// meaningless — with the flag on, the backward pass prices the weak band, so its own dp[] is
// higher by construction.

test('shadow is off unless asked for', () => {
  const oe = runEngine({ weakPvInDp: false, exportRatio: 0.30 });
  assert.ok(!oe._weakPvShadow, 'no engine should pay for a second compute() by default');
});

test('shadow records the flipped flag, scored on one scorer', () => {
  const oe = runEngine({ weakPvInDp: false, exportRatio: 0.30, shadow: true });
  const w = oe._weakPvShadow;
  assert.ok(w, 'a horizon with a weak-PV slot must produce a shadow record');
  assert.strictEqual(w.flagOn, false, 'flagOn describes the plan that shipped, not the shadow');
  assert.strictEqual(w.nWeakSlots, 2, 'two slots carry a weak surplus in this scenario');
  assert.ok(Number.isFinite(w.eurBase) && Number.isFinite(w.eurShadow) && Number.isFinite(w.dEur));
  assert.ok(Math.abs(w.dEur - (w.eurShadow - w.eurBase)) < 1e-9, 'dEur must be the scored delta');
  // Decision scope: without a differing slot the € delta is not evidence of anything.
  assert.ok(w.nDiff > 0, `the flag must change something here (nDiff=${w.nDiff})`);
  // The reverse trap: here the labels are identical and only the SoC path moves, so a diff
  // counter on labels alone would have called this run unmoved.
  assert.strictEqual(w.nDiffAction, 0, 'both plans label these slots the same');
  assert.ok(w.nDiffSoc > 0, `the SoC path must differ (nDiffSoc=${w.nDiffSoc})`);
  assert.strictEqual(w.action0Shadow, 'preserve', 'the shadow stores the surplus at ratio 0.30');
  // Input coverage, so a flat default cannot pass unnoticed: this scenario IS flat by design.
  assert.strictEqual(w.consDistinct, 1, 'fixture consumption is a single value');
  assert.strictEqual(w.consN, PRICES.length);
});

test('storing beats exporting at ratio 0.30, so the shadow scores positive', () => {
  const w = runEngine({ weakPvInDp: false, exportRatio: 0.30, shadow: true })._weakPvShadow;
  assert.ok(w.dEur > 0,
    `store €${STORE_VALUE.toFixed(4)} beats export €${(T0_PRICE * 0.30).toFixed(4)}, `
    + `so flipping the flag must score positive (got ${w.dEur})`);
});

test('label churn is not a decision: ratio 0.90 differs in 2 labels, 0 kWh', () => {
  const w = runEngine({ weakPvInDp: false, exportRatio: 0.90, shadow: true })._weakPvShadow;
  // 'preserve' with a flat SoC and 'standby' are two names for the same physics: the surplus
  // leaves the house either way. A diff counter on labels alone would report this as a decision.
  assert.strictEqual(w.nDiffAction, 2, 'the labels do differ');
  assert.strictEqual(w.nDiffSoc, 0, 'but no kWh moves, so the SoC paths are identical');
  assert.strictEqual(w.dEur, 0, 'and the € delta must be exactly zero');
});

test('exporting beats storing at ratio 0.90, so the shadow does not score positive', () => {
  const w = runEngine({ weakPvInDp: false, exportRatio: 0.90, shadow: true })._weakPvShadow;
  assert.ok(w.dEur <= 0,
    `export €${(T0_PRICE * 0.90).toFixed(4)} beats store €${STORE_VALUE.toFixed(4)}, `
    + `so flipping the flag must not score positive (got ${w.dEur})`);
});

for (const ratio of [0.30, 0.90]) {
  test(`the shadow leaves the shipped plan untouched at export ratio ${ratio.toFixed(2)}`, () => {
    const plain = runSlots({ weakPvInDp: false, exportRatio: ratio });
    const withShadow = runSlots({ weakPvInDp: false, exportRatio: ratio, shadow: true });
    assert.strictEqual(JSON.stringify(withShadow), JSON.stringify(plain),
      'a diagnostic must not change the plan that ships');
  });
}

test('no weak-PV slot in the horizon: no shadow run at all', () => {
  // Night horizon — zero PV everywhere, so nothing could differ and the second compute() is
  // pure cost. This is the guard that keeps every night run free.
  const oe = runEngine({
    weakPvInDp: false, exportRatio: 0.30, shadow: true, pvW: PV_W.map(() => 0),
  });
  assert.ok(!oe._weakPvShadow, 'a horizon without a weak-PV slot must skip the shadow');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
