'use strict';

// Regression: the overnight refill-reserve confidence read pvKwhTomorrow, which is summed
// (device.js, sumPvNetWindow) BEFORE the PV correction stack (daily bias, accuracy, intraday,
// cloud, capacity cap) runs. The plan, chart and DP all use the corrected forecast, and the
// `ratio` haircut inside refillConfidenceFromForecast is measured against the post-bias
// forecast — so feeding it pre-bias PV applied the downside twice. 2026-09-25 evening:
// dailyBias ×1.26, pvTomorrow=2.0/2.7kWh, cv=0.34, ratio=0.56 → conf 0.42 → floor +29%,
// battery held 28% overnight at €0.33-0.41 > break-even €0.29.
//
// _reservePvKwh rescales the (min-of-3 smoothed) pvKwhTomorrow by this run's
// corrected/raw window sum, so the reserve sees the same PV as the DP without a second
// smoothing history.

const assert = require('assert');
const fc = require('fast-check');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
const OptimizationEngine = require('../lib/optimization-engine.js');
Module.prototype.require = origRequire;

assert.strictEqual(typeof BatteryPolicyDevice._reservePvKwh, 'function', '_reservePvKwh missing');
const reservePv = BatteryPolicyDevice._reservePvKwh;

// 1. 25-09 reconstruction: hourly PV for tomorrow, 300W flat consumption, 800W charge cap.
const start = Date.UTC(2026, 8, 26, 0, 0);
const rawW = [0, 0, 0, 0, 0, 0, 50, 250, 500, 700, 850, 900, 900, 800, 600, 400, 200, 50, 0, 0, 0, 0, 0, 0];
const mk = (arr) => arr.map((w, h) => ({ timestamp: new Date(start + (h + 1) * 3600_000).toISOString(), pvPowerW: w }));
const cons = () => 300;
const sum = (arr) => OptimizationEngine.sumPvNetWindow(mk(arr), start, start + 24 * 3600_000, 800, cons);
const rawKwh = sum(rawW);
const corrKwh = sum(rawW.map(w => Math.round(w * 1.26)));
assert.ok(corrKwh > rawKwh, `corrected ${corrKwh} should exceed raw ${rawKwh}`);

const smoothed = rawKwh; // min-of-3 equal to this run
const span = 2.7;
const confRaw  = OptimizationEngine.refillConfidenceFromForecast(0.34, 0.56, smoothed, span, 0.22);
const confCorr = OptimizationEngine.refillConfidenceFromForecast(0.34, 0.56, reservePv(smoothed, rawKwh, corrKwh), span, 0.22);
assert.ok(confCorr > confRaw, `reserve confidence must rise with corrected PV: raw=${confRaw} corr=${confCorr}`);

// 2. No correction → identical to today's input (pure no-op).
fc.assert(fc.property(fc.double({ min: 0, max: 20, noNaN: true }), fc.double({ min: 0.01, max: 20, noNaN: true }), (s, r) =>
  Math.abs(reservePv(s, r, r) - s) < 1e-9));

// 3. Monotone in the corrected sum, never negative; raw=0 falls back to the corrected sum.
fc.assert(fc.property(
  fc.double({ min: 0, max: 20, noNaN: true }), fc.double({ min: 0.01, max: 20, noNaN: true }),
  fc.double({ min: 0, max: 20, noNaN: true }), fc.double({ min: 0, max: 20, noNaN: true }),
  (s, r, c1, c2) => {
    const [lo, hi] = c1 <= c2 ? [c1, c2] : [c2, c1];
    return reservePv(s, r, lo) >= 0 && reservePv(s, r, lo) <= reservePv(s, r, hi) + 1e-9;
  }));
assert.strictEqual(reservePv(0, 0, 1.5), 1.5);
assert.strictEqual(reservePv(0, 0, 0), 0);

console.log(`refill-reserve-corrected-pv: OK (raw=${rawKwh}kWh corr=${corrKwh}kWh conf ${confRaw.toFixed(2)}→${confCorr.toFixed(2)})`);
