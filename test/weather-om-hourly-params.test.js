'use strict';

// Regression: Open-Meteo has no `cin` variable (it errors with a 400 "Data corrupted"
// response) — the correct name is `convective_inhibition`. That typo shipped in
// _fetchStandardHourly's hourly param list and broke every standard-hourly fetch
// (400 Bad Request) from 2026-09-03 16:00 UTC until fixed 2026-09-04, wiping the PV
// forecast for "tomorrow" since the whole request failed, not just that one field.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../lib/weather-forecaster.js'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const fnMatch = src.match(/_fetchStandardHourly\([^)]*\)\s*{[\s\S]*?hourly:\s*'([^']*)'/);
assert.ok(fnMatch, 'could not find _fetchStandardHourly hourly param string in weather-forecaster.js');
const fields = fnMatch[1].split(',');

test('_fetchStandardHourly does not request the invalid `cin` param', () => {
  assert.ok(!fields.includes('cin'), '`cin` is not a valid Open-Meteo variable — use convective_inhibition');
});

test('_fetchStandardHourly requests convective_inhibition instead', () => {
  assert.ok(fields.includes('convective_inhibition'), 'expected convective_inhibition in hourly param list');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
