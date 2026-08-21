const assert = require('assert');
const PbthProvider = require('../lib/pbth-provider');

// Minimal homey stub
function makeHomey(getApiApp) {
  return {
    log: (...args) => {},
    error: (...args) => {},
    api: { getApiApp: getApiApp || (() => { throw new Error('api.getApiApp not stubbed'); }) }
  };
}

(async () => {
  // ── Test A: getCurrentPrice() timestamp matching (synthetic cache, no fetch) ──
  {
    const provider = new PbthProvider(makeHomey());

    const now = new Date();
    const startThisHour = new Date(now.getTime() - 30 * 60 * 1000); // started 30 minutes ago
    const startNextHour = new Date(startThisHour.getTime() + 60 * 60 * 1000);

    provider.cache = [
      { timestamp: startThisHour, price: 0.1111, exportPrice: 0.05, hour: startThisHour.getHours(), minute: 0 },
      { timestamp: startNextHour, price: 0.2222, exportPrice: 0.06, hour: startNextHour.getHours(), minute: 0 }
    ];

    const price = provider.getCurrentPrice();
    assert.strictEqual(price, 0.1111, 'Expected provider to return the price for the current timestamp window');
    console.log('Test A (PbthProvider timestamp matching): PASSED');
  }

  // ── Test B: fetchPrices() with no deviceId set never calls the API ──
  {
    let called = false;
    const provider = new PbthProvider(makeHomey(() => { called = true; return { get: async () => ({ prices: [] }) }; }));
    const result = await provider.fetchPrices(true);
    assert.deepStrictEqual(result, [], 'No device selected must return an empty array');
    assert.strictEqual(called, false, 'No device selected must never call the app-to-app API');
    console.log('Test B (no deviceId skips the API call): PASSED');
  }

  // ── Test C: dap15 device — native 15-min slots populate cache15min, aggregate to hourly ──
  {
    const base = new Date();
    base.setUTCMinutes(0, 0, 0);
    const slots = [0, 15, 30, 45].map((m, i) => ({
      time: new Date(base.getTime() + m * 60_000).toISOString(),
      importPrice: 0.10 + i * 0.01,
      exportPrice: 0.04 + i * 0.01,
      isForecast: false
    }));

    const homey = makeHomey(appId => {
      assert.strictEqual(appId, 'com.gruijter.powerhour');
      return {
        get: async path => {
          assert.strictEqual(path, '/dap-prices');
          return { prices: [{ deviceId: 'dev-15', deviceName: 'NL_Netherlands', driverType: 'dap15', slots }] };
        }
      };
    });

    const provider = new PbthProvider(homey, { deviceId: 'dev-15' });
    const result = await provider.fetchPrices(true);

    assert.strictEqual(provider.driverType, 'dap15');
    assert.strictEqual(provider.cache15min.length, 4, 'dap15 device must populate native 15-min cache');
    assert.strictEqual(result.length, 1, 'Four quarters in one hour must aggregate to a single hourly slot');
    assert.ok(Math.abs(result[0].price - 0.115) < 1e-9, 'Hourly aggregate must average the four import prices');
    assert.ok(Math.abs(result[0].exportPrice - 0.055) < 1e-9, 'Hourly aggregate must average the four export prices');
    console.log('Test C (dap15 device: native 15-min + hourly aggregate): PASSED');
  }

  // ── Test D: dap device — hourly-only slots, cache15min stays null (no fabricated quarters) ──
  {
    const base = new Date();
    base.setUTCMinutes(0, 0, 0);
    const slots = [0, 1].map(h => ({
      time: new Date(base.getTime() + h * 3_600_000).toISOString(),
      importPrice: 0.20 + h * 0.01,
      exportPrice: 0.08
    }));

    const homey = makeHomey(() => ({
      get: async () => ({ prices: [{ deviceId: 'dev-1h', deviceName: 'Zonneplan', driverType: 'dap', slots }] })
    }));

    const provider = new PbthProvider(homey, { deviceId: 'dev-1h' });
    const result = await provider.fetchPrices(true);

    assert.strictEqual(provider.driverType, 'dap');
    assert.strictEqual(provider.cache15min, null, 'dap device must not populate a native 15-min cache');
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].price, 0.20);
    console.log('Test D (dap device: hourly only, no fabricated 15-min): PASSED');
  }

  // ── Test E: chosen deviceId not present in the response → falsy, no throw ──
  {
    const homey = makeHomey(() => ({
      get: async () => ({ prices: [{ deviceId: 'some-other-device', deviceName: 'X', driverType: 'dap15', slots: [] }] })
    }));

    const provider = new PbthProvider(homey, { deviceId: 'missing-device' });
    const result = await provider.fetchPrices(true);
    assert.deepStrictEqual(result, [], 'Unknown deviceId must resolve to an empty array, not throw');
    console.log('Test E (unknown deviceId → falsy, no throw): PASSED');
  }

  // ── Test F: device present but slots[] empty → falsy, no throw ──
  {
    const homey = makeHomey(() => ({
      get: async () => ({ prices: [{ deviceId: 'dev-empty', deviceName: 'Empty', driverType: 'dap15', slots: [] }] })
    }));

    const provider = new PbthProvider(homey, { deviceId: 'dev-empty' });
    const result = await provider.fetchPrices(true);
    assert.deepStrictEqual(result, [], 'Empty slots[] must resolve to an empty array, not throw');
    console.log('Test F (empty slots[] → falsy, no throw): PASSED');
  }

  // ── Test G: app not installed / API call rejects → falsy, no throw ──
  {
    const homey = makeHomey(() => ({ get: async () => { throw new Error('app not installed'); } }));
    const provider = new PbthProvider(homey, { deviceId: 'dev-1h' });
    const result = await provider.fetchPrices(true);
    assert.deepStrictEqual(result, [], 'A rejected app-to-app call must resolve to an empty array, not throw');
    console.log('Test G (API rejection → falsy, no throw): PASSED');
  }

  // ── Test H: on API failure, a previously-populated cache is returned stale rather than dropped ──
  {
    const homey = makeHomey(() => ({ get: async () => { throw new Error('network error'); } }));
    const provider = new PbthProvider(homey, { deviceId: 'dev-1h' });
    const staleSlot = { timestamp: new Date(), price: 0.30, exportPrice: 0.1, hour: 0, minute: 0 };
    provider.cache = [staleSlot];

    const result = await provider.fetchPrices(true);
    assert.deepStrictEqual(result, [staleSlot], 'A fetch failure must return the stale cache, not wipe it');
    console.log('Test H (fetch failure returns stale cache): PASSED');
  }

  // ── Test I: getAll15MinPrices() must carry exportPrice through — this array feeds compute()
  // directly (tariff-manager.js merges it with native-source priority over the expanded hourly
  // fallback), so a dropped field here silently starves the DP of exportPrice on every quarter. ──
  {
    const base = new Date();
    base.setUTCMinutes(0, 0, 0);
    const slots = [0, 15, 30, 45].map((m, i) => ({
      time: new Date(base.getTime() + m * 60_000).toISOString(),
      importPrice: 0.10 + i * 0.01,
      exportPrice: 0.04 + i * 0.01
    }));

    const homey = makeHomey(() => ({
      get: async () => ({ prices: [{ deviceId: 'dev-15', deviceName: 'NL_Netherlands', driverType: 'dap15', slots }] })
    }));

    const provider = new PbthProvider(homey, { deviceId: 'dev-15' });
    await provider.fetchPrices(true);

    const quarters = provider.getAll15MinPrices();
    assert.strictEqual(quarters.length, 4);
    assert.ok(quarters.every(q => typeof q.exportPrice === 'number'), 'getAll15MinPrices() dropped exportPrice');
    assert.ok(Math.abs(quarters[0].exportPrice - 0.04) < 1e-9, 'exportPrice value must match the source quarter, not just be present');
    console.log('Test I (getAll15MinPrices carries exportPrice): PASSED');
  }

  console.log('pbth-provider.test.js: all assertions passed');
})().catch(err => {
  console.error('pbth-provider.test.js FAILED:', err.message);
  process.exit(1);
});
