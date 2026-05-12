'use strict';

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const homey = { log() {} };
const SETTINGS = {
  tariff_type: 'dynamic',
  battery_efficiency: 0.7415781214938163,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  respect_minmax: true,
  policy_mode: 'balanced',
};

function makeEngine() {
  return new PolicyEngine(homey, { ...SETTINGS });
}

console.log('\nPolicyEngine — charge/planning regressions\n');

test('runtime charge uses dynamic max and keeps to_full when PV does not provide net surplus', () => {
  const engine = makeEngine();
  const mode = engine._mapPolicyToHwMode('charge', {
    policyMode: 'balanced',
    dynamicMaxChargePrice: 0.175,
    battery: {
      stateOfCharge: 11,
      maxChargePowerW: 1600,
    },
    tariff: {
      currentPrice: 0.164,
    },
    p1: {
      resolved_gridPower: 15,
      battery_power: 0,
      pv_power_estimated: 1974,
      avg_consumption_w: 1989,
    },
  });
  assert.strictEqual(mode, 'to_full');
});

test('planning mapping keeps charge as to_full on cheap hours with PV but no surplus', () => {
  const engine = makeEngine();
  const mapped = engine._mapActionToHwModeForPlanning('charge', {
    price: 0.164,
    soc: 11,
    pvW: 1974,
    consumptionW: 1989,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.175,
    minDischargePrice: 0.25,
    minSoc: 0,
    maxSoc: 100,
    futurePrices: [],
    battChargePowerW: 1600,
  });
  assert.strictEqual(mapped.hwMode, 'to_full');
});

test('planning schedule uses actual battery capacity for SoC projection', () => {
  const engine = makeEngine();
  const start = new Date('2026-05-12T13:00:00.000Z');
  const slots = [
    {
      timestamp: start.toISOString(),
      action: 'preserve',
      price: 0.21,
      socProjected: 0,
      consumptionW: 0,
    },
    {
      timestamp: new Date(start.getTime() + 3_600_000).toISOString(),
      action: 'preserve',
      price: 0.22,
      socProjected: 0,
      consumptionW: 0,
    },
  ];
  const pvForecast = [
    { timestamp: slots[0].timestamp, pvPowerW: 1600 },
    { timestamp: slots[1].timestamp, pvPowerW: 1600 },
  ];
  const schedule = engine.buildPlanningSchedule(
    slots,
    pvForecast,
    null,
    1600,
    0.175,
    5.376
  );
  assert.ok(schedule[1].socProjected > 29 && schedule[1].socProjected < 31,
    `Expected ~30% SoC after 1h @ 1600W on 5.376kWh, got ${schedule[1].socProjected}%`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
