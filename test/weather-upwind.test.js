'use strict';

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');

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

console.log('\nWeatherForecaster.getUpwindModulation\n');

const NOW = Date.parse('2026-07-09T12:00:00Z');

// ── active cases ─────────────────────────────────────────────────────────────
test('fresh data + kt<0.98 + ff>1 → active', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 5 * 60_000 };
  const r = WeatherForecaster.getUpwindModulation(upwind, NOW);
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.upwindKt, 0.7);
  assert.strictEqual(r.leadMs, (40_000 / 5) * 1000);
  assert.strictEqual(r.leadMin, Math.round(((40_000 / 5) * 1000) / 60_000));
});

test('data exactly 89min old → still active', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 89 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, true);
});

// ── staleness gate (the bug this fixes) ─────────────────────────────────────
test('data >90min old + kt<0.98 + ff>1 → inactive (was: still modulated, the bug)', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 91 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('data 3h old (worst realistic case pre-fix) → inactive', () => {
  const upwind = { upwindKt: 0.5, thisFf: 8, windObsMs: NOW - 180 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('missing windObsMs and pointObsMs (legacy/fallback shape) → no staleness gate, active if otherwise valid', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, true);
});

// ── pointObsMs gate (upwindKt's own timestamp — separate from the wind reading) ─────
test('fresh wind but pointObsMs >90min old → inactive (stale COT/kt, fresh wind can\'t hide it)', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 2 * 60_000, pointObsMs: NOW - 91 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('fresh pointObsMs but windObsMs >90min old → inactive (stale wind, fresh kt can\'t hide it)', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 91 * 60_000, pointObsMs: NOW - 2 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('both windObsMs and pointObsMs fresh (<90min) → active', () => {
  const upwind = { upwindKt: 0.7, thisFf: 5, windObsMs: NOW - 10 * 60_000, pointObsMs: NOW - 15 * 60_000 };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, true);
});

// ── unchanged existing behavior (regression guards) ─────────────────────────
test('kt >= 0.98 (clear upwind) → inactive regardless of freshness', () => {
  const upwind = { upwindKt: 0.99, thisFf: 5, windObsMs: NOW };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('thisFf <= 1 (calm/no wind) → inactive', () => {
  const upwind = { upwindKt: 0.7, thisFf: 1, windObsMs: NOW };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

test('null upwind → inactive', () => {
  assert.strictEqual(WeatherForecaster.getUpwindModulation(null, NOW).active, false);
});

test('upwindKt null (no verklikker station) → inactive', () => {
  const upwind = { upwindKt: null, thisFf: 5, windObsMs: NOW };
  assert.strictEqual(WeatherForecaster.getUpwindModulation(upwind, NOW).active, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
