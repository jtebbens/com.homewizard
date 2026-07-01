const assert = require('assert');
const TariffManager = require('../lib/tariff-manager');

function makeManager({ hourly, xadi15 = [], kwh15 = [], entsoe15 = [] }) {
  const manager = Object.create(TariffManager.prototype);
  manager.log = () => {};
  manager.dynamicProvider = {
    getAllHourlyPrices: () => hourly,
    entsoe: {
      getAll15MinPrices: () => entsoe15
    }
  };
  manager.xadiProvider = {
    getAll15MinPrices: () => xadi15
  };
  manager.kwhpriceProvider = {
    getAll15MinPrices: () => kwh15
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
    xadi15: [
      slot(base, 0, 0.41, 'xadi'),
      slot(base, 15, 0.42, 'xadi')
    ],
    kwh15: []
  });

  const prices = manager.getAll15MinPrices();
  assert.strictEqual(prices.length, 8, 'partial native data must not shrink expanded fallback coverage');
  assert.strictEqual(prices[0].price, 0.41, 'native Xadi price should override matching fallback slot');
  assert.strictEqual(prices[1].price, 0.42, 'native Xadi price should override matching fallback slot');
  assert.strictEqual(prices[2].price, 0.31, 'missing native slot should keep expanded fallback price');
  assert.strictEqual(prices[7].price, 0.32, 'later fallback slot should remain available');
}

{
  const manager = makeManager({
    hourly,
    xadi15: [slot(base, 0, 0.41, 'xadi')],
    kwh15: [slot(base, 0, 0.51, 'kwhprice')]
  });

  const prices = manager.getAll15MinPrices();
  assert.strictEqual(prices.length, 8);
  assert.strictEqual(prices[0].price, 0.51, 'KwhPrice should keep highest priority for overlapping native slots');
}

console.log('tariff-15min-coverage tests passed');
