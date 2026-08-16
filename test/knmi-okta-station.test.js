'use strict';

// Second KNMI station for cloud cover (okta, EDR param `n`).
//
// The nearest-station pick (_nearest) is distance-only and does not check which parameters a
// station actually reports. For this user the nearest station (Cabauw, 14km) never reports `n`
// (0/7381 readings over 52 days) while De Bilt (18km) reports it on 99.7% of hours.
//
// The first build asked /locations for an `n`-filtered station list. EDR ignores the filter there
// (verified live 16-08: filtered == unfiltered == 77 stations, Cabauw included), so it picked
// Cabauw and returned a null reading in silence. Selection now runs off the /area query, which
// does honour the filter and returns the readings themselves — a station counts as reporting `n`
// only when it actually hands one over.
//
// Guards covered here: selection skips a nearer station whose `n` is null, the distance cap, the
// okta scale (KNMI codes 9 = "sky obscured", which must never read as clear), an empty area
// (404) reading as "no station" rather than an error, and the staleness cut-off on getTodayOkta().

const assert = require('assert');
const Module = require('module');

// --- stub fetchWithTimeout so knmi-stations.js runs offline -------------------------------
const calls = [];
let responder = null;

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/fetchWithTimeout')) {
    return (url, options, timeoutMs) => {
      calls.push({ url, timeoutMs });
      return Promise.resolve(responder(url));
    };
  }
  return origRequire.apply(this, arguments);
};
const knmi = require('../lib/knmi-stations.js');
const WeatherForecaster = require('../lib/weather-forecaster.js');
Module.prototype.require = origRequire;

const { fetchKnmiCloudObservations, _resetCachesForTest } = knmi;

// --- fixtures ------------------------------------------------------------------------------
const USER_LAT = 52.02, USER_LON = 5.043;

function station(id, name, lat, lon) {
  return { id, properties: { name }, geometry: { coordinates: [lon, lat] } };
}
const CABAUW = station('06348', 'Cabauw', 51.97, 4.926);   // ~14km, no `n`
const DE_BILT = station('06260', 'De Bilt', 52.10, 5.18);  // ~18km, has `n`
const FAR = station('06280', 'Eelde', 53.12, 6.585);       // ~140km

