'use strict';

// Regression: the planning schedule (settings/index.html chart) displayed
// slot.exportPrice raw, straight from the DP's dp[] output — that field is
// ALWAYS computed from export_price_addon/export_price_multiplier
// (entsoe-fallback-provider.js), regardless of tariff_model. The actual DP
// decision (exportValue() in price-formulas.js) already ignores that field
// under tariff_model=saldering and returns priceSlot.price instead — so the
// chart kept showing an asymmetric export price even after switching back to
// saldering, while the DP itself had already stopped using it (live 2026-08-29
// ~11:08Z: user reverted tariff_model to saldering, chart still showed the old
// asymmetric export price).
//
// Contract: buildPlanningSchedule() must null out exportPrice for display
// unless tariff_model === 'asymmetric_2027', mirroring tariff-manager.js's own
// currentExportPrice (null under saldering).

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
  respect_minmax: true,
  policy_mode: 'balanced',
};

const CAP_KWH  = 5.376;
const CHARGE_W = 1600;

function makeEngine(tariffModel) {
  return new PolicyEngine(homey, { ...BASE_SETTINGS, tariff_model: tariffModel });
}

function makeSlots() {
  const start = new Date('2026-05-12T10:00:00.000Z'); // daylight window
  const hour = 3_600_000;
  return [0, 1].map(i => ({
    timestamp: new Date(start.getTime() + i * hour).toISOString(),
    action: 'preserve',
    price: 0.20,
    exportPrice: -0.05, // asymmetric-style value, always computed regardless of tariff_model
    socProjected: 30,
    consumptionW: 0,
  }));
}

console.log('\nPlanning schedule — exportPrice display gated by tariff_model\n');

test('saldering: displayed exportPrice is null even though slot.exportPrice is set', () => {
  const engine = makeEngine('saldering');
  const slots = makeSlots();
  const pvForecast = slots.map(s => ({ timestamp: s.timestamp, pvPowerW: CHARGE_W }));
  const schedule = engine.buildPlanningSchedule(slots, pvForecast, null, CHARGE_W, 0.175, CAP_KWH);
  schedule.forEach((s, i) => {
    assert.strictEqual(s.exportPrice, null,
      `slot ${i}: saldering must not display an asymmetric export price, got ${s.exportPrice}`);
  });
});

test('asymmetric_2027: displayed exportPrice passes through the DP value unchanged', () => {
  const engine = makeEngine('asymmetric_2027');
  const slots = makeSlots();
  const pvForecast = slots.map(s => ({ timestamp: s.timestamp, pvPowerW: CHARGE_W }));
  const schedule = engine.buildPlanningSchedule(slots, pvForecast, null, CHARGE_W, 0.175, CAP_KWH);
  schedule.forEach((s, i) => {
    assert.strictEqual(s.exportPrice, -0.05,
      `slot ${i}: asymmetric_2027 must still display the per-slot export price, got ${s.exportPrice}`);
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
