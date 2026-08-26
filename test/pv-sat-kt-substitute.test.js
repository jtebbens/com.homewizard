'use strict';

/**
 * Satellite GHI as a clearness-index (kt) substitute, for the morning hours where KNMI's own
 * kt does not exist yet.
 *
 * Why this exists: `_computeKnmiKt` needs >=4 daylight hours of KNMI data, so kt is null until
 * roughly 08:06-09:43 UTC. Until then `getDailyPvBiasFactor` classifies the day on OM cloud
 * cover > 75%, which on 2026-08-17 picked the overcast bucket (0.440) for a day whose measured
 * kt never went below 0.36 — the blend put 08:00 UTC at 1250 W, the roof did 1403 W, the DP got
 * 550 W. Measured over 33 days: 108 runs on 5 days were classified overcast while that day's kt
 * never dropped under 0.30. See project_daily_bias_overcast_bucket_halves_blend_0817 sections 5-6.
 *
 * The satellite curve is already accumulated in `_satGhi15min` (36h of 15-min buckets), so the
 * substitute reuses the SAME formula as KNMI (ratio of sums, ghi > 10, elev >= 5,
 * clear-sky = 1000*sin(elev)) — that keeps kt_sat on the same scale as kt_knmi, so the existing
 * 0.30 / 0.65 bucket thresholds carry over unchanged.
 */

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');
const LearningEngine = require('../lib/learning-engine');

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

const LAT = 52.02;
const LON = 5.04;
const DAY = '2026-08-17';

function makeWF(buckets = {}) {
  const homey = { log: () => {}, error: () => {} };
  const wf = new WeatherForecaster(homey, null);
  wf._lastLat = LAT;
  wf._lastLon = LON;
  wf._satGhi15min = { ...buckets };
  return wf;
}

const at = (hhmm, day = DAY) => Date.parse(`${day}T${hhmm}:00.000Z`);

/** Independent reference: ratio of sums over qualifying buckets. Mirrors nothing — it is the
 *  definition the implementation has to match, computed here from the raw inputs. */
function expectedKt(buckets) {
  let sa = 0, sc = 0, n = 0;
  for (const [ms, ghi] of Object.entries(buckets)) {
    if (typeof ghi !== 'number' || ghi <= 10) continue;
    const { elev } = WeatherForecaster._solarElevAz(new Date(+ms), LAT, LON);
    if (elev < 5) continue;
    const clear = 1000 * Math.sin(elev * Math.PI / 180);
    if (clear <= 10) continue;
    sa += ghi; sc += clear; n++;
  }
  return { kt: n >= 8 && sc > 0 ? sa / sc : null, n };
}

/** 15-min buckets from `hhmm` onward, `count` of them, each holding `ghi` W/m2. */
function series(hhmm, count, ghi, day = DAY) {
  const out = {};
  let ms = at(hhmm, day);
  for (let i = 0; i < count; i++) { out[ms] = ghi; ms += 900_000; }
  return out;
}

console.log('satellite kt substitute');

test('7 buckets is not enough — no verdict', () => {
  const wf = makeWF(series('06:00', 7, 400));
  const info = wf.getTodaySatKtInfo(DAY);
  assert.strictEqual(info.kt, null, 'below the 8-bucket minimum kt must stay null');
  assert.strictEqual(info.n, 7);
});

test('8 buckets is enough, and equals the ratio of sums', () => {
  const buckets = series('06:00', 8, 400);
  const wf = makeWF(buckets);
  const info = wf.getTodaySatKtInfo(DAY);
  const ref = expectedKt(buckets);
  assert.strictEqual(info.n, 8);
  assert.ok(info.kt != null, 'kt must exist at n=8');
  assert.ok(Math.abs(info.kt - ref.kt) < 1e-9,
    `ratio of sums expected ${ref.kt}, got ${info.kt}`);
});

test('ratio of sums, not mean of ratios — uneven buckets separate the two', () => {
  // Low sun + high GHI in one bucket, high sun + low GHI in another: the two aggregations
  // disagree, so this pins which one is implemented.
  const buckets = { ...series('06:00', 8, 100) };
  buckets[at('06:00')] = 700;
  const wf = makeWF(buckets);
  const ref = expectedKt(buckets);
  let meanOfRatios = 0, m = 0;
  for (const [ms, ghi] of Object.entries(buckets)) {
    const { elev } = WeatherForecaster._solarElevAz(new Date(+ms), LAT, LON);
    meanOfRatios += ghi / (1000 * Math.sin(elev * Math.PI / 180)); m++;
  }
  meanOfRatios /= m;
  assert.ok(Math.abs(ref.kt - meanOfRatios) > 1e-3, 'test data must separate the two forms');
  assert.ok(Math.abs(wf.getTodaySatKtInfo(DAY).kt - ref.kt) < 1e-9, 'must be ratio of sums');
});

test("yesterday's buckets do not count toward today", () => {
  const wf = makeWF({ ...series('06:00', 8, 400, '2026-08-16'), ...series('06:00', 3, 400) });
  assert.strictEqual(wf.getTodaySatKtInfo(DAY).n, 3, 'only today');
  assert.strictEqual(wf.getTodaySatKtInfo(DAY).kt, null);
  assert.strictEqual(wf.getTodaySatKtInfo('2026-08-16').n, 8, 'yesterday still resolves on its own');
});

test('dark and low-sun buckets are skipped — same filters as _computeKnmiKt', () => {
  const good = series('06:00', 8, 400);
  const wf = makeWF({
    ...good,
    [at('05:00')]: 400, // elev 3.9 deg < 5
    [at('08:00')]: 6,   // ghi <= 10
    [at('08:15')]: null,
  });
  const info = wf.getTodaySatKtInfo(DAY);
  assert.strictEqual(info.n, 8, 'the three junk buckets must not be counted');
  assert.ok(Math.abs(info.kt - expectedKt(good).kt) < 1e-9);
});