function ok(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

/** One station's slice of an /area CoverageJSON response. */
function areaStation(st, nValues) {
  const [lon, lat] = st.geometry.coordinates;
  return {
    type: 'Coverage',
    domain: { axes: { x: { values: [lon] }, y: { values: [lat] } } },
    ranges: { n: { values: nValues } },
    'eumetnet:locationId': st.id,
  };
}

/** Serve the /area query plus the unfiltered station list used to name the winner. */
function makeResponder({ area, stations = [], areaStatus = 200 }) {
  return (url) => {
    if (url.includes('/area')) {
      if (areaStatus !== 200) {
        return { ok: false, status: areaStatus, json: () => Promise.resolve({ detail: 'no stations' }) };
      }
      return ok({ type: 'CoverageCollection', coverages: area });
    }
    // /locations/<id> is the qg observation call; bare /locations is the station list.
    if (/\/locations\/[^?]/.test(url)) return ok({ type: 'Coverage', ranges: { qg: { values: [200] } } });
    return ok({ features: stations });
  };
}

function reset() {
  calls.length = 0;
  _resetCachesForTest();
}

(async () => {
  // 1. THE LIVE BUG. Cabauw is nearer and is returned by the area query, but its `n` is null.
  //    Selection must skip it for De Bilt instead of taking the null and going quiet.
  {
    reset();
    responder = makeResponder({
      area: [areaStation(CABAUW, [null, null]), areaStation(DE_BILT, [3, 4])],
      stations: [CABAUW, DE_BILT, FAR],
    });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.ok(res, 'expected an okta reading');
    assert.strictEqual(res.n, 4, 'must take the latest reading of the chosen station');
    assert.strictEqual(res.stationName, 'De Bilt', 'must pick the nearest station that reports n');
    const areaCall = calls.find((c) => c.url.includes('/area'));
    assert.ok(areaCall, 'selection must run off the /area query');
    assert.ok(areaCall.url.includes('parameter-name=n') && /POLYGON/i.test(decodeURIComponent(areaCall.url)),
      `/area must be a POLYGON query filtered on n, got ${areaCall.url}`);
    assert.ok(!calls.some((c) => /\/locations\/[^?]/.test(c.url)),
      'the area readings make a per-station observation call redundant');
  }

  // 2. Distance cap: the box corners reach past the cap, so a far station inside the box must
  //    still be rejected — an okta reading 140km away says nothing about the sky here.
  {
    reset();
    responder = makeResponder({ area: [areaStation(FAR, [4])], stations: [CABAUW, FAR] });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res, null, 'station beyond the distance cap must yield null');
  }

  // 3. Okta scale. KNMI codes n in okta 0-8, with 9 = "sky obscured" (fog/precipitation):
  //    naive scaling would give 112% and, worse, any n>8 must never read as clear.
  {
    const cases = [[0, 0], [2, 0.25], [8, 1], [9, 1]];
    for (const [n, expected] of cases) {
      reset();
      responder = makeResponder({ area: [areaStation(DE_BILT, [n])], stations: [DE_BILT] });
      const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
      assert.strictEqual(res.oktaFrac, expected, `n=${n} must map to oktaFrac ${expected}`);
    }
    // Nobody reporting at all → null, never a defaulted 0 (which would read as clear sky).
    reset();
    responder = makeResponder({ area: [areaStation(DE_BILT, [null])], stations: [DE_BILT] });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res, null, 'a station without a reading must not be selected');
  }

  // 4. An empty area is an empty answer, not a failure: EDR 404s with "the query returned no
  //    stations". Throwing here would log a fetch error every hour for users with no okta nearby.
  {
    reset();
    responder = makeResponder({ area: [], stations: [DE_BILT], areaStatus: 404 });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res, null, 'an empty area must return null, not throw');
  }

  // 5. The station list is only consulted to name the winner, and it is shared with the qg
  //    lookup: one list fetch, cached for both.
  {
    reset();
    responder = makeResponder({
      area: [areaStation(DE_BILT, [4])], stations: [CABAUW, DE_BILT],
    });
    await knmi.fetchKnmiObservations('key', USER_LAT, USER_LON);
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res.stationName, 'De Bilt', 'must name the okta station, not the qg one');
    const listCalls = calls.filter((c) => /\/locations$/.test(c.url)).length;
    assert.strictEqual(listCalls, 1, 'the station list must be fetched once and cached');
  }

  // 6. Staleness: the fetch cadence is 55 min, so a missed fetch must not let the signal live on.
  {
    const wf = new WeatherForecaster({ log() {}, error() {} });
    wf._todayOkta = 0.25;
    wf._todayOktaTs = Date.now() - 30 * 60 * 1000;
    assert.strictEqual(wf.getTodayOkta(), 0.25, 'fresh okta must be returned');
    wf._todayOktaTs = Date.now() - 3 * 60 * 60 * 1000;
    assert.strictEqual(wf.getTodayOkta(), null, 'okta older than the staleness cap must be null');
    wf._todayOkta = null;
    wf._todayOktaTs = Date.now();
    assert.strictEqual(wf.getTodayOkta(), null, 'absent okta stays null');
  }

  // 7. New day resets okta along with kt — never cross-check today's cloud against yesterday's sky.
  {
    const wf = new WeatherForecaster({ log() {}, error() {} });
    wf._resetTodayKtIfNewDay('2026-08-16');
    wf._todayOkta = 0.125;
    wf._todayOktaTs = Date.now();
    wf._resetTodayKtIfNewDay('2026-08-17');
    assert.strictEqual(wf._todayOkta, null, 'okta must reset on a new UTC day');
  }

  console.log('knmi-okta-station.test.js: all assertions hold');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
