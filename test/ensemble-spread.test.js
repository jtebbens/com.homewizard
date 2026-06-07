'use strict';

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');

const fakeHomey = { log() {}, error() {} };

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

const MODELS = ['meteofrance_arpege_europe', 'gfs_seamless', 'icon_seamless', 'knmi_harmonie_arome_netherlands'];

// Build minimal ensemble + standard API responses. perSlotModelVals: array of [mf,gfs,icon,knmi].
function makeData(perSlotModelVals) {
  const n = perSlotModelVals.length;
  const today = new Date().toISOString().slice(0, 10);
  const time = Array.from({ length: n }, (_, i) => `${today}T${String(i).padStart(2, '0')}:00`);
  const hourly = { time };
  MODELS.forEach((m, mi) => {
    hourly[`shortwave_radiation_${m}`] = perSlotModelVals.map(v => v[mi]);
  });
  const ensembleData = { hourly };
  const standardData = { timezone: 'UTC', hourly: { time, shortwave_radiation: time.map(() => 0) }, daily: {} };
  return { ensembleData, standardData };
}

console.log('\nWeatherForecaster ensemble spread — p50 not discounted on model disagreement\n');

// Model disagreement is two-sided uncertainty, not a downward bias. The blended p50 must
// equal the weighted mean regardless of spread (no `wMean − k·std` discount).

// std > 80 branch
test('high disagreement (std>80) → p50 = weighted mean, not discounted', () => {
  const wf = new WeatherForecaster(fakeHomey);
  // mf=100 gfs=100 icon=100 knmi=400 → uMean=175, std≈129.9 (>80), wMean(equal)=175
  const { ensembleData, standardData } = makeData([[100, 100, 100, 400]]);
  const out = wf._mergeApiResponses(ensembleData, standardData, null, 52, 5);
  assert.strictEqual(out.hourly.shortwave_radiation[0], 175,
    `Expected undiscounted weighted mean 175, got ${out.hourly.shortwave_radiation[0]}`);
});

// 30 < std ≤ 80 branch
test('moderate disagreement (std>30) → p50 = weighted mean, not discounted', () => {
  const wf = new WeatherForecaster(fakeHomey);
  // mf=100 gfs=100 icon=100 knmi=250 → uMean=137.5, std≈64.95 (>30,≤80), wMean=137.5
  const { ensembleData, standardData } = makeData([[100, 100, 100, 250]]);
  const out = wf._mergeApiResponses(ensembleData, standardData, null, 52, 5);
  assert.strictEqual(out.hourly.shortwave_radiation[0], 138,
    `Expected undiscounted weighted mean 138, got ${out.hourly.shortwave_radiation[0]}`);
});

// Agreement (std ≤ 30): unchanged — still the weighted mean.
test('model agreement (std≤30) → p50 = weighted mean', () => {
  const wf = new WeatherForecaster(fakeHomey);
  const { ensembleData, standardData } = makeData([[200, 200, 210, 190]]);
  const out = wf._mergeApiResponses(ensembleData, standardData, null, 52, 5);
  assert.strictEqual(out.hourly.shortwave_radiation[0], 200,
    `Expected weighted mean 200, got ${out.hourly.shortwave_radiation[0]}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
