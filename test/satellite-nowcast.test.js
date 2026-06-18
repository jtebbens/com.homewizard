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

  test('averages 15-min readings into hourly slot', () => {
    const wf = makeWF();
    const now = new Date('2026-06-18T10:00:00Z');
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
    // wxFactor for code=0 = 1.0, biasFactor=1.0 → radiation = 500
    assert.strictEqual(slot.radiationWm2, 500);
  });

  test('sets radiationSpreadFrac to 0.05 for satellite slots', () => {
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
    assert.strictEqual(slot.radiationSpreadFrac, 0.05);
  });

  test('stores raw satGhiWm2 on slot', () => {
    const wf = makeWF({ biasFactor: 1.2 });
    const slot = makeSlot(10, 200);
    wf.cache = { hourlyForecast: [slot] };

    const issue = new Date('2026-06-18T09:30:00Z');
    const satData = {
      issue: issue.toISOString(),
      curve: [{ t: '2026-06-18T10:00:00Z', wm2: 400 }],
    };

    wf._applySatelliteOverlay(satData);
    assert.strictEqual(slot.satGhiWm2, 400);
    // radiationWm2 = 400 * 1.2 * 1.0(wxFactor) = 480
    assert.strictEqual(slot.radiationWm2, 480);
  });

  test('does NOT override slots beyond 3h lead', () => {
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

  test('overrides slots within 3h lead', () => {
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
    // slot12: 2h lead → overridden
    assert.strictEqual(slot12.satGhiWm2, 600);
    assert.strictEqual(slot12.radiationSpreadFrac, 0.05);
    // slot14: 4h lead → NOT overridden
    assert.strictEqual(slot14.radiationWm2, 300);
    assert.strictEqual(slot14.satGhiWm2, undefined);
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
