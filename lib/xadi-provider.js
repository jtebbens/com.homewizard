'use strict';

const fetch = require('node-fetch');

/**
 * Xadi Day-Ahead Prices Provider
 * 
 * ✅ UPDATED: Now preserves 15-minute intervals from Xadi API
 * 
 * Fetches both /today and /next24h to ensure complete coverage.
 * Markup is applied CLIENT-SIDE (not via the Xadi API parameters) so the
 * formula is identical to KwhPriceProvider: (spot + markup) × 1.21
 */
class XadiProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.markup = options.markup !== undefined ? options.markup : 0.11;
    this.cache = null;           // Hourly averages (backward compatible)
    this.cache15min = null;       // ✅ NEW: 15-minute intervals
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    this._loadCache();
  }

  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('xadi_cache');
      if (cached && cached.expiry > Date.now()) {
        this.cache = cached.prices.map(p => ({
          ...p,
          timestamp: new Date(p.timestamp)
        }));
        // ✅ NEW: Load 15-min cache
        this.cache15min = cached.prices15min?.map(p => ({
          ...p,
          timestamp: new Date(p.timestamp)
        })) || null;
        
        this.cacheExpiry = cached.expiry;
        this.log(`Loaded ${this.cache.length} hourly + ${this.cache15min?.length || 0} 15-min prices from storage (expires in ${Math.round((this.cacheExpiry - Date.now()) / 60000)}min)`);
      }
    } catch (error) {
      this.log('Failed to load cached prices:', error.message);
    }
  }

  async _saveCache() {
    // Cache is saved centrally by MergedPriceProvider — skip individual save
    // to reduce settings store pressure and memory churn
  }

  /**
   * Map a single Xadi API item to a price object.
   * Markup applied client-side: (spot + markup) × 1.21
   * 
   * ✅ NEW: Extracts minute from hour field (e.g., "10:15" → hour:10, minute:15)
   * @private
   */
  _mapItem(item) {
    // Use server-applied price directly (markup already included by API)
    const price = item.price;
    const spot  = item.markup?.originalPrice ?? item.price;

    // Extract hour and minute from "10:15" format
    const [hourStr, minuteStr] = (item.hour || '0:00').split(':');
    const hour   = parseInt(hourStr,   10);
    const minute = parseInt(minuteStr, 10);

    return {
      timestamp: new Date(item.time),
      price,
      priceMwh: item.priceMwh,
      hour,
      minute,
      originalPrice: spot
    };
  }

  /**
   * ✅ NEW: Separate 15-minute intervals from hourly averages
   * @private
   */
  _separateIntervals(allPrices) {
    const intervals15min = [];
    const hourlyBuckets = {};

    allPrices.forEach(p => {
      // Add to 15-min array
      intervals15min.push(p);
      
      // Also bucket by hour for hourly averages
      const hourKey = `${p.timestamp.getFullYear()}-${p.timestamp.getMonth()}-${p.timestamp.getDate()}-${p.hour}`;
      if (!hourlyBuckets[hourKey]) {
        hourlyBuckets[hourKey] = { prices: [], timestamp: null };
      }
      hourlyBuckets[hourKey].prices.push(p.price);
      if (p.minute === 0 || !hourlyBuckets[hourKey].timestamp) {
        hourlyBuckets[hourKey].timestamp = p.timestamp;
      }
    });

    // Create hourly averages
    const hourlyPrices = Object.entries(hourlyBuckets).map(([key, bucket]) => {
      const avgPrice = bucket.prices.reduce((a, b) => a + b, 0) / bucket.prices.length;
      const ts = bucket.timestamp || new Date(key.split('-').slice(0, 3).join('-'));
      const hour = parseInt(key.split('-')[3], 10);
      
      return {
        timestamp: ts,
        price: avgPrice,
        hour,
        originalPrice: avgPrice - this.markup  // Reverse: server formula is spot + markup
      };
    }).sort((a, b) => a.timestamp - b.timestamp);

    return {
      intervals15min: intervals15min.sort((a, b) => a.timestamp - b.timestamp),
      hourlyPrices
    };
  }

  /**
   * Fetch prices from /today, /next24h and /day/tomorrow.
   * API called with markup=0&vat=0 to receive raw spot prices.
   * 
   * ✅ UPDATED: Now stores both 15-min and hourly data
   * @param {boolean} force - Force refresh even if cache is valid
   */
  async fetchPrices(force = false) {
    const now = Date.now();
    const hour = new Date().getHours();

    const shouldForceRefresh = force && (hour >= 15 && hour <= 16) &&
                               this.cache && (now - (this.cacheExpiry - 60 * 60 * 1000)) > 30 * 60 * 1000;

    if (this.cache && this.cacheExpiry > now && !shouldForceRefresh) {
      this.log('Using cached Xadi prices');
      return this.cache;
    }

    if (shouldForceRefresh) {
      this.log('Forcing price refresh during release window (15:00-16:00)');
    }

    // Let Xadi apply markup server-side (same formula as KwhPrice: spot + markup, no VAT)
    const baseParams = `markup=${this.markup}&vat=0`;
    const allPrices = [];
    const seenTimestamps = new Set();

    try {
      // 1. /today
      const todayUrl = `https://dap.xadi.eu/api/nl/today?${baseParams}`;
      this.log(`Fetching Xadi /today (CET): ${todayUrl}`);
      try {
        const res = await fetch(todayUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'success' && data.data && data.data.length > 0) {
            const prices = data.data.map(item => this._mapItem(item));
            prices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) { allPrices.push(p); seenTimestamps.add(ts); }
            });
            this.log(`✅ Fetched ${prices.length} intervals from /today`);
          }
        }
      } catch (err) { this.log(`Failed to fetch /today: ${err.message}`); }

      // 2. /next24h
      const next24hUrl = `https://dap.xadi.eu/api/nl/next24h?${baseParams}`;
      this.log(`Fetching Xadi /next24h (CET): ${next24hUrl}`);
      try {
        const res = await fetch(next24hUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'success' && data.data && data.data.length > 0) {
            const prices = data.data.map(item => this._mapItem(item));
            let newCount = 0;
            prices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) { allPrices.push(p); seenTimestamps.add(ts); newCount++; }
            });
            this.log(`✅ Fetched ${prices.length} intervals from /next24h (${newCount} new)`);
          }
        }
      } catch (err) { this.log(`Failed to fetch /next24h: ${err.message}`); }

      // 3. /day/tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];
      const dayAheadUrl = `https://dap.xadi.eu/api/nl/day/${tomorrowStr}?${baseParams}`;
      this.log(`Attempting to fetch tomorrow's prices: ${dayAheadUrl}`);
      try {
        const res = await fetch(dayAheadUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'success' && data.data && data.data.length > 0) {
            const prices = data.data.map(item => this._mapItem(item));
            let newCount = 0;
            prices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) { allPrices.push(p); seenTimestamps.add(ts); newCount++; }
            });
            this.log(`✅ Fetched ${prices.length} intervals for tomorrow (${newCount} new)`);
          }
        }
      } catch (err) { this.log(`Tomorrow's prices not yet available: ${err.message}`); }

      if (allPrices.length === 0) throw new Error('No price data available from any endpoint');

      // ✅ NEW: Separate 15-min and hourly data
      const { intervals15min, hourlyPrices } = this._separateIntervals(allPrices);

      const firstTime = intervals15min[0].timestamp;
      const lastTime = intervals15min[intervals15min.length - 1].timestamp;
      this.log(`📊 Total ${intervals15min.length} 15-min intervals (${hourlyPrices.length} hours) from ${firstTime.toISOString()} to ${lastTime.toISOString()}`);

      // Log sample
      const sample = intervals15min.find(p => p.originalPrice > 0) || intervals15min[0];
      this.log(`Price calc sample: (€${sample.originalPrice.toFixed(5)} spot + €${this.markup} markup) × 1.21 = €${sample.price.toFixed(5)}`);

      this.cache15min = intervals15min;
      this.cache = hourlyPrices;
      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      await this._saveCache();

      return this.cache;

    } catch (error) {
      this.error('Failed to fetch Xadi prices:', error);
      if (this.cache) {
        this.log('Returning stale cache due to fetch error');
        return this.cache;
      }
      throw error;
    }
  }

  // ✅ NEW: Get all 15-minute prices
  getAll15MinPrices() {
    if (!this.cache15min || this.cache15min.length === 0) return [];
    const now = new Date();
    return this.cache15min.map((p, idx) => ({
      hour: p.hour,
      minute: p.minute,
      index: idx,
      price: p.price,
      timestamp: p.timestamp,
      hoursFromNow: Math.floor((p.timestamp - now) / (1000 * 60 * 60))
    }));
  }

  // ✅ NEW: Get current 15-minute price
  getCurrent15MinPrice() {
    if (!this.cache15min || this.cache15min.length === 0) return null;
    const now = new Date();
    const current = this.cache15min.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 15 * 60 * 1000);
      return now >= start && now < end;
    });
    return current ? current.price : null;
  }

  // ════════════════════════════════════════════════════════════
  // EXISTING METHODS (mostly unchanged, work with hourly cache)
  // ════════════════════════════════════════════════════════════

  getCurrentRate() {
    if (!this.cache || this.cache.length === 0) return 'standard';
    const now = new Date();
    let current = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return now >= start && now < new Date(start.getTime() + 3600 * 1000);
    }) || this.cache.find(p => p.hour === now.getHours()) || this.cache[0];

    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const std = this._calculateStdDev(prices, avg);
    const price = current.price;

    this.log(`Current price: €${price.toFixed(4)}/kWh | Avg: €${avg.toFixed(4)} | StdDev: ${std.toFixed(4)}`);

    if (price < avg - std || price < min + (max - min) * 0.15) return 'super-off-peak';
    if (price < avg - std * 0.3) return 'off-peak';
    if (price > avg + std * 0.5 || price > max - (max - min) * 0.20) return 'peak';
    return 'standard';
  }

  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    return (
      this.cache.find(p => {
        const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
        return now >= start && now < new Date(start.getTime() + 3600 * 1000);
      }) ||
      this.cache.find(p => p.hour === now.getHours()) ||
      this.cache[0]
    ).price;
  }

  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const currentRate = this.getCurrentRate();
    for (let i = 1; i < 24; i++) {
      const futureTime = new Date(now.getTime() + i * 3600 * 1000);
      const futurePrice = this.cache.find(p => p.hour === futureTime.getHours());
      if (!futurePrice) continue;
      const futureRate = this._categorizeSinglePrice(futurePrice.price);
      if (futureRate !== currentRate) {
        return { rate: futureRate, startsIn: i * 60, price: futurePrice.price, hour: futurePrice.hour };
      }
    }
    return null;
  }

  _categorizeSinglePrice(price) {
    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const std = this._calculateStdDev(prices, avg);
    if (price < avg - std || price < min + (max - min) * 0.15) return 'super-off-peak';
    if (price < avg - std * 0.3) return 'off-peak';
    if (price > avg + std * 0.5 || price > max - (max - min) * 0.20) return 'peak';
    return 'standard';
  }

  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) return null;
    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return { average: avg, min, max, stdDev: this._calculateStdDev(prices, avg), range: max - min, current: this.getCurrentPrice(), totalHours: prices.length };
  }

  getCheapestHours(count = 3, lookAhead = 24) {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    const future = [];
    for (let i = 0; i < lookAhead; i++) {
      const ft = new Date(now.getTime() + i * 3600 * 1000);
      const p = this.cache.find(q => {
        const start = q.timestamp instanceof Date ? q.timestamp : new Date(q.timestamp);
        return ft >= start && ft < new Date(start.getTime() + 3600 * 1000);
      }) || this.cache.find(q => q.hour === ft.getHours());
      if (p) future.push({ ...p, hoursFromNow: i });
    }
    return future.sort((a, b) => a.price - b.price).slice(0, count);
  }

  getMostExpensiveHours(count = 3, lookAhead = 24) {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    const future = [];
    for (let i = 0; i < lookAhead; i++) {
      const ft = new Date(now.getTime() + i * 3600 * 1000);
      const p = this.cache.find(q => {
        const start = q.timestamp instanceof Date ? q.timestamp : new Date(q.timestamp);
        return ft >= start && ft < new Date(start.getTime() + 3600 * 1000);
      }) || this.cache.find(q => q.hour === ft.getHours());
      if (p) future.push({ ...p, hoursFromNow: i });
    }
    return future.sort((a, b) => b.price - a.price).slice(0, count);
  }

  _calculateStdDev(values, mean) {
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }

  invalidateCache() {
    this.cache = null;
    this.cache15min = null;
    this.cacheExpiry = null;
    this.log('Xadi price cache invalidated');
  }

  getTop3Cheapest() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    const future = this._getHourlyCache().filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return ts >= new Date(now.getTime() - 30 * 60 * 1000);
    });
    return [...future].sort((a, b) => a.price - b.price).slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  getTop3MostExpensive() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    const future = this._getHourlyCache().filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return ts >= new Date(now.getTime() - 30 * 60 * 1000);
    });
    return [...future].sort((a, b) => b.price - a.price).slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  _getHourlyCache() {
    const seen = new Set();
    return this.cache.filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const key = `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}-${ts.getHours()}`;
      const isOnHour = ts.getMinutes() === 0;
      if (isOnHour) { seen.add(key); return true; }
      if (!seen.has(key)) { seen.add(key); return true; }
      return false;
    });
  }

  hasPrices() {
    return this.cache && this.cache.length > 0;
  }

  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    return this.cache.map(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return { 
        hour: p.hour, 
        index: Math.floor((ts - now) / (1000 * 60 * 60)), 
        price: p.price, 
        timestamp: p.timestamp 
      };
    });
  }

  getCoverageInfo() {
    if (!this.cache || this.cache.length === 0) {
      return { hasPrices: false, totalHours: 0, firstHour: null, lastHour: null, hoursFromNow: { min: 0, max: 0 } };
    }
    const now = new Date();
    const timestamps = this.cache.map(p => p.timestamp);
    const first = new Date(Math.min(...timestamps));
    const last = new Date(Math.max(...timestamps));
    const hoursFromNow = this.cache.map(p => Math.floor((p.timestamp - now) / (1000 * 60 * 60)));
    return { hasPrices: true, totalHours: this.cache.length, firstHour: first.toISOString(), lastHour: last.toISOString(), hoursFromNow: { min: Math.min(...hoursFromNow), max: Math.max(...hoursFromNow) } };
  }
}

module.exports = XadiProvider;