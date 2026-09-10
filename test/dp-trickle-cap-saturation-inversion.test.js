'use strict';

// Regression: the store value is not monotone in the trickle cap. A TIGHTER cap yields a HIGHER
// store value, because a zeroed cap is read as "no cap" and falls back to the uncapped suffix max.
//
// trickleSuffixMaxPrice[k] is the highest price between k and the first pvStrong slot after it,
// and resets to 0 as soon as k+1 is itself pvStrong. Zero means "the window is empty", but
// rawStorePrice treats it as "no cap at all" and falls back to suffixMaxPrice — the evening peak.
// One slot later, where the window is NOT empty, the cap lands on a small price and the store
// value collapses. Two neighbouring surplus slots then get store values a factor 4 apart on
// nothing but the PV coverage of the slot after them.
//
// Live 2026-09-10 09:00Z (11:00 Ams), from policy_optimizer_schedule:
//   11:00  EUR0.299  cov 0.750  next cov 0.950 (strong) → cap 0    → store EUR0.556 → STORED
//   11:15  EUR0.278  cov 0.950  next cov 0.450 (weak)   → cap 0.263 → store EUR0.118 → EXPORTED
// The pack reached 100% at 13:45 either way, so the morning kWh added nothing to the evening —
// it only decided WHICH surplus went to the grid. The planner kept the expensive one and sold
// the cheap one. dp_trickle_cap_saturation puts the same pvSaturatesAhead test on the <= 0
// branch that dp_trickle_cap_positive already puts on the > 0 branch, which collapses both to
// one monotone predicate: rawStorePrice = pvSaturatesAhead ? trickleSuffixMaxPrice[t] : suffixMaxPrice[t].

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine.js');
const { storeValue } = require('../lib/price-formulas.js');

const RTE = 0.7315;
const CYCLE = 0.075;
const EXPENSIVE = 0.299; // t0 — cap zeroed by a pvStrong successor
const CHEAPER = 0.278;   // t1 — cap lands on t2's price
const WEAK_PRICE = 0.263; // t2 — the price the cap lands on for t1
const PEAK_PRICE = 0.863; // t5 — the uncapped suffix max

const CAPPED_VALUE = storeValue(WEAK_PRICE, RTE, CYCLE); // ≈ €0.118, what t1 gets
const UNCAPPED_VALUE = storeValue(PEAK_PRICE, RTE, CYCLE); // ≈ €0.556, what t0 wrongly gets
const ZEROED_VALUE = storeValue(0, RTE, CYCLE); // −€0.075, what t0 should get

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Hourly slots, consumption 200 W, charge rate 800 W → pvCoverage = (pvW − 200) / 800.
const PRICES = [EXPENSIVE, CHEAPER, WEAK_PRICE, 0.236, 0.250, PEAK_PRICE, 0.400, 0.300];
//                 t0         t1        t2        t3     t4       t5        t6     t7
const PV_W = [800, 960, 560, 880, 800, 0, 0, 0];
//   cov:     0.75 0.95 0.45 0.85 0.75  0  0  0
// t1 is pvStrong → trickleSuffixMaxPrice[t0] = 0 (empty window).
// t2 is weak, t3 is pvStrong → trickleSuffixMaxPrice[t1] = price[t2] = €0.263.
// Surplus reachable from t1 on: 0.76 + 0.36 + 0.68 + 0.60 = 2.40 kWh; from t2 on: 1.64 kWh.
// Room at 45% of 2.688 kWh = 1.478 kWh → the PV ahead saturates in both cases, so the cap
// assertion ("a later pvStrong block refills the pack") is TRUE at both slots.

