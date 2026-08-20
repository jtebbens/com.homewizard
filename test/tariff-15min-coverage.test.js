const assert = require('assert');
const TariffManager = require('../lib/tariff-manager');

function makeManager({ hourly, pbth15 = [], entsoe15 = [] }) {
  const manager = Object.create(TariffManager.prototype);
  manager.log = () => {};
  manager.dynamicProvider = {
    getAllHourlyPrices: () => hourly,
    entsoe: {
      getAll15MinPrices: () => entsoe15
    }
  };
  manager.pbthProvider = {
    getAll15MinPrices: () => pbth15
  };
  return manager;
}

function slot(base, minutes, price, source = 'test') {
  const timestamp = new Date(base.getTime() + minutes * 60_000);
  return {
    timestamp,
    price,
    hour: timestamp.getUTCHours(),
    minute: timestamp.getUTCMinutes(),
    source
  };
}

const base = new Date('2026-07-01T00:00:00.000Z');
const hourly = [
  { timestamp: new Date(base), hour: 0, price: 0.31, source: 'entsoe' },
  { timestamp: new Date(base.getTime() + 60 * 60_000), hour: 1, price: 0.32, source: 'entsoe' }
];

{
  const manager = makeManager({
    hourly,
    pbth15: [
      slot(base, 0, 0.41, 'pbth'),
      slot(base, 15, 0.42, 'pbth')
    ]
  });

  const prices = manager.getAll15MinPrices();
  assert.strictEqual(prices.length, 8, 'partial native data must not shrink expanded fallback coverage');
  assert.strictEqual(prices[0].price, 0.41, 'native PBTH price should override matching fallback slot');
  assert.strictEqual(prices[1].price, 0.42, 'native PBTH price should override matching fallback slot');
  assert.strictEqual(prices[2].price, 0.31, 'missing native slot should keep expanded fallback price');
  assert.strictEqual(prices[7].price, 0.32, 'later fallback slot should remain available');
}

{
  const manager = makeManager({
    hourly,
    pbth15: [slot(base, 0, 0.51, 'pbth')],
    entsoe15: [slot(base, 0, 0.11, 'entsoe')]
  });

  const prices = manager.getAll15MinPrices();
  assert.strictEqual(prices.length, 8);
  assert.strictEqual(prices[0].price, 0.51, 'PBTH should keep highest priority over ENTSOE for overlapping native slots');
}

// PBTH's paired 'dap' device serves today only; the second hour stands in for tomorrow,
// where ENTSOE is the only native 15-min source. Without ENTSOE reaching this merge those
// slots stay expanded — four identical quarters per hour, which is what the DP then plans
// tomorrow on.
{
  const manager = makeManager({
    hourly,
    pbth15: [
      slot(base, 0, 0.51, 'pbth'),
      slot(base, 15, 0.52, 'pbth'),
      slot(base, 30, 0.53, 'pbth'),
      slot(base, 45, 0.54, 'pbth')
    ],
    entsoe15: [
      slot(base, 0, 0.11, 'entsoe'),
      slot(base, 15, 0.12, 'entsoe'),
      slot(base, 30, 0.13, 'entsoe'),
      slot(base, 45, 0.14, 'entsoe'),
      slot(base, 60, 0.21, 'entsoe'),
      slot(base, 75, 0.22, 'entsoe'),
      slot(base, 90, 0.23, 'entsoe'),
      slot(base, 105, 0.24, 'entsoe')
    ]
  });

  const prices = manager.getAll15MinPrices();
  assert.strictEqual(prices.length, 8);
  assert.deepStrictEqual(
    prices.slice(0, 4).map(p => p.price), [0.51, 0.52, 0.53, 0.54],
    'PBTH must outrank ENTSOE where both have native data'
  );
  assert.deepStrictEqual(
    prices.slice(4).map(p => p.price), [0.21, 0.22, 0.23, 0.24],
    'ENTSOE native quarters must replace the expanded hourly price on the day PBTH does not cover'
  );
  assert.strictEqual(
    new Set(prices.slice(4).map(p => p.price)).size, 4,
    'no flat block of four identical quarters may survive when native 15-min data exists'
  );
}

console.log('tariff-15min-coverage tests passed');
