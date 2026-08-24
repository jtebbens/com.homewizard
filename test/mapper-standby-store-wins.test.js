'use strict';

/**
 * Regression: the standby branch must honour the store-vs-export verdict.
 *
 * Live 2026-08-24 13:02:57Z (15:02 local), one policy run under tariff_model=asymmetric_2027:
 *   PV OVERSCHOT: storing beats exporting (max €0.424 × 0.72 − cycle €0.075 = €0.230
 *                 > export €0.077) → force charge
 *   [MAPPING] policyMode=standby, soc=70, PV=true (pvEst=3600W, pvP1=2866W, netSurplus≈2549W)
 *   [MAPPING] standby (DP: PV export beats storage at current price)
 *
 * Storing won by €0.153/kWh and the battery still idled with 2.5 kW going to the grid at
 * €0.077. The DP planned export from the slot's FORECAST export price; _pvStoreWins is that
 * same test re-run on the LIVE price. Every other branch reads it — charge (:1497),
 * trickle (:1544), preserve (:1564), discharge (:1474) — standby never did.
 *
 * Under saldering the gap was invisible: export == retail price, so storing rarely won on a
 * slot the DP had already marked for export. Asymmetric export prices split the two apart.
 *
 * The planning mapper's `action === 'standby'` branch had the identical hole, so fixing only
 * the runtime would make the chart project export on slots the battery now banks.
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
  max_charge_price: 0.241,
  min_discharge_price: 0.22,
  respect_minmax: true,
  cycle_cost_per_kwh: 0.075,
  battery_efficiency: 0.72,
  min_profit_margin: 0.01,
  policy_mode: 'balanced',
  tariff_model: 'asymmetric_2027',
};

// Live shape of the 13:02:57Z run: DP says standby (it planned export), real surplus on the
// meter, SoC 70% with headroom to 95%, price well under the charge ceiling.
function runtimeCtx(pvStoreWins, over = {}) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 70, maxChargePowerW: 800 },
    tariff: { currentPrice: 0.192, currentExportPrice: 0.077 },
    evCharging: false,
    _delayCharge: false,
    _pvStoreWins: pvStoreWins,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: -2549,
      battery_power: 0,
      pv_power_estimated: 3600,
      avg_consumption_w: 1051,
    },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: 0.72,
    weather: { todaySunset: new Date(now + 5 * 3_600_000), todaySunrise: new Date(now - 8 * 3_600_000) },
    ...over,
  };
}

function planningArgs(pvStoreValue, over = {}) {
  return {
    price: 0.192,
    soc: 70,
    pvW: 3600,
    consumptionW: 1051,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.241,
    minDischargePrice: 0.22,
    minSoc: 5,
    maxSoc: 95,
    futurePrices: [],
    battChargePowerW: 800,
    pvStoreValue,
    exportPrice: 0.077,
    battCapKwh: 2.688,
    pvKwhTomorrow: 0,
    refillConfidence: 1,
    ...over,
  };
}

// ─── Runtime mapper ───────────────────────────────────────────────────────────

test('runtime: store wins on a DP-standby slot → bank the surplus', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(true));
  assert.strictEqual(mode, 'zero_charge_only',
    `store €0.230 > export €0.077 with 2549W surplus must bank, got '${mode}'`);
});

// The DP can plan standby on a slot where storing beats exporting, because a pvStrong slot
// before the same peak stores the same kWh at a lower forgone export (cheaperPvAhead). Banking
// here fills the room that cheaper slot was meant to fill, so the cheap PV is exported instead.
// Live 2026-08-24: the plan showed 13 such overrides in a row (08:15-11:15, forgone export
// EUR0.207 falling to EUR0.069), and buildPlanningSchedule then carried two SoC paths at once.
test('runtime: store wins but the DP defers to cheaper PV → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(true, { _pvDeferToCheaperPv: true }));
  assert.strictEqual(mode, 'standby',
    `a deliberate deferral must not be overridden, got '${mode}'`);
});

test('chart: store wins but the DP defers to cheaper PV → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby',
    planningArgs(0.230, { cheaperPvAhead: true }));
  assert.strictEqual(hwMode, 'standby',
    `chart must project the deferral, not a charge the runtime no longer performs, got '${hwMode}'`);
});

test('runtime: export wins → standby unchanged', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(false));
  assert.strictEqual(mode, 'standby',
    `_pvStoreWins=false must still idle and export, got '${mode}'`);
});

test('runtime: no verdict (undefined) keeps current behaviour', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(undefined));
  assert.strictEqual(mode, 'standby',
    `without a verdict the branch must not change behaviour, got '${mode}'`);
});

test('runtime: store wins but battery full → standby (no headroom)', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(true, {
    battery: { stateOfCharge: 95, maxChargePowerW: 800 },
  }));
  assert.strictEqual(mode, 'standby',
    `at max_soc there is nothing to bank, got '${mode}'`);
});

test('runtime: store wins but no live PV → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(true, {
    p1: { resolved_gridPower: 400, battery_power: 0, pv_power_estimated: 0, avg_consumption_w: 400 },
  }));
  assert.strictEqual(mode, 'standby',
    `no surplus to harvest must not flip the mode, got '${mode}'`);
});

// ─── Planning mapper (chart) — must not diverge from the runtime ──────────────

test('chart: store wins on a DP-standby slot → zero_charge_only', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(0.230));
  assert.strictEqual(hwMode, 'zero_charge_only',
    `chart must project the charge the runtime now performs, got '${hwMode}'`);
});

test('chart: export wins on a DP-standby slot → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  // Evening shape from the same schedule: store €0.182 ≤ export €0.206.
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(0.182, {
    price: 0.333, exportPrice: 0.206,
  }));
  assert.strictEqual(hwMode, 'standby',
    `export €0.206 > store €0.182 must stay on export, got '${hwMode}'`);
});

test('chart: no store value → standby unchanged', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(null));
  assert.strictEqual(hwMode, 'standby',
    `without a store value the branch must not change behaviour, got '${hwMode}'`);
});

test('chart: store wins but battery full → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(0.230, { soc: 95 }));
  assert.strictEqual(hwMode, 'standby',
    `at max_soc there is nothing to bank, got '${hwMode}'`);
});

// ─── Saldering must be bit-identical to the pre-fix behaviour ─────────────────
// The user still runs saldering in 2026 and switches asymmetric_2027 on only to test.
// Under saldering export credits the retail price, so _pvStoreWins can be true on a far
// peak (store €0.230 > price €0.192) — without the tariff gate this branch would charge
// where the old code idled.

const SALDERING = { ...SETTINGS, tariff_model: 'saldering' };

test('saldering runtime: store wins → standby (unchanged)', () => {
  const eng = new PolicyEngine({ log() {} }, SALDERING);
  const mode = eng._mapPolicyToHwMode('standby', runtimeCtx(true));
  assert.strictEqual(mode, 'standby',
    `saldering must keep the pre-fix behaviour, got '${mode}'`);
});

test('saldering chart: store wins → standby (unchanged)', () => {
  const eng = new PolicyEngine({ log() {} }, SALDERING);
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(0.230));
  assert.strictEqual(hwMode, 'standby',
    `saldering chart must keep the pre-fix behaviour, got '${hwMode}'`);
});

test('saldering: no tariff_model set defaults to saldering → standby', () => {
  const noModel = { ...SETTINGS };
  delete noModel.tariff_model;
  const eng = new PolicyEngine({ log() {} }, noModel);
  assert.strictEqual(eng._mapPolicyToHwMode('standby', runtimeCtx(true)), 'standby',
    'missing tariff_model must not enable the asymmetric branch');
});

// ─── Runtime and chart must agree on the same slot ────────────────────────────

test('sync: runtime and chart return the same mode on the live 13:02Z slot', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const runtime = eng._mapPolicyToHwMode('standby', runtimeCtx(true));
  const { hwMode } = eng._mapActionToHwModeForPlanning('standby', planningArgs(0.230));
  assert.strictEqual(runtime, hwMode,
    `runtime '${runtime}' and chart '${hwMode}' must not diverge on the same slot`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
