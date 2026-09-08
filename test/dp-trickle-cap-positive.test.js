'use strict';

// Regression: a POSITIVE trickle cap was taken unconditionally, without testing whether the
// free PV ahead actually refills the battery.
//
// trickleSuffixMaxPrice[k] resets to 0 as soon as ONE slot has pvCoverage >= pvStrongCoverage,
// on the assertion that "PV-strong hours refill the battery independently". The saturation test
// that checks that assertion (pvSaturatesAhead) sits only on the `<= 0` branch; where the cap
// lands on a positive price the assertion is never checked.
//
// Live 2026-09-08 11:00Z (13:00 Ams): 339 W surplus went to the grid at €0.214 with the pack at
// 45%. The store value used was €0.110 — the NEXT slot's price (€0.2529 × 0.7315 − 0.075),
// because a pvStrong slot one step further reset the cap. The evening peak of €0.459 was worth
// €0.261 stored. The same run logged `saturating=0`: on no slot did the PV ahead fill the room,
// and the pack ended the day at 55%, never full. The assertion was factually wrong.
//
// Scenario below reproduces that shape: weak-PV slot now, weak-PV slot next (its price is what
// the cap lands on), one pvStrong slot after that (the reset), evening peak, and PV ahead well
// under the remaining room.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine.js');
const { storeValue } = require('../lib/price-formulas.js');

const RTE = 0.7315;
const CYCLE = 0.075;
const CAP_PRICE = 0.2529; // slot 1 — where the trickle cap lands
const PEAK_PRICE = 0.459; // slot 5 — the uncapped suffix max
const CAPPED_VALUE = storeValue(CAP_PRICE, RTE, CYCLE);   // ≈ €0.110
const UNCAPPED_VALUE = storeValue(PEAK_PRICE, RTE, CYCLE); // ≈ €0.261

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// --- 1. optimization-engine: the store value on the forward pass ----------------

// Hourly slots. Consumption 200 W throughout, charge rate 800 W, so
// pvCoverage = (pvW - 200) / 800.
const PRICES = [0.214, CAP_PRICE, 0.240, 0.230, 0.280, PEAK_PRICE, 0.300, 0.200];
//                t0        t1       t2      t3      t4        t5       t6      t7
// t2 is the only pvStrong slot (cov 0.75) — it resets the cap at k=1, so
// trickleSuffixMaxPrice[0] = price[1] and the €0.459 peak is cut off.
const PV_W = [539, 539, 800, 440, 200, 0, 0, 0];
//   cov:   0.424 0.424 0.75  0.30  0    0  0  0
// PV reachable from t=1 on: (0.424 + 0.75 + 0.30) × 0.8 = 1.18 kWh.
// Room at 45% of 2.688 kWh = 1.478 kWh → the PV ahead does NOT saturate.

