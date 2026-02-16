'use strict';

const XadiProvider = require('./xadi-provider');
const EnergyZeroProvider = require('./energyzero-provider');

/**
 * TariffManager with dynamic pricing support
 * Supports multiple price data sources
 */
class TariffManager {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = homey.log.bind(homey);
    
    // Initialize provider based on settings
    this.dynamicProvider = null;
    this._initializeDynamicProvider();
  }

  /**
   * Initialize dynamic pricing provider
   * @private
   */
  _initializeDynamicProvider() {
    if (!this.settings.enable_dynamic_pricing) {
      return;
    }

    // Initialize BOTH providers for automatic fallback
    const markup = this.settings.dynamic_price_markup || 0.11; // Default €0.11/kWh
    
    this.xadiProvider = new XadiProvider(this.homey);
    this.energyzeroProvider = new EnergyZeroProvider(this.homey, { markup });
    
    // Start with Xadi as primary, EnergyZero as fallback
    this.dynamicProvider = this.xadiProvider;
    this.activeProvider = 'xadi';
    
    this.log('Dynamic pricing enabled with Xadi (primary) and EnergyZero (fallback)');
    
    // Fetch prices from both and determine which to use
    this._selectBestProvider();
  }

  /**
 * Select the best available provider based on data availability
 * @private
 */
