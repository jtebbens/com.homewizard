'use strict';

const fetch = require('node-fetch');

/**
 * EnergyZero Day-Ahead Prices Provider
 * Fetches Dutch dynamic electricity prices from EnergyZero public API
 * https://external.docs.api.staging.energyzero.nl/
 * 
 * TIMEZONE HANDLING:
 * - EnergyZero API returns prices for CET/CEST hours (Dutch local time)
 * - API timestamps are in UTC format (e.g., "2024-02-14T21:00:00Z")
 * - We convert all hours to Europe/Amsterdam timezone for consistency
 * - This ensures prices align with Dutch market hours regardless of server timezone
 */
class EnergyZeroProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);
    
    // Markup to add to prices (in EUR per kWh)
    // This is applied AFTER VAT, matching energy supplier behavior
    this.markup = options.markup || 0.11;  // Default €0.11/kWh markup
    this.log(`EnergyZero provider initialized with markup: €${this.markup}/kWh`);
    
    // Load cached prices from persistent storage
    this._loadCache();
  }

  /**
   * Load cached prices from Homey settings
   * @private
   */
  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('energyzero_cache');
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
      await this.homey.settings.set('energyzero_cache', {
        prices: this.cache,
        expiry: this.cacheExpiry,
        savedAt: Date.now()
      });
    } catch (error) {
      this.error('Failed to save price cache:', error.message);
    }
  }

  /**
   * Fetch next 24-48 hours of prices from EnergyZero
   */
  async fetchPrices() {
    if (this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached EnergyZero prices');
      return this.cache;
    }

    // EnergyZero API quirk: it interprets dates as UTC, but returns prices for CET/CEST hours
    // To get midnight CET, we need to request the previous day in UTC during winter (CET = UTC+1)
    // or 2 days back during summer (CEST = UTC+2)
    const now = new Date();
    
    // Determine if we're in CET (UTC+1) or CEST (UTC+2)
    const testDate = now.toLocaleString('en-US', { 
      timeZone: 'Europe/Amsterdam',
      timeZoneName: 'short'
    });
    const isDST = testDate.includes('CEST');
    const offsetHours = isDST ? 2 : 1;
    
    // Get current date in Amsterdam
    const cetDateStr = now.toLocaleString('en-CA', { 
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).split(',')[0];
    
    const [year, month, day] = cetDateStr.split('-').map(Number);
    
    // Subtract offset hours to get UTC date that will return midnight CET prices
    const fromDateObj = new Date(Date.UTC(year, month - 1, day - 1, 24 - offsetHours, 0, 0));
    const tillDateObj = new Date(fromDateObj.getTime() + 48 * 60 * 60 * 1000);
    
    const fromDate = fromDateObj.toISOString().split('T')[0];
    const tillDate = tillDateObj.toISOString().split('T')[0];

    // EnergyZero API endpoint for electricity prices
    // Interval: 4 (DAY_AHEAD - dynamic hourly prices)
    // usageType: 1 (electricity usage)
    // inclBtw: true (include VAT)
    // Dates are in YYYY-MM-DD format for Dutch local dates
    const url = `https://api.energyzero.nl/v1/energyprices?fromDate=${fromDate}T00:00:00.000Z&tillDate=${tillDate}T00:00:00.000Z&interval=4&usageType=1&inclBtw=true`;
    
    this.log(`Fetching EnergyZero prices for CET dates ${fromDate} to ${tillDate}`);

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`EnergyZero API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.Prices || !Array.isArray(data.Prices)) {
        throw new Error('Invalid response format from EnergyZero API');
      }

      // Transform EnergyZero format to our internal format
      // EnergyZero returns timestamps in UTC, but they represent CET/CEST hours
      // NOTE: Despite inclBtw=true, the API appears to return prices WITHOUT VAT
      this.cache = data.Prices.map((item, index) => {
        const timestamp = new Date(item.readingDate);
        const basePrice = item.price; // Price from API (appears to be without VAT)
        const priceWithVAT = basePrice * 1.21; // Apply 21% VAT
        const priceWithMarkup = priceWithVAT + this.markup; // Add supplier markup
        
        // Get the hour in CET/CEST timezone (Amsterdam)
        const cetHour = parseInt(timestamp.toLocaleString('en-US', { 
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
          hour12: false
        }));
        
        // Log first price for debugging
        if (index === 0) {
          this.log(`API raw price: €${item.price.toFixed(5)} → +21% VAT: €${priceWithVAT.toFixed(5)} → +markup: €${priceWithMarkup.toFixed(5)}`);
        }
        
        return {
          timestamp: timestamp,
          price: priceWithMarkup, // Final price: base + VAT + markup
          priceWithoutMarkup: priceWithVAT, // Price with only VAT
          originalPrice: basePrice, // Original API price (without VAT or markup)
          hour: cetHour, // Hour in CET/CEST timezone
          readingDate: item.readingDate
        };
      }).sort((a, b) => a.timestamp - b.timestamp);

      // Cache for 1 hour
      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      
      // Save to persistent storage
      await this._saveCache();

      this.log(`Fetched ${this.cache.length} hourly prices from EnergyZero`);
      
      // Log first, last, and current hour price with timezone info for verification
      if (this.cache.length > 0) {
        const first = this.cache[0];
        const last = this.cache[this.cache.length - 1];
        this.log(`Price range: ${first.timestamp.toISOString()} (${first.hour}:00 CET, €${first.price.toFixed(4)}) to ${last.timestamp.toISOString()} (${last.hour}:00 CET, €${last.price.toFixed(4)})`);
        
        // Log current hour price
        const now = new Date();
        const currentHourCET = parseInt(now.toLocaleString('en-US', { 
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
          hour12: false
        }));
        const currentPrice = this.cache.find(p => p.hour === currentHourCET);
        if (currentPrice) {
          this.log(`Current hour (${currentHourCET}:00 CET): €${currentPrice.price.toFixed(5)} = €${currentPrice.originalPrice.toFixed(5)} (API) × 1.21 (VAT) + €${this.markup.toFixed(5)} (markup)`);
          this.log(`Current price timestamp: ${currentPrice.timestamp.toISOString()}`);
          
          // Find today's actual 22:00 price (not yesterday's)
          const todayPrices = this.cache.filter(p => {
            const priceDate = p.timestamp.toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).split(',')[0];
            const currentDate = now.toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).split(',')[0];
            return priceDate === currentDate;
          });
          this.log(`Found ${todayPrices.length} prices for today (${now.toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).split(',')[0]})`);
          
          const todayCurrentHour = todayPrices.find(p => p.hour === currentHourCET);
          if (todayCurrentHour && todayCurrentHour.timestamp.getTime() !== currentPrice.timestamp.getTime()) {
            this.log(`⚠️ WARNING: Using yesterday's price! Today's ${currentHourCET}:00 CET price: €${todayCurrentHour.price.toFixed(5)} (${todayCurrentHour.timestamp.toISOString()})`);
          }
        }
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

  /**
   * Get current electricity rate classification
   */
  getCurrentRate() {
    if (!this.cache || this.cache.length === 0) return 'standard';

    const now = new Date();
    
    // Find price for current hour (timestamps are in UTC, comparisons work correctly)
    let currentPrice = this.cache.find(p => {
      if (!p.timestamp) return false;
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });

    // Fallback: find by hour in CET/CEST timezone
    if (!currentPrice) {
      const currentHourCET = parseInt(now.toLocaleString('en-US', { 
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        hour12: false
      }));
      currentPrice = this.cache.find(p => p.hour === currentHourCET);
    }

    if (!currentPrice) {
      this.log('getCurrentRate: no exact match for current time, using first entry');
      currentPrice = this.cache[0];
    }

    // Calculate statistics
    const prices = this.cache.map(p => p.price);
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const stdDev = this._calculateStdDev(prices, avgPrice);

    const price = currentPrice.price;

    // Classify rate based on price relative to average
    if (price <= avgPrice - stdDev * 0.5) return 'low';
    if (price >= avgPrice + stdDev * 0.5) return 'peak';
    return 'standard';
  }

  /**
   * Get next rate change time
   */
  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;

    const now = new Date();
    const nextHour = this.cache.find(p => {
      const timestamp = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return timestamp > now;
    });

    return nextHour ? nextHour.timestamp : null;
  }

  /**
   * Get current price per kWh (including VAT + markup)
   */
  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;

    const now = new Date();
    const currentPrice = this.cache.find(p => {
      if (!p.timestamp) return false;
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      const isMatch = now >= start && now < end;
      return isMatch;
    });

    if (currentPrice) {
      this.log(`getCurrentPrice: Found €${currentPrice.price.toFixed(5)} for ${currentPrice.timestamp.toISOString()} (hour ${currentPrice.hour}:00 CET)`);
    } else {
      this.log(`getCurrentPrice: No price found for current time ${now.toISOString()}`);
    }

    return currentPrice ? currentPrice.price : null;
  }

  /**
   * Get price statistics for the cached period
   */
  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) {
      return { avg: null, min: null, max: null, stdDev: null };
    }

    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const stdDev = this._calculateStdDev(prices, avg);

    return { avg, min, max, stdDev };
  }

  /**
   * Get top 3 cheapest hours
   */
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

  /**
   * Get top 3 most expensive hours
   */
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
   * Calculate standard deviation
   */
  _calculateStdDev(values, mean) {
    const squareDiffs = values.map(value => Math.pow(value - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Check if price data is currently available
   */
  hasPrices() {
    return this.cache && this.cache.length > 0;
  }

  /**
   * Get all available hourly prices for planning view
   */
  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    
    const now = new Date();
    
    return this.cache.map(p => {
      // Calculate hours from now based on actual timestamp
      const hoursAhead = Math.floor((p.timestamp - now) / (1000 * 60 * 60));
      
      return {
        hour: p.hour,           // Hour of day (0-23)
        index: hoursAhead,      // Hours from now (can be negative for past hours)
        price: p.price,
        timestamp: p.timestamp
      };
    });
  }
}

module.exports = EnergyZeroProvider;
