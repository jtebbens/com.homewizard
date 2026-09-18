'use strict';

// The energypriceforecast feed (forecast_NL.json, hourly) stopped around 13:00 NL on day+2, so
// the evening peak of day+2 never reached the planner (live 18-09: plan ended 20-09 11:45Z).
// It was dropped: the self-hosted EpexPredictor feed (forecast_NL_epex.json, 15-min, 72h) is
// now the only estimate source, cut off at 23:45 Amsterdam of day+2.

const assert = require('assert');
const path = require('path');

// Stub the fetch helper before the provider is required, so fetchPrices() runs offline.
const fetchPath = require.resolve(path.join(__dirname, '../includes/utils/fetchWithTimeout'));
let responses = {};
require.cache[fetchPath] = {
  id: fetchPath, filename: fetchPath, loaded: true,
  exports: async (url) => {
    const r = Object.entries(responses).find(([k]) => url.endsWith(k));
    if (!r || r[1] instanceof Error) throw (r ? r[1] : new Error('no stub'));
    return { ok: true, status: 200, json: async () => r[1] };
  },
};

const PriceForecastProvider = require('../lib/price-forecast-provider');
const { importPrice } = require('../lib/price-formulas');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const homey = { log() {}, error() {} };
const H = 3_600_000;
const Q = 900_000;

/** Hourly EUR/MWh rows from `startIso`, `n` hours. */
const hourly = (startIso, n, price = 100) =>
  Array.from({ length: n }, (_, i) => ({ time: new Date(Date.parse(startIso) + i * H).toISOString(), price }));
/** 15-min EUR/MWh rows from `startIso`, `n` quarters. */
const quarters = (startIso, n, price = 200) =>
  Array.from({ length: n }, (_, i) => ({ time: new Date(Date.parse(startIso) + i * Q).toISOString(), price }));

(async () => {
  console.log('price-forecast-epex-extend');

  // Mirrors 18-09 11:15Z: epex 72h of 15-min rows from 11:00Z.
  const NOW = new Date('2026-09-18T12:47:00Z');
  const epex = { data: quarters('2026-09-18T11:00:00Z', 289), points: 289, res: '15m', updated: 'y' };

  await test('epex is the only source, through 23:45 NL of day+2', async () => {
    responses = { 'forecast_NL_epex.json': epex, 'forecast_NL.json': { data: hourly('2026-09-18T22:00:00Z', 38) } };
    const p = new PriceForecastProvider(homey, { zone: 'NL' });
    const slots = await p.fetchPrices(true, NOW);
    assert.strictEqual(slots[0].timestamp.toISOString(), '2026-09-18T11:00:00.000Z');
    const last = slots[slots.length - 1].timestamp.toISOString();
    assert.strictEqual(last, '2026-09-20T21:45:00.000Z', `ends 20-09 23:45 NL (CEST), got ${last}`);
    // 18-09 11:00Z → 20-09 21:45Z inclusive, 15-min each; no hourly epf slot (price 100) mixed in.
    assert.strictEqual(slots.length, (58 * 4) + 4);
    assert.ok(slots.every(s => s.originalPrice === 0.2));
    assert.ok(slots.every(s => s.estimated === true));
  });

  await test('15m row → 1 slot, hourly row → 4 slots, same importPrice', async () => {
    const p = new PriceForecastProvider(homey, { zone: 'NL', markup: 0.11, shade: 0.9 });
    const one = p._expandToSlots([{ time: '2026-09-20T15:00:00Z', price: 200 }], '15m');
    assert.strictEqual(one.length, 1);
    assert.strictEqual(one[0].price, importPrice(0.2 * 0.9, 0.11));
    const four = p._expandToSlots([{ time: '2026-09-20T15:00:00Z', price: 200 }]);
    assert.strictEqual(four.length, 4);
    assert.strictEqual(four[0].price, one[0].price);
  });

  await test('epex fetch failure → keeps previous cache; no cache → throws', async () => {
    responses = { 'forecast_NL_epex.json': epex };
    const p = new PriceForecastProvider(homey, { zone: 'NL' });
    const first = await p.fetchPrices(true, NOW);
    responses = { 'forecast_NL_epex.json': new Error('boom') };
    assert.strictEqual(await p.fetchPrices(true, NOW), first);
    const fresh = new PriceForecastProvider(homey, { zone: 'NL' });
    await assert.rejects(() => fresh.fetchPrices(true, NOW), /boom/);
  });

  await test('DST end day (25-10-2026, 25h): boundary is still 23:45 NL (CET = 22:45Z)', async () => {
    const now = new Date('2026-10-23T10:00:00Z');
    responses = { 'forecast_NL_epex.json': { data: quarters('2026-10-23T10:00:00Z', 300), res: '15m' } };
    const p = new PriceForecastProvider(homey, { zone: 'NL' });
    const slots = await p.fetchPrices(true, now);
    assert.strictEqual(slots[slots.length - 1].timestamp.toISOString(), '2026-10-25T22:45:00.000Z');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
