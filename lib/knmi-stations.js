'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const EDR_BASE = 'https://api.dataplatform.knmi.nl/edr/v1/collections/10-minute-in-situ-meteorological-observations';

// Station lists are cached per parameter filter: the unfiltered list feeds the qg lookup, the
// 'n'-filtered list the okta lookup, and they resolve to different stations.
const _locationsCache = new Map();
const LOCATIONS_TTL = 24 * 60 * 60 * 1000;

// Cloud cover is only useful from a station close enough to share the sky overhead.
const MAX_OKTA_DIST_KM = 60;

async function _getLocations(apiKey, paramFilter = null) {
  const now = Date.now();
  const key = paramFilter ?? '';
  const hit = _locationsCache.get(key);
  if (hit && (now - hit.time) < LOCATIONS_TTL) return hit.features;
  // EDR supports server-side parameter filtering, so "nearest station reporting X" is one call.
  const url = paramFilter
    ? `${EDR_BASE}/locations?parameter-name=${encodeURIComponent(paramFilter)}`
    : `${EDR_BASE}/locations`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: apiKey } }, 10000);
  if (!res.ok) throw new Error(`KNMI locations error ${res.status}`);
  const data = await res.json();
  const features = data.features ?? [];
  _locationsCache.set(key, { features, time: now });
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

/**
 * Fetch cloud cover (okta) from the nearest KNMI station that actually reports `n`.
 *
 * The nearest station overall need not report cloud cover — Cabauw (14km) never does, De Bilt
 * (18km) does. EDR's /locations endpoint filters server-side, so this stays generic per user
 * instead of naming a station.
 *
 * Returns null when no reporting station is within MAX_OKTA_DIST_KM. Throws on API errors, like
 * fetchKnmiObservations — the caller catches.
 * @param {string} apiKey
 * @param {number} userLat
 * @param {number} userLon
 * @param {{knownStationId?: string, knownN?: number|null}} [known] Reading already fetched by
 *        fetchKnmiObservations; reused instead of a second round-trip when it is the same station.
 * @returns {Promise<{n:number|null, oktaFrac:number|null, stationName:string, distKm:number}|null>}
 */
async function fetchKnmiCloudObservations(apiKey, userLat, userLon, known = {}) {
  if (!apiKey || typeof userLat !== 'number' || typeof userLon !== 'number') return null;

  const features = await _getLocations(apiKey, 'n');
  const { feature, distDeg } = _nearest(features, userLat, userLon);
  if (!feature) return null;

  const distKm = Math.round(distDeg * 111);
  if (distKm > MAX_OKTA_DIST_KM) return null;

  const stationName = feature.properties?.name ?? feature.id;

  const n = feature.id === known.knownStationId
    ? (known.knownN ?? null)
    : _lastVal(await _fetchCoverage(apiKey, feature.id, 'n'), 'n');

  return { n, oktaFrac: oktaToFraction(n), stationName, distKm };
}

/** Test seam: the 24h station-list cache is module-level and would leak between cases. */
function _resetCachesForTest() {
  _locationsCache.clear();
}

module.exports = {
  fetchKnmiObservations,
  fetchKnmiCloudObservations,
  oktaToFraction,
  MAX_OKTA_DIST_KM,
  _resetCachesForTest,
};
