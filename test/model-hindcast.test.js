'use strict';

// The 14-day hindcast scorer ranks the 5 Open-Meteo ensemble models on forecast SHAPE, using the
// archived day-ahead run (previous_day1) against the panel means already stored in
// policy_mode_history. getModelWeights() only consumes the RANK, so the score is scale-free by
// construction — one fitted factor per model absorbs panel size and any systematic model offset.
//
// What these tests guard:
//  1. scale invariance — a model reporting double W/m² must not be punished or rewarded
//  2. shape error IS punished, and reorders the ranking
//  3. pairing discipline — thin hours, flagged slots and night hours never enter n
//  4. the n < MIN_PAIRED_HOURS gate keeps getModelWeights() on the EMA path even with the flag on

const assert = require('assert');
const {
  buildActualHourMap, buildForecastMaps, scoreModels, MIN_PAIRED_HOURS,
} = require('../lib/model-hindcast');
const { ENSEMBLE_MODELS } = require('../lib/weather-forecaster');
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

const H0 = Math.floor(Date.parse('2026-08-01T00:00:00Z') / 3600000);

// A clean solar day: 6 daylight hours, bell-shaped.
const SHAPE = [80, 320, 700, 900, 640, 210];
const DAY_START_H = 6; // 06:00-12:00 UTC, all above the 10 W/m² daylight gate

/** Build a forecast map for one model over `days` copies of `shape`. */
function gtiMap(shape, days = 1, mult = 1) {
  const m = new Map();
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < shape.length; i++) {
      m.set(H0 + d * 24 + DAY_START_H + i, shape[i] * mult);
    }
  }
  return m;
}

/** Actual panel W = yield × the true shape. */
function actualMap(shape, days = 1, yieldFactor = 0.18) {
  const m = new Map();
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < shape.length; i++) {
      m.set(H0 + d * 24 + DAY_START_H + i, shape[i] * yieldFactor);
    }
  }
  return m;
}

test('scale invariance: doubling a model\'s GTI leaves its score and rank untouched', () => {
  const actual = actualMap(SHAPE, 5);
  const base = {};
  const scaled = {};
  for (const m of ENSEMBLE_MODELS) {
    base[m] = gtiMap(SHAPE, 5);
    scaled[m] = gtiMap(SHAPE, 5);
  }
  // Only the first model is doubled.
  scaled[ENSEMBLE_MODELS[0]] = gtiMap(SHAPE, 5, 2);

  const a = scoreModels(base, actual);
  const b = scoreModels(scaled, actual);

  assert.strictEqual(a.n, b.n, 'paired-hour count must not change');
  assert.ok(Math.abs(a.scores[ENSEMBLE_MODELS[0]] - b.scores[ENSEMBLE_MODELS[0]]) < 1e-9,
    `score moved on a pure rescale: ${a.scores[ENSEMBLE_MODELS[0]]} → ${b.scores[ENSEMBLE_MODELS[0]]}`);
  // k must absorb the factor 2, not the score.
  assert.ok(Math.abs(b.k[ENSEMBLE_MODELS[0]] * 2 - a.k[ENSEMBLE_MODELS[0]]) < 1e-9,
    'the fitted factor k must absorb the rescale');
});

test('shape error is punished and reorders the ranking', () => {
  const actual = actualMap(SHAPE, 5);
  const gti = {};
  for (const m of ENSEMBLE_MODELS) gti[m] = gtiMap(SHAPE, 5);

  // One model gets the timing wrong: same daily total, peak in the wrong hour.
  const wrong = [700, 900, 80, 320, 640, 210];
  const badModel = ENSEMBLE_MODELS[2];
  gti[badModel] = gtiMap(wrong, 5);

  const r = scoreModels(gti, actual);

  const perfect = ENSEMBLE_MODELS.filter(m => m !== badModel);
  for (const m of perfect) {
    assert.ok(r.scores[m] > 0.999, `exact-shape model ${m} should score ~1.0, got ${r.scores[m]}`);
  }
  assert.ok(r.scores[badModel] < 0.7,
    `wrong-shape model should be punished, got ${r.scores[badModel]}`);

  const ranked = Object.entries(r.scores).sort((a, b) => b[1] - a[1]).map(([m]) => m);
  assert.strictEqual(ranked[ranked.length - 1], badModel, 'wrong-shape model must rank last');
});

