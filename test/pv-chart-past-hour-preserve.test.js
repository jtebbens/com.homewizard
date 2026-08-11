'use strict';

// Regression 2026-08-11: the weather path (device.js ~1957) rebuilt policy_pv_forecast_hourly
// from raw OM x learned-YF for the WHOLE day, past hours included, and its 30-minute
// blendAge gate never held because the optimizer cadence is exactly 30 minutes — both
// writers fired 0.4s apart on every run. The optimizer then snapshotted the just-clobbered
// value as _preExistingPvForecast and _buildPvChartByDay carried it back out, so an elapsed
// hour permanently held the uncorrected value (h09 stored 1875W while every run that covered
// h09 computed 2273-2694W).
//
// _preservePastHours enforces:
//   1. Today's hours strictly before nowAmsHour keep the previously stored value.
//   2. The current hour and every future hour keep the freshly computed value.
//   3. Tomorrow (index 1) is never touched.
//   4. Missing/partial previous state degrades to the fresh value, no crash.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const preserve = BatteryPolicyDevice._preservePastHours.bind(BatteryPolicyDevice);

const NOW_AMS_HOUR = 12;

// --- 1. the actual bug: an elapsed hour keeps the corrected value -------------

// Previous store = what the optimizer wrote (corrected). Fresh = raw OM x YF rebuild.
const previous = [{ 8: 1089, 9: 2694, 10: 2363, 11: 2729, 12: 2819, 13: 2884 }, { 9: 2016 }];
const fresh    = [{ 8: 900,  9: 1875, 10: 2100, 11: 2500, 12: 2600, 13: 2700 }, { 9: 1700 }];

const r = preserve(fresh, previous, NOW_AMS_HOUR);

assert.strictEqual(r[0][9], 2694, 'elapsed hour 9 must keep the stored corrected value');
assert.notStrictEqual(r[0][9], 1875, 'the raw OM x YF clobber value must not survive');
assert.strictEqual(r[0][8], 1089, 'elapsed hour 8 preserved');
assert.strictEqual(r[0][10], 2363, 'elapsed hour 10 preserved');
assert.strictEqual(r[0][11], 2729, 'elapsed hour 11 preserved');

// --- 2. current and future hours take the fresh value ------------------------

assert.strictEqual(r[0][12], 2600, 'current hour must take the fresh value');
assert.strictEqual(r[0][13], 2700, 'future hour must take the fresh value');

// --- 3. tomorrow is never touched --------------------------------------------

assert.strictEqual(r[1][9], 1700, 'tomorrow keeps the fresh value at every hour');

// --- 4. mutates in place and returns the same array --------------------------

assert.strictEqual(r, fresh, 'returns the fresh array it mutated');

// --- 5. missing previous state degrades to fresh, no crash -------------------

const f2 = [{ 9: 1875 }, {}];
assert.strictEqual(preserve(f2, null, NOW_AMS_HOUR)[0][9], 1875, 'null previous → fresh kept');
assert.strictEqual(preserve(f2, undefined, NOW_AMS_HOUR)[0][9], 1875, 'undefined previous → fresh kept');
assert.strictEqual(preserve(f2, [], NOW_AMS_HOUR)[0][9], 1875, 'empty previous → fresh kept');
assert.strictEqual(preserve(f2, [null, null], NOW_AMS_HOUR)[0][9], 1875, 'null day map → fresh kept');
assert.doesNotThrow(() => preserve(null, previous, NOW_AMS_HOUR), 'null fresh must not throw');

// --- 6. non-numeric previous values are ignored ------------------------------

const f3 = [{ 9: 1875 }, {}];
preserve(f3, [{ 9: null }, {}], NOW_AMS_HOUR);
assert.strictEqual(f3[0][9], 1875, 'null in previous must not overwrite a real fresh value');

// --- 7. a past hour absent from fresh is restored from previous --------------

