'use strict';

const fetch = require('node-fetch');

/**
 * Xadi Day-Ahead Prices Provider (next24h version)
 * Always returns a full 24-hour price window
 */
class XadiProvider {
  constructor(homey) {
    this.homey = homey;
    this.cache = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);
    
    // Load cached prices from persistent storage
    this._loadCache();
  }

  /**
   * Load cached prices from Homey settings
   * @private
   */
  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('xadi_cache');
      if (cached && cached.expiry > Date.now()) {
        this.cache = cached.prices.map(p => ({
          ...p,
          timestamp: new Date(p.timestamp) // Restore Date objects
        }));
        this.cacheExpiry = cached.expiry;
        this.log(`Loaded ${this.cache.length} cached prices from storage (expires in ${Math.round((this.cacheExpiry - Date.now()) / 60000)}min)`);
      }
    } catch (error) {
      this.log('Failed to load cached prices:', error.message);
    }
  }

  /**
   * Save cached prices to Homey settings
   * @private
   */
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
   * Fetch next 24 hours of prices
   */
  async fetchPrices() {
    if (this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached Xadi prices');
      return this.cache;
    }

    const url = `https://dap.xadi.eu/api/nl/next24h?markup=0.11&vat=0.21`;
    this.log(`Fetching Xadi next24h: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Xadi API error: ${response.status}`);

      const data = await response.json();
      if (data.status !== 'success') {
        throw new Error(`Xadi API returned status: ${data.status}`);
      }

      this.cache = data.data.map(item => ({
        timestamp: new Date(item.time),   // UTC timestamp from Xadi
        price: item.price,
        priceMwh: item.priceMwh,
        hour: parseInt(item.localTime.split(',')[1], 10),
        originalPrice: item.markup.originalPrice
      }));

      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      
      // Save to persistent storage
      await this._saveCache();

      this.log(`Fetched ${this.cache.length} hourly prices from Xadi (next24h)`);
      return this.cache;

    } catch (error) {
      this.error('Failed to fetch Xadi next24h prices:', error);
      if (this.cache) {
        this.log('Returning stale cache due to fetch error');
        return this.cache;
      }
      throw error;
    }
  }

  /**
   * Get current electricity rate
   */
  getCurrentRate() {
    if (!this.cache || this.cache.length === 0) return 'standard';

    const now = new Date();
    // Prefer matching by the provided timestamp window (more robust),
    // falling back to an hour-based match when necessary.
    let currentPrice = this.cache.find(p => {
      if (!p.timestamp) return false;
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });

    if (!currentPrice) {
      const currentHour = now.getHours();   // LOCAL TIME
      currentPrice = this.cache.find(p => p.hour === currentHour);
    }

    if (!currentPrice) {
      const first = this.cache[0];
      const firstHour = first && first.hour !== undefined ? first.hour : 'unknown';
      this.log(
        `getCurrentRate: no exact match for current time, using first entry (${firstHour})`
      );
      currentPrice = first;
    }

    const prices = this.cache.map(p => p.price);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const stdDev = this._calculateStdDev(prices, avgPrice);

    const price = currentPrice.price;

    this.log(
      `Current price: €${price.toFixed(4)}/kWh | Avg: €${avgPrice.toFixed(4)} | StdDev: ${stdDev.toFixed(4)}`
    );

    if (price < avgPrice - stdDev || price < minPrice + (maxPrice - minPrice) * 0.15)
      return 'super-off-peak';

    if (price < avgPrice - stdDev * 0.3)
      return 'off-peak';

    if (price > avgPrice + stdDev * 0.5 || price > maxPrice - (maxPrice - minPrice) * 0.20)
      return 'peak';

    return 'standard';
  }

  /**
   * Get current price
   */
  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;

    const now = new Date();

    let currentPrice = this.cache.find(p => {
      if (!p.timestamp) return false;
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });

    if (!currentPrice) {
      // fallback to hour equality
      const currentHour = now.getHours();
      currentPrice = this.cache.find(p => p.hour === currentHour);
    }

    if (!currentPrice) {
      const first = this.cache[0];
      this.log(
        `getCurrentPrice: no exact match for current time, using first entry (${first.hour})`
      );
      currentPrice = first;
    }

    return currentPrice.price;
  }

  /**
   * Next rate change
   */
  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;

    const now = new Date();
    const currentRate = this.getCurrentRate();

    for (let i = 1; i < 24; i++) {
      const futureTime = new Date(now.getTime() + i * 3600 * 1000);
      const futureHour = futureTime.getHours();   // LOCAL TIME

      const futurePrice = this.cache.find(p => p.hour === futureHour);
      if (!futurePrice) continue;

      const futureRate = this._categorizeSinglePrice(futurePrice.price);

      if (futureRate !== currentRate) {
        return {
          rate: futureRate,
          startsIn: i * 60,
          price: futurePrice.price,
          hour: futurePrice.hour
        };
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
    const std = this._calculateStdDev(prices, avg);

    return {
      average: avg,
      min,
      max,
      stdDev: std,
      range: max - min,
      current: this.getCurrentPrice(),
      totalHours: prices.length
    };
  }

  getCheapestHours(count = 3, lookAhead = 24) {
    if (!this.cache || this.cache.length === 0) return [];

    const now = new Date();
    const futureHours = [];

    for (let i = 0; i < lookAhead; i++) {
      const futureTime = new Date(now.getTime() + i * 3600 * 1000);
      // Prefer matching by timestamp window
      const priceData = this.cache.find(p => {
        if (!p.timestamp) return false;
        const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
        const end = new Date(start.getTime() + 3600 * 1000);
        return futureTime >= start && futureTime < end;
      }) || this.cache.find(p => p.hour === futureTime.getHours());
      if (priceData) {
        futureHours.push({ ...priceData, hoursFromNow: i });
      }
    }

    return futureHours.sort((a, b) => a.price - b.price).slice(0, count);
  }

  getMostExpensiveHours(count = 3, lookAhead = 24) {
    if (!this.cache || this.cache.length === 0) return [];

    const now = new Date();
    const futureHours = [];

    for (let i = 0; i < lookAhead; i++) {
      const futureTime = new Date(now.getTime() + i * 3600 * 1000);
      const priceData = this.cache.find(p => {
        if (!p.timestamp) return false;
        const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
        const end = new Date(start.getTime() + 3600 * 1000);
        return futureTime >= start && futureTime < end;
      }) || this.cache.find(p => p.hour === futureTime.getHours());
      if (priceData) {
        futureHours.push({ ...priceData, hoursFromNow: i });
      }
    }

    return futureHours.sort((a, b) => b.price - a.price).slice(0, count);
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
    return [...this.cache]
      .sort((a, b) => a.price - b.price)
      .slice(0, 3)
      .map(p => ({
        hour: p.hour,
        price: p.price,
        timestamp: p.timestamp
      }));
  }

  getTop3MostExpensive() {
    if (!this.cache || this.cache.length === 0) return [];
    return [...this.cache]
      .sort((a, b) => b.price - a.price)
      .slice(0, 3)
      .map(p => ({
        hour: p.hour,
        price: p.price,
        timestamp: p.timestamp
      }));
  }

  /**
   * Check if price data is currently available
   */
  hasPrices() {
    return this.cache && this.cache.length > 0;
  }
}

module.exports = XadiProvider;