test('pairing: thin hours, flagged slots and night hours never enter n', () => {
  const iso = (h, q) => new Date((H0 + h) * 3600000 + q * 900000).toISOString();

  const entries = [
    // Hour 6 fully covered → counts. Buckets 07:00..07:45 describe the intervals ending there,
    // i.e. 06:45-07:00 belongs to hour 6, so the four quarters of hour 6 end at 06:15..07:00.
    { ts: iso(6, 1), pvAvgW: 100, exception: null },
    { ts: iso(6, 2), pvAvgW: 100, exception: null },
    { ts: iso(6, 3), pvAvgW: 100, exception: null },
    { ts: iso(7, 0), pvAvgW: 100, exception: null },
    // Hour 7: only 2 quarters → dropped by MIN_QUARTERS.
    { ts: iso(7, 1), pvAvgW: 200, exception: null },
    { ts: iso(7, 2), pvAvgW: 200, exception: null },
    // Hour 8: 4 quarters but one flagged → the flagged one is skipped, leaving 3 → still counts.
    { ts: iso(8, 1), pvAvgW: 300, exception: null },
    { ts: iso(8, 2), pvAvgW: 300, exception: null },
    { ts: iso(8, 3), pvAvgW: 300, exception: null },
    { ts: iso(9, 0), pvAvgW: 999, exception: 'p1_unavailable' },
    // Hour 9: 4 quarters, all flagged → dropped entirely.
    { ts: iso(9, 1), pvAvgW: 400, exception: 'battery_sensor_lag' },
    { ts: iso(9, 2), pvAvgW: 400, exception: 'battery_sensor_lag' },
    { ts: iso(9, 3), pvAvgW: 400, exception: 'battery_sensor_lag' },
    { ts: iso(10, 0), pvAvgW: 400, exception: 'battery_sensor_lag' },
  ];

  const actual = buildActualHourMap(entries);
  assert.deepStrictEqual([...actual.keys()].sort((a, b) => a - b), [H0 + 6, H0 + 8],
    'only the fully-covered, unflagged hours may survive');
  assert.strictEqual(actual.get(H0 + 8), 300, 'the flagged quarter must not drag the hour mean');

  // Night hours: forecast below the daylight gate → excluded from n even when actuals exist.
  const gti = {};
  for (const m of ENSEMBLE_MODELS) {
    gti[m] = new Map([[H0 + 6, 500], [H0 + 8, 2]]); // hour 8 is below DAYLIGHT_W
  }
  const r = scoreModels(gti, actual);
  assert.strictEqual(r.n, 1, `night/dark hours must not be scored, got n=${r.n}`);
});

test('forecast label offset puts Open-Meteo hours on interval-start keys', () => {
  const json = {
    hourly: {
      time: ['2026-08-01T07:00', '2026-08-01T08:00'],
      global_tilted_irradiance_previous_day1_gfs_seamless: [111, 222],
    },
  };
  const maps = buildForecastMaps(json);
  // 07:00 is the preceding-hour mean, i.e. the 06:00-07:00 interval → key = hour 6.
  assert.strictEqual(maps.gfs_seamless.get(H0 + 6), 111);
  assert.strictEqual(maps.gfs_seamless.get(H0 + 7), 222);
});

test('n below MIN_PAIRED_HOURS keeps getModelWeights on the EMA path, flag on or off', () => {
  const engine = new LearningEngine({ log() {}, error() {} });
  engine.data = {
    pv_model_accuracy: {
      meteofrance_arpege_europe: 0.90,
      gfs_seamless: 0.60,
      icon_seamless: 0.85,
      knmi_harmonie_arome_netherlands: 0.80,
      ecmwf_ifs: 0.70,
    },
    // Hindcast disagrees hard: gfs best, meteofrance worst.
    pv_model_hindcast: {
      scores: {
        meteofrance_arpege_europe: 0.10,
        gfs_seamless: 0.99,
        icon_seamless: 0.50,
        knmi_harmonie_arome_netherlands: 0.40,
        ecmwf_ifs: 0.30,
      },
      n: MIN_PAIRED_HOURS - 1,
      computedAt: Date.now(),
    },
  };

  const emaWeights = engine.getModelWeights();
  engine.hindcastEnabled = true;
  const gated = engine.getModelWeights();
  assert.deepStrictEqual(gated, emaWeights,
    'a too-small window must not be allowed to reorder the blend');

  // With enough hours the hindcast does take over and the ranking flips.
  engine.data.pv_model_hindcast.n = MIN_PAIRED_HOURS;
  const applied = engine.getModelWeights();
  assert.ok(applied.gfs_seamless > applied.meteofrance_arpege_europe,
    'once the window is big enough the hindcast ranking must win');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