// The weather path emits nothing for an hour without a dailyProfiles entry; the stored
// history for that hour must still survive the rebuild.
const f4 = [{ 12: 2600 }, {}];
preserve(f4, [{ 9: 2694 }, {}], NOW_AMS_HOUR);
assert.strictEqual(f4[0][9], 2694, 'past hour missing from fresh is restored from previous');

// --- 8. midnight: nowAmsHour=0 preserves nothing ------------------------------

const f5 = [{ 0: 5, 1: 7 }, {}];
preserve(f5, [{ 0: 999, 1: 999 }, {}], 0);
assert.deepStrictEqual(f5[0], { 0: 5, 1: 7 }, 'at hour 0 no hour is in the past');

// --- 9. _buildPvChartByDay must not overwrite an elapsed hour -----------------
//
// Regression 2026-08-11 (second writer). weather-forecaster._processForecast picks
// currentIndex = first OM label with t > now (:510), then shifts each slot back one hour
// for the "preceding hour" convention (:599). So hourlyForecast[0] is always the hour that
// was RUNNING at fetch time. The weather cache lives 1h while the optimizer runs every
// 15 min, so after the clock passes the next hour that leading slot is fully elapsed and
// still sits at the head of the array. device.js:3069 filters on radiationWm2 only — no
// time filter — so the stale slot reaches _buildPvChartByDay, which overwrote its hour on
// every run with a freshly re-corrected value (measured: h18 254→259→252 while h2..h17,
// absent from the array, stayed frozen).
//
// The DP itself is unaffected: _getPvForSlot brackets per PRICE slot and sumPvNetWindow
// drops slotMs <= startMs, so no future slot ever reads the stale entry.

const build = BatteryPolicyDevice._buildPvChartByDay.bind(BatteryPolicyDevice);

const NOW = new Date('2026-08-11T17:10:00Z'); // 19:10 Amsterdam → h18 elapsed, h19 running
const pvFc = [
  { timestamp: '2026-08-11T16:00:00Z', pvPowerW: 999 }, // h18 Ams — stale, already elapsed
  { timestamp: '2026-08-11T17:00:00Z', pvPowerW: 196 }, // h19 Ams — running hour
  { timestamp: '2026-08-11T18:00:00Z', pvPowerW: 83 },  // h20 Ams — future
  { timestamp: '2026-08-12T16:00:00Z', pvPowerW: 244 }, // tomorrow h18 — future
];
const stored = [{ 17: 796, 18: 254, 19: 153 }, { 18: 184 }];

const b = build(stored, pvFc, 3000, NOW);

assert.strictEqual(b[0][18], 254, 'elapsed hour 18 must keep the stored value, not the stale slot');
assert.notStrictEqual(b[0][18], 999, 'the stale leading slot must not reach the chart');
assert.strictEqual(b[0][17], 796, 'an hour absent from pvForecast is carried through unchanged');
assert.strictEqual(b[0][19], 196, 'the running hour still takes the fresh value');
assert.strictEqual(b[0][20], 83, 'future hours take the fresh value');
assert.strictEqual(b[1][18], 244, 'tomorrow has no elapsed hours — always fresh');

// Cold start: nothing stored for the elapsed hour → fall back to the fresh value rather
// than leaving a hole in the chart.
const bCold = build([{}, {}], pvFc, 3000, NOW);
assert.strictEqual(bCold[0][18], 999, 'no stored value → elapsed hour falls back to fresh');

// A non-numeric stored value must not win over a real fresh value.
const bNull = build([{ 18: null }, {}], pvFc, 3000, NOW);
assert.strictEqual(bNull[0][18], 999, 'null stored value → elapsed hour falls back to fresh');

// Midnight: at hour 0 nothing is elapsed yet.
const bMid = build([{ 0: 999 }, {}], [{ timestamp: '2026-08-10T22:10:00Z', pvPowerW: 5 }],
  3000, new Date('2026-08-10T22:10:00Z')); // 00:10 Ams on the 11th
assert.strictEqual(bMid[0][0], 5, 'at hour 0 no hour is in the past');

console.log('pv-chart-past-hour-preserve: all assertions passed');
