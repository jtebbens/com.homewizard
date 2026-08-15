'use strict';

const fetchWithRetry = require('../includes/utils/fetchWithRetry');
const { ENSEMBLE_MODELS } = require('./weather-forecaster');

// Archived per-model forecast runs. `*_previous_day1` is the run issued one day earlier, so every
// scored hour sits at a fixed ~24h lead — the lead the DP actually plans on. The plain
// historical-forecast-api returns the LATEST run instead (~0-6h lead) and would rank the models on
// a horizon we never use. Verified 2026-08-15: all 5 models return 360/360 slots over 14 days,
// 16.9 kB in one call, with our tilt/azimuth applied.
const PREV_RUNS_URL = 'https://previous-runs-api.open-meteo.com/v1/forecast';

const HINDCAST_DAYS    = 14;
const DAYLIGHT_W       = 10;  // same threshold as _learnFromYesterday (weather-forecaster.js)
const MIN_QUARTERS     = 3;   // of 4 per hour — a thinly covered hour aliases the panel mean
const MIN_PAIRED_HOURS = 60;  // below this the ranking is noise, not a measurement

// Open-Meteo labels hourly radiation at the END of the interval (preceding-hour mean), the panel
// slots are keyed by interval start. Shifting the forecast label back one hour puts both on
// interval-start keys. The daily job logs a −1/0/+1 sweep so this stays evidence-backed instead of
// assumed — a wrong alignment inflates every model's error and can reorder the ranking.
const FORECAST_LABEL_OFFSET_H = -1;

const MS_HOUR = 3600000;
const MS_QUARTER = 900000;

/**
 * Fetch 14 days of archived day-ahead GTI per ensemble model.
 * @returns {Promise<object>} raw Open-Meteo JSON
 */
async function fetchPreviousRuns(lat, lon, tilt, azimuth, days = HINDCAST_DAYS) {
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    hourly: 'global_tilted_irradiance_previous_day1',
    tilt: tilt.toString(),
    azimuth: azimuth.toString(),
    models: ENSEMBLE_MODELS.join(','),
    past_days: days.toString(),
    forecast_days: '1',
    timezone: 'UTC'
  });
  const url = `${PREV_RUNS_URL}?${params.toString()}`;
  const res = await fetchWithRetry(url, {}, 20000);
  if (!res.ok) throw new Error(`Previous-runs API error: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Per-model GTI keyed by interval-START epoch hour.
 * @param {object} json  response from fetchPreviousRuns
 * @returns {{ [model: string]: Map<number, number> }}
 */
function buildForecastMaps(json) {
  const times = json?.hourly?.time;
  const out = {};
  if (!Array.isArray(times)) return out;

  for (const model of ENSEMBLE_MODELS) {
    const arr = json.hourly[`global_tilted_irradiance_previous_day1_${model}`];
    if (!Array.isArray(arr)) continue;
    const map = new Map();
    for (let i = 0; i < times.length; i++) {
      const v = arr[i];
      if (typeof v !== 'number') continue;
      const h = Math.floor(Date.parse(`${times[i]}Z`) / MS_HOUR) + FORECAST_LABEL_OFFSET_H;
      map.set(h, v);
    }
    out[model] = map;
  }
  return out;
}

/**
 * Panel PV per interval-START epoch hour, from mode-history entries.
 *
 * `pvAvgW` is the mean over the 15 min ENDING at the entry's bucket (device.js ~:2668), so the
 * bucket minus 1 ms lands inside the interval it describes.
 *
 * @param {Array<{ts: string, pvAvgW: ?number, exception: ?string}>} entries
 * @returns {Map<number, number>} epoch hour → mean panel W
 */
function buildActualHourMap(entries) {
  const acc = new Map();
  for (const e of entries || []) {
    if (typeof e?.pvAvgW !== 'number') continue;
    // A slot flagged p1_unavailable / battery_sensor_lag / bms_calibration has an untrustworthy
    // panel mean — scoring against it would blame the forecast for a meter problem.
    if (e.exception) continue;
    const ts = Date.parse(e.ts);
    if (!isFinite(ts)) continue;
    const bucket = Math.floor(ts / MS_QUARTER) * MS_QUARTER;
    const h = Math.floor((bucket - 1) / MS_HOUR);
    const cur = acc.get(h) || { sum: 0, n: 0 };
    cur.sum += e.pvAvgW;
    cur.n += 1;
    acc.set(h, cur);
  }

  const out = new Map();
  for (const [h, v] of acc) {
    if (v.n < MIN_QUARTERS) continue;
    out.set(h, v.sum / v.n);
  }
  return out;
}

/**
 * Rank the ensemble models on forecast SHAPE over the window.
 *
 * getModelWeights() only uses the RANK, so the score is deliberately scale-free: one fitted factor
 * k_m per model absorbs panel size, efficiency and any systematic model offset, and what is left is
 * the shape error. That avoids re-implementing the GTI→PV conversion (yield factors) a second time.
 *
 *   k_m    = Σ actual / Σ gti_m
 *   nMAE_m = Σ |actual − k_m · gti_m| / Σ actual
 *   score  = max(0, 1 − nMAE_m)
 *
 * Only hours present in the actuals AND in every model are scored, so all models see the same set.
 *
 * @param {{ [model: string]: Map<number, number> }} gtiByModel
 * @param {Map<number, number>} actualByHour
 * @param {number} [shiftH=0]  shift applied to the forecast keys — for the alignment sweep
 * @returns {{ scores: object, k: object, n: number }}
 */
function scoreModels(gtiByModel, actualByHour, shiftH = 0) {
  const models = ENSEMBLE_MODELS.filter(m => gtiByModel[m]?.size);
  const empty = { scores: {}, k: {}, n: 0 };
  if (!models.length || !actualByHour?.size) return empty;

  const hours = [];
  for (const [h, actual] of actualByHour) {
    const gtis = models.map(m => gtiByModel[m].get(h + shiftH));
    if (gtis.some(g => typeof g !== 'number')) continue;
    if (Math.max(...gtis) <= DAYLIGHT_W) continue;
    hours.push({ actual, gtis });
  }
  if (!hours.length) return empty;

  const sumA = hours.reduce((s, x) => s + x.actual, 0);
  if (sumA <= 0) return empty;

  const scores = {}, k = {};
  models.forEach((m, mi) => {
    const sumG = hours.reduce((s, x) => s + x.gtis[mi], 0);
    if (sumG <= 0) return;
    const km = sumA / sumG;
    const absErr = hours.reduce((s, x) => s + Math.abs(x.actual - km * x.gtis[mi]), 0);
    scores[m] = Math.max(0, 1 - absErr / sumA);
    k[m] = km;
  });

  return { scores, k, n: hours.length };
}

/** Models sorted best-first, as a compact `model:score` string for the shadow log. */
function formatRanking(scores) {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .map(([m, s]) => `${m.split('_')[0]}:${s.toFixed(3)}`)
    .join(',');
}

module.exports = {
  fetchPreviousRuns,
  buildForecastMaps,
  buildActualHourMap,
  scoreModels,
  formatRanking,
  HINDCAST_DAYS,
  MIN_PAIRED_HOURS,
  FORECAST_LABEL_OFFSET_H,
};
