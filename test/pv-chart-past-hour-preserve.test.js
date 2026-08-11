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

console.log('pv-chart-past-hour-preserve: all assertions passed');
