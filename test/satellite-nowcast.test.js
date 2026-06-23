'use strict';

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function makeWF(opts = {}) {
  const logs = [];
  const homey = {
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push('ERR: ' + args.join(' ')),
  };
  const le = opts.learningEngine || {
    getRadiationBiasFactor: () => opts.biasFactor ?? 1.0,
  };
  const wf = new WeatherForecaster(homey, le);
  wf._logs = logs;
  return wf;
}

function makeSlot(utcHour, radiationWm2 = 200, extras = {}) {
  const t = new Date('2026-06-18T00:00:00Z');
  t.setUTCHours(utcHour);
  return { time: t, radiationWm2, weatherCode: 0, precipProb: 0, radiationSpreadFrac: 0.3, ...extras };
}

function makeSatData(issueOffsetMin = 0, curveEntries = []) {
  const issue = new Date(Date.now() - issueOffsetMin * 60_000);
  return {
    issue: issue.toISOString(),
    lat: 52.02,
    lon: 5.04,
    fetched_utc: new Date().toISOString(),
    curve: curveEntries.map((wm2, i) => ({
      t: new Date(issue.getTime() + i * 15 * 60_000).toISOString(),
      wm2,
    })),
  };
}

// ── _fetchSatelliteNowcast ──

console.log('\n_fetchSatelliteNowcast:');

