'use strict';

// Clear-sky denominator behind the clearness index kt, and the weather-type buckets on top of it.
//
// kt = measured GHI / clear-sky GHI decides whether a day is typed clear / mixed / overcast, and
// that type shifts the whole PV forecast through getDailyPvBiasFactor(). The denominator is
// computed from solar elevation alone, so getting it wrong bends the kt scale — and because kt is
// a ratio of SUMS, it bends it by season: in summer the sub-15° hours carry ~5% of the day, in
// December all of it.
//
// The property that matters is NOT "the formula returns these numbers" — a test that recomputes
// the formula only confirms whoever wrote it. It is that the kt scale must be season-stationary:
// the clearest days of every month should score about the same, because no atmosphere is clearer
// in April than in December. That is what the last test measures, on a year of real ERA5
// radiation, through the production functions.

const assert = require('assert');
const path = require('path');
const WeatherForecaster = require('../lib/weather-forecaster');
const LearningEngine = require('../lib/learning-engine');

let passed = 0;
let failed = 0;

const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  });
}

console.log('\nClear-sky formula & kt buckets\n');

// ---------------------------------------------------------------------------
// 1. The two denominators
// ---------------------------------------------------------------------------

test('simple model is the plain oblique-incidence projection', () => {
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(90, 'simple')), 1000);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(30, 'simple')), 500);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(10, 'simple')), 174);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(5, 'simple')), 87);
});

test('haurwitz adds atmospheric extinction: barely at zenith, heavily at grazing angles', () => {
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(90, 'haurwitz')), 1037);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(30, 'haurwitz')), 490);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(10, 'haurwitz')), 137);
  assert.strictEqual(Math.round(WeatherForecaster._clearSkyGhi(5, 'haurwitz')), 50);
});

test('the gap between the models grows as the sun drops', () => {
  const gap = (e) => WeatherForecaster._clearSkyGhi(e, 'simple') / WeatherForecaster._clearSkyGhi(e, 'haurwitz');
  assert.ok(gap(90) < 1.0, 'at zenith haurwitz is the higher of the two');
  assert.ok(gap(30) > 1.0 && gap(30) < 1.1, `30°: expected a few %, got ${gap(30).toFixed(3)}`);
  assert.ok(gap(10) > 1.2, `10°: expected >20%, got ${gap(10).toFixed(3)}`);
  assert.ok(gap(5) > 1.6, `5°: expected >60%, got ${gap(5).toFixed(3)}`);
});

test('unknown model falls back to the historical default rather than throwing', () => {
  assert.strictEqual(WeatherForecaster._clearSkyGhi(30), WeatherForecaster._clearSkyGhi(30, 'simple'));
  assert.strictEqual(WeatherForecaster._clearSkyGhi(30, 'nonsense'), WeatherForecaster._clearSkyGhi(30, 'simple'));
});

test('sun at or below the horizon yields no clear-sky radiation', () => {
  for (const model of ['simple', 'haurwitz']) {
    assert.strictEqual(WeatherForecaster._clearSkyGhi(0, model), 0);
    assert.strictEqual(WeatherForecaster._clearSkyGhi(-10, model), 0);
  }
});

// ---------------------------------------------------------------------------
// 2. The buckets on top of it
// ---------------------------------------------------------------------------

test('classifyKt boundaries: 0.65 is clear, 0.30 is already mixed', () => {
  assert.strictEqual(LearningEngine.classifyKt(0.65), 'clear');
  assert.strictEqual(LearningEngine.classifyKt(0.6499), 'mixed');
  assert.strictEqual(LearningEngine.classifyKt(0.30), 'mixed');
  assert.strictEqual(LearningEngine.classifyKt(0.2999), 'overcast');
});

test('classifyKt says null when there is nothing to classify', () => {
  assert.strictEqual(LearningEngine.classifyKt(null), null);
  assert.strictEqual(LearningEngine.classifyKt(undefined), null);
  assert.strictEqual(LearningEngine.classifyKt(NaN), null);
});

test('getDailyPvBiasFactor routes through the same buckets', () => {
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {
    pv_daily_bias_clear: 1.20, pv_daily_bias_clear_samples: 10,
    pv_daily_bias_overcast: 0.80, pv_daily_bias_overcast_samples: 10,
    pv_daily_bias: 1.00, pv_daily_bias_samples: 10,
  };
  assert.strictEqual(engine.getDailyPvBiasFactor(null, 0.70), 1.20);
  assert.strictEqual(engine.getDailyPvBiasFactor(null, 0.20), 0.80);
  assert.strictEqual(engine.getDailyPvBiasFactor(null, 0.50), 1.00);
});