async _selectBestProvider() {
  this.log('🔍 Selecting best price provider...');
  
  try {
    // Try Xadi first
    await this.xadiProvider.fetchPrices();
    const xadiPriceCount = this.xadiProvider.cache?.length || 0;
    
    // Consider Xadi good if we have at least 40 hours (covers most of tomorrow)
    if (xadiPriceCount >= 40) {
      this.dynamicProvider = this.xadiProvider;
      this.activeProvider = 'xadi';
      this.log(`✅ Using Xadi provider (${xadiPriceCount} prices available)`);
      return;
    }
    
    this.log(`⚠️ Xadi has only ${xadiPriceCount} prices (need 40+), trying EnergyZero fallback...`);
  } catch (error) {
    this.log('⚠️ Xadi fetch failed, trying EnergyZero fallback:', error.message);
  }
  
  // Fallback to EnergyZero
  try {
    await this.energyzeroProvider.fetchPrices();
    const ezPriceCount = this.energyzeroProvider.cache?.length || 0;
    
    if (ezPriceCount > 0) {
      this.dynamicProvider = this.energyzeroProvider;
      this.activeProvider = 'energyzero';
      this.log(`✅ Using EnergyZero provider (${ezPriceCount} prices available, fallback active)`);
      return;
    }
    
    this.log('⚠️ EnergyZero returned no prices');
  } catch (error) {
    this.log('❌ EnergyZero fetch also failed:', error.message);
  }
  
  // Both failed - use Xadi even with limited data if available
  if (this.xadiProvider.cache?.length > 0) {
    this.dynamicProvider = this.xadiProvider;
    this.activeProvider = 'xadi';
    const xadiPriceCount = this.xadiProvider.cache?.length || 0;
    this.log(`⚠️ Using Xadi with limited data (${xadiPriceCount} prices)`);
    return;
  }
  
  // Complete failure
  this.log('❌ No price provider available - both Xadi and EnergyZero failed');
  this.dynamicProvider = null;
  this.activeProvider = null;
}

  /**
   * Get current tariff information
   * @param {number} gridPower - Current grid power (positive = import, negative = export)
   * @returns {Object} Tariff information
   */
  getCurrentTariff(gridPower = 0) {
    const now = new Date();
    
    // Use dynamic pricing if enabled and provider is available
    if (this.settings.enable_dynamic_pricing && this.dynamicProvider) {
      try {
        return this._getDynamicTariff(gridPower, now);
      } catch (error) {
        this.log('Dynamic tariff fetch failed, falling back to manual:', error.message);
        return this._getManualTariff(gridPower, now);
      }
    }
    
    // Fallback to manual time-of-use
    return this._getManualTariff(gridPower, now);
  }

  /**
   * Get dynamic tariff from provider
   * @private
   */
  _getDynamicTariff(gridPower, now) {
  const currentRate = this.dynamicProvider.getCurrentRate();
  const nextChange = this.dynamicProvider.getNextRateChange();
  const currentPrice = this.dynamicProvider.getCurrentPrice();
  const stats = this.dynamicProvider.getPriceStatistics();

  // Price already includes markup from provider
  // (Xadi applies it via URL params, EnergyZero applies it in constructor)

  // ======================================================
  // DAYCURVE: TOP 3 CHEAPEST & TOP 3 MOST EXPENSIVE HOURS
  // ======================================================
  let top3Lowest = [];
  let top3Highest = [];

  if (this.dynamicProvider) {
    top3Lowest = this.dynamicProvider.getTop3Cheapest();
    top3Highest = this.dynamicProvider.getTop3MostExpensive();
  }

  // Get all 24-hour prices for planning view
  const allPrices = this.dynamicProvider ? this.dynamicProvider.getAllHourlyPrices() : [];

  return {
    currentRate,
    nextRateChange: nextChange,
    gridPower,
    isImporting: gridPower > 0,
    isExporting: gridPower < 0,
    currentPrice: currentPrice,
    priceWithoutMarkup: currentPrice, // For backwards compatibility
    statistics: stats,
    top3Lowest,
    top3Highest,
    allPrices,
    timestamp: now,
    source: this.activeProvider || 'unknown'
  };
}


  /**
   * Get manual time-of-use tariff
   * @private
   */
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

  /**
   * Determine current rate based on time (manual mode)
   * @private
   */
  _getCurrentRate(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    
    if (tariffType === 'fixed') {
      return 'standard';
    }
    
    if (tariffType === 'time_of_use') {
      return this._getTimeOfUseRate(now);
    }
    
    return 'standard';
  }

  /**
   * Calculate time-of-use rate based on configured hours
   * @private
   */
  _getTimeOfUseRate(now) {
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentMinutes = hour * 60 + minute;
    
    // Parse configured rate periods
    const peakPeriods = this._parseTimePeriods(this.settings.peak_hours || '17:00-21:00');
    const offPeakPeriods = this._parseTimePeriods(this.settings.off_peak_hours || '23:00-07:00');
    const superOffPeakPeriods = this._parseTimePeriods(this.settings.super_off_peak_hours || '');
    
    // Check in priority order
    if (this._isInPeriod(currentMinutes, superOffPeakPeriods)) {
      return 'super-off-peak';
    }
    
    if (this._isInPeriod(currentMinutes, offPeakPeriods)) {
      return 'off-peak';
    }
    
    if (this._isInPeriod(currentMinutes, peakPeriods)) {
      return 'peak';
    }
    
    return 'standard';
  }

  /**
   * Parse time period strings like "17:00-21:00,07:00-09:00"
   * @private
   */
  _parseTimePeriods(periodsString) {
    if (!periodsString) return [];
    
    const periods = [];
    const parts = periodsString.split(',');
    
    for (const part of parts) {
      const [start, end] = part.trim().split('-');
      if (start && end) {
        periods.push({
          start: this._timeToMinutes(start.trim()),
          end: this._timeToMinutes(end.trim())
        });
      }
    }
    
    return periods;
  }

  /**
   * Convert "HH:MM" to minutes since midnight
   * @private
   */
  _timeToMinutes(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Check if current time is within any of the given periods
   * @private
   */
  _isInPeriod(currentMinutes, periods) {
    for (const period of periods) {
      // Handle overnight periods (e.g., 23:00-07:00)
      if (period.end < period.start) {
        if (currentMinutes >= period.start || currentMinutes <= period.end) {
          return true;
        }
      } else {
        if (currentMinutes >= period.start && currentMinutes <= period.end) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Get next rate change information (manual mode)
   * @private
   */
  _getNextRateChange(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    
    if (tariffType === 'fixed') {
      return null;
    }
    
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentMinutes = hour * 60 + minute;
    
    // Get all period boundaries
    const boundaries = this._getAllBoundaries();
    
    // Find next boundary after current time
    for (const boundary of boundaries) {
      let minutesUntil;
      
      if (boundary.minutes > currentMinutes) {
        minutesUntil = boundary.minutes - currentMinutes;
      } else {
        // Next occurrence is tomorrow
        minutesUntil = (1440 - currentMinutes) + boundary.minutes;
      }
      
      if (minutesUntil > 0) {
        return {
          rate: boundary.rate,
          startsIn: minutesUntil
        };
      }
    }
    
    return null;
  }

  /**
   * Get all rate boundaries sorted by time
   * @private
   */
  _getAllBoundaries() {
    const boundaries = [];
    
    const addBoundaries = (periodsString, rate) => {
      const periods = this._parseTimePeriods(periodsString);
      for (const period of periods) {
        boundaries.push({ minutes: period.start, rate });
        boundaries.push({ minutes: period.end, rate: 'standard' });
      }
    };
    
    addBoundaries(this.settings.peak_hours || '', 'peak');
    addBoundaries(this.settings.off_peak_hours || '', 'off-peak');
    addBoundaries(this.settings.super_off_peak_hours || '', 'super-off-peak');
    
    // Sort by minutes
    boundaries.sort((a, b) => a.minutes - b.minutes);
    
    return boundaries;
  }

  /**
   * Get tariff multiplier for cost calculations
   * @param {string} rate - Rate category
   * @returns {number}
   */
  getTariffMultiplier(rate) {
    const multipliers = {
      'super-off-peak': 0.5,
      'off-peak': 0.7,
      'standard': 1.0,
      'peak': 1.5
    };
    
    return multipliers[rate] || 1.0;
  }

  /**
   * Update settings (called when user changes tariff configuration)
   * @param {Object} newSettings
   */
  updateSettings(newSettings) {
    const dynamicChanged = newSettings.enable_dynamic_pricing !== 
                          this.settings.enable_dynamic_pricing;
    
    this.settings = { ...this.settings, ...newSettings };
    
    // Reinitialize dynamic provider if setting changed
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
   * Fetch prices proactively
   * Call this at strategic times (e.g., after 13:00 to get tomorrow's prices)
   */
  async updateDynamicPrices() {
    if (this.dynamicProvider) {
      try {
        await this.dynamicProvider.fetchPrices();
        this.log('Dynamic prices updated successfully');
        return true;
      } catch (error) {
        this.log('Failed to update dynamic prices:', error.message);
        return false;
      }
    }
    return false;
  }

  /**
   * Get cheapest charging hours
   * Useful for advanced scheduling
   * @param {number} count - Number of cheapest hours
   * @param {number} lookAhead - Hours to look ahead
   */
  getCheapestHours(count = 3, lookAhead = 24) {
    if (!this.dynamicProvider) {
      return [];
    }
    
    try {
      return this.dynamicProvider.getCheapestHours(count, lookAhead);
    } catch (error) {
      this.log('Failed to get cheapest hours:', error.message);
      return [];
    }
  }

  /**
   * Get most expensive discharging hours
   * Useful for advanced scheduling
   * @param {number} count - Number of most expensive hours
   * @param {number} lookAhead - Hours to look ahead
   */
  getMostExpensiveHours(count = 3, lookAhead = 24) {
    if (!this.dynamicProvider) {
      return [];
    }
    
    try {
      return this.dynamicProvider.getMostExpensiveHours(count, lookAhead);
    } catch (error) {
      this.log('Failed to get most expensive hours:', error.message);
      return [];
    }
  }

  /**
   * Get price statistics
   * Useful for UI display
   */
  getPriceStatistics() {
    if (!this.dynamicProvider) {
      return null;
    }
    
    try {
      return this.dynamicProvider.getPriceStatistics();
    } catch (error) {
      this.log('Failed to get price statistics:', error.message);
      return null;
    }
  }
}

module.exports = TariffManager;