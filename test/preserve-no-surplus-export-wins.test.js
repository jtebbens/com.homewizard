'use strict';

/**
 * Regression: a DP 'preserve' slot with PV but no net surplus at run time must still get the
 * store-vs-export verdict, or the mapper banks PV worth more on the grid.
 *
 * Live 2026-09-29 14:30:11Z (16:30 CEST):
 *   plan slot: preserve, pvStoredByDp=false → chart 'preserve:export_wins(store€0.238≤exp€0.325)'
 *   [MAPPING] policyMode=preserve, soc=65, PV=true (pvEst=325W, netSurplus≈0W), price=0.325
 *   → no 'PV OVERSCHOT' line (_computePvFlags returned at the <50W surplus gate),
 *     _pvStoreWins undefined → mapper :1738 'zero_charge_only' while storing (€0.238) lost to
 *     exporting (€0.325). At 14:00Z/14:15Z (surplus ≥50W) the same test said standby.
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

const RealDate = Date;
function atLiveRun(fn) {
  const fixed = new RealDate('2026-09-29T14:30:11.000Z');
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

function run({ dpAction = 'preserve', price = 0.325, meta = {} } = {}) {
  const settings = {
    tariff_type: 'dynamic',
    min_soc: 0,
    max_soc: 100,
    max_charge_price: 0.15,
    min_discharge_price: 0.22,
    respect_minmax: false,
    cycle_cost_per_kwh: 0.075,
    battery_efficiency: 0.731,
    min_profit_margin: 0.01,
    policy_mode: 'balanced',
    tariff_model: 'saldering',
  };
  const eng = new PolicyEngine({ log() {} }, settings);
  const inputs = {
    policyMode: 'balanced',
    battery: { stateOfCharge: 65, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    tariff: {
      currentPrice: price,
      allPrices: [
        { timestamp: '2026-09-29T16:45:00.000Z', price: 0.428 },
        { timestamp: '2026-09-29T18:00:00.000Z', price: 0.366 },
      ],
      slotHours: 0.25,
    },
    dynamicMaxChargePrice: 0.238,
    evCharging: false,
    _chargeUrgent: false,
    // PV present, house load covers it: net surplus 0W.
    p1: {
      resolved_gridPower: 30,
      battery_power: 0,
      pv_power_estimated: 325,
      avg_consumption_w: 655,
    },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: 0.731,
    effectiveRte: 0.731,
    optimizer: { getSlotMeta: () => ({ action: dpAction, pvStoredByDp: false, ...meta }) },
  };
  return atLiveRun(() => {
    inputs.weather = { todaySunset: new Date(Date.now() + 2 * 3_600_000) };
    eng._computePvFlags(inputs);
    return { flags: inputs, mode: eng._mapPolicyToHwMode(dpAction, inputs) };
  });
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('preserve-no-surplus-export-wins');

test('preserve, 0W surplus, export €0.325 > store €0.238 → standby', () => {
  const { flags, mode } = run({});
  assert.strictEqual(flags._pvStoreWins, false, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.strictEqual(mode, 'standby', `got '${mode}'`);
});

test('preserve, 0W surplus, store wins (price €0.15) → zero_charge_only unchanged', () => {
  const { flags, mode } = run({ price: 0.15 });
  assert.strictEqual(flags._pvStoreWins, true, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.strictEqual(mode, 'zero_charge_only', `got '${mode}'`);
});

// The widened gate is preserve-only: a DP charge slot at 0W surplus keeps its old path
// (no verdict → the export test in the CHARGE branch cannot block a grid charge on PV that isn't there).
test('DP charge, 0W surplus: no verdict, flags untouched', () => {
  const { flags } = run({ dpAction: 'charge' });
  assert.strictEqual(flags._pvStoreWins, undefined, `_pvStoreWins=${flags._pvStoreWins}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
