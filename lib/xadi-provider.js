'use strict';

const fetch = require('node-fetch');

/**
 * Xadi Day-Ahead Prices Provider (Improved)
 * Fetches both /today and /next24h to ensure complete coverage
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
   * Fetch prices from both /today and /next24h endpoints for complete coverage
   * NOTE: Xadi returns prices in CET (Central European Time), not UTC.
   * All timestamps from Xadi are in CET and stored as-is.
   * @param {boolean} force - Force refresh even if cache is valid
   */
  async fetchPrices(force = false) {
    const now = Date.now();
    const hour = new Date().getHours(); // LOCAL TIME (CET in production)
    
    // During price release window (15:00-16:00), force refresh if cache is older than 30min
    const shouldForceRefresh = force && (hour >= 15 && hour <= 16) && 
                               this.cache && (now - (this.cacheExpiry - 60 * 60 * 1000)) > 30 * 60 * 1000;
    
    if (this.cache && this.cacheExpiry > now && !shouldForceRefresh) {
      this.log('Using cached Xadi prices');
      return this.cache;
    }
    
    if (shouldForceRefresh) {
      this.log('Forcing price refresh during release window (15:00-16:00)');
    }

    const markup = 0.11;
    const vat = 0.21;
    const allPrices = [];
    const seenTimestamps = new Set();

    try {
      // 1. Fetch TODAY's prices (from midnight to midnight CET)
      const todayUrl = `https://dap.xadi.eu/api/nl/today?markup=${markup}&vat=${vat}`;
      this.log(`Fetching Xadi /today (CET): ${todayUrl}`);

      try {
        const todayResponse = await fetch(todayUrl);
        if (todayResponse.ok) {
          const todayData = await todayResponse.json();
          if (todayData.status === 'success' && todayData.data && todayData.data.length > 0) {
            const todayPrices = todayData.data.map(item => ({
              timestamp: new Date(item.time),
              price: item.price,
              priceMwh: item.priceMwh,
              hour: parseInt((item.hour || '0:00').split(':')[0], 10),
              originalPrice: item.markup.originalPrice
            }));
            
            todayPrices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) {
                allPrices.push(p);
                seenTimestamps.add(ts);
              }
            });
            
            this.log(`✅ Fetched ${todayPrices.length} prices from /today`);
          }
        }
      } catch (err) {
        this.log(`Failed to fetch /today: ${err.message}`);
      }

      // 2. Fetch NEXT24H (from current hour onwards, in CET)
      const next24hUrl = `https://dap.xadi.eu/api/nl/next24h?markup=${markup}&vat=${vat}`;
      this.log(`Fetching Xadi /next24h (CET): ${next24hUrl}`);

      try {
        const next24hResponse = await fetch(next24hUrl);
        if (next24hResponse.ok) {
          const next24hData = await next24hResponse.json();
          if (next24hData.status === 'success' && next24hData.data && next24hData.data.length > 0) {
            const next24hPrices = next24hData.data.map(item => ({
              timestamp: new Date(item.time),
              price: item.price,
              priceMwh: item.priceMwh,
              hour: parseInt((item.hour || '0:00').split(':')[0], 10),
              originalPrice: item.markup.originalPrice
            }));
            
            let newCount = 0;
            next24hPrices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) {
                allPrices.push(p);
                seenTimestamps.add(ts);
                newCount++;
              }
            });
            
            this.log(`✅ Fetched ${next24hPrices.length} prices from /next24h (${next24hPrices.length - newCount} overlapping with /today, ${newCount} new)`);
          }
        }
      } catch (err) {
        this.log(`Failed to fetch /next24h: ${err.message}`);
      }

      // 3. Try to fetch TOMORROW's full day (available after ~15:00)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD
      
      const dayAheadUrl = `https://dap.xadi.eu/api/nl/day/${tomorrowStr}?markup=${markup}&vat=${vat}`;
      this.log(`Attempting to fetch tomorrow's prices: ${dayAheadUrl}`);
      
      try {
        const tomorrowResponse = await fetch(dayAheadUrl);
        if (tomorrowResponse.ok) {
          const tomorrowData = await tomorrowResponse.json();
          if (tomorrowData.status === 'success' && tomorrowData.data && tomorrowData.data.length > 0) {
            const tomorrowPrices = tomorrowData.data.map(item => ({
              timestamp: new Date(item.time),
              price: item.price,
              priceMwh: item.priceMwh,
              hour: parseInt((item.hour || '0:00').split(':')[0], 10),
              originalPrice: item.markup.originalPrice
            }));
            
            let newTomorrowCount = 0;
            tomorrowPrices.forEach(p => {
              const ts = p.timestamp.getTime();
              if (!seenTimestamps.has(ts)) {
                allPrices.push(p);
                seenTimestamps.add(ts);
                newTomorrowCount++;
              }
            });
            
            this.log(`✅ Fetched ${tomorrowPrices.length} prices for tomorrow (${newTomorrowCount} new)`);
          }
        }
      } catch (err) {
        this.log(`Tomorrow's prices not yet available (expected after 15:00): ${err.message}`);
      }

      if (allPrices.length === 0) {
        throw new Error('No price data available from any endpoint');
      }

      // Sort by timestamp
      allPrices.sort((a, b) => a.timestamp - b.timestamp);

      // Log the time range we have
      const firstTime = allPrices[0].timestamp;
      const lastTime = allPrices[allPrices.length - 1].timestamp;
      this.log(`📊 Total ${allPrices.length} hourly prices from ${firstTime.toISOString()} to ${lastTime.toISOString()}`);

      this.cache = allPrices;
      this.cacheExpiry = Date.now() + 60 * 60 * 1000; // Cache for 1 hour
      
      // Save to persistent storage
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
    const now = new Date();
    // FIX: Only future (or current) hours. Past cheap hours can never be "now"
    // so they just waste top-3 slots and hide future cheap opportunities.
    const future = this._getHourlyCache().filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return ts >= new Date(now.getTime() - 30 * 60 * 1000); // allow 30min lookback for current hour
    });
    return [...future]
      .sort((a, b) => a.price - b.price)
      .slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  getTop3MostExpensive() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    // FIX: Only future (or current) hours. Past expensive hours can never be "now"
    // and block tomorrow's peak hours from appearing in top-3.
    const future = this._getHourlyCache().filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return ts >= new Date(now.getTime() - 30 * 60 * 1000); // allow 30min lookback for current hour
    });
    return [...future]
      .sort((a, b) => b.price - a.price)
      .slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  // Deduplicated hourly view of cache (handles 15-min /next24h slots)
  // NOTE: Uses local time (CET) since Xadi prices are in CET, not UTC
  _getHourlyCache() {
    const seen = new Set();
    return this.cache.filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      // Key by local hour (CET), not UTC
      const key = `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}-${ts.getHours()}`;
      const isOnHour = ts.getMinutes() === 0;
      if (isOnHour) { seen.add(key); return true; }
      if (!seen.has(key)) { seen.add(key); return true; }
      return false;
    });
  }

  /**
   * Check if price data is currently available
   */
  hasPrices() {
    return this.cache && this.cache.length > 0;
  }

  /**
   * Get all available hourly prices for planning view
   * Returns array with index field for settings page compatibility
   * NOTE: Xadi prices are in CET. Uses local time (CET) for deduplication.
   */
  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    
    const now = new Date();
    
    // /next24h returns 15-min slots. Deduplicate to one entry per clock-hour
    // (keep the on-the-hour entry, or the first slot of each hour if missing).
    const seen = new Set();
    const hourly = this.cache.filter(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      // Key by local hour bucket (year-month-day-hour in CET, not UTC)
      const key = `${ts.getFullYear()}-${ts.getMonth()}-${ts.getDate()}-${ts.getHours()}`;
      // Prefer on-the-hour entries; keep first seen if no exact match
      const isOnHour = ts.getMinutes() === 0;
      if (isOnHour) {
        seen.add(key); // mark hour as covered by an exact entry
        return true;
      }
      if (!seen.has(key)) {
        seen.add(key); // first 15-min slot of this hour
        return true;
      }
      return false; // subsequent 15-min slots of a covered hour
    });
    
    return hourly.map(p => {
      const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const hoursAhead = Math.floor((ts - now) / (1000 * 60 * 60));
      return {
        hour: p.hour,       // Hour of day (0-23)
        index: hoursAhead,  // Hours from now (negative = past)
        price: p.price,
        timestamp: p.timestamp
      };
    });
  }

  /**
   * Get coverage info for debugging
   */
  getCoverageInfo() {
    if (!this.cache || this.cache.length === 0) {
      return {
        hasPrices: false,
        totalHours: 0,
        firstHour: null,
        lastHour: null,
        hoursFromNow: { min: 0, max: 0 }
      };
    }

    const now = new Date();
    const timestamps = this.cache.map(p => p.timestamp);
    const first = new Date(Math.min(...timestamps));
    const last = new Date(Math.max(...timestamps));
    
    const hoursFromNow = this.cache.map(p => 
      Math.floor((p.timestamp - now) / (1000 * 60 * 60))
    );
    
    return {
      hasPrices: true,
      totalHours: this.cache.length,
      firstHour: first.toISOString(),
      lastHour: last.toISOString(),
      hoursFromNow: {
        min: Math.min(...hoursFromNow),
        max: Math.max(...hoursFromNow)
      }
    };
  }
}

module.exports = XadiProvider;