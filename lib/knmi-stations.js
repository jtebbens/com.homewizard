'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const EDR_BASE = 'https://api.dataplatform.knmi.nl/edr/v1/collections/10-minute-in-situ-meteorological-observations';

let _locationsCache = null;
let _locationsCacheTime = 0;
const LOCATIONS_TTL = 24 * 60 * 60 * 1000;

async function _getLocations(apiKey) {
  const now = Date.now();
  if (_locationsCache && (now - _locationsCacheTime) < LOCATIONS_TTL) return _locationsCache;
  const res = await fetchWithTimeout(`${EDR_BASE}/locations`, { headers: { Authorization: apiKey } }, 10000);
  if (!res.ok) throw new Error(`KNMI locations error ${res.status}`);
  const data = await res.json();
  _locationsCache = data.features ?? [];
  _locationsCacheTime = now;
  return _locationsCache;
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

  const now = new Date();
  const from = new Date(now - 40 * 60 * 1000); // 40 min covers both 10-min (qg) and 30-min (n) params
  const datetime = `${from.toISOString().slice(0, 19)}Z/${now.toISOString().slice(0, 19)}Z`;

  const url = new URL(`${EDR_BASE}/locations/${encodeURIComponent(feature.id)}`);
  url.searchParams.set('datetime', datetime);
  url.searchParams.set('parameter-name', 'qg,n,ss,ta');
  url.searchParams.set('f', 'CoverageJSON');

  const res = await fetchWithTimeout(url.toString(), { headers: { Authorization: apiKey } }, 15000);
  if (!res.ok) throw new Error(`KNMI EDR error ${res.status}`);
  const data = await res.json();

  const coverages = data.coverages ?? (data.type === 'Coverage' ? [data] : []);
  if (!coverages.length) throw new Error('KNMI: no coverages in response');
  const ranges = coverages[coverages.length - 1].ranges ?? {};

  return {
    qg: _lastVal(ranges, 'qg'),
    n:  _lastVal(ranges, 'n'),
    ss: _lastVal(ranges, 'ss'),
    ta: _lastVal(ranges, 'ta'),
    stationName,
    distKm,
  };
}

module.exports = { fetchKnmiObservations };