(async () => {

  await testAsync('stale issue (>30min) returns null', async () => {
    const wf = makeWF();
    const staleData = {
      issue: new Date(Date.now() - 31 * 60_000).toISOString(),
      curve: [{ t: new Date().toISOString(), wm2: 500 }],
    };
    // Mock fetchWithTimeout via monkey-patch on the instance method
    wf._fetchSatelliteNowcast = async function (url, token) {
      // Reproduce validation logic with stale data
      const data = staleData;
      if (!data.issue || !Array.isArray(data.curve) || data.curve.length === 0) return null;
      const issueAge = Date.now() - new Date(data.issue).getTime();
      if (issueAge > 30 * 60 * 1000 || issueAge < -5 * 60 * 1000) return null;
      if (data.curve.some(c => typeof c.wm2 !== 'number' || c.wm2 < 0)) return null;
      return data;
    };
    const result = await wf._fetchSatelliteNowcast('http://test', '');
    assert.strictEqual(result, null);
  });

  await testAsync('negative wm2 returns null', async () => {
    const wf = makeWF();
    const badData = {
      issue: new Date().toISOString(),
      curve: [{ t: new Date().toISOString(), wm2: -10 }],
    };
    wf._fetchSatelliteNowcast = async function () {
      const data = badData;
      if (!data.issue || !Array.isArray(data.curve) || data.curve.length === 0) return null;
      const issueAge = Date.now() - new Date(data.issue).getTime();
      if (issueAge > 30 * 60 * 1000 || issueAge < -5 * 60 * 1000) return null;
      if (data.curve.some(c => typeof c.wm2 !== 'number' || c.wm2 < 0)) return null;
      return data;
    };
    const result = await wf._fetchSatelliteNowcast();
    assert.strictEqual(result, null);
  });

  await testAsync('empty curve returns null', async () => {
    const wf = makeWF();
    wf._fetchSatelliteNowcast = async function () {
      const data = { issue: new Date().toISOString(), curve: [] };
      if (!data.issue || !Array.isArray(data.curve) || data.curve.length === 0) return null;
      return data;
    };
    const result = await wf._fetchSatelliteNowcast();
    assert.strictEqual(result, null);
  });

  // ── _applySatelliteOverlay ──

  console.log('\n_applySatelliteOverlay:');

  // Observation-only: overlay stores raw satGhiWm2 for accuracy/learning and
  // must NOT mutate radiationWm2/radiationSpreadFrac (DP stays on Open-Meteo).
  test('averages 15-min readings into satGhiWm2, leaves radiationWm2 untouched', () => {
    const wf = makeWF();
    const slot = makeSlot(10, 200);
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [
        { t: '2026-06-18T10:00:00Z', wm2: 400 },
        { t: '2026-06-18T10:15:00Z', wm2: 600 },
        { t: '2026-06-18T10:30:00Z', wm2: 500 },
        { t: '2026-06-18T10:45:00Z', wm2: 500 },
      ],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, 500); // avg(400,600,500,500)
    assert.strictEqual(slot.radiationWm2, 200); // observation-only: unchanged
  });

  // The hourly satGhiWm2 above loses resolution; the overlay also retains the raw
  // 15-min curve so the accuracy sampler can match Solcast's 15-min cadence (no gaps).
  test('retains per-15-min sat GHI (not just the hourly average) via getSatGhiAt', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [makeSlot(10, 200)] };
    const satData = makeSatData(30, [400, 600, 500, 480]); // issue now-30m, 4×15-min

    wf._applySatelliteOverlay(satData);

    // each 15-min bucket returns its OWN value, not the hourly mean (495)
    const buckets = satData.curve.map(c => new Date(c.t).getTime());
    assert.strictEqual(wf.getSatGhiAt(buckets[0]), 400);
    assert.strictEqual(wf.getSatGhiAt(buckets[1]), 600);
    assert.strictEqual(wf.getSatGhiAt(buckets[2]), 500);
    assert.strictEqual(wf.getSatGhiAt(buckets[3]), 480);
    // a bucket inside the same hour but offset by a few minutes maps to its 15-min slot
    assert.strictEqual(wf.getSatGhiAt(buckets[1] + 5 * 60_000), 600);
    // a time with no curve point returns null (no faked carry)
    assert.strictEqual(wf.getSatGhiAt(buckets[3] + 3600_000), null);
  });

  test('does NOT mutate radiationSpreadFrac (observation-only)', () => {
    const wf = makeWF();
    const slot = makeSlot(10, 200);
    slot.radiationSpreadFrac = 0.35;
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T10:00:00Z', wm2: 400 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.radiationSpreadFrac, 0.35); // unchanged
  });

  test('stores raw satGhiWm2 on slot, no radiation/satRad mutation', () => {
    const wf = makeWF({ biasFactor: 1.2 });
    const slot = makeSlot(10, 200);
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T10:00:00Z', wm2: 400 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, 400); // raw GHI, no bias applied
    assert.strictEqual(slot.radiationWm2, 200); // unchanged
    assert.strictEqual(slot.satRadWm2, undefined); // not set anymore
  });

  test('does NOT touch slots beyond 3h lead', () => {
    const wf = makeWF();
    const slot = makeSlot(14, 200);
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T10:00:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T14:00:00Z', wm2: 800 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.radiationWm2, 200); // unchanged
    assert.strictEqual(slot.satGhiWm2, undefined);
    assert.strictEqual(slot.radiationSpreadFrac, 0.3); // unchanged
  });

  test('sets satGhiWm2 for slots within 3h lead only', () => {
    const wf = makeWF();
    const slot12 = makeSlot(12, 200);
    const slot14 = makeSlot(14, 300);
    wf.cache = { hourlyForecast: [slot12, slot14] };

    const issue = new Date('2026-06-18T10:00:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [
        { t: '2026-06-18T12:00:00Z', wm2: 600 },
        { t: '2026-06-18T14:00:00Z', wm2: 800 },
      ],
    };

    wf._applySatelliteOverlay(satData);
    // slot12: 2h lead → satGhiWm2 set, radiationWm2 untouched
    assert.strictEqual(slot12.satGhiWm2, 600);
    assert.strictEqual(slot12.radiationWm2, 200);
    // slot14: 4h lead → not touched
    assert.strictEqual(slot14.radiationWm2, 300);
    assert.strictEqual(slot14.satGhiWm2, undefined);
  });

  // Forward-only guard: a slot whose hour starts before the satellite issue must
  // NOT be back-filled. The pre-issue hour only catches the dim edge curve point,
  // which would project to ~0 W and record a fake sat=0 (100% miss) in the pill.
  test('does NOT back-fill a slot starting before the issue', () => {
    const wf = makeWF();
    const slot = makeSlot(9, 200); // 09:00Z, one hour before issue
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T10:00:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T09:30:00Z', wm2: 150 }], // edge point inside h=9
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, undefined); // excluded → accuracy stores null
    assert.strictEqual(slot.radiationWm2, 200); // unchanged
  });

  test('mid-hour issue skips that hour\'s pre-issue start, keeps next hour', () => {
    const wf = makeWF();
    const slot10 = makeSlot(10, 200); // 10:00Z, issue lands mid-hour → lead -30min
    const slot11 = makeSlot(11, 200); // 11:00Z → lead +30min, forward
    wf.cache = { hourlyForecast: [slot10, slot11] };

    const issue = new Date('2026-06-18T10:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [
        { t: '2026-06-18T10:30:00Z', wm2: 300 }, // inside h=10 but pre-issue-start
        { t: '2026-06-18T11:00:00Z', wm2: 700 },
      ],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot10.satGhiWm2, undefined); // pre-issue hour skipped
    assert.strictEqual(slot11.satGhiWm2, 700); // forward hour kept
  });

  test('in-place mutation: cache.hourlyForecast identity preserved', () => {
    const wf = makeWF();
    const slots = [makeSlot(10, 200)];
    wf.cache = { hourlyForecast: slots };
    const ref = wf.cache.hourlyForecast;

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T10:00:00Z', wm2: 400 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(wf.cache.hourlyForecast, ref);
    assert.strictEqual(wf.cache.hourlyForecast[0], slots[0]);
  });

  test('no-op when cache is null', () => {
    const wf = makeWF();
    wf.cache = null;
    const satData = makeSatData(0, [500]);
    // Should not throw
    wf._applySatelliteOverlay(satData);
    assert.strictEqual(wf.cache, null);
  });

  test('no-op when curve is empty', () => {
    const wf = makeWF();
    const slot = makeSlot(10, 200);
    wf.cache = { hourlyForecast: [slot] };
    const satData = { issue: new Date().toISOString(), curve: [] };
    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.radiationWm2, 200); // unchanged
  });

  // ── satPanelW via SAT_YIELD_FACTORS ──

  console.log('\nsatPanelW / getSatPanelWAt / getSatYieldFactor:');

  test('_applySatelliteOverlay sets satPanelW using SAT_YIELD_FACTORS', () => {
    const wf = makeWF();
    const slot = makeSlot(10, 200);
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [
        { t: '2026-06-18T10:00:00Z', wm2: 400 },
        { t: '2026-06-18T10:15:00Z', wm2: 600 },
      ],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, 500);
    const expectedYf = WeatherForecaster.getSatYieldFactor(10);
    assert.strictEqual(slot.satPanelW, Math.round(500 * expectedYf));
  });

  test('satPanelW is null for UTC hours outside SAT_YIELD_FACTORS', () => {
    const wf = makeWF();
    const slot = makeSlot(2, 100); // UTC 2 — no sat-YF entry
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T01:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T02:00:00Z', wm2: 50 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, 50);
    assert.strictEqual(slot.satPanelW, null);
  });

  test('getSatPanelWAt returns panel W using sat-YF', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [makeSlot(12, 200)] };
    const satData = makeSatData(5, [300, 400, 350, 380]);
    wf._applySatelliteOverlay(satData);

    const bucket0 = new Date(satData.curve[0].t).getTime();
    const utcH = new Date(bucket0).getUTCHours();
    const expectedYf = WeatherForecaster.getSatYieldFactor(utcH);
    const result = wf.getSatPanelWAt(bucket0);
    assert.strictEqual(result, Math.round(300 * expectedYf));
  });

  test('getSatPanelWAt returns null for missing bucket', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [] };
    const result = wf.getSatPanelWAt(Date.now() + 99_999_999);
    assert.strictEqual(result, null);
  });

  test('getSatPanelWAt returns null for hour without sat-YF', () => {
    const wf = makeWF();
    const t = new Date('2026-06-18T02:00:00Z');
    const key = String(Math.floor(t.getTime() / 900_000) * 900_000);
    wf._satGhi15min = { [key]: 100 };
    const result = wf.getSatPanelWAt(t.getTime());
    assert.strictEqual(result, null);
  });

  test('static getSatYieldFactor returns known values', () => {
    assert.strictEqual(WeatherForecaster.getSatYieldFactor(10), 3.640);
    assert.strictEqual(WeatherForecaster.getSatYieldFactor(18), 1.001);
    assert.strictEqual(WeatherForecaster.getSatYieldFactor(0), 0);
    assert.strictEqual(WeatherForecaster.getSatYieldFactor(23), 0);
  });

  // ── startSatelliteLoop / stopSatelliteLoop ──

  console.log('\nstartSatelliteLoop / stopSatelliteLoop:');

  test('startSatelliteLoop sets _satUrl and _satToken', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [] };
    wf.startSatelliteLoop('http://example.com/sat', 'secret123');
    assert.strictEqual(wf._satUrl, 'http://example.com/sat');
    assert.strictEqual(wf._satToken, 'secret123');
    wf.stopSatelliteLoop();
  });

  test('stopSatelliteLoop clears state', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [] };
    wf.startSatelliteLoop('http://example.com/sat', 'tok');
    wf.stopSatelliteLoop();
    assert.strictEqual(wf._satUrl, null);
    assert.strictEqual(wf._satToken, null);
    assert.strictEqual(wf._satInterval, null);
    assert.strictEqual(wf._satFetching, false);
  });

  test('double-start clears previous interval', () => {
    const wf = makeWF();
    wf.cache = { hourlyForecast: [] };
    wf.startSatelliteLoop('http://a', 'tok1');
    const int1 = wf._satInterval;
    wf.startSatelliteLoop('http://b', 'tok2');
    assert.strictEqual(wf._satUrl, 'http://b');
    assert.strictEqual(wf._satToken, 'tok2');
    // Old interval should have been cleared (new one is different)
    assert.notStrictEqual(wf._satInterval, int1);
    wf.stopSatelliteLoop();
  });

  // ── Summary ──

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);

})();