// ---------------------------------------------------------------------------
// 3. The property the change is for: a season-stationary kt scale
// ---------------------------------------------------------------------------

// Rebuilds daily kt exactly the way _computeKnmiKt does — same gates (ghi > 10, elev >= 5,
// elevation taken at HH:30, >= 4 qualifying hours), same solar geometry, same clear-sky helper.
function dailyKt(days, lat, lon, model) {
  const out = [];
  for (const [dateStr, hours] of Object.entries(days)) {
    let act = 0, clear = 0, n = 0;
    for (const [hourStr, ghi] of Object.entries(hours)) {
      if (ghi <= 10) continue;
      const d = new Date(`${dateStr}T${String(hourStr).padStart(2, '0')}:30:00Z`);
      const { elev } = WeatherForecaster._solarElevAz(d, lat, lon);
      if (elev < 5) continue;
      const cs = WeatherForecaster._clearSkyGhi(elev, model);
      if (cs <= 10) continue;
      act += ghi; clear += cs; n++;
    }
    if (n >= 4 && clear > 0) out.push({ month: dateStr.slice(5, 7), kt: act / clear });
  }
  return out;
}

// The clearest days of a month, as p90 of that month's daily kt. Max-minus-min across all twelve
// is too fragile to assert on: it hangs on the single worst month, and a month that simply had no
// clear day at all (October 2025 in this fixture, p90 0.695) drags it regardless of the formula.
// The claim is specifically about LOW SUN, so compare the darkest months against the brightest.
const DARK_MONTHS = ['11', '12', '01'];
const BRIGHT_MONTHS = ['04', '05', '06', '07'];

function monthlyP90(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month).push(r.kt);
  }
  const p90 = new Map();
  for (const [m, a] of byMonth) {
    const s = a.sort((x, y) => x - y);
    p90.set(m, s[Math.min(s.length - 1, Math.floor(0.9 * s.length))]);
  }
  const mean = (ms) => ms.reduce((acc, m) => acc + p90.get(m), 0) / ms.length;
  return {
    months: p90.size,
    dark: mean(DARK_MONTHS),
    bright: mean(BRIGHT_MONTHS),
    gap: mean(BRIGHT_MONTHS) - mean(DARK_MONTHS),
  };
}

test('haurwitz gives the more season-stationary kt scale on a year of real radiation', () => {
  const fx = require(path.join(__dirname, 'fixtures', 'kt-hourly-ghi-1y.json'));
  const simple = monthlyP90(dailyKt(fx.days, fx._lat, fx._lon, 'simple'));
  const haur = monthlyP90(dailyKt(fx.days, fx._lat, fx._lon, 'haurwitz'));

  assert.strictEqual(simple.months, 12, 'fixture must span all twelve months');
  assert.strictEqual(haur.months, 12);

  // The defect: on the current scale the clearest winter days score far below the clearest
  // summer days, which no atmosphere explains.
  assert.ok(
    simple.gap > 0.10,
    `expected the simple scale to sag in winter, got a gap of ${simple.gap.toFixed(3)}`,
  );
  // The fix: that gap must largely close. It need not reach zero — winter air is genuinely hazier
  // and the sun grazes for longer, so some residual is real.
  assert.ok(
    haur.gap < simple.gap * 0.5,
    `expected the winter gap to at least halve, got ${haur.gap.toFixed(3)} vs ${simple.gap.toFixed(3)}`,
  );
  // Directional guard: the lift must come from raising winter, not from flattening summer.
  assert.ok(
    haur.dark > simple.dark + 0.08,
    `winter p90 should rise, got ${haur.dark.toFixed(3)} vs ${simple.dark.toFixed(3)}`,
  );
  assert.ok(
    Math.abs(haur.bright - simple.bright) < 0.03,
    `summer p90 should barely move, got ${haur.bright.toFixed(3)} vs ${simple.bright.toFixed(3)}`,
  );
});

test('the two kt sources share one denominator, so a model change moves both together', () => {
  // _computeSatKt documents that it must land on the same scale as _computeKnmiKt. Guard that
  // they both route through the shared helper by checking they respond to the model argument.
  const homey = { log: () => {}, error: () => {} };
  const wf = new WeatherForecaster(homey, { data: { knmi_hourly_actuals: {
    '2026-01-15': { 9: 60, 10: 110, 11: 140, 12: 130, 13: 90 },
  } } });
  const ktSimple = wf._computeKnmiKt('2026-01-15', 52.02, 5.04, 'simple');
  const ktHaur = wf._computeKnmiKt('2026-01-15', 52.02, 5.04, 'haurwitz');
  assert.ok(ktSimple != null && ktHaur != null, 'both models must produce a kt for this day');
  assert.ok(ktHaur > ktSimple * 1.10, `January kt should lift >10%, got ${ktSimple.toFixed(3)} → ${ktHaur.toFixed(3)}`);

  // Default follows the instance model, which is what the device sets from the setting.
  assert.strictEqual(wf.clearSkyModel, 'simple', 'default must stay the historical behaviour');
  wf._todayKnmiKt = 0.40;
  wf._todayKnmiKtHaurwitz = 0.68;
  assert.strictEqual(wf.getTodayKt(), 0.40);
  wf.clearSkyModel = 'haurwitz';
  assert.strictEqual(wf.getTodayKt(), 0.68);
});

