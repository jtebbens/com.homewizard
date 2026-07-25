'use strict';

// Regression: peak-shaving forced discharge must not be silently downgraded to
// standby by the mapper's profitability gate. Peak shaving is a real-time grid-
// import safety cap (docs/battery-policy-user-guide.md: "discharge to keep grid
// import below this"), economics-blind by design — unlike a normal DP-originated
// discharge, which must still respect min_discharge_price/break-even.

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

const BASE_SETTINGS = {
  tariff_type: 'dynamic',
  battery_efficiency: 0.7415781214938163,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  policy_mode: 'balanced',
  peak_shaving_threshold: 1500,
};

function makeOptimizer(slot) {
  return {
    getSlot: () => slot,
    getSlotMeta: () => ({ pvCoverage: 0, pvExportWins: false }),
    _schedule: { slots: [] },
  };
}

function makeInputs({ slot, gridPower, price }) {
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 50, maxDischargePowerW: 800, maxChargePowerW: 800 },
    p1: { resolved_gridPower: gridPower, battery_power: 0, pv_power_estimated: 0, avg_consumption_w: gridPower },
    tariff: { currentPrice: price, allPrices: [] },
    optimizer: makeOptimizer(slot),
  };
}

console.log('\nPolicyEngine — peak-shaving vs profitability gate\n');

test('peak-shaving discharge bypasses profitability floor (price below min_discharge_price)', () => {
  const engine = new PolicyEngine(homey, { ...BASE_SETTINGS });
  const result = engine.calculatePolicy(makeInputs({ slot: 'preserve', gridPower: 3000, price: 0.05 }));
  assert.strictEqual(result.policyMode, 'discharge',
    `load 3000W > threshold 1500W must force discharge, got ${result.policyMode}`);
  assert.strictEqual(result.debug?.exception, 'peak_shaving',
    `expected peak_shaving exception, got ${result.debug?.exception}`);
  assert.notStrictEqual(result.hwMode, 'standby',
    'peak-shaving must not be silently downgraded to standby by the price gate');
});

test('normal DP discharge (no peak shaving) still respects profitability floor', () => {
  const engine = new PolicyEngine(homey, { ...BASE_SETTINGS });
  const result = engine.calculatePolicy(makeInputs({ slot: 'discharge', gridPower: 300, price: 0.05 }));
  assert.strictEqual(result.policyMode, 'discharge', `expected DP discharge to stand, got ${result.policyMode}`);
  assert.strictEqual(result.debug?.exception, null,
    `no exception expected on plain DP discharge, got ${result.debug?.exception}`);
  assert.strictEqual(result.hwMode, 'standby',
    `price €0.05 below min_discharge_price €0.25 must gate to standby, got ${result.hwMode}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
