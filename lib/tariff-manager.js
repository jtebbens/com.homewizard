'use strict';

const XadiProvider = require('./xadi-provider');
const EnergyZeroProvider = require('./energyzero-provider');

/**
 * TariffManager with dynamic pricing support
 * 
 * FIXES:
 * 1. [CRITICAL] top3Lowest/top3Highest now expose .price field correctly
 *    PolicyEngine was comparing object to number (always false!)
 * 2. [HIGH] Added next24Hours field to tariff (PolicyEngine reads this, not allPrices)
 * 3. [HIGH] allPrices now saved to homey settings for planning view
 * 4. [MEDIUM] updateDynamicPrices() now re-runs provider selection
 */
class TariffManager {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = homey.log.bind(homey);
    
    this.dynamicProvider = null;
    this._initializeDynamicProvider();
  }

  _initializeDynamicProvider() {
    if (!this.settings.enable_dynamic_pricing) {
      return;
    }

    const markup = this.settings.dynamic_price_markup || 0.11;
    
    this.xadiProvider = new XadiProvider(this.homey);
    this.energyzeroProvider = new EnergyZeroProvider(this.homey, { markup });
    
    this.dynamicProvider = this.xadiProvider;
    this.activeProvider = 'xadi';
    
    this.log('Dynamic pricing enabled with Xadi (primary) and EnergyZero (fallback)');
    
    this._selectBestProvider();
  }

  async _selectBestProvider() {
    this.log('🔍 Selecting best price provider...');
    
    try {
      await this.xadiProvider.fetchPrices();
      const xadiPriceCount = this.xadiProvider.cache?.length || 0;
      
      // Xadi preferred over EnergyZero because:
      // 1. Applies markup+VAT server-side (correct consumer prices)
      // 2. Includes 00:00 local hour - EnergyZero only returns 23h (misses 23:00 UTC prev day)
      // 3. Same underlying ENTSO-E source - prices are identical when markup applied
      // Threshold: 23 (today gives 24h but may occasionally return fewer)
      if (xadiPriceCount >= 23) {
        this.dynamicProvider = this.xadiProvider;
        this.activeProvider = 'xadi';
        this.log(`✅ Using Xadi provider (${xadiPriceCount} prices available)`);
        return;
      }
      
      this.log(`⚠️ Xadi has only ${xadiPriceCount} prices (need 23+), trying EnergyZero fallback...`);
    } catch (error) {
      this.log('⚠️ Xadi fetch failed, trying EnergyZero fallback:', error.message);
    }
    
    // Fallback to EnergyZero
    // Note: only 23 hours (misses 00:00 local), EnergyZeroProvider must apply markup+VAT
    try {
      await this.energyzeroProvider.fetchPrices();
      const ezPriceCount = this.energyzeroProvider.cache?.length || 0;
      
      if (ezPriceCount > 0) {
        this.dynamicProvider = this.energyzeroProvider;
        this.activeProvider = 'energyzero';
        this.log(`✅ Using EnergyZero provider (${ezPriceCount} prices, fallback active)`);
        this.log('⚠️ Note: EnergyZero missing 00:00 local hour vs Xadi');
        return;
      }
      
      this.log('⚠️ EnergyZero returned no prices');
    } catch (error) {
      this.log('❌ EnergyZero fetch also failed:', error.message);
    }
    
    // Both failed - use Xadi stale cache if available
    if (this.xadiProvider.cache?.length > 0) {
      this.dynamicProvider = this.xadiProvider;
      this.activeProvider = 'xadi';
      this.log(`⚠️ Using Xadi with limited data (${this.xadiProvider.cache.length} prices)`);
      return;
    }
    
    this.log('❌ No price provider available - both Xadi and EnergyZero failed');
    this.dynamicProvider = null;
    this.activeProvider = null;
  }

  getCurrentTariff(gridPower = 0) {
    const now = new Date();
    
    if (this.settings.enable_dynamic_pricing && this.dynamicProvider) {
      try {
        return this._getDynamicTariff(gridPower, now);
      } catch (error) {
        this.log('Dynamic tariff fetch failed, falling back to manual:', error.message);
        return this._getManualTariff(gridPower, now);
      }
    }
    
    return this._getManualTariff(gridPower, now);
  }

  /**
   * Get dynamic tariff from provider
   * @private
   * 
   * FIX 1: top3Lowest/top3Highest now correctly expose {hour, price, timestamp}
   *         PolicyEngine must use p.price not p when comparing (see PolicyEngine fix)
   * 
   * FIX 2: Added next24Hours field - PolicyEngine._applyDayAheadStrategy() reads this
   * 
   * FIX 3: Saves allPrices to homey settings for planning view
   */
  _getDynamicTariff(gridPower, now) {
    const currentRate = this.dynamicProvider.getCurrentRate();
    const nextChange = this.dynamicProvider.getNextRateChange();
    const currentPrice = this.dynamicProvider.getCurrentPrice();
    const stats = this.dynamicProvider.getPriceStatistics();

    // FIX 1: These return objects {hour, price, timestamp}
    // PolicyEngine MUST use p.price when comparing, not p directly!
    const top3Lowest = this.dynamicProvider.getTop3Cheapest();    // [{hour, price, timestamp}]
    const top3Highest = this.dynamicProvider.getTop3MostExpensive(); // [{hour, price, timestamp}]

    // Get all hourly prices
    const allPrices = this.dynamicProvider.getAllHourlyPrices();

    // FIX 2: Build next24Hours array for PolicyEngine._applyDayAheadStrategy()
    // This is what PolicyEngine reads - was missing before!
    const next24Hours = allPrices
      .filter(p => p.index >= 0 && p.index < 24) // Only future hours
      .sort((a, b) => a.index - b.index)
      .map(p => ({
        hour: p.hour,
        index: p.index,
        price: p.price,
        timestamp: p.timestamp
      }));

    // FIX 3: Save to homey settings for planning view
    // Use try/catch in async wrapper instead of .catch() - settings.set may not return a Promise
    (async () => {
      try {
        await this.homey.settings.set('policy_all_prices', allPrices);
      } catch (err) {
        this.log('Failed to save policy_all_prices to settings:', err.message);
      }
    })();

    return {
      currentRate,
      nextRateChange: nextChange,
      gridPower,
      isImporting: gridPower > 0,
      isExporting: gridPower < 0,
      currentPrice,
      priceWithoutMarkup: currentPrice, // backwards compat
      statistics: stats,
      top3Lowest,   // [{hour, price, timestamp}] - use p.price in PolicyEngine!
      top3Highest,  // [{hour, price, timestamp}] - use p.price in PolicyEngine!
      allPrices,    // all hours with index field
      next24Hours,  // FIX 2: future hours sorted by index, for PolicyEngine
      timestamp: now,
      source: this.activeProvider || 'unknown'
    };
  }

  _getManualTariff(gridPower, now) {
    const currentRate = this._getCurrentRate(now);
    const nextChange = this._getNextRateChange(now);
    
    return {
      currentRate,
      nextRateChange: nextChange,
      gridPower,
      isImporting: gridPower > 0,
      isExporting: gridPower < 0,
      currentPrice: null,
      timestamp: now,
      source: 'manual'
    };
  }

  _getCurrentRate(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    
    if (tariffType === 'fixed') return 'standard';
    if (tariffType === 'time_of_use') return this._getTimeOfUseRate(now);
    return 'standard';
  }

  _getTimeOfUseRate(now) {
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentMinutes = hour * 60 + minute;
    
    const peakPeriods = this._parseTimePeriods(this.settings.peak_hours || '17:00-21:00');
    const offPeakPeriods = this._parseTimePeriods(this.settings.off_peak_hours || '23:00-07:00');
    const superOffPeakPeriods = this._parseTimePeriods(this.settings.super_off_peak_hours || '');
    
    if (this._isInPeriod(currentMinutes, superOffPeakPeriods)) return 'super-off-peak';
    if (this._isInPeriod(currentMinutes, offPeakPeriods)) return 'off-peak';
    if (this._isInPeriod(currentMinutes, peakPeriods)) return 'peak';
    return 'standard';
  }

  _parseTimePeriods(periodsString) {
    if (!periodsString) return [];
    
    return periodsString.split(',')
      .map(part => {
        const [start, end] = part.trim().split('-');
        if (start && end) {
          return {
            start: this._timeToMinutes(start.trim()),
            end: this._timeToMinutes(end.trim())
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  _timeToMinutes(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + minutes;
  }

  _isInPeriod(currentMinutes, periods) {
    return periods.some(period => {
      if (period.end < period.start) {
        // Overnight period (e.g., 23:00-07:00)
        return currentMinutes >= period.start || currentMinutes <= period.end;
      }
      return currentMinutes >= period.start && currentMinutes <= period.end;
    });
  }

  _getNextRateChange(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    if (tariffType === 'fixed') return null;
    
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentMinutes = hour * 60 + minute;
    const boundaries = this._getAllBoundaries();
    
    for (const boundary of boundaries) {
      const minutesUntil = boundary.minutes > currentMinutes
        ? boundary.minutes - currentMinutes
        : (1440 - currentMinutes) + boundary.minutes;
      
      if (minutesUntil > 0) {
        return { rate: boundary.rate, startsIn: minutesUntil };
      }
    }
    
    return null;
  }

  _getAllBoundaries() {
    const boundaries = [];
    
    const addBoundaries = (periodsString, rate) => {
      this._parseTimePeriods(periodsString).forEach(period => {
        boundaries.push({ minutes: period.start, rate });
        boundaries.push({ minutes: period.end, rate: 'standard' });
      });
    };
    
    addBoundaries(this.settings.peak_hours || '', 'peak');
    addBoundaries(this.settings.off_peak_hours || '', 'off-peak');
    addBoundaries(this.settings.super_off_peak_hours || '', 'super-off-peak');
    
    return boundaries.sort((a, b) => a.minutes - b.minutes);
  }

  getTariffMultiplier(rate) {
    return { 'super-off-peak': 0.5, 'off-peak': 0.7, 'standard': 1.0, 'peak': 1.5 }[rate] || 1.0;
  }

  updateSettings(newSettings) {
    const dynamicChanged = newSettings.enable_dynamic_pricing !== this.settings.enable_dynamic_pricing;
    this.settings = { ...this.settings, ...newSettings };
    
    if (dynamicChanged) {
      if (newSettings.enable_dynamic_pricing) {
        this._initializeDynamicProvider();
      } else {
        this.dynamicProvider = null;
        this.log('Dynamic pricing disabled');
      }
    }
    
    this.log('Tariff settings updated');
  }

  /**
   * FIX 4: Re-run provider selection instead of just fetching from current provider
   * This allows switching from EnergyZero back to Xadi when it recovers
   */
  async updateDynamicPrices() {
    if (!this.settings.enable_dynamic_pricing) return false;
    
    try {
      await this._selectBestProvider();
      this.log('Dynamic prices updated successfully');
      return true;
    } catch (error) {
      this.log('Failed to update dynamic prices:', error.message);
      return false;
    }
  }

  getCheapestHours(count = 3, lookAhead = 24) {
    if (!this.dynamicProvider) return [];
    try {
      return this.dynamicProvider.getCheapestHours(count, lookAhead);
    } catch (error) {
      this.log('Failed to get cheapest hours:', error.message);
      return [];
    }
  }

  getMostExpensiveHours(count = 3, lookAhead = 24) {
    if (!this.dynamicProvider) return [];
    try {
      return this.dynamicProvider.getMostExpensiveHours(count, lookAhead);
    } catch (error) {
      this.log('Failed to get most expensive hours:', error.message);
      return [];
    }
  }

  getPriceStatistics() {
    if (!this.dynamicProvider) return null;
    try {
      return this.dynamicProvider.getPriceStatistics();
    } catch (error) {
      this.log('Failed to get price statistics:', error.message);
      return null;
    }
  }
}

module.exports = TariffManager;