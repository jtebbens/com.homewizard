const assert = require('assert');
const TariffManager = require('../lib/tariff-manager');

function makeHomey() {
  return {
    log: () => {},
    error: () => {},
    settings: {
      // homey.settings.get() is synchronous in the real SDK — _initializeDynamicProvider()
      // now calls it directly (for pbth_device_id), so the stub must match that shape.
      get: () => null,
      set: () => {}
    }
  };
}

// _initializeDynamicProvider() constructs MergedPriceProvider synchronously before firing
// the (unawaited) async _selectBestProvider() fetch — stub that out so the test never
// hits the network, then inspect the synchronously-constructed provider's config.

// ── Test A: export_price_multiplier/export_price_addon settings threaded into MergedPriceProvider ──
{
  const manager = Object.create(TariffManager.prototype);
  manager.homey = makeHomey();
  manager.log = () => {};
  manager._selectBestProvider = async () => {};
  manager.settings = {
    enable_dynamic_pricing: true,
    dynamic_price_markup: 0.11,
    export_price_multiplier: 1.10,
    export_price_addon: 0.02
  };

  manager._initializeDynamicProvider();

  assert.strictEqual(manager.mergedProvider.exportMultiplier, 1.10, 'exportMultiplier not read from settings');
  assert.strictEqual(manager.mergedProvider.exportAddon, 0.02, 'exportAddon not read from settings');
  console.log('Test A (settings threaded into MergedPriceProvider): PASSED');
}

// ── Test B: missing settings fall back to neutral defaults (multiplier=1.0, addon=0) ──
{
  const manager = Object.create(TariffManager.prototype);
  manager.homey = makeHomey();
  manager.log = () => {};
  manager._selectBestProvider = async () => {};
  manager.settings = { enable_dynamic_pricing: true };

  manager._initializeDynamicProvider();

  assert.strictEqual(manager.mergedProvider.exportMultiplier, 1.0, 'default exportMultiplier must be 1.0');
  assert.strictEqual(manager.mergedProvider.exportAddon, 0, 'default exportAddon must be 0');
  console.log('Test B (neutral defaults when unset): PASSED');
}

// ── Test C: _expandHourlyTo15Min() carries exportPrice through the no-native-15min fallback ──
{
  const manager = Object.create(TariffManager.prototype);
  manager.log = () => {};
  const base = new Date('2026-07-01T00:00:00.000Z');
  manager.dynamicProvider = {
    getAllHourlyPrices: () => [
      { timestamp: base, hour: 0, price: 0.19, exportPrice: 0.077 }
    ]
  };

  const intervals = manager._expandHourlyTo15Min();
  assert.strictEqual(intervals.length, 4, 'one hour must expand to 4 15-min slots');
  assert.ok(intervals.every(i => i.exportPrice === 0.077), 'exportPrice must survive the hourly→15min expansion');
  console.log('Test C (exportPrice survives 15-min expansion fallback): PASSED');
}

console.log('tariff-manager-export-price.test.js: all assertions passed');
