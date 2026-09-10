'use strict';

// Estimated prices ("forecast") fill the part of tomorrow the day-ahead auction has not
// published yet. Two things must hold, or the fill stops being temporary:
//   1. a real source always beats an estimate on the same timestamp — that IS the
//      replacement mechanism (tariff-manager sourcePriority forecast:-1), there is no
//      separate replace step;
//   2. with the setting off, not a single estimated slot reaches the planner.
// Plus: estimates must never be written to the price settings, because everything reading
// those back (diagnose page, ROI, price history) would score a forecast as a realised price.

const assert = require('assert');
const TariffManager = require('../lib/tariff-manager');

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

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);          // 14:00 CEST
const slot = (offsetSlots, price, extra = {}) => ({
  timestamp: new Date(T0 + offsetSlots * 900_000),
  price,
  exportPrice: price,
  hour: 14,
  minute: 0,
  ...extra,
});

/** TariffManager with the provider layer stubbed out — only the merge is under test. */
function makeManager({ mode = 'off', realSlots = [], forecastSlots = [] } = {}) {
  const homey = { log() {}, settings: { get: () => null, set() {} } };
  const tm = new TariffManager(homey, { enable_dynamic_pricing: false, price_forecast_fill: mode });
  tm.settings.price_forecast_fill = mode;
  tm.dynamicProvider = {
    entsoe: { getAll15MinPrices: () => realSlots },
    getAllHourlyPrices: () => [],
  };
  tm.pbthProvider = null;
  tm.forecastProvider = {
    hasPrices: () => forecastSlots.length > 0,
    getAll15MinPrices: () => forecastSlots.map(s => ({ ...s, estimated: true })),
  };
  return tm;
}

console.log('\nprice-forecast merge');

test('estimate fills only slots no real source covers', () => {
  const tm = makeManager({
    mode: 'on',
    realSlots: [slot(0, 0.20), slot(1, 0.21)],
    forecastSlots: [slot(1, 0.99), slot(2, 0.30), slot(3, 0.31)],
  });
  const out = tm.getAll15MinPrices();
  assert.strictEqual(out.length, 4, `expected 4 slots, got ${out.length}`);
  const overlap = out.find(p => p.timestamp.getTime() === T0 + 900_000);
  assert.strictEqual(overlap.price, 0.21, 'real price must survive on the overlapping slot');
  assert.ok(!overlap.estimated, 'overlapping slot must not be flagged estimated');
  const filled = out.filter(p => p.estimated);
  assert.strictEqual(filled.length, 2, 'only the two uncovered slots may be estimated');
});

test('a real price arriving later overwrites the estimate on that timestamp', () => {
  const before = makeManager({ mode: 'on', realSlots: [slot(0, 0.20)], forecastSlots: [slot(1, 0.99)] });
  const filled = before.getAll15MinPrices().find(p => p.timestamp.getTime() === T0 + 900_000);
  assert.ok(filled.estimated && filled.price === 0.99, 'estimate should be present before publication');

  const after = makeManager({ mode: 'on', realSlots: [slot(0, 0.20), slot(1, 0.24)], forecastSlots: [slot(1, 0.99)] });
  const real = after.getAll15MinPrices().find(p => p.timestamp.getTime() === T0 + 900_000);
  assert.strictEqual(real.price, 0.24, 'published day-ahead must replace the estimate');
  assert.ok(!real.estimated, 'replaced slot must no longer be flagged estimated');
});

test('mode off and mode shadow keep every estimate out of the planner', () => {
  for (const mode of ['off', 'shadow']) {
    const tm = makeManager({ mode, realSlots: [slot(0, 0.20)], forecastSlots: [slot(1, 0.99), slot(2, 0.30)] });
    const out = tm.getAll15MinPrices();
    assert.strictEqual(out.length, 1, `mode ${mode}: expected only the real slot, got ${out.length}`);
    assert.ok(!out.some(p => p.estimated), `mode ${mode}: no slot may be estimated`);
  }
});

test('estimated slots are never persisted to settings', () => {
  const written = {};
  const homey = { log() {}, settings: { get: () => null, set: (k, v) => { written[k] = v; } } };
  const tm = new TariffManager(homey, { enable_dynamic_pricing: false });
  tm._schedulePricesPersist({
    all15min: [slot(0, 0.20), slot(1, 0.99, { estimated: true })],
    allPrices: [slot(0, 0.20), slot(4, 0.99, { estimated: true })],
  });
  tm._pricesPersistTimer._onTimeout();          // fire the 60s debounce now
  clearTimeout(tm._pricesPersistTimer);
  assert.strictEqual(written.policy_all_prices_15min.length, 1, '15-min blob must hold only real prices');
  assert.strictEqual(written.policy_all_prices.length, 1, 'hourly blob must hold only real prices');
  assert.ok(!written.policy_all_prices_15min.some(p => p.estimated), 'no estimated slot may be written');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
