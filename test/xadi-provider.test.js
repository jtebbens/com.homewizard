const assert = require('assert');
const XadiProvider = require('../lib/xadi-provider');

// Minimal homey stub
const homey = {
  log: (...args) => {},
  error: (...args) => {}
};

(async () => {
  const provider = new XadiProvider(homey);

  // Build a synthetic cache with two hourly windows: one covering 'now' and one next hour
  const now = new Date();
  const startThisHour = new Date(now.getTime() - 30 * 60 * 1000); // started 30 minutes ago
  const startNextHour = new Date(startThisHour.getTime() + 60 * 60 * 1000);

  provider.cache = [
    {
      timestamp: startThisHour,
      price: 0.1111,
      priceMwh: 111.1,
      hour: startThisHour.getHours(),
      originalPrice: 0.1111
    },
    {
      timestamp: startNextHour,
      price: 0.2222,
      priceMwh: 222.2,
      hour: startNextHour.getHours(),
      originalPrice: 0.2222
    }
  ];

  const price = provider.getCurrentPrice();
  console.log('Provider current price returned:', price);

  assert.strictEqual(price, 0.1111, 'Expected provider to return the price for the current timestamp window');

  console.log('XadiProvider timestamp matching test: PASSED');
})();