function runEngine({ positiveGate }) {
  const oe = new OE({
    battery_efficiency: RTE, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering',
    dp_trickle_cap_positive: positiveGate,
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

test('gate off reproduces the live number: store value is the capped €0.110', () => {
  const slots = runEngine({ positiveGate: false });
  assert.ok(Math.abs(slots[0].pvStoreValue - CAPPED_VALUE) < 1e-6,
    `expected the capped value ${CAPPED_VALUE.toFixed(4)}, got ${slots[0].pvStoreValue.toFixed(4)}`);
  assert.ok(slots[0].pvStoreValue < 0.214,
    'with the cap taken unconditionally, exporting at €0.214 wins — the bug');
});

test('gate on: unsaturating PV ahead → the cap is dropped, store value is €0.261', () => {
  const slots = runEngine({ positiveGate: true });
  assert.strictEqual(slots[0].pvTrickleCapHonoured, false,
    'PV ahead (1.18 kWh) is under the room (1.48 kWh) → the cap must not be honoured');
  assert.ok(Math.abs(slots[0].pvStoreValue - UNCAPPED_VALUE) < 1e-6,
    `expected the uncapped value ${UNCAPPED_VALUE.toFixed(4)}, got ${slots[0].pvStoreValue.toFixed(4)}`);
  assert.ok(slots[0].pvStoreValue > 0.214,
    'storing (€0.261) must now beat exporting at €0.214');
});

test('the gate does not fire where the PV really saturates', () => {
  // Same prices, but the pvStrong block ahead carries 3.0 kWh — more than the 1.48 kWh of room.
  // The cap then asserts something true and must stand, both with the gate on and off.
  const oe = new OE({
    battery_efficiency: RTE, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering', dp_trickle_cap_positive: true,
  });
  const base = Date.now();
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pv = [539, 539, 1000, 1000, 1000, 1000, 0, 0]; // cov 0.42, 0.42, 1, 1, 1, 1 → 3.2 kWh from t=1
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: pv[h] }));
  const cons = prices.map(() => 200);
  oe.compute(prices, 45, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  const s = oe._schedule.slots;
  assert.strictEqual(s[0].pvTrickleCapHonoured, true,
    'PV ahead exceeds the room → the cap assertion holds and must be honoured');
  assert.ok(Math.abs(s[0].pvStoreValue - CAPPED_VALUE) < 1e-6,
    `saturating case must keep the capped value, got ${s[0].pvStoreValue.toFixed(4)}`);
});

// --- 2. policy-engine: the live gate reads its own copy of the number ------------
// The runtime does not read pvStoreValue; it reads slotMeta.pvTrickleMaxValue and nets the
// cycle cost itself. A fix in the engine alone leaves the hardware on the old €0.110.

const RealDate = Date;
function atAmsterdamMidday(fn) {
  const fixed = new RealDate('2026-09-08T11:00:00.000Z');
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
    { timestamp: '2026-09-08T18:00:00.000Z', price: PEAK_PRICE },
    { timestamp: '2026-09-08T12:00:00.000Z', price: CAP_PRICE },
  ];
  const inputs = {
    battery: { stateOfCharge: 45, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: { resolved_gridPower: -339, pv_power_estimated: 539, avg_consumption_w: 200 },
    tariff: { currentPrice: 0.214, allPrices, slotHours: 0.25 },
    optimizer: { getSlotMeta: () => slotMeta },
  };
  atAmsterdamMidday(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
  return inputs;
}

test('runtime honours the cap when the engine did', () => {
  const out = runFlags({
    pvTrickleMaxValue: CAP_PRICE * RTE, pvTrickleCapHonoured: true,
    action: 'standby', pvStoreValue: CAPPED_VALUE,
  });
  assert.ok(Math.abs(out._pvStoreValue - CAPPED_VALUE) < 1e-6,
    `honoured cap must keep €${CAPPED_VALUE.toFixed(3)}, got ${out._pvStoreValue}`);
  assert.notStrictEqual(out._pvStoreWins, true, 'export at €0.214 still wins there');
});

test('runtime drops the cap when the engine did — the live decision flips to charge', () => {
  const out = runFlags({
    pvTrickleMaxValue: CAP_PRICE * RTE, pvTrickleCapHonoured: false,
    action: 'standby', pvStoreValue: UNCAPPED_VALUE,
  });
  assert.ok(Math.abs(out._pvStoreValue - UNCAPPED_VALUE) < 1e-6,
    `dropped cap must yield €${UNCAPPED_VALUE.toFixed(3)}, got ${out._pvStoreValue}`);
  assert.strictEqual(out._pvStoreWins, true,
    'store €0.261 > export €0.214 → the runtime must force charge');
});

test('an older schedule without the field is unchanged', () => {
  const out = runFlags({
    pvTrickleMaxValue: CAP_PRICE * RTE, action: 'standby', pvStoreValue: CAPPED_VALUE,
  });
  assert.ok(Math.abs(out._pvStoreValue - CAPPED_VALUE) < 1e-6,
    `missing field must behave as honoured, got ${out._pvStoreValue}`);
});

console.log(`\ndp-trickle-cap-positive: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
