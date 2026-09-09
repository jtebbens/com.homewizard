'use strict';

/**
 * Regression: a DP charge slot under the price ceiling was executed as zero_charge_only
 * whenever PV surplus was present, so the battery could not pull the missing watts from
 * the grid when a cloud collapsed the surplus mid-slot.
 *
 * Live 2026-09-09 (Insights energy_power, 1-min samples, Amsterdam local). Full rate is
 * 800W = 200Wh = 7.4pp SoC per quarter:
 *   15:00  447W avg → 112Wh (+4.2pp)   88Wh short
 *   15:30  677W avg → 169Wh (+6.3pp)   31Wh short
 *   15:45  496W avg → 124Wh (+4.6pp)   76Wh short
 * 195Wh lost = 7.3pp SoC, a full quarter of charging, at €0.197–0.206 against a
 * €0.241 ceiling — grid charging was economically approved the whole time. The 15:45 run:
 *   [MAPPING][CHARGE] _pvStoreWins + sustained PV surplus (1447W), soc=64% → zero_charge_only
 *
 * The planning mapper never had this branch (price <= maxChargePrice → to_full), so the chart
 * published to_full for slots the runtime executed as zero_charge_only.
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  process.stdout.write(`[${name}] ... `);
  try { fn(); console.log('✓ PASS'); passed++; }
  catch (err) { console.log('✗ FAIL'); console.error(`   ${String(err.message || err)}`); failed++; }
}

const CYCLE = 0.075;
const RTE   = 0.7326;

const SETTINGS = {
  tariff_type: 'dynamic',
  min_soc: 5,
  max_soc: 95,
  max_charge_price: 0.241,
  min_discharge_price: 0.22,
  respect_minmax: true,
  cycle_cost_per_kwh: CYCLE,
  battery_efficiency: RTE,
  min_profit_margin: 0.01,
  policy_mode: 'balanced',
  tariff_model: 'saldering',
};

// The live 15:45 shape: pvEst 2155W, learned load 708W → net surplus 1447W, exporting.
function runtimeCtx(over = {}) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 61, maxChargePowerW: 800 },
    tariff: { currentPrice: 0.197 },
    evCharging: false,
    _delayCharge: false,
    _pvStoreWins: true,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: -800,
      battery_power: 0,
      pv_power_estimated: 2155,
      avg_consumption_w: 708,
    },
    batteryCost: { avgCost: 0.196, energyKwh: 1.6 },
    batteryEfficiency: RTE,
    weather: { todaySunset: new Date(now + 4 * 3_600_000), todaySunrise: new Date(now - 8 * 3_600_000) },
    ...over,
  };
}

function planningArgs(over = {}) {
  return {
    price: 0.197,
    soc: 61,
    pvW: 2155,
    consumptionW: 708,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.241,
    minDischargePrice: 0.22,
    minSoc: 5,
    maxSoc: 95,
    futurePrices: [],
    battChargePowerW: 800,
    pvStoreValue: 0.45,
    exportPrice: null,
    battCapKwh: 2.688,
    pvKwhTomorrow: 0,
    refillConfidence: 1,
    ...over,
  };
}

// ─── The fix: a cheap DP charge slot charges at full rate, PV surplus or not ───

test('runtime charge: cheap price + PV surplus → to_full', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx());
  assert.strictEqual(mode, 'to_full',
    `€0.197 ≤ ceiling €0.241 must charge at full rate so a PV dip is filled from the grid, got '${mode}'`);
});

// Runtime and chart must agree — socProjected is published from the chart mapper's view.
test('sync: runtime and planning mapper agree on the same slot', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const runtime = eng._mapPolicyToHwMode('charge', runtimeCtx());
  const { hwMode } = eng._mapActionToHwModeForPlanning('charge', planningArgs());
  assert.strictEqual(runtime, hwMode,
    `chart projects '${hwMode}' while the runtime executes '${runtime}'`);
});

// ─── Containment: everything the ceiling still governs stays as it was ─────────

test('runtime charge: price above the ceiling keeps PV-only capture', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx({ tariff: { currentPrice: 0.310 } }));
  assert.strictEqual(mode, 'zero_charge_only',
    `above the ceiling grid charging is off the table, got '${mode}'`);
});

test('runtime charge: export wins still idles the battery', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx({ _pvStoreWins: false }));
  assert.strictEqual(mode, 'standby',
    `exporting beats storing → PV must go to the grid, got '${mode}'`);
});

test('runtime charge: no PV at a cheap price is unchanged', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('charge', runtimeCtx({
    _pvStoreWins: undefined,
    p1: { resolved_gridPower: 400, battery_power: 0, pv_power_estimated: 0, avg_consumption_w: 400 },
  }));
  assert.strictEqual(mode, 'to_full',
    `night grid charge must stay to_full, got '${mode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