function runEngine({ satGate }) {
  const oe = new OE({
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
    dp_trickle_cap_saturation: satGate,
  });
  const base = Date.now();
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = prices.map(() => 200);
  oe.compute(prices, 45, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

// --- 1. the inversion itself ----------------------------------------------------

test('gate off reproduces the live inversion: the tighter cap yields the higher store value', () => {
  const s = runEngine({ satGate: false });
  assert.ok(Math.abs(s[0].pvStoreValue - UNCAPPED_VALUE) < 1e-6,
    `t0 (empty window) expected the uncapped €${UNCAPPED_VALUE.toFixed(4)}, got ${s[0].pvStoreValue.toFixed(4)}`);
  assert.ok(Math.abs(s[1].pvStoreValue - CAPPED_VALUE) < 1e-6,
    `t1 (window = €0.263) expected €${CAPPED_VALUE.toFixed(4)}, got ${s[1].pvStoreValue.toFixed(4)}`);
  assert.ok(s[0].pvStoreValue > s[1].pvStoreValue,
    'the bug: t0 has the tighter cap yet the higher store value');
});

test('gate off: the expensive surplus is stored while the cheaper one is exported', () => {
  const s = runEngine({ satGate: false });
  assert.ok(s[0].pvStoreValue > PRICES[0],
    `t0 stores at €${PRICES[0]} because €${UNCAPPED_VALUE.toFixed(3)} beats exporting`);
  assert.ok(s[1].pvStoreValue < PRICES[1],
    `t1 exports at €${PRICES[1]} because €${CAPPED_VALUE.toFixed(3)} does not`);
  assert.strictEqual(s[1].pvExportWins, true, 't1 is the exported slot');
});

// --- 2. the fix -----------------------------------------------------------------

test('gate on: a zeroed cap under saturation is honoured, not inverted', () => {
  const s = runEngine({ satGate: true });
  assert.strictEqual(s[0].pvTrickleCapBinds, true,
    'PV ahead (2.40 kWh) covers the room (1.48 kWh) → the zeroed cap must bind');
  assert.ok(Math.abs(s[0].pvStoreValue - ZEROED_VALUE) < 1e-6,
    `expected €${ZEROED_VALUE.toFixed(4)}, got ${s[0].pvStoreValue.toFixed(4)}`);
});

test('gate on: store value is monotone in the cap across the two slots', () => {
  const s = runEngine({ satGate: true });
  assert.ok(s[0].pvStoreValue <= s[1].pvStoreValue + 1e-9,
    `tighter cap must not outvalue the looser one: t0 ${s[0].pvStoreValue.toFixed(4)} vs t1 ${s[1].pvStoreValue.toFixed(4)}`);
});

test('gate on: the expensive surplus is no longer stored ahead of the cheaper one', () => {
  const s = runEngine({ satGate: true });
  assert.ok(s[0].pvStoreValue < PRICES[0],
    'exporting €0.299 must now beat storing it');
  assert.ok(!(s[0].pvStoreValue > PRICES[0] && s[1].pvStoreValue < PRICES[1]),
    'never store the dearer surplus while exporting the cheaper one in the same PV block');
});

test('DEFAULT settings (no flag passed) never store the dearer surplus while exporting the cheaper', () => {
  // The live path: nothing in device.js passes dp_trickle_cap_saturation, so this is what the
  // shipped build does. Red until the constructor default flips.
  const oe = new OE({
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
  });
  const base = Date.now();
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = prices.map(() => 200);
  oe.compute(prices, 45, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  const s = oe._schedule.slots;
  assert.ok(s[0].pvStoreValue <= s[1].pvStoreValue + 1e-9,
    `store value must be monotone in the cap: t0 ${s[0].pvStoreValue.toFixed(4)} (cap 0) vs t1 ${s[1].pvStoreValue.toFixed(4)} (cap €${WEAK_PRICE})`);
  assert.ok(!(s[0].pvStoreValue > PRICES[0] && s[1].pvStoreValue < PRICES[1]),
    `stores €${PRICES[0]} while exporting €${PRICES[1]} in the same PV block`);
});

test('gate on does not touch a slot whose PV ahead does not saturate', () => {
  // Same shape, but the PV after t0 is far under the room — the cap assertion is false there,
  // so pvSaturatesAhead is false and the uncapped suffix max must stand, gate or no gate.
  const oe = new OE({
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
    dp_trickle_cap_saturation: true,
  });
  const base = Date.now();
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pv = [800, 640, 200, 200, 200, 0, 0, 0]; // from t1: 0.44 kWh only, room 1.478 kWh
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: pv[h] }));
  const cons = prices.map(() => 200);
  oe.compute(prices, 45, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  const s = oe._schedule.slots;
  assert.strictEqual(s[0].pvTrickleCapBinds, false,
    'PV ahead is under the room → the zeroed cap must not bind');
  assert.ok(Math.abs(s[0].pvStoreValue - UNCAPPED_VALUE) < 1e-6,
    `unsaturating case keeps the uncapped value, got ${s[0].pvStoreValue.toFixed(4)}`);
});

// --- 3. the runtime reads its own copy of the number -----------------------------
// policy-engine does not read pvStoreValue on this branch; it rebuilds the value from
// slotMeta.pvTrickleMaxValue / pvTrickleCapBinds. If branch 2 of that ladder does not fire,
// the runtime falls through to its own max over futurePrices and diverges from the DP.

const RealDate = Date;
function atFixedTime(fn) {
  const fixed = new RealDate('2026-09-10T09:00:00.000Z');
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
      if (!args.length) return new RealDate(fixed.getTime());
    }

    static now() { return fixed.getTime(); }
  };
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

function runFlags(slotMeta) {
  const ctx = {
    settings: { max_soc: 100, cycle_cost_per_kwh: CYCLE },
    BATTERY_EFFICIENCY: RTE,
    _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
    _disposalValue: PolicyEngine.prototype._disposalValue,
    log: () => {},
  };
  const allPrices = [
    { timestamp: '2026-09-10T17:00:00.000Z', price: PEAK_PRICE },
    { timestamp: '2026-09-10T10:00:00.000Z', price: WEAK_PRICE },
  ];
  const inputs = {
    battery: { stateOfCharge: 45, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: { resolved_gridPower: -600, pv_power_estimated: 800, avg_consumption_w: 200 },
    tariff: { currentPrice: EXPENSIVE, allPrices, slotHours: 0.25 },
    optimizer: { getSlotMeta: () => slotMeta },
  };
  atFixedTime(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
  return inputs;
}

test('runtime binds the zeroed cap when the engine did', () => {
  const out = runFlags({
    pvTrickleMaxValue: 0, pvTrickleCapBinds: true, pvTrickleCapHonoured: true,
    action: 'preserve', pvStoreValue: ZEROED_VALUE,
  });
  assert.ok(Math.abs(out._pvStoreValue - ZEROED_VALUE) < 1e-6,
    `runtime must land on €${ZEROED_VALUE.toFixed(4)}, got ${out._pvStoreValue}`);
  assert.strictEqual(out._pvStoreWins, false,
    'export at €0.299 wins — the runtime must not force a charge');
});

test('runtime without the binding flag still falls back to the uncapped value', () => {
  const out = runFlags({
    pvTrickleMaxValue: 0, pvTrickleCapBinds: false, pvTrickleCapHonoured: true,
    action: 'preserve', pvStoreValue: UNCAPPED_VALUE,
  });
  assert.ok(out._pvStoreValue > EXPENSIVE,
    `unsaturating case keeps storing, got ${out._pvStoreValue}`);
  assert.strictEqual(out._pvStoreWins, true, 'store still wins there');
});

console.log(`\ndp-trickle-cap-saturation-inversion: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
