'use strict';

// Weather discharge-boost gate (2026-06-13 below-min discharge divergence).
// _applyWeatherForecast boosted scores.discharge at currentPrice >= minDischargePrice
// * 0.75 / 0.85 — below the user min AND below the DP's own gate
// (optimization-engine: discharge only when price >= effectiveMinDischarge). On a cheap
// night with abundant tomorrow-PV this discharged stored PV at €0.17–0.20 (< €0.22 min),
// diverging runtime from DP/chart/explainability and losing RTE. The boost must now gate
// at the full min-discharge price, matching the DP.
//
// device.js's require('homey') is stubbed so we can reach the prototype method without
// running the Homey lifecycle. _applyWeatherForecast lives on PolicyEngine, loaded directly.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Minimal harness: call the prototype method with a stub `this`.
function runWeather({ price, minDischarge = 0.22, pvKwhTomorrow = 5.7, capKwh = 2.69, soc = 33 }) {
  const scores = { charge: 0, discharge: 0, preserve: 0 };
  const ctx = {
    settings: { tariff_type: 'dynamic', min_discharge_price: minDischarge },
    log: () => {},
  };
  const weather = {
    sunshineNext4Hours: 0, sunshineNext8Hours: 0, sunshineTodayRemaining: 0,
    sunshineTomorrow: 8, pvKwhTomorrow, // abundant: >= cap * 1.5 triggers aggressive path
  };
  const tariff  = { currentPrice: price };
  const battery = { totalCapacityKwh: capKwh, stateOfCharge: soc };
  const inputs  = { effectiveMinDischarge: minDischarge, optimizer: { getSlot: () => 'standby' } };
  PolicyEngine.prototype._applyWeatherForecast.call(ctx, scores, weather, tariff, battery, inputs);
  return scores;
}

// The observed bug: €0.195 and €0.170 are below €0.22 min but above the old 0.85/0.75 gates.
test('price below min (€0.195) → no discharge boost despite abundant tomorrow-PV', () => {
  const scores = runWeather({ price: 0.195 });
  assert.strictEqual(scores.discharge, 0, `discharge must stay 0, got ${scores.discharge}`);
});

test('price below min (€0.170) → no discharge boost', () => {
  const scores = runWeather({ price: 0.170 });
  assert.strictEqual(scores.discharge, 0, `discharge must stay 0, got ${scores.discharge}`);
});

test('price at min (€0.220) → discharge boosted (gate matches DP)', () => {
  const scores = runWeather({ price: 0.220 });
  assert.ok(scores.discharge > 0, `discharge must be boosted at >= min, got ${scores.discharge}`);
});

test('price above min (€0.250) → discharge boosted', () => {
  const scores = runWeather({ price: 0.250 });
  assert.ok(scores.discharge > 0, `discharge must be boosted, got ${scores.discharge}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
