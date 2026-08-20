'use strict';

/**
 * Regression: the charge branch above max_charge_price must honour the export test.
 *
 * Live 2026-08-17 07:15:00Z, one policy run:
 *   PV OVERSCHOT: export more profitable (export €0.378 > €0.194, margin €0.184) → standby
 *   Optimizer: 24h-DP → charge (0.200kWh)
 *   [MAPPING][CHARGE] price €0.378 > max_charge_price, PV active (635W) → zero_charge_only
 *
 * The store-vs-export comparison ran, answered "exporting wins", and the fallback branch
 * charged anyway — while its three sibling branches (discharge, positive charge, preserve)
 * all read _pvStoreWins. Scored that day: 0.511 kWh bought at €0.31-0.38, ≈€0.078.
 *
 * The planning mapper had the same hole in its charge branch while its own preserve branch
 * already compared storeValue against exportValue — fixing only the runtime would make the
 * chart project a charge the battery no longer performs.
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  process.stdout.write(`[${name}] ... `);
  try { fn(); console.log('✓ PASS'); passed++; }
  catch (err) { console.log('✗ FAIL'); console.error(`   ${String(err.message || err)}`); failed++; }
}

const SETTINGS = {
  tariff_type: 'dynamic',
  min_soc: 5,
  max_soc: 95,
  max_charge_price: 0.225,
  min_discharge_price: 0.22,
  respect_minmax: true,
  cycle_cost_per_kwh: 0.075,
  battery_efficiency: 0.85,
  min_profit_margin: 0.01,
  policy_mode: 'balanced',
  tariff_model: 'saldering',
};

// Live shape of the 07:15Z run: DP says charge, price far above the ceiling, real PV export
// on the meter, mid SoC so no floor/ceiling guard fires first.
function runtimeCtx(pvStoreWins, over = {}) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 50, maxChargePowerW: 800 },
    tariff: { currentPrice: 0.378 },
    evCharging: false,
    _delayCharge: false,
    _pvStoreWins: pvStoreWins,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: -635,
      battery_power: 0,
      pv_power_estimated: 1035,
      avg_consumption_w: 400,
    },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: 0.85,
    weather: { todaySunset: new Date(now + 6 * 3_600_000), todaySunrise: new Date(now - 3 * 3_600_000) },
    ...over,
  };
}

function planningArgs(pvStoreValue, over = {}) {
  return {
    price: 0.378,
    soc: 50,
    pvW: 1035,
    consumptionW: 400,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.225,
    minDischargePrice: 0.22,
    minSoc: 5,
    maxSoc: 95,
    futurePrices: [],
    battChargePowerW: 800,
    pvStoreValue,
    exportPrice: null,
    battCapKwh: 2.688,
    pvKwhTomorrow: 0,
    refillConfidence: 1,
    ...over,
  };
}

// ─── Runtime mapper ───────────────────────────────────────────────────────────

test('runtime: export wins → standby, not zero_charge_only', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx(false));
  assert.strictEqual(mode, 'standby',
    `DP charge at €0.378 > ceiling €0.225 with _pvStoreWins=false must idle and export, got '${mode}'`);
});

test('runtime: store wins → still captures PV', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx(true));
  assert.strictEqual(mode, 'zero_charge_only',
    `storing beats exporting → PV must still be banked, got '${mode}'`);
});

// Gap 1 (preserve fallback at policy-engine.js:1516) runs on _pvStoreWins === undefined and is
// deliberately NOT part of this fix. Pin the current behaviour so closing it later is a visible,
// intentional change rather than a silent side effect.
test('runtime: no verdict (undefined) keeps current behaviour', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx(undefined));
  assert.strictEqual(mode, 'zero_charge_only',
    `without a verdict the branch must not change behaviour, got '${mode}'`);
});

// ─── Planning mapper (chart) — must not diverge from the runtime ──────────────

test('chart: export wins → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  // storeValue €0.194 ≤ exportValue €0.378 (saldering ⇒ export == import price)
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge', planningArgs(0.194));
  assert.strictEqual(hwMode, 'standby',
    `chart must project the same idle-and-export the runtime performs, got '${hwMode}'`);
});

test('chart: store wins → zero_charge_only', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge', planningArgs(0.52));
  assert.strictEqual(hwMode, 'zero_charge_only',
    `storeValue above exportValue must keep the PV capture, got '${hwMode}'`);
});

test('chart: no store value → unchanged behaviour', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge', planningArgs(null));
  assert.strictEqual(hwMode, 'zero_charge_only',
    `slots without a DP store value must not flip, got '${hwMode}'`);
});

// ─── Below the price ceiling — live miss 2026-08-20 11:45 ─────────────────────
// Both mappers returned to_full on `price <= maxChargePrice` before their own export test
// could run. Live: "cheap hour €0.200 <= max_charge_price €0.206 → to_full" on a slot where
// storing was worth €0.195 against a €0.200 export. Same veto as above the ceiling, one
// branch earlier.

test('runtime: cheap hour but export wins → standby, not to_full', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx(false, { tariff: { currentPrice: 0.200 } }));
  assert.strictEqual(mode, 'standby',
    `€0.200 under the ceiling with _pvStoreWins=false must idle and export, got '${mode}'`);
});

test('chart: cheap hour but export wins → standby, not to_full', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge',
    planningArgs(0.195, { price: 0.200, maxChargePrice: 0.206 }));
  assert.strictEqual(hwMode, 'standby',
    `chart must project the same idle-and-export the runtime performs, got '${hwMode}'`);
});

// The guard that keeps the two mappers symmetric: without PV the runtime has no _pvStoreWins
// verdict at all, so the chart must not veto a grid charge the battery does perform.
test('chart: cheap hour without PV still charges from the grid', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge',
    planningArgs(0.195, { price: 0.200, maxChargePrice: 0.206, pvW: 0 }));
  assert.strictEqual(hwMode, 'to_full',
    `night grid charge must survive the export test, got '${hwMode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
