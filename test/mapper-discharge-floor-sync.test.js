'use strict';

/**
 * Regression: the runtime discharge floor must be the same floor the DP and the chart use.
 *
 * Live 2026-08-17, evening peak (all times UTC):
 *   [MAPPING] safe break-even €0.408 (eff=0.720, cycleCost=€0.075/kWh)
 *   [MAPPING] policyMode=discharge, soc=40, ..., price=0.392
 *   ✅ Successfully applied: standby
 *
 * The DP planned discharge on a €0.102 floor (cycle_cost / battery_efficiency, the same floor
 * buildPlanningSchedule draws the chart with), while _mapPolicyToHwMode re-derived its own floor
 * from the cost model as avgCost/eff + cycleCost*0.5 = €0.408 and silently returned standby.
 * €0.408 sat above every price in the 48h horizon (max €0.396), so the battery could not discharge
 * at all. Measured over the log: 0 blocked runs/day for 32 days, then 10 of 19 on 08-17 — avgCost
 * had been inflated by the expensive charges of project_mapper_ignores_pvstorewins_0817.
 *
 * avgCost is a sunk cost: holding the kWh does not earn it back. Which slot to sell in is the DP's
 * job, over the horizon — not a second, differently-derived gate at t=0.
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

// Live 2026-08-17 shape. battery_efficiency 0.735 with a learned RTE of 0.720 reproduces the
// logged eff=0.720 and, with avgCost 0.267, the logged break-even of €0.408.
const CYCLE_COST = 0.075;
const CONFIGURED_EFF = 0.735;
const SETTINGS_FLOOR = CYCLE_COST / CONFIGURED_EFF; // €0.102 — the DP's and the chart's floor
const AVG_COST = 0.267;

function settings(respectMinMax) {
  return {
    tariff_type: 'dynamic',
    min_soc: 5,
    max_soc: 95,
    max_charge_price: 0.221,
    min_discharge_price: 0.22,
    respect_minmax: respectMinMax,
    cycle_cost_per_kwh: CYCLE_COST,
    battery_efficiency: CONFIGURED_EFF,
    min_profit_margin: 0.01,
    policy_mode: 'balanced',
    tariff_model: 'saldering',
  };
}

// Evening run: sun well down, house importing, battery idle at 40%.
function runtimeCtx(price, { withCostModel = true } = {}) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 40, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    tariff: { currentPrice: price },
    evCharging: false,
    _delayCharge: false,
    _pvStoreWins: false,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: 407,
      battery_power: 0,
      pv_power_estimated: 0,
      avg_consumption_w: 407,
    },
    batteryCost: withCostModel ? { avgCost: AVG_COST, energyKwh: 1.1 } : { avgCost: 0, energyKwh: 0 },
    batteryEfficiency: 0.720,
    weather: {
      todaySunset: new Date(now - 2 * 3_600_000),
      todaySunrise: new Date(now - 14 * 3_600_000),
    },
  };
}

// What buildPlanningSchedule hands the planning mapper in opportunistic mode: the settings floor.
function planningArgs(price) {
  return {
    price,
    soc: 40,
    pvW: 0,
    consumptionW: 407,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.221,
    minDischargePrice: SETTINGS_FLOOR,
    minSoc: 5,
    maxSoc: 95,
    futurePrices: [],
    battChargePowerW: 800,
    pvStoreValue: null,
    exportPrice: null,
    battCapKwh: 2.688,
    pvKwhTomorrow: 0,
    refillConfidence: 1,
  };
}

const discharges = (mode) => mode === 'zero_discharge_only' || mode === 'zero';

// ─── 1. The live 2026-08-17 run ───────────────────────────────────────────────

test('runtime: DP discharge at €0.392 is not blocked by the cost model', () => {
  const eng = new PolicyEngine({ log() {} }, settings(false));
  const mode = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.392));
  assert.strictEqual(mode, 'zero_discharge_only',
    `price €0.392 clears the €${SETTINGS_FLOOR.toFixed(3)} floor the DP planned on; `
    + `avgCost €${AVG_COST} is sunk and must not gate, got '${mode}'`);
});

test('runtime: floor itself still holds below €0.102', () => {
  const eng = new PolicyEngine({ log() {} }, settings(false));
  const mode = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.05));
  assert.ok(!discharges(mode),
    `below the cycle-cost floor discharging loses money, got '${mode}'`);
});

// The cost model must not change the outcome at all any more: same price, same verdict with and
// without stored-cost history. Without this, the fix could be mistaken for "cost model absent".
test('runtime: verdict is identical with and without a cost model', () => {
  const eng = new PolicyEngine({ log() {} }, settings(false));
  const withCost    = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.392, { withCostModel: true }));
  const withoutCost = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.392, { withCostModel: false }));
  assert.strictEqual(withCost, withoutCost,
    `the cost model must no longer move the discharge decision, got '${withCost}' vs '${withoutCost}'`);
});

// ─── 2. Cross-mapper agreement (the check no existing test performs) ───────────
//
// dp-planning-tile-sync.test.js only exercises buildPlanningSchedule, only with preserve/standby
// actions, and only in strict mode — so runtime-vs-chart discharge divergence was untested.

test('runtime and chart agree on discharge across the price range', () => {
  const eng = new PolicyEngine({ log() {} }, settings(false));
  const mismatches = [];
  for (const price of [0.05, 0.09, 0.11, 0.15, 0.22, 0.28, 0.35, 0.392, 0.45]) {
    const runtime  = discharges(eng._mapPolicyToHwMode('discharge', runtimeCtx(price)));
    const planning = discharges(eng._mapActionToHwModeForPlanning('discharge', planningArgs(price)).hwMode);
    if (runtime !== planning) mismatches.push(`€${price.toFixed(3)}: runtime=${runtime} chart=${planning}`);
  }
  assert.deepStrictEqual(mismatches, [],
    `chart and runtime must not disagree on discharging:\n   ${mismatches.join('\n   ')}`);
});

// ─── 3. Strict mode is untouched ──────────────────────────────────────────────

test('strict mode: min_discharge_price still blocks below €0.22', () => {
  const eng = new PolicyEngine({ log() {} }, settings(true));
  const mode = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.15));
  assert.ok(!discharges(mode),
    `respect_minmax=true must keep honouring min_discharge_price, got '${mode}'`);
});

test('strict mode: discharges above min_discharge_price', () => {
  const eng = new PolicyEngine({ log() {} }, settings(true));
  const mode = eng._mapPolicyToHwMode('discharge', runtimeCtx(0.392));
  assert.strictEqual(mode, 'zero_discharge_only',
    `above min_discharge_price strict mode must discharge, got '${mode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
