'use strict';

const XadiProvider = require('./xadi-provider');
const KwhPriceProvider = require('./kwhprice-provider');

/**
 * MergedPriceProvider
 *
 * Fetches from both Xadi and KwhPrice concurrently and merges their hourly
 * price data into the most complete possible table. Both sources derive from
 * ENTSO-E day-ahead prices, so spot prices are identical when both have a slot.
 *
 * Merge strategy (per UTC-hour slot):
 *   - Xadi wins when both sources have the same slot (trusted, server-applied markup)
 *   - KwhPrice fills any slot Xadi is missing
 *   - Result is sorted ascending by timestamp
 *
 * Typical coverage:
 *   Before ~13:15 CET  → today 24h from either/both sources
 *   After  ~13:15 CET  → today + tomorrow up to 48h
 *
 * Exposes the same public interface as EnergyZeroProvider / KwhPriceProvider
 * so it is a drop-in for TariffManager.dynamicProvider.
 */
class MergedPriceProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    this.markup = options.markup || 0.11;

    // Both underlying providers share the same markup so prices are comparable
    this.xadi = new XadiProvider(homey);
    this.kwhprice = new KwhPriceProvider(homey, { markup: this.markup });

    // Track which sources contributed to the last fetch
    this.lastFetchSources = [];

    this.log(`MergedPriceProvider initialized with markup: €${this.markup}/kWh`);
    this._cacheLoadPromise = this._loadCache();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('merged_price_cache');
      if (cached && cached.expiry > Date.now()) {
        this.cache = cached.prices.map(p => ({ ...p, timestamp: new Date(p.timestamp) }));
        this.cacheExpiry = cached.expiry;
        this.lastFetchSources = cached.sources || [];

        // Restore 15-min caches from what was saved — sub-providers' _saveCache() is a
        // no-op (saves centrally here), so without this, cache15min is always null after
        // restart and getAll15MinPrices() falls back to _expandHourlyTo15Min().
        if (cached.prices15min_kwh?.length > 0) {
          this._cached15min_kwh = cached.prices15min_kwh.map(p => ({
            ...p, timestamp: new Date(p.timestamp)
          }));
        }
        if (cached.prices15min_xadi?.length > 0) {
          this._cached15min_xadi = cached.prices15min_xadi.map(p => ({
            ...p, timestamp: new Date(p.timestamp)
          }));
        }

        this.log(
          `Loaded ${this.cache.length} merged cached prices ` +
          `(sources: ${this.lastFetchSources.join('+')}, ` +
          `expires in ${Math.round((this.cacheExpiry - Date.now()) / 60000)}min, ` +
          `15-min: ${this._cached15min_kwh?.length || 0} kwh + ${this._cached15min_xadi?.length || 0} xadi)`
        );
      }
    } catch (err) {
      this.log('Failed to load merged cache:', err.message);
    }
  }

  async _saveCache() {
    // Debounce 5min — homey.settings.set allocates ~30 MB V8 heap per call
    // (framework-internal). In-memory this.cache is already the primary source;
    // persistence only serves restart recovery.
    if (this._saveCacheTimer) clearTimeout(this._saveCacheTimer);
    this._saveCacheTimer = setTimeout(() => {
      this._saveCacheTimer = null;
      try {
        this.homey.settings.set('merged_price_cache', {
          prices: this.cache,
          prices15min_kwh:  this.kwhprice.cache15min  || null,
          prices15min_xadi: this.xadi.cache15min || null,
          expiry: this.cacheExpiry,
          sources: this.lastFetchSources,
          savedAt: Date.now()
        });
      } catch (err) {
        this.error('Failed to save merged cache:', err.message);
      }
    }, 5 * 60 * 1000);
  }

  // ─── Merge logic ─────────────────────────────────────────────────────────────

  /**
   * Merge two arrays of hourly price objects.
   * Both arrays use the shape: { timestamp: Date, price, originalPrice, hour, readingDate }
   *
   * Xadi entries take priority; KwhPrice fills gaps.
   * Key = UTC hour start (ISO string, truncated to the hour).
   */
  _merge(xadiPrices, kwhPrices) {
    const slots = new Map();

    /**
     * Snap any timestamp to the UTC hour boundary it belongs to.
     * Xadi returns prices at :45 past the hour (15-min interval offset);
     * snapping ensures getCurrentPrice()'s [start, start+1h) window is correct
     * and that both sources key on the same bucket.
     */
    const snapToHour = ts => {
      const d = ts instanceof Date ? ts : new Date(ts);
      return new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours())
      );
    };

    const normalize = p => ({
      ...p,
      timestamp: snapToHour(p.timestamp)
    });

    // Add Xadi first (lower priority — used as fallback for hours KwhPrice doesn't have)
    for (const p of xadiPrices) {
      const n = normalize(p);
      slots.set(n.timestamp.toISOString(), { ...n, _source: 'xadi' });
    }

    // Overwrite with KwhPrice (higher priority — final EPEX auction prices)
    for (const p of kwhPrices) {
      const n = normalize(p);
      slots.set(n.timestamp.toISOString(), { ...n, _source: 'kwhprice' });
    }

    return Array.from(slots.values())
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  async fetchPrices(force = false) {
    // Wait for the initial settings cache load (constructor calls _loadCache async)
    if (this._cacheLoadPromise) {
      await this._cacheLoadPromise;
      this._cacheLoadPromise = null;
    }
    if (!force && this.cache && this.cacheExpiry > Date.now()) {
      this.log(`Using merged cache (${this.cache.length}h, sources: ${this.lastFetchSources.join('+')})`);

      // Restore sub-provider 15-min caches from the saved data loaded in _loadCache().
      // This ensures getAll15MinPrices() (called by TariffManager) returns native 15-min
      // data instead of falling back to _expandHourlyTo15Min() on every restart.
      // Sub-providers' own _loadCache() doesn't set cache15min (their _saveCache is no-op),
      // so this is the only way to populate them when the hourly cache is still valid.
      if (!this.kwhprice.cache15min && this._cached15min_kwh?.length > 0) {
        this.kwhprice.cache15min = this._cached15min_kwh;
        this.log(`♻️ Restored ${this.kwhprice.cache15min.length} KwhPrice 15-min prices from merged cache`);
      }
      if (!this.xadi.cache15min && this._cached15min_xadi?.length > 0) {
        this.xadi.cache15min = this._cached15min_xadi;
        this.log(`♻️ Restored ${this.xadi.cache15min.length} Xadi 15-min prices from merged cache`);
      }

      return this.cache;
    }

    // Fetch both concurrently; treat each failure independently
    const [xadiResult, kwhResult] = await Promise.allSettled([
      this.xadi.fetchPrices(force),
      this.kwhprice.fetchPrices(force)
    ]);

    const xadiPrices = xadiResult.status === 'fulfilled' ? (xadiResult.value || []) : [];
    const kwhPrices  = kwhResult.status  === 'fulfilled' ? (kwhResult.value  || []) : [];

    if (xadiResult.status === 'rejected') {
      this.log('⚠️ Xadi fetch failed in merge:', xadiResult.reason?.message);
    }
    if (kwhResult.status === 'rejected') {
      this.log('⚠️ KwhPrice fetch failed in merge:', kwhResult.reason?.message);
    }

    if (xadiPrices.length === 0 && kwhPrices.length === 0) {
      // Both failed — return stale cache if available
      if (this.cache?.length > 0) {
        this.log('⚠️ Both sources failed, returning stale merged cache');
        return this.cache;
      }
      throw new Error('MergedPriceProvider: both Xadi and KwhPrice returned no data');
    }

    this.lastFetchSources = [
      ...(xadiPrices.length  > 0 ? ['xadi']     : []),
      ...(kwhPrices.length   > 0 ? ['kwhprice'] : [])
    ];

    this.cache = this._merge(xadiPrices, kwhPrices);
    this.cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
    await this._saveCache();

    // Detailed coverage log
    const xadiSlots    = this.cache.filter(p => p._source === 'xadi').length;
    const kwhSlots     = this.cache.filter(p => p._source === 'kwhprice').length;
    const totalH       = this.cache.length;
    const days         = totalH > 24 ? 'today + tomorrow' : 'today only';

    this.log(
      `✅ Merged price table: ${totalH}h (${days}) — ` +
      `${xadiSlots}h from Xadi, ${kwhSlots}h from KwhPrice`
    );

    if (this.cache.length > 0) {
      const first = this.cache[0];
      const last  = this.cache[this.cache.length - 1];
      this.log(
        `Range: ${first.timestamp instanceof Date ? first.timestamp.toISOString() : first.timestamp} ` +
        `(${first.hour}:00) → ` +
        `${last.timestamp instanceof Date ? last.timestamp.toISOString() : last.timestamp} ` +
        `(${last.hour}:00)`
      );
    }

    return this.cache;
  }

  getCurrentRate() {
    if (!this.cache || this.cache.length === 0) return 'standard';

    const now = new Date();
    let current = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end   = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });

    if (!current) {
      const currentHour = parseInt(
        now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false })
      );
      current = this.cache.find(p => p.hour === currentHour);
    }

    if (!current) current = this.cache[0];

    const prices  = this.cache.map(p => p.price);
    const avg     = prices.reduce((a, b) => a + b, 0) / prices.length;
    const stdDev  = this._calculateStdDev(prices, avg);
    const price   = current.price;

    if (price <= avg - stdDev * 0.5) return 'low';
    if (price >= avg + stdDev * 0.5) return 'peak';
    return 'standard';
  }

  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;
    const now  = new Date();
    const next = this.cache.find(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return ts > now;
    });
    return next ? next.timestamp : null;
  }

  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const current = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end   = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });
    return current ? current.price : null;
  }

  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) {
      return { avg: null, min: null, max: null, stdDev: null };
    }
    const prices = this.cache.map(p => p.price);
    const avg    = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      avg,
      min:    Math.min(...prices),
      max:    Math.max(...prices),
      stdDev: this._calculateStdDev(prices, avg)
    };
  }

  getTop3Cheapest() {
    if (!this.cache || this.cache.length === 0) return [];
    return [...this.cache]
      .sort((a, b) => a.price - b.price)
      .slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  getTop3MostExpensive() {
    if (!this.cache || this.cache.length === 0) return [];
    return [...this.cache]
      .sort((a, b) => b.price - a.price)
      .slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  hasPrices() {
    return !!(this.cache && this.cache.length > 0);
  }

  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    return this.cache.map(p => ({
      hour:      p.hour,
      index:     Math.floor((new Date(p.timestamp) - now) / (1000 * 60 * 60)),
      price:     p.price,
      timestamp: p.timestamp,
      source:    p._source   // bonus: callers can see where each hour came from
    }));
  }

  _calculateStdDev(values, mean) {
    const sq = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(sq.reduce((a, b) => a + b, 0) / values.length);
  }
}

module.exports = MergedPriceProvider;