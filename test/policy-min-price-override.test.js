'use strict';

// Regression: min-price discharge override must only fire under respect_minmax.
// With respect_minmax=false, effectiveMinDischarge is the computed break-even (~€0.10),
// which the DP already factors in — overriding there flips a deliberate DP preserve
// (save-for-peak arbitrage) to discharge and produces the "PLAN AFWIJKING" log spam.

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
};

// Optimizer that schedules preserve for the current slot, no PV this slot,
// with a known higher future price the DP is deliberately saving for.
function makeOptimizer() {
  return {
    getSlot: () => 'preserve',
    getSlotMeta: () => ({ pvCoverage: 0, pvExportWins: false }),
    _schedule: { slots: [] },
  };
}

function makeInputs() {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 50, maxDischargePowerW: 800, maxChargePowerW: 800 },
    p1: { resolved_gridPower: 300, battery_power: 0, pv_power_estimated: 0, avg_consumption_w: 300 },
    tariff: {
      currentPrice: 0.30, // above both break-even and min_discharge_price
      allPrices: [
        { timestamp: new Date(now + 3600_000).toISOString(), price: 0.36 },
        { timestamp: new Date(now + 7200_000).toISOString(), price: 0.33 },
      ],
    },
    optimizer: makeOptimizer(),
  };
}

console.log('\nPolicyEngine — min-price override gate\n');

test('respect_minmax=false: DP preserve is NOT overridden to discharge', () => {
  const engine = new PolicyEngine(homey, { ...BASE_SETTINGS, respect_minmax: false });
  const result = engine.calculatePolicy(makeInputs());
  assert.strictEqual(result.policyMode, 'preserve',
    `DP preserve must stand (break-even threshold), got ${result.policyMode} (exception ${result.debug?.exception})`);
  assert.notStrictEqual(result.debug?.exception, 'min_price_override',
    'min_price_override must not fire when respect_minmax=false');
});

test('respect_minmax=true: DP preserve IS overridden above user min_discharge_price', () => {
  const engine = new PolicyEngine(homey, { ...BASE_SETTINGS, respect_minmax: true });
  const result = engine.calculatePolicy(makeInputs());
  assert.strictEqual(result.policyMode, 'discharge',
    `price €0.30 > user min €0.25 must override to discharge, got ${result.policyMode}`);
  assert.strictEqual(result.debug?.exception, 'min_price_override',
    `expected min_price_override exception, got ${result.debug?.exception}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