test('forward buckets are forecast, not observation — excluded', () => {
  // _satGhi15min holds the whole curve, which runs hours ahead of its issue time. Counting those
  // would let a nowcast of the coming afternoon decide the morning's weather type.
  const wf = makeWF({ ...series('06:00', 8, 400), ...series('08:00', 8, 900) });
  const info = wf.getTodaySatKtInfo(DAY, at('08:00'));
  assert.strictEqual(info.n, 8, 'only buckets strictly before now');
  assert.ok(Math.abs(info.kt - expectedKt(series('06:00', 8, 400)).kt) < 1e-9,
    'the bright forward buckets must not lift kt');
});

test('a single fresh curve is not a verdict — its forward buckets do not reach the minimum', () => {
  const wf = makeWF(series('06:00', 16, 400)); // 06:00 through 09:45
  const info = wf.getTodaySatKtInfo(DAY, at('07:00'));
  assert.strictEqual(info.n, 4, 'four elapsed buckets at 07:00');
  assert.strictEqual(info.kt, null, 'kt still needs 2h of ELAPSED sky');
});

test('no coordinates yet — no verdict rather than a wrong one', () => {
  const wf = makeWF(series('06:00', 8, 400));
  wf._lastLat = null;
  wf._lastLon = null;
  assert.strictEqual(wf.getTodaySatKtInfo(DAY).kt, null);
});

test('empty accumulator after a restart reports n=0, not a crash', () => {
  const wf = makeWF();
  wf._satGhi15min = null;
  assert.deepStrictEqual(wf.getTodaySatKtInfo(DAY),
    { kt: null, n: 0, raw: 0, mapN: 0, coords: true });
});

// The three ways to have no verdict have to be distinguishable from each other, or the shadow
// line cannot say whether the substitute is broken or merely still filling up (2026-08-26).
test('missing coordinates and an empty accumulator do not look alike', () => {
  const noCoords = makeWF(series('06:00', 8, 400));
  noCoords._lastLat = null;
  noCoords._lastLon = null;
  const a = noCoords.getTodaySatKtInfo(DAY);
  assert.strictEqual(a.coords, false, 'coords must report the real cause');
  assert.strictEqual(a.raw, 8, 'the buckets are there — only the elevation gate cannot run');
  assert.strictEqual(a.n, 0);

  const empty = makeWF();
  const b = empty.getTodaySatKtInfo(DAY);
  assert.strictEqual(b.coords, true);
  assert.strictEqual(b.mapN, 0, 'nothing held at all');
  assert.strictEqual(b.raw, 0);
});

test('raw counts today past daylight buckets, before the elevation gate', () => {
  const wf = makeWF({
    ...series('03:00', 4, 400),          // sun below 5 deg: raw, but not n
    ...series('06:00', 8, 400),          // qualifying
    ...series('06:00', 4, 400, '2026-08-16'), // yesterday: neither
    [at('08:00')]: 5,                    // dark bucket: neither
  });
  const info = wf.getTodaySatKtInfo(DAY, at('12:00'));
  assert.strictEqual(info.raw, 12, 'today past buckets above the dark filter');
  assert.strictEqual(info.n, 8, 'only the ones that clear the elevation gate');
  assert.strictEqual(info.mapN, 17, 'everything held, yesterday and dark included');
});

console.log('\nclassification flip (the 2026-08-17 shape)');

function bias(cloudPct, kt) {
  const le = Object.create(LearningEngine.prototype);
  le.data = {
    pv_daily_bias_overcast: 0.440, pv_daily_bias_overcast_samples: 12,
    pv_daily_bias: 0.561, pv_daily_bias_samples: 30,
    pv_daily_bias_clear: 1.20, pv_daily_bias_clear_samples: 10,
  };
  return le.getDailyPvBiasFactor(cloudPct, kt);
}

test('live behaviour today: kt null + cloud 90% picks the overcast bucket', () => {
  assert.strictEqual(bias(90, null), 0.440, 'this is the factor the DP actually got on 17-08');
});

test('a satellite kt of 0.5 moves the day out of the overcast bucket', () => {
  assert.strictEqual(bias(90, 0.5), 0.561, 'kt >= 0.30 is not overcast, kt < 0.65 is not clear');
});

test('a satellite kt that really is overcast keeps 0.440', () => {
  assert.strictEqual(bias(90, 0.22), 0.440, 'the factor is legitimate when the sky is observed dark');
});

console.log('\nwiring — which kt classifies the day');

// Stub 'homey' so battery-policy/device.js loads outside Homey.
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

test('measured KNMI kt always wins over the satellite estimate', () => {
  assert.strictEqual(BatteryPolicyDevice._resolveClassifierKt(0.57, 0.22, true), 0.57);
});

test('with the setting off the satellite kt is inert — OM cloud fallback, unchanged behaviour', () => {
  assert.strictEqual(BatteryPolicyDevice._resolveClassifierKt(null, 0.5, false), null);
  assert.strictEqual(bias(90, BatteryPolicyDevice._resolveClassifierKt(null, 0.5, false)), 0.440);
});

test('with the setting on the satellite kt fills the morning gap', () => {
  assert.strictEqual(BatteryPolicyDevice._resolveClassifierKt(null, 0.5, true), 0.5);
  assert.strictEqual(bias(90, BatteryPolicyDevice._resolveClassifierKt(null, 0.5, true)), 0.561);
});

test('setting on but no satellite verdict yet — still the OM cloud fallback', () => {
  assert.strictEqual(BatteryPolicyDevice._resolveClassifierKt(null, null, true), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
