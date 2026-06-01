'use strict';

// Regression: planning-chart forward-sim must not project free-PV SoC increase on a slot
// the runtime actually exports. Runtime store value is the trickle-capped suffix max
// (policy-engine _pvStoreValue): a far price peak BEYOND a pvStrong refill is served by free
// PV later, so storing now is not worthwhile. The forward-sim used the UNCAPPED suffix max,
// so it charged the battery in the projection ("fills to 100%") while the runtime exported.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEngine() {
  return new OE({ battery_efficiency: 0.72, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 });
}

// Scenario mirroring live 13:00: strong PV now, a modest near peak (capped sees → 0.18 < price),
// a PV refill that resets the cap, then a big far peak (uncapped sees → 0.37 > price).
function run() {
  const oe = makeEngine();
  const base = new Date('2026-06-01T11:00:00.000Z').getTime();
  const mk = (h, price) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), price });
  const prices = [mk(0, 0.23), mk(1, 0.25), mk(2, 0.10), mk(3, 0.52), mk(4, 0.10), mk(5, 0.10)];
  const pv = [3000, 0, 3000, 0, 3000, 3000];
  const pvForecast = pv.map((w, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: w }));
  const cons = [50, 50, 50, 50, 50, 50];
  oe.compute(prices, 53, 2.688, 800, 800, pvForecast, 0.72, cons, 0.10);
  return oe._schedule.slots;
}

console.log('\nOptimizationEngine — forward-sim export/SoC sync\n');

test('preserve+pvStrong with capped store < price does not project free-PV charge (export, SoC flat)', () => {
  const slots = run();
  const t0 = slots[0];
  assert.ok(t0.pvCoverage >= 0.9, `precondition: t0 pvStrong, got cov=${t0.pvCoverage}`);
  assert.ok((t0.pvTrickleMaxValue ?? 0) < t0.price,
    `precondition: capped store < price, got ${t0.pvTrickleMaxValue} vs ${t0.price}`);
  // Runtime exports here → SoC must not rise from free PV.
  assert.ok(slots[1].socProjected <= t0.socProjected + 0.005,
    `Expected SoC flat (export), got ${(t0.socProjected * 100).toFixed(1)}% → ${(slots[1].socProjected * 100).toFixed(1)}%`);
});

test('preserve+pvStrong with capped store > price still projects free-PV charge', () => {
  const slots = run();
  // t2 (13:00): cappedStore 0.374 > price 0.10 → storing wins → SoC should rise into the peak.
  const t2 = slots[2];
  assert.ok((t2.pvTrickleMaxValue ?? 0) > t2.price,
    `precondition: capped store > price, got ${t2.pvTrickleMaxValue} vs ${t2.price}`);
  assert.ok(slots[3].socProjected > t2.socProjected + 0.005,
    `Expected SoC rise (store wins), got ${(t2.socProjected * 100).toFixed(1)}% → ${(slots[3].socProjected * 100).toFixed(1)}%`);
});

// The planning re-mapper drives the chart's drawn SoC (simSoc). A DP=preserve slot with strong
// PV but where storing loses to exporting (the live 13:00 case) must map to standby, not
// zero_charge_only — otherwise the chart projects the battery filling while the runtime exports.
function makePE() {
  return new PolicyEngine({ log() {} }, {
    tariff_type: 'dynamic', battery_efficiency: 0.72, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, max_charge_price: 0.12, min_discharge_price: 0.60,
    respect_minmax: true, policy_mode: 'balanced',
  });
}
const PRESERVE_ARGS = (pvStoreValue) => ({
  price: 0.23, soc: 53, pvW: 3000, consumptionW: 50,
  tariffType: 'dynamic', userPolicyMode: 'balanced',
  maxChargePrice: 0.12, minDischargePrice: 0.60, minSoc: 0, maxSoc: 100,
  futurePrices: [], battChargePowerW: 800, pvStoreValue,
});

test('remapper: preserve+pvStrong with store value < price maps to standby (export, no fill)', () => {
  const r = makePE()._mapActionToHwModeForPlanning('preserve', PRESERVE_ARGS(0.18));
  assert.strictEqual(r.hwMode, 'standby', `Expected standby, got ${r.hwMode} (${r.reason})`);
});

test('remapper: preserve+pvStrong with store value > price still maps to zero_charge_only', () => {
  const r = makePE()._mapActionToHwModeForPlanning('preserve', PRESERVE_ARGS(0.30));
  assert.strictEqual(r.hwMode, 'zero_charge_only', `Expected zero_charge_only, got ${r.hwMode} (${r.reason})`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
