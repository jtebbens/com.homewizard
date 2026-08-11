'use strict';

// Regression 2026-08-11: hourlyForecast (what the DP plans on) built radiationWm2 from the
// ensemble (`ensRadiationWm2`), while dailyProfiles (what the chart's past hours come from)
// built it from the single default Open-Meteo run. Same learned yield factors, same
// radiationWm2 x yf formula in both consumers, different irradiance underneath — so a stored
// past hour sat ~43% below what the DP had computed for that same hour (h09: 1875W stored vs
// 2273-2694W computed). _ensRadiationForIndex is now the single implementation feeding both.
//
// It enforces:
//   1. Weighted mean over the per-model series, scaled by biasFactor x wxFactor.
//   2. Missing model weights fall back to 0.25; models without data for the index are skipped.
//   3. null when no model has data, so the caller keeps its single-run fallback.
//   4. Past indices work — perModelRadiation spans the full time array, not just the future.
//   5. The GTI/GHI ratio is only reported via `out`, clamped to [0.3, 2.5].

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  return origRequire.apply(this, arguments);
};
const WeatherForecaster = require('../lib/weather-forecaster.js');
Module.prototype.require = origRequire;

const ens = WeatherForecaster._ensRadiationForIndex.bind(WeatherForecaster);

// Four models, index 0 = a past hour, index 1 = a future hour.
const hourly = {
  perModelRadiation: {
    meteofrance_arpege_europe: [400, 700],
    gfs_seamless:              [500, 800],
    icon_seamless:             [600, 900],
    knmi_harmonie_arome_netherlands: [500, 800],
  },
  perModelGhi: {
    meteofrance_arpege_europe: [250, 500],
    gfs_seamless:              [250, 500],
    icon_seamless:             [250, 500],
    knmi_harmonie_arome_netherlands: [250, 500],
  },
};
const EQUAL = { meteofrance_arpege_europe: 0.25, gfs_seamless: 0.25, icon_seamless: 0.25, knmi_harmonie_arome_netherlands: 0.25 };

// --- 1. weighted mean x biasFactor x wxFactor --------------------------------

// Equal weights: mean of 400/500/600/500 = 500.
assert.strictEqual(ens(hourly, 0, 1, 1, EQUAL), 500, 'equal weights → plain mean');
assert.strictEqual(ens(hourly, 0, 1.2, 1, EQUAL), 600, 'biasFactor scales the result');
assert.strictEqual(ens(hourly, 0, 1, 0.5, EQUAL), 250, 'wxFactor scales the result');
assert.strictEqual(ens(hourly, 0, 1.1, 0.9, EQUAL), Math.round(500 * 1.1 * 0.9), 'both factors applied');

// Unequal weights shift the mean toward the heavier model.
const skew = { ...EQUAL, icon_seamless: 1.0 };
const wSum = 0.25 * 400 + 0.25 * 500 + 1.0 * 600 + 0.25 * 500;
assert.strictEqual(ens(hourly, 0, 1, 1, skew), Math.round(wSum / 1.75), 'weights shift the mean');

// --- 2. the regression: this must NOT equal the single-model value -----------

// The default Open-Meteo run for this index would be 400 (meteofrance). Before the fix
// dailyProfiles stored that; the DP had the ensemble 500. The gap is the bug.
assert.notStrictEqual(ens(hourly, 0, 1, 1, EQUAL), 400, 'ensemble must differ from the single run');

// --- 3. past index works exactly like a future index -------------------------

assert.strictEqual(ens(hourly, 1, 1, 1, EQUAL), 800, 'future index averages its own column');
assert.ok(ens(hourly, 0, 1, 1, EQUAL) > 0, 'past index (0) is not skipped');

// --- 4. missing data and missing weights -------------------------------------

const sparse = { perModelRadiation: { a: [null, 800], b: [600, undefined] } };
assert.strictEqual(ens(sparse, 0, 1, 1, null), 600, 'models without data for the index are skipped');
assert.strictEqual(ens(sparse, 0, 1, 1, { b: 0.5 }), 600, 'single remaining model → its own value');
assert.strictEqual(ens({ perModelRadiation: { a: [null] } }, 0, 1, 1, null), null, 'no data → null');
assert.strictEqual(ens({}, 0, 1, 1, null), null, 'no perModelRadiation → null');
assert.strictEqual(ens({ perModelRadiation: {} }, 0, 1, 1, null), null, 'empty model set → null');

// Absent weights default to 0.25 for every model, which is still a plain mean.
assert.strictEqual(ens(hourly, 0, 1, 1, null), 500, 'null weights → 0.25 each → plain mean');

// --- 5. gtiOverGhi only via `out`, clamped -----------------------------------

const out = {};
ens(hourly, 0, 1, 1, EQUAL, out);
assert.strictEqual(out.gtiOverGhi, 2, 'ratio = weighted GTI / weighted GHI (500/250)');

assert.doesNotThrow(() => ens(hourly, 0, 1, 1, EQUAL), 'out is optional');

// Clamp both ends.
const hi = { perModelRadiation: { a: [1000] }, perModelGhi: { a: [100] } };   // ratio 10
const lo = { perModelRadiation: { a: [100] },  perModelGhi: { a: [1000] } };  // ratio 0.1
const oHi = {}, oLo = {};
ens(hi, 0, 1, 1, null, oHi);
ens(lo, 0, 1, 1, null, oLo);
assert.strictEqual(oHi.gtiOverGhi, 2.5, 'ratio clamped at 2.5');
assert.strictEqual(oLo.gtiOverGhi, 0.3, 'ratio clamped at 0.3');

// No GHI series → no ratio reported, caller keeps its own default.
const noGhi = {};
ens({ perModelRadiation: { a: [500] } }, 0, 1, 1, null, noGhi);
assert.strictEqual(noGhi.gtiOverGhi, undefined, 'no GHI → ratio left untouched');

console.log('ens-radiation-shared: all assertions passed');
