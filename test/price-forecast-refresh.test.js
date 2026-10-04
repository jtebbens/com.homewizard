'use strict';

// The estimated prices must be re-fetched on the same cadence as the real prices.
// 2026-09-28: forecastProvider.fetchPrices() was only called once, from
// _selectBestProvider() at init, so after a restart the estimate list stayed frozen
// (ended at 23:45 of "today") and tomorrow never showed up as estimated slots.

const assert = require('assert');
const TariffManager = require('../lib/tariff-manager');

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

function makeManager(forecastProvider) {
  const homey = { log() {}, settings: { get: () => null, set() {} } };
  const tm = new TariffManager(homey, { enable_dynamic_pricing: false, price_forecast_fill: 'on' });
  tm.forecastProvider = forecastProvider;
  return tm;
}

(async () => {
  console.log('\nprice-forecast refresh');

  await test('every refreshForecast() call reaches forecastProvider.fetchPrices()', async () => {
    let calls = 0;
    const tm = makeManager({ fetchPrices: async () => { calls++; return []; } });
    await tm.refreshForecast();
    await tm.refreshForecast();
    assert.strictEqual(calls, 2);
  });

  await test('a failing fetch never throws (estimates are nice-to-have)', async () => {
    const tm = makeManager({ fetchPrices: async () => { throw new Error('boom'); } });
    await tm.refreshForecast();
  });

  await test('no forecastProvider (setting off) is a no-op', async () => {
    const tm = makeManager(null);
    await tm.refreshForecast();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
