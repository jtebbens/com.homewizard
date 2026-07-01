const assert = require('assert');
const MergedPriceProvider = require('../lib/merged-price-provider');

// Minimal homey stub — settings.get resolves null (no persisted cache) so the
// provider's constructor-time _loadCache() resolves quickly and cleanly.
function makeHomey() {
  return {
    log: (...args) => {},
    error: (...args) => {},
    settings: {
      get: async () => null,
      set: () => {}
    }
  };
}

function makeSlots(count, { startHour = 0, price = 0.2 } = {}) {
  const base = new Date();
  base.setUTCMinutes(0, 0, 0);
  base.setUTCHours(base.getUTCHours() + startHour);
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(base.getTime() + i * 3_600_000),
    price,
    hour: (base.getUTCHours() + i) % 24
  }));
}

(async () => {
  // ── Test A: all-null-price slots from both providers → ENTSOE emergency fallback fires ──
  {
    const provider = new MergedPriceProvider(makeHomey());
    await provider._cacheLoadPromise;

    const nullSlots = makeSlots(24).map(s => ({ ...s, price: null }));
    provider.xadi.fetchPrices = async () => nullSlots;
    provider.kwhprice.fetchPrices = async () => nullSlots.map(s => ({ ...s, price: NaN }));
    provider.entsoe.fetchPrices = async () => makeSlots(48, { price: 0.25 });

    const result = await provider.fetchPrices(true);

    assert.strictEqual(provider.lastFetchSources.join(','), 'entsoe',
      'All-null-price slots from both primary providers must be treated as no data, triggering ENTSOE fallback');
    assert.ok(result.every(p => Number.isFinite(p.price)), 'Fallback result must contain only valid prices');
    console.log('Test A (all-null-price triggers ENTSOE fallback): PASSED');
  }

  // ── Test B: mixed valid/invalid slots from one provider → invalid slots dropped, no crash ──
  {
    const provider = new MergedPriceProvider(makeHomey());
    await provider._cacheLoadPromise;

    const mixedXadi = makeSlots(24).map((s, i) => (i % 3 === 0 ? { ...s, price: null } : s));
    provider.xadi.fetchPrices = async () => mixedXadi;
    provider.kwhprice.fetchPrices = async () => [];
    provider.entsoe.fetchPrices = async () => makeSlots(48, { price: 0.25 });

    const result = await provider.fetchPrices(true);

    const validXadiCount = mixedXadi.filter(s => Number.isFinite(s.price)).length;
    assert.ok(result.every(p => Number.isFinite(p.price)), 'Merged result must never contain an invalid price');
    assert.ok(result.length >= validXadiCount, 'Valid Xadi slots must survive the merge');
    console.log('Test B (mixed valid/invalid slots dropped cleanly): PASSED');
  }

  // ── Test C: incomplete (<48h) cache uses the short retry TTL, not the full hour ──
  {
    const provider = new MergedPriceProvider(makeHomey());
    await provider._cacheLoadPromise;

    provider.xadi.fetchPrices = async () => makeSlots(24, { price: 0.2 }); // today only
    provider.kwhprice.fetchPrices = async () => [];
    provider.entsoe.fetchPrices = async () => []; // tomorrow-fill also comes up empty

    await provider.fetchPrices(true);

    const minutesLeft = (provider.cacheExpiry - Date.now()) / 60000;
    assert.ok(provider.cache.length < 48, 'Test setup must actually produce an incomplete (<48h) cache');
    assert.ok(minutesLeft <= 16 && minutesLeft > 10,
      `Incomplete cache must use the ~15-min retry TTL, got ${minutesLeft.toFixed(1)}min`);
    console.log('Test C (incomplete cache uses short retry TTL): PASSED');
  }

  // ── Test D: full (48h) cache uses the normal 1-hour TTL (regression guard) ──
  {
    const provider = new MergedPriceProvider(makeHomey());
    await provider._cacheLoadPromise;

    provider.xadi.fetchPrices = async () => makeSlots(48, { price: 0.2 }); // today + tomorrow
    provider.kwhprice.fetchPrices = async () => [];
    provider.entsoe.fetchPrices = async () => [];

    await provider.fetchPrices(true);

    const minutesLeft = (provider.cacheExpiry - Date.now()) / 60000;
    assert.strictEqual(provider.cache.length, 48, 'Test setup must actually produce a full 48h cache');
    assert.ok(minutesLeft <= 61 && minutesLeft > 55,
      `Full 48h cache must keep the normal ~60-min TTL, got ${minutesLeft.toFixed(1)}min`);
    console.log('Test D (full 48h cache keeps normal TTL): PASSED');
  }

  console.log('merged-price-provider.test.js: all assertions passed');
  process.exit(0);
})().catch(err => {
  console.error('merged-price-provider.test.js FAILED:', err.message);
  process.exit(1);
});
