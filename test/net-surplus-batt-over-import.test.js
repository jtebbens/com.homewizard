'use strict';

/**
 * Regression: net PV surplus read 0W while the battery charged harder than the grid supplied.
 *
 * Live 2026-09-16 11:29:51Z (13:29 local), PV OFF→ON event run:
 *   [MAPPING] policyMode=preserve, soc=12, PV=true (sticky=true, pvEst=398W, pvP1=290W, netSurplus≈0W)
 *   [MAPPING][PRESERVE] no net surplus (0W) → standby (idle, no cycle)
 * Meter at that moment: grid +598W import, battery +800W charging. At least 202W of that charge
 * came from PV, yet the battery term in _netPvSurplusW only counted when grid <= 0. The remaining
 * pvEst − avgConsumption term leaned on a flow PV value 4m51s old (398W; 970W 11s later).
 *
 * Energy balance at the meter: PV + grid = load + batt → PV − load = batt − grid. While the battery
 * charges, batt − max(0, grid) is the measured surplus; for grid <= 0 it equals the old term.
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

const surplus = (p1) => PolicyEngine.prototype._netPvSurplusW(p1);

// avg_consumption_w 888 = pvP1 290 + grid 598 (pvFromP1 = avg − grid in the mapper log).
const LIVE_P1 = { resolved_gridPower: 598, battery_power: 800, pv_power_estimated: 398, avg_consumption_w: 888 };

test('live 13:29: battery 800W over grid import 598W → 202W surplus', () => {
  assert.strictEqual(surplus(LIVE_P1), 202);
});

test('grid exporting while charging → battery term unchanged', () => {
  assert.strictEqual(surplus({ resolved_gridPower: -300, battery_power: 800, pv_power_estimated: 0, avg_consumption_w: 400 }), 800);
});

test('grid exactly 0 while charging → battery term unchanged', () => {
  assert.strictEqual(surplus({ resolved_gridPower: 0, battery_power: 600, pv_power_estimated: 0, avg_consumption_w: 400 }), 600);
});

test('battery charging less than grid import → no surplus', () => {
  assert.strictEqual(surplus({ resolved_gridPower: 598, battery_power: 300, pv_power_estimated: 0, avg_consumption_w: 400 }), 0);
});

test('battery discharging while importing → no surplus', () => {
  assert.strictEqual(surplus({ resolved_gridPower: 200, battery_power: -500, pv_power_estimated: 0, avg_consumption_w: 400 }), 0);
});

test('battery idle (≤50W) → falls back to PV-vs-load term', () => {
  assert.strictEqual(surplus({ resolved_gridPower: 100, battery_power: 50, pv_power_estimated: 900, avg_consumption_w: 400 }), 500);
});

test('PV-vs-load term still wins when larger', () => {
  assert.strictEqual(surplus({ resolved_gridPower: 100, battery_power: 300, pv_power_estimated: 1400, avg_consumption_w: 400 }), 1000);
});

// ─── Runtime mapper on the live slot ──────────────────────────────────────────

const SETTINGS = {
  tariff_type: 'dynamic',
  min_soc: 5,
  max_soc: 95,
  max_charge_price: 0.26,
  min_discharge_price: 0.22,
  respect_minmax: true,
  cycle_cost_per_kwh: 0.075,
  battery_efficiency: 0.73,
  policy_mode: 'balanced',
};

function liveCtx(p1) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 12, maxChargePowerW: 800 },
    tariff: { currentPrice: 0.249 },
    evCharging: false,
    p1,
    weather: { todaySunset: new Date(now + 5 * 3_600_000), todaySunrise: new Date(now - 6 * 3_600_000) },
  };
}

test('mapper preserve: live 13:29 slot → absorb PV, not standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('preserve', liveCtx(LIVE_P1));
  assert.strictEqual(mode, 'zero_charge_only',
    `202W measured surplus must not idle the battery, got '${mode}'`);
});

test('mapper preserve: battery below grid import → standby unchanged', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('preserve', liveCtx({ ...LIVE_P1, battery_power: 300 }));
  assert.strictEqual(mode, 'standby', `no measured surplus must stay standby, got '${mode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
