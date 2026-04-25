'use strict';

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');

const att = WeatherForecaster._weatherAttenuation.bind(WeatherForecaster);

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

function approx(a, b, eps = 0.001) {
  assert.ok(Math.abs(a - b) <= eps, `Expected ~${b}, got ${a}`);
}

console.log('\nWeatherForecaster._weatherAttenuation\n');

// ── No attenuation codes ─────────────────────────────────────────────────────
test('clear sky (code 0) → 1.0', () => assert.strictEqual(att(0), 1.0));
test('partly cloudy (code 2) → 1.0', () => assert.strictEqual(att(2), 1.0));
test('overcast (code 3) → 1.0', () => assert.strictEqual(att(3), 1.0));
test('drizzle (code 51) → 1.0', () => assert.strictEqual(att(51), 1.0));
test('light rain (code 61) → 1.0', () => assert.strictEqual(att(61), 1.0));

// ── Fog (bypass precipProb gate) ─────────────────────────────────────────────
test('fog (45) at 0% precipProb → 0.12 (no confidence gate)', () => approx(att(45, 0), 0.12));
test('fog (45) at 100% precipProb → 0.12', () => approx(att(45, 100), 0.12));
test('rime fog (48) → 0.12', () => approx(att(48, 100), 0.12));

// ── Snow ─────────────────────────────────────────────────────────────────────
test('heavy snow (75) at high precipProb → 0.05', () => approx(att(75, 100), 0.05));
test('snow grains (77) at high precipProb → 0.05', () => approx(att(77, 100), 0.05));
test('light snow (71) at high precipProb → 0.30', () => approx(att(71, 100), 0.30));
test('moderate snow (73) at high precipProb → 0.30', () => approx(att(73, 100), 0.30));
test('light snow showers (85) at high precipProb → 0.20', () => approx(att(85, 100), 0.20));
test('heavy snow showers (86) at high precipProb → 0.10', () => approx(att(86, 100), 0.10));

// ── Rain ─────────────────────────────────────────────────────────────────────
test('heavy rain (65) at high precipProb → 0.50', () => approx(att(65, 100), 0.50));
test('freezing rain (67) at high precipProb → 0.50', () => approx(att(67, 100), 0.50));

// ── Thunderstorm ─────────────────────────────────────────────────────────────
test('thunderstorm (95) at high precipProb → 0.30', () => approx(att(95, 100), 0.30));
test('thunderstorm+hail (96) at high precipProb → 0.30', () => approx(att(96, 100), 0.30));
test('thunderstorm+heavy hail (99) at high precipProb → 0.30', () => approx(att(99, 100), 0.30));

// ── Confidence gate (precipProb < 40) ────────────────────────────────────────
test('heavy snow (75) at 0% precipProb → 1.0 (no attenuation)', () => approx(att(75, 0), 1.0));
test('heavy snow (75) at 20% precipProb → blend 0.5', () => {
  // confidence = 20/40 = 0.5; factor = 1.0 - (1 - 0.05) * 0.5 = 1.0 - 0.475 = 0.525
  approx(att(75, 20), 0.525);
});
test('heavy snow (75) at 40% precipProb → full attenuation', () => approx(att(75, 40), 0.05));
test('heavy snow (75) at 100% precipProb → full attenuation', () => approx(att(75, 100), 0.05));

// ── Default precipProb = 100 when omitted ────────────────────────────────────
test('thunderstorm (95) with no precipProb arg → 0.30', () => approx(att(95), 0.30));

// ── Return type ──────────────────────────────────────────────────────────────
test('return value is always a number', () => {
  assert.strictEqual(typeof att(0), 'number');
  assert.strictEqual(typeof att(45, 50), 'number');
  assert.strictEqual(typeof att(999, 0), 'number');
});
test('return value is always in [0, 1]', () => {
  [0, 45, 48, 71, 73, 75, 77, 85, 86, 65, 67, 95, 96, 99].forEach(code => {
    [0, 20, 40, 80, 100].forEach(prob => {
      const f = att(code, prob);
      assert.ok(f >= 0 && f <= 1, `code=${code} prob=${prob} → ${f} out of range`);
    });
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
