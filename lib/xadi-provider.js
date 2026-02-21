'use strict';

const fetch = require('node-fetch');

/**
 * Xadi Day-Ahead Prices Provider
 * Fetches both /today and /next24h to ensure complete coverage.
 *
 * Markup is applied CLIENT-SIDE (not via the Xadi API parameters) so the
 * formula is identical to KwhPriceProvider: (spot + markup) × 1.21
 * This ensures prices from both sources are directly comparable.
 */
class XadiProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.markup = options.markup !== undefined ? options.markup : 0.11;
    this.cache = null;
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
        this.cacheExpiry = cached.expiry;
        this.log(`Loaded ${this.cache.length} cached prices from storage (expires in ${Math.round((this.cacheExpiry - Date.now()) / 60000)}min)`);
      }
    } catch (error) {
      this.log('Failed to load cached prices:', error.message);
    }
  }

  async _saveCache() {
    try {
      await this.homey.settings.set('xadi_cache', {
        prices: this.cache,
        expiry: this.cacheExpiry,
        savedAt: Date.now()
      });
    } catch (error) {
      this.error('Failed to save price cache:', error.message);
    }
  }

  /**
   * Map a single Xadi API item to a price object.
   * Markup applied client-side: (spot + markup) × 1.21
   * Identical formula to KwhPriceProvider.
   * @private
   */
  _mapItem(item) {
    const spot = item.markup.originalPrice; // raw ENTSO-E spot €/kWh
    const price = (spot + this.markup) * 1.21;
    return {
      timestamp: new Date(item.time),
      price,
      priceMwh: item.priceMwh,
      hour: parseInt((item.hour || '0:00').split(':')[0], 10),
      originalPrice: spot
    };
  }

  /**
   * Fetch prices from /today, /next24h and /day/tomorrow.
   * API called with markup=0&vat=0 to receive raw spot prices.
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

    // Always fetch raw spot — markup applied client-side
    const baseParams = 'markup=0&vat=0';
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
            this.log(`✅ Fetched ${prices.length} prices from /today`);
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
            this.log(`✅ Fetched ${prices.length} prices from /next24h (${prices.length - newCount} overlapping with /today, ${newCount} new)`);
          }
        }
      } catch (err) { this.log(`Failed to fetch /next24h: ${err.message}`); }

      // 3. /day/tomorrow (available after ~13:15 CET)
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
            this.log(`✅ Fetched ${prices.length} prices for tomorrow (${newCount} new)`);
          }
        }
      } catch (err) { this.log(`Tomorrow's prices not yet available (expected after ~13:15 CET): ${err.message}`); }

      if (allPrices.length === 0) throw new Error('No price data available from any endpoint');

      allPrices.sort((a, b) => a.timestamp - b.timestamp);

      const firstTime = allPrices[0].timestamp;
      const lastTime = allPrices[allPrices.length - 1].timestamp;
      this.log(`📊 Total ${allPrices.length} hourly prices from ${firstTime.toISOString()} to ${lastTime.toISOString()}`);

      // Log sample so formula is visible in logs
      const sample = allPrices.find(p => p.originalPrice > 0) || allPrices[0];
      this.log(`Price calc sample: (€${sample.originalPrice.toFixed(5)} spot + €${this.markup} markup) × 1.21 = €${sample.price.toFixed(5)}`);

      this.cache = allPrices;
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
    const seen = new Set();
    const hourly = this.cache.filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const key = `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}-${ts.getHours()}`;
      const isOnHour = ts.getMinutes() === 0;
      if (isOnHour) { seen.add(key); return true; }
      if (!seen.has(key)) { seen.add(key); return true; }
      return false;
    });
    return hourly.map(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return { hour: p.hour, index: Math.floor((ts - now) / (1000 * 60 * 60)), price: p.price, timestamp: p.timestamp };
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