'use strict';

const assert = require('assert');
const CR = require('../lib/chart-renderer');

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

console.log('configToJs:');

test('serializes primitives correctly', () => {
  assert.strictEqual(CR.configToJs(null), 'null');
  assert.strictEqual(CR.configToJs(undefined), 'null');
  assert.strictEqual(CR.configToJs(true), 'true');
  assert.strictEqual(CR.configToJs(42), '42');
  assert.strictEqual(CR.configToJs(3.14), '3.14');
  assert.strictEqual(CR.configToJs('hello'), '"hello"');
});

test('serializes arrays recursively', () => {
  assert.strictEqual(CR.configToJs([1, 2, 3]), '[1,2,3]');
  assert.strictEqual(CR.configToJs(['a', 'b']), '["a","b"]');
  assert.strictEqual(CR.configToJs([[1], [2]]), '[[1],[2]]');
});

test('serializes objects recursively', () => {
  assert.strictEqual(CR.configToJs({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
  assert.strictEqual(CR.configToJs({ nested: { v: 5 } }), '{"nested":{"v":5}}');
});

test('preserves function values (key behavior for quickchart.io)', () => {
  const fn = function (v) { return v + 1; };
  const out = CR.configToJs({ callback: fn });
  assert.ok(out.includes('function'), 'function keyword preserved');
  assert.ok(out.includes('return'), 'function body preserved');
  assert.ok(!out.includes('null'), 'function not serialized as null');
});

test('handles arrow functions', () => {
  const arrow = (v) => v * 2;
  const out = CR.configToJs(arrow);
  assert.ok(out.includes('=>') || out.includes('function'), 'arrow body preserved');
});

console.log('\nbuildPlanningChartConfig:');

test('returns null for empty slots', () => {
  assert.strictEqual(CR.buildPlanningChartConfig({ slots: [] }), null);
  assert.strictEqual(CR.buildPlanningChartConfig(null), null);
  assert.strictEqual(CR.buildPlanningChartConfig({}), null);
});

test('returns config with bar + line datasets', () => {
  const now = Date.now();
  const slots = Array.from({ length: 24 }, (_, i) => ({
    ts: now - 12 * 3_600_000 + i * 3_600_000,
    hour: i,
    mode: i < 12 ? 'past' : 'standby',
    price: 0.20,
    soc: 50 + i,
    pvW: 100 * i,
  }));
  const cfg = CR.buildPlanningChartConfig({ slots, currentSoc: 50, currentMode: 'standby' });
  assert.ok(cfg);
  assert.strictEqual(cfg.type, 'bar');
  assert.ok(Array.isArray(cfg.data.datasets));
  const labels = cfg.data.datasets.map(d => d.label);
  assert.ok(labels.includes('_prijs'), 'price bars present');
  assert.ok(labels.includes('SoC (%)'), 'SoC line present');
});

test('clips to first 96 slots (max one day)', () => {
  const now = Date.now();
  const slots = Array.from({ length: 200 }, (_, i) => ({
    ts: now + i * 900_000, hour: 0, mode: 'standby', price: 0.20, soc: 50, pvW: 0,
  }));
  const cfg = CR.buildPlanningChartConfig({ slots });
  assert.strictEqual(cfg.data.labels.length, 96);
});

console.log('\nbuildPvChartConfig:');

test('returns config even with no data (empty inputs)', () => {
  const cfg = CR.buildPvChartConfig({});
  assert.ok(cfg);
  assert.strictEqual(cfg.type, 'line');
});

test('builds 24h labels by default', () => {
  const cfg = CR.buildPvChartConfig({ pvCapacityW: 4000 });
  assert.strictEqual(cfg.data.labels.length, 24);
});

test('builds 48h labels when tomorrow forecast present', () => {
  const tomorrow = { 6: 100, 12: 800, 18: 300 };
  const cfg = CR.buildPvChartConfig({ pvForecast: [null, tomorrow] });
  assert.strictEqual(cfg.data.labels.length, 48);
});

test('omits OM/SC datasets when no data', () => {
  const cfg = CR.buildPvChartConfig({});
  const labels = cfg.data.datasets.map(d => d.label);
  assert.ok(labels.includes('PV Werkelijk'));
  assert.ok(labels.includes('PV Verwachting'));
  assert.ok(!labels.includes('Open-Meteo'));
  assert.ok(!labels.includes('Solcast'));
});

test('includes OM dataset when forecast available', () => {
  const cfg = CR.buildPvChartConfig({ pvForecastOM: [{ 12: 1000 }] });
  const labels = cfg.data.datasets.map(d => d.label);
  assert.ok(labels.includes('Open-Meteo'));
});

console.log('\nbuildModeChartBody:');

test('returns null for empty modeHistory', () => {
  assert.strictEqual(CR.buildModeChartBody(null), null);
  assert.strictEqual(CR.buildModeChartBody([]), null);
  assert.strictEqual(CR.buildModeChartBody(undefined), null);
});

test('returns JSON body string for valid history', () => {
  const history = [
    { h: '2026-05-20T09:00', m: { zero: 4 }, soc: 50 },
    { h: '2026-05-20T09:15', m: { zero: 4 }, soc: 51 },
  ];
  const body = CR.buildModeChartBody(history);
  assert.strictEqual(typeof body, 'string');
  const parsed = JSON.parse(body);
  assert.strictEqual(parsed.version, '4');
  assert.strictEqual(parsed.width, 900);
  assert.strictEqual(parsed.height, 500);
  assert.ok(parsed.chart);
  assert.strictEqual(parsed.chart.type, 'bar');
});

test('includes SoC line dataset when soc values present', () => {
  const history = [{ h: '2026-05-20T09:00', m: { zero: 4 }, soc: 50 }];
  const body = CR.buildModeChartBody(history);
  const parsed = JSON.parse(body);
  const socDs = parsed.chart.data.datasets.find(d => d.label === 'SoC %');
  assert.ok(socDs, 'SoC dataset present');
  assert.strictEqual(socDs.type, 'line');
});

test('skips modes with zero contribution', () => {
  const history = [{ h: '2026-05-20T09:00', m: { zero: 4 }, soc: 50 }];
  const body = CR.buildModeChartBody(history);
  const parsed = JSON.parse(body);
  const labels = parsed.chart.data.datasets.map(d => d.label);
  // Only 'Nul' (zero) and 'SoC %' expected — other modes filtered out
  assert.ok(labels.includes('Nul'));
  assert.ok(!labels.includes('Laden'));
  assert.ok(!labels.includes('Standby'));
});

console.log('\n══════════════════════════════');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('══════════════════════════════');
if (failed > 0) process.exit(1);
