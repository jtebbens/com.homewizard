'use strict';

// project_dp_input_check_gaps_0815 point (c): pvForecast reaches compute() with zero value
// checks, unlike the price feed (optimization-engine.js:280, whole horizon rejected on one
// bad value). This is the shadow-log-only sanity check: age / coverage / plausibility /
// all-zero, logged but never rejecting. Must fail before _pvForecastSanityCheck existed
// (device would have no such method) and pass after.

const assert = require('assert');
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'homey') return { Device: class {}, App: class {}, FlowCardTrigger: class {} };
  return _origLoad.call(this, req, ...a);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
const OptimizationEngine = require('../lib/optimization-engine.js');
Module._load = _origLoad;

let passed = 0, failed = 0;
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

function makeDev() {
  const logs = [];
  const dev = {
    log: (msg) => logs.push(msg),
    optimizationEngine: new OptimizationEngine({}),
    _logs: logs,
  };
  dev._pvForecastSanityCheck = BatteryPolicyDevice.prototype._pvForecastSanityCheck;
  return dev;
}

// 8 hourly 15-min price slots spanning 06:00Z-08:00Z, well inside the sun window below.
function make15minPrices(startHourUtc, count) {
  const out = [];
  const start = Date.UTC(2026, 7, 28, startHourUtc, 0, 0);
  for (let i = 0; i < count; i++) {
    out.push({ timestamp: new Date(start + i * 900_000).toISOString(), price: 0.25 });
  }
  return out;
}

function makeWeather({ fetchedAt = Date.now() } = {}) {
  return {
    fetchedAt,
    todaySunrise: new Date(Date.UTC(2026, 7, 28, 4, 30, 0)),
    todaySunset:  new Date(Date.UTC(2026, 7, 28, 18, 30, 0)),
    tomorrowSunrise: new Date(Date.UTC(2026, 7, 29, 4, 31, 0)),
    tomorrowSunset:  new Date(Date.UTC(2026, 7, 29, 18, 29, 0)),
  };
}

function fullHourlyPv(startHourUtc, count, w) {
  const out = [];
  for (let h = 0; h < count; h++) {
    out.push({ timestamp: new Date(Date.UTC(2026, 7, 28, startHourUtc + h, 0, 0)).toISOString(), pvPowerW: w });
  }
  return out;
}

test('healthy input (fresh, full coverage, plausible, non-zero) → no flag logged', () => {
  const dev = makeDev();
  const prices = make15minPrices(6, 8); // 06:00-08:00Z
  const pvForecast = fullHourlyPv(6, 3, 500); // hours 6,7,8 present
  dev._pvForecastSanityCheck(pvForecast, 2000, makeWeather(), prices);
  assert.strictEqual(dev._logs.length, 0, `expected no log, got: ${dev._logs.join(' | ')}`);
});

test('missing hour in daylight window → COVERAGE flag', () => {
  const dev = makeDev();
  const prices = make15minPrices(6, 8); // 06:00-08:00Z
  const pvForecast = [
    { timestamp: new Date(Date.UTC(2026, 7, 28, 6, 0, 0)).toISOString(), pvPowerW: 500 },
    // hour 7 missing entirely
    { timestamp: new Date(Date.UTC(2026, 7, 28, 8, 0, 0)).toISOString(), pvPowerW: 500 },
  ];
  dev._pvForecastSanityCheck(pvForecast, 2000, makeWeather(), prices);
  assert.strictEqual(dev._logs.length, 1, 'expected exactly one sanity log');
  // 8 price slots @15min cover hours 6-7 only (2h); hour 7's 4 slots have no pvForecast
  // entry (hour 7 skipped above), so 4/8 slots are "real".
  assert.match(dev._logs[0], /COVERAGE 4\/8 daylight slots/);
});

test('all daylight slots zero → ALL-ZERO flag', () => {
  const dev = makeDev();
  const prices = make15minPrices(6, 8); // 8 × 15-min slots = hours 6-7
  const pvForecast = fullHourlyPv(6, 3, 0);
  dev._pvForecastSanityCheck(pvForecast, 2000, makeWeather(), prices);
  assert.strictEqual(dev._logs.length, 1, 'expected exactly one sanity log');
  assert.match(dev._logs[0], /ALL-ZERO 8 daylight slots/);
});

test('slot exceeds 1.2× panel capacity → IMPLAUSIBLE flag', () => {
  const dev = makeDev();
  const prices = make15minPrices(6, 8);
  const pvForecast = fullHourlyPv(6, 3, 3000); // cap 2000W, 3000 > 1.2*2000
  dev._pvForecastSanityCheck(pvForecast, 2000, makeWeather(), prices);
  assert.strictEqual(dev._logs.length, 1, 'expected exactly one sanity log');
  assert.match(dev._logs[0], /IMPLAUSIBLE maxPvW=3000>1\.2×cap\(2000\)/);
});

test('forecast fetched 4h ago → STALE flag', () => {
  const dev = makeDev();
  const prices = make15minPrices(6, 8);
  const pvForecast = fullHourlyPv(6, 3, 500);
  dev._pvForecastSanityCheck(pvForecast, 2000, makeWeather({ fetchedAt: Date.now() - 4 * 3_600_000 }), prices);
  assert.strictEqual(dev._logs.length, 1, 'expected exactly one sanity log');
  assert.match(dev._logs[0], /STALE age=240min/);
});

test('horizon entirely outside daylight → no flag, no crash', () => {
  const dev = makeDev();
  const prices = make15minPrices(22, 8); // 22:00-00:00Z, deep night
  dev._pvForecastSanityCheck([], 2000, makeWeather(), prices);
  assert.strictEqual(dev._logs.length, 0);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
