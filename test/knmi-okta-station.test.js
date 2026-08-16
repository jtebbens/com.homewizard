'use strict';

// Second KNMI station for cloud cover (okta, EDR param `n`).
//
// The nearest-station pick (_nearest) is distance-only and does not check which parameters a
// station actually reports. For this user the nearest station (Cabauw, 14km) never reports `n`
// (0/7381 readings over 52 days) while De Bilt (18km) reports it on 99.7% of hours. EDR's
// /locations endpoint supports server-side `?parameter-name=` filtering, so "nearest station that
// reports n" is a single filtered call — no per-station probing, no hardcoded station.
//
// Guards covered here: the filtered lookup is really used, the distance cap, the okta scale
// (KNMI codes 9 = "sky obscured", which must never read as clear), the no-second-HTTP-call reuse
// when both parameters come from the same station, and the staleness cut-off on getTodayOkta().

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
function locations(features) {
  return ok({ features });
}
function coverage(nValues) {
  return ok({ type: 'Coverage', ranges: { n: { values: nValues } } });
}

/** Serve a filtered /locations list plus an observation coverage. */
function makeResponder({ filtered, unfiltered, nValues }) {
  return (url) => {
    // The observation URL is /locations/<id>?…; the station list is /locations or /locations?…
    if (!/\/locations\//.test(url)) {
      return url.includes('parameter-name=n') ? locations(filtered) : locations(unfiltered);
    }
    return coverage(nValues);
  };
}

function reset() {
  calls.length = 0;
  _resetCachesForTest();
}

(async () => {
  // 1. Station selection uses the `n`-filtered list, not the raw nearest station.
  //    Cabauw is nearer but absent from the filtered list, so De Bilt must win.
  {
    reset();
    responder = makeResponder({
      filtered: [DE_BILT, FAR], unfiltered: [CABAUW, DE_BILT, FAR], nValues: [4],
    });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.ok(res, 'expected an okta reading');
    assert.strictEqual(res.stationName, 'De Bilt', 'must pick the nearest station that reports n');
    const locCall = calls.find((c) => c.url.includes('/locations'));
    assert.ok(locCall.url.includes('parameter-name=n'),
      `/locations must be filtered server-side, got ${locCall.url}`);
  }

  // 2. Distance cap: no okta station within range → null, not a useless far-away reading.
  {
    reset();
    responder = makeResponder({ filtered: [FAR], unfiltered: [CABAUW, FAR], nValues: [4] });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res, null, 'station beyond the distance cap must yield null');
    assert.ok(!calls.some((c) => c.url.includes('/locations/')),
      'must not fetch observations from an out-of-range station');
  }

  // 3. Okta scale. KNMI codes n in okta 0-8, with 9 = "sky obscured" (fog/precipitation):
  //    naive scaling would give 112% and, worse, any n>8 must never read as clear.
  {
    const cases = [[0, 0], [2, 0.25], [8, 1], [9, 1]];
    for (const [n, expected] of cases) {
      reset();
      responder = makeResponder({ filtered: [DE_BILT], unfiltered: [DE_BILT], nValues: [n] });
      const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
      assert.strictEqual(res.oktaFrac, expected, `n=${n} must map to oktaFrac ${expected}`);
    }
    // No reading at all → null oktaFrac, never a defaulted 0 (which would read as clear sky).
    reset();
    responder = makeResponder({ filtered: [DE_BILT], unfiltered: [DE_BILT], nValues: [null] });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(res.oktaFrac, null, 'missing n must be null, not 0');
  }

  // 4. Reuse: when the okta station is the same station the qg fetch already used, skip the
  //    second HTTP round-trip and take `n` from the reading we already have.
  {
    reset();
    responder = makeResponder({ filtered: [DE_BILT], unfiltered: [DE_BILT], nValues: [6] });
    const res = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON, {
      knownStationId: '06260', knownN: 3,
    });
    assert.strictEqual(res.oktaFrac, 0.375, 'must reuse the already-fetched n');
    assert.ok(!calls.some((c) => c.url.includes('/locations/')),
      'must not re-fetch observations for a station already read');
  }

  // 5. Locations cache is keyed per parameter filter — the filtered list must not be served
  //    from (or poison) the unfiltered cache used by the qg lookup.
  {
    reset();
    responder = makeResponder({
      filtered: [DE_BILT], unfiltered: [CABAUW, DE_BILT], nValues: [4],
    });
    await knmi.fetchKnmiObservations('key', USER_LAT, USER_LON);
    const first = await fetchKnmiCloudObservations('key', USER_LAT, USER_LON);
    assert.strictEqual(first.stationName, 'De Bilt',
      'filtered lookup must not reuse the unfiltered station list');
    const locCalls = calls.filter((c) => !/\/locations\//.test(c.url)).length;
    assert.strictEqual(locCalls, 2, 'each parameter filter needs its own cached list');
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
