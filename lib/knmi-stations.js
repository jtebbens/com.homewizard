'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const EDR_BASE = 'https://api.dataplatform.knmi.nl/edr/v1/collections/10-minute-in-situ-meteorological-observations';

let _locationsCache = null;
const LOCATIONS_TTL = 24 * 60 * 60 * 1000;

// Cloud cover is only useful from a station close enough to share the sky overhead.
const MAX_OKTA_DIST_KM = 60;

async function _getLocations(apiKey) {
  const now = Date.now();
  if (_locationsCache && (now - _locationsCache.time) < LOCATIONS_TTL) return _locationsCache.features;
  const res = await fetchWithTimeout(`${EDR_BASE}/locations`, { headers: { Authorization: apiKey } }, 10000);
  if (!res.ok) throw new Error(`KNMI locations error ${res.status}`);
  const data = await res.json();
  const features = data.features ?? [];
  _locationsCache = { features, time: now };
  return features;
}

function _nearest(features, userLat, userLon) {
  let best = null, bestD = Infinity;
  for (const f of features) {
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (lat == null || lon == null) continue;
    const d = Math.hypot(lat - userLat, lon - userLon);
    if (d < bestD) { bestD = d; best = f; }
  }
  return { feature: best, distDeg: bestD };
}

function _lastVal(ranges, param) {
  const vals = ranges[param]?.values;
  if (!vals?.length) return null;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] != null && isFinite(vals[i])) return vals[i];
  }
  return null;
}

/** 40 min covers both the 10-min (qg) and 30-min (n) observation cadences. */
function _obsWindow() {
  const now = new Date();
  const from = new Date(now - 40 * 60 * 1000);
  return `${from.toISOString().slice(0, 19)}Z/${now.toISOString().slice(0, 19)}Z`;
}

async function _fetchCoverage(apiKey, stationId, params) {
  const url = new URL(`${EDR_BASE}/locations/${encodeURIComponent(stationId)}`);
  url.searchParams.set('datetime', _obsWindow());
  url.searchParams.set('parameter-name', params);
  url.searchParams.set('f', 'CoverageJSON');

  const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: apiKey } }, 15000);
  if (!res.ok) throw new Error(`KNMI EDR error ${res.status}`);
  const data = await res.json();

  const coverages = data.coverages ?? (data.type === 'Coverage' ? [data] : []);
  if (!coverages.length) throw new Error('KNMI: no coverages in response');
  return coverages[coverages.length - 1].ranges ?? {};
}

/**
 * Convert KNMI cloud cover to a 0-1 fraction.
 * `n` is coded in okta 0-8, plus 9 = "sky obscured" (fog/precipitation). 9 must read as fully
 * covered, never as clear — and never scale to >1.
 * @param {number|null} n
 * @returns {number|null}
 */
function oktaToFraction(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
  return Math.min(1, n / 8);
}

/**
 * Fetch weather observations from nearest KNMI automatic station via EDR API.
 * Returns null if API key missing or on any error.
 * @param {string} apiKey
 * @param {number} userLat
 * @param {number} userLon
 * @returns {Promise<{qg:number|null, n:number|null, ss:number|null, ta:number|null, stationName:string, distKm:number}|null>}
 */
async function fetchKnmiObservations(apiKey, userLat, userLon) {
  if (!apiKey || typeof userLat !== 'number' || typeof userLon !== 'number') return null;

  const features = await _getLocations(apiKey);
  const { feature, distDeg } = _nearest(features, userLat, userLon);
  if (!feature) throw new Error('KNMI: no stations found');

  const stationName = feature.properties?.name ?? feature.id;
  const distKm = Math.round(distDeg * 111);

  const ranges = await _fetchCoverage(apiKey, feature.id, 'qg,n,ss,ta');

  return {
    qg: _lastVal(ranges, 'qg'),
    n:  _lastVal(ranges, 'n'),
    ss: _lastVal(ranges, 'ss'),
    ta: _lastVal(ranges, 'ta'),
    stationId: feature.id,
    stationName,
    distKm,
  };
}

/** Station name for the log line; the /area response carries an id but no name. */
async function _stationName(apiKey, stationId) {
  try {
    const features = await _getLocations(apiKey);
    return features.find((f) => f.id === stationId)?.properties?.name ?? stationId;
  } catch {
    return stationId; // A cosmetic lookup must never cost a valid reading.
  }
}

/**
 * Fetch cloud cover (okta) from the nearest KNMI station that actually reports `n`.
 *
 * The nearest station overall need not report cloud cover — Cabauw (14km) never does, De Bilt
 * (18km) does. `?parameter-name=` is IGNORED on /locations (verified 2026-08-16: filtered and
 * unfiltered both return all 77 stations, Cabauw included), so selection cannot lean on it. The
 * /area query does honour the filter and returns the readings themselves, so one call gives both
 * "which stations near me report n" and their current values — measured, not promised.
 *
 * Returns null when no station within MAX_OKTA_DIST_KM reports `n`. Throws on API errors, like
 * fetchKnmiObservations — the caller catches.
 * @param {string} apiKey
 * @param {number} userLat
 * @param {number} userLon
 * @returns {Promise<{n:number, oktaFrac:number|null, stationName:string, distKm:number}|null>}
 */
async function fetchKnmiCloudObservations(apiKey, userLat, userLon) {
  if (!apiKey || typeof userLat !== 'number' || typeof userLon !== 'number') return null;

  // Box the search at the distance cap, in the same degree metric _nearest uses.
  const d = MAX_OKTA_DIST_KM / 111;
  const [w, e, s, n] = [userLon - d, userLon + d, userLat - d, userLat + d];
  const url = new URL(`${EDR_BASE}/area`);
  url.searchParams.set('coords', `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`);
  url.searchParams.set('parameter-name', 'n');
  url.searchParams.set('datetime', _obsWindow());
  url.searchParams.set('f', 'CoverageJSON');

  const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: apiKey } }, 15000);
  if (res.status === 404) return null; // "The query returned no stations" — empty, not an error.
  if (!res.ok) throw new Error(`KNMI EDR area error ${res.status}`);
  const data = await res.json();
  const coverages = data.coverages ?? (data.type === 'Coverage' ? [data] : []);

  let best = null, bestD = Infinity;
  for (const cov of coverages) {
    const lon = cov.domain?.axes?.x?.values?.[0];
    const lat = cov.domain?.axes?.y?.values?.[0];
    if (lat == null || lon == null) continue;
    // A station listed without a reading is no cloud-cover station for our purpose.
    const value = _lastVal(cov.ranges ?? {}, 'n');
    if (value == null) continue;
    const dist = Math.hypot(lat - userLat, lon - userLon);
    if (dist < bestD) { bestD = dist; best = { n: value, id: cov['eumetnet:locationId'] }; }
  }
  if (!best) return null;

  // The box is a square around the cap, so its corners reach further than the cap itself.
  const distKm = Math.round(bestD * 111);
  if (distKm > MAX_OKTA_DIST_KM) return null;

  return {
    n: best.n,
    oktaFrac: oktaToFraction(best.n),
    stationName: await _stationName(apiKey, best.id),
    distKm,
  };
}

/** Test seam: the 24h station-list cache is module-level and would leak between cases. */
function _resetCachesForTest() {
  _locationsCache = null;
}

module.exports = {
  fetchKnmiObservations,
  fetchKnmiCloudObservations,
  oktaToFraction,
  MAX_OKTA_DIST_KM,
  _resetCachesForTest,
};
