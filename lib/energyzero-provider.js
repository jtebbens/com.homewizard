'use strict';

const fetch = require('node-fetch');

/**
 * EnergyZero Day-Ahead Prices Provider
 * 
 * FIX: VAT/markup order was wrong:
 *   WRONG:   (spot × 1.21) + markup  → misses VAT on markup (€0.023/kWh too low!)
 *   CORRECT: (spot + markup) × 1.21  → matches Xadi exactly
 *
 * This explains why EnergyZero "looked off" vs Xadi - it was consistently
 * €0.023/kWh lower (= markup × VAT = 0.11 × 0.21).
 */
class EnergyZeroProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);
    
    this.markup = options.markup || 0.11;
    this.log(`EnergyZero provider initialized with markup: €${this.markup}/kWh`);
    
    this._loadCache();
  }

  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('energyzero_cache');
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
      await this.homey.settings.set('energyzero_cache', {
        prices: this.cache,
        expiry: this.cacheExpiry,
        savedAt: Date.now()
      });
    } catch (error) {
      this.error('Failed to save price cache:', error.message);
    }
  }

  async fetchPrices() {
    if (this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached EnergyZero prices');
      return this.cache;
    }

    const now = new Date();
    
    const testDate = now.toLocaleString('en-US', { 
      timeZone: 'Europe/Amsterdam',
      timeZoneName: 'short'
    });
    const isDST = testDate.includes('CEST');
    const offsetHours = isDST ? 2 : 1;
    
    const cetDateStr = now.toLocaleString('en-CA', { 
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).split(',')[0];
    
    const [year, month, day] = cetDateStr.split('-').map(Number);
    
    const fromDateObj = new Date(Date.UTC(year, month - 1, day - 1, 24 - offsetHours, 0, 0));
    const tillDateObj = new Date(fromDateObj.getTime() + 48 * 60 * 60 * 1000);
    
    const fromDate = fromDateObj.toISOString().split('T')[0];
    const tillDate = tillDateObj.toISOString().split('T')[0];

    // inclBtw=false: API returns raw spot prices (despite the param name being confusing)
    // We apply VAT ourselves in the correct order: (spot + markup) × 1.21
    const url = `https://api.energyzero.nl/v1/energyprices?fromDate=${fromDate}T00:00:00.000Z&tillDate=${tillDate}T00:00:00.000Z&interval=4&usageType=1&inclBtw=false`;
    
    this.log(`Fetching EnergyZero prices for CET dates ${fromDate} to ${tillDate}`);

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`EnergyZero API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.Prices || !Array.isArray(data.Prices)) {
        throw new Error('Invalid response format from EnergyZero API');
      }

      this.cache = data.Prices.map((item, index) => {
        const timestamp = new Date(item.readingDate);
        const spot = item.price; // Raw spot price, ex VAT, ex markup

        // FIX: Correct order matches how energy suppliers actually charge:
        // VAT applies to the total (spot + markup), not just the spot price
        // This matches Xadi's formula exactly: (spot + markup) × 1.21
        const finalPrice = (spot + this.markup) * 1.21;

        if (index === 0) {
          this.log(`EZ price calc: (€${spot.toFixed(5)} spot + €${this.markup} markup) × 1.21 VAT = €${finalPrice.toFixed(5)}`);
        }
        
        const cetHour = parseInt(timestamp.toLocaleString('en-US', { 
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
          hour12: false
        }));
        
        return {
          timestamp,
          price: finalPrice,
          originalPrice: spot,
          hour: cetHour,
          readingDate: item.readingDate
        };
      }).sort((a, b) => a.timestamp - b.timestamp);

      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      await this._saveCache();

      this.log(`Fetched ${this.cache.length} hourly prices from EnergyZero`);
      
      if (this.cache.length > 0) {
        const first = this.cache[0];
        const last = this.cache[this.cache.length - 1];
        this.log(`Price range: ${first.timestamp.toISOString()} (${first.hour}:00 CET, €${first.price.toFixed(4)}) to ${last.timestamp.toISOString()} (${last.hour}:00 CET, €${last.price.toFixed(4)})`);
      }
      
      return this.cache;

    } catch (error) {
      this.error('Failed to fetch EnergyZero prices:', error);
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
    let currentPrice = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });

    if (!currentPrice) {
      const currentHourCET = parseInt(now.toLocaleString('en-US', { 
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        hour12: false
      }));
      currentPrice = this.cache.find(p => p.hour === currentHourCET);
    }

    if (!currentPrice) currentPrice = this.cache[0];

    const prices = this.cache.map(p => p.price);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const stdDev = this._calculateStdDev(prices, avgPrice);
    const price = currentPrice.price;

    if (price <= avgPrice - stdDev * 0.5) return 'low';
    if (price >= avgPrice + stdDev * 0.5) return 'peak';
    return 'standard';
  }

  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const nextHour = this.cache.find(p => {
      const timestamp = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return timestamp > now;
    });
    return nextHour ? nextHour.timestamp : null;
  }

  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const currentPrice = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });
    return currentPrice ? currentPrice.price : null;
  }

  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) return { avg: null, min: null, max: null, stdDev: null };
    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return {
      avg,
      min: Math.min(...prices),
      max: Math.max(...prices),
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

  _calculateStdDev(values, mean) {
    const squareDiffs = values.map(value => Math.pow(value - mean, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  hasPrices() {
    return this.cache && this.cache.length > 0;
  }

  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    return this.cache.map(p => ({
      hour: p.hour,
      index: Math.floor((p.timestamp - now) / (1000 * 60 * 60)),
      price: p.price,
      timestamp: p.timestamp
    }));
  }
}

module.exports = EnergyZeroProvider;