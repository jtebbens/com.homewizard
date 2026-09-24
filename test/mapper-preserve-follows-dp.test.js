'use strict';

/**
 * Regression: a DP 'preserve' slot must not be parked in standby by the policy layer's own
 * export-vs-store re-derivation (_computePvFlags → _pvStoreWins === false → mapper standby).
 *
 * Live 2026-09-24 13:18:17Z (15:18 CEST), run right after an app restart:
 *   DP: v[preserve=1.1061 charge=1.1061] → preserve (standby valued lower, so storing beat exporting)
 *   PV OVERSCHOT: cap bindt, waarde tot vol-punt €0.138 → export more profitable (export €0.216)
 *   [MAPPING][PRESERVE] export wins (_pvStoreWins=false) → standby (PV to grid)
 * 27s earlier the same check read €0.276 (pvKwhFromT1 5.77 → 6.28 kWh) and the battery charged.
 * The DP already prices export in vPreserve/vStandby (optimization-engine _runBackwardDP), so a
 * second decider on the same question flipped the battery on forecast noise.
 * dp_mapper_follows_preserve (hidden, default on) makes the policy layer follow the DP.
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

const RealDate = Date;
function atLiveRun(fn) {
  const fixed = new RealDate('2026-09-24T13:18:17.000Z');
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

function run({ followDp, dpAction = 'preserve' } = {}) {
  const settings = {
    tariff_type: 'dynamic',
    min_soc: 0,
    max_soc: 100,
    max_charge_price: 0.15,
    min_discharge_price: 0.22,
    respect_minmax: false,
    cycle_cost_per_kwh: 0.075,
    battery_efficiency: 0.73,
    min_profit_margin: 0.01,
    policy_mode: 'balanced',
    tariff_model: 'saldering',
  };
  if (followDp !== undefined) settings.dp_mapper_follows_preserve = followDp;
  const eng = new PolicyEngine({ log() {} }, settings);
  const inputs = {
    policyMode: 'balanced',
    battery: { stateOfCharge: 71, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    tariff: {
      currentPrice: 0.216,
      allPrices: [
        { timestamp: '2026-09-24T17:00:00.000Z', price: 0.503 },
        { timestamp: '2026-09-25T11:00:00.000Z', price: 0.138 },
      ],
      slotHours: 0.25,
    },
    dynamicMaxChargePrice: 0.276,
    evCharging: false,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: -374,
      battery_power: 800,
      pv_power_estimated: 1674,
      avg_consumption_w: 460,
    },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: 0.73,
    // Cap-bound store value from the live run: PV ahead fills the battery, value to full-point €0.138.
    optimizer: { getSlotMeta: () => ({ action: dpAction, pvTrickleMaxValue: 0.138 }) },
  };
  return atLiveRun(() => {
    inputs.weather = { todaySunset: new Date(Date.now() + 3 * 3_600_000) };
    eng._computePvFlags(inputs);
    return { flags: inputs, mode: eng._mapPolicyToHwMode(dpAction, inputs) };
  });
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('mapper-preserve-follows-dp');

test('flag off reproduces 13:18Z: store €0.138 < export €0.216 → standby', () => {
  const { flags, mode } = run({ followDp: false });
  assert.strictEqual(flags._pvStoreWins, false, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.strictEqual(mode, 'standby', `got '${mode}'`);
});

test('default (flag on): DP preserve → store PV (zero_charge_only), explainability follows DP', () => {
  const { flags, mode } = run({});
  assert.strictEqual(flags._pvStoreWins, true, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.strictEqual(flags._pvWeakOwnedByDp, true, 'explainability must repeat the DP verdict');
  assert.strictEqual(mode, 'zero_charge_only', `mapper overrode DP preserve; got '${mode}'`);
});

test('flag on, DP charge: preserve-follow does not touch other DP actions', () => {
  const on = run({ dpAction: 'charge' });
  const off = run({ dpAction: 'charge', followDp: false });
  assert.strictEqual(on.flags._pvStoreWins, off.flags._pvStoreWins);
  assert.strictEqual(on.mode, off.mode);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