// ---------------------------------------------------------------------------
// 4. The daily scoreboard that makes the change checkable
// ---------------------------------------------------------------------------

function makeScoringEngine() {
  const logs = [];
  // homey.log is what the scoring line uses — LearningEngine's own this.log is gated behind a
  // hardcoded `debug = false` and never reaches the log at all.
  const engine = new LearningEngine({ log: (...a) => logs.push(a.join(' ')) }, { setStoreValue: async () => {} });
  // Ten samples on the target day, actual 20% above predicted → ratio 1.2.
  const preds = [];
  for (let h = 6; h < 16; h++) {
    preds.push({ timestamp: `2026-12-11T${String(h).padStart(2, '0')}:30:00Z`, predicted: 100, actual: 120 });
  }
  engine.data = {
    pv_predictions: preds,
    pv_daily_bias_clear: 1.25, pv_daily_bias_clear_samples: 10,
    pv_daily_bias_overcast: 0.70, pv_daily_bias_overcast_samples: 10,
    pv_daily_bias: 0.95, pv_daily_bias_samples: 10,
  };
  return { engine, logs };
}

// 0.571 vs 0.689 is a real pair from 2025-12-11: the day the two models straddle the 0.65 line.
const DEC11 = { simple: 0.571, haurwitz: 0.689, active: 'simple' };

test('scoreboard records one row per day with both models', async () => {
  const { engine } = makeScoringEngine();
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  const board = engine.data.kt_model_scoreboard;
  assert.strictEqual(board.length, 1);
  const row = board[0];
  assert.strictEqual(row.d, '2026-12-11');
  assert.strictEqual(row.ratio, 1.2, 'the realised forecast error is the point of the row');
  assert.strictEqual(row.bS, 'mixed');
  assert.strictEqual(row.bH, 'clear');
  assert.strictEqual(row.fS, 0.95, 'mixed EMA');
  assert.strictEqual(row.fH, 1.25, 'clear EMA');
  assert.strictEqual(row.active, 'simple');
});

test('the recorded factors are the ones in force that day, not the post-update ones', async () => {
  const { engine } = makeScoringEngine();
  const before = engine.data.pv_daily_bias;
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  assert.notStrictEqual(engine.data.pv_daily_bias, before, 'the EMA must still be updated');
  assert.strictEqual(engine.data.kt_model_scoreboard[0].fS, before,
    'the row must capture the pre-update factor, otherwise it scores the answer against itself');
});

test('a day is not double-counted if the recorder runs twice', async () => {
  const { engine } = makeScoringEngine();
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  assert.strictEqual(engine.data.kt_model_scoreboard.length, 1);
  assert.strictEqual(engine.data.kt_model_scoreboard[0].d, '2026-12-11');
});

test('scoreboard is capped so it cannot grow without bound', async () => {
  const { engine } = makeScoringEngine();
  engine.data.kt_model_scoreboard = [];
  for (let i = 0; i < 260; i++) engine.data.kt_model_scoreboard.push({ d: `old-${i}` });
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  const board = engine.data.kt_model_scoreboard;
  assert.strictEqual(board.length, 250);
  assert.strictEqual(board[board.length - 1].d, '2026-12-11', 'newest day survives the trim');
});

test('the score line names which model landed closer to the realised ratio', async () => {
  const { engine, logs } = makeScoringEngine();
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, DEC11.simple, DEC11);
  const line = logs.find((l) => l.includes('[KT SCORE]'));
  assert.ok(line, 'a scoring line must be logged');
  // ratio 1.2: clear (1.25) is off by 0.05, mixed (0.95) by 0.25.
  assert.ok(line.includes('WISSEL, haurwitz beter'), `unexpected verdict in: ${line}`);
});

test('no scoreboard row when the caller supplies no model pair (unchanged old behaviour)', async () => {
  const { engine } = makeScoringEngine();
  await engine.recordDailyPvBiasFromPredictions('2026-12-11', null, 0.571);
  assert.strictEqual(engine.data.kt_model_scoreboard, undefined);
});

(async () => {
  for (const t of queue) await t();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
