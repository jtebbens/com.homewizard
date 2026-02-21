'use strict';

const MergedPriceProvider = require('./merged-price-provider');

/**
 * TariffManager with dynamic pricing support
 *
 * Dynamic provider is now MergedPriceProvider, which internally fetches from
 * both Xadi and KwhPrice concurrently and produces the most complete hourly
 * price table possible (up to 48h after ~13:15 CET).
 *
 * TariffManager no longer needs to orchestrate provider fallback itself —
 * MergedPriceProvider handles that internally. _selectBestProvider() is kept
 * for the coverage check and the "promote back to merged after failure" case.
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

    // MergedPriceProvider owns both Xadi and KwhPrice internally.
    // Expose .xadiProvider and .kwhpriceProvider as pass-throughs so that
    // device.js _schedulePriceRefresh() can still reference them directly.
    this.mergedProvider   = new MergedPriceProvider(this.homey, { markup });
    this.xadiProvider     = this.mergedProvider.xadi;
    this.kwhpriceProvider = this.mergedProvider.kwhprice;

    this.dynamicProvider = this.mergedProvider;
    this.activeProvider  = 'merged';

    this.log('Dynamic pricing enabled with MergedPriceProvider (Xadi + KwhPrice)');

    this._selectBestProvider();
  }

  async _selectBestProvider() {
    this.log('🔍 Fetching merged prices...');

    try {
      await this.mergedProvider.fetchPrices();
      const count = this.mergedProvider.cache?.length || 0;

      if (count > 0) {
        this.dynamicProvider = this.mergedProvider;
        this.activeProvider  = 'merged';
        const days = count > 24 ? 'today + tomorrow' : 'today only';
        this.log(`✅ Merged provider ready: ${count}h (${days})`);
        return;
      }

      this.log('⚠️ Merged provider returned no prices');
    } catch (err) {
      this.log('❌ Merged provider fetch failed:', err.message);
    }

    this.log('❌ No price data available');
    this.dynamicProvider = null;
    this.activeProvider  = null;
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

  _getDynamicTariff(gridPower, now) {
    const currentRate  = this.dynamicProvider.getCurrentRate();
    const nextChange   = this.dynamicProvider.getNextRateChange();
    const currentPrice = this.dynamicProvider.getCurrentPrice();
    const stats        = this.dynamicProvider.getPriceStatistics();
    const top3Lowest   = this.dynamicProvider.getTop3Cheapest();
    const top3Highest  = this.dynamicProvider.getTop3MostExpensive();
    const allPrices    = this.dynamicProvider.getAllHourlyPrices();

    const next24Hours = allPrices
      .filter(p => p.index >= 0 && p.index < 24)
      .sort((a, b) => a.index - b.index)
      .map(p => ({
        hour:      p.hour,
        index:     p.index,
        price:     p.price,
        timestamp: p.timestamp,
        source:    p.source
      }));

    (async () => {
      try {
        await this.homey.settings.set('policy_all_prices', allPrices);
      } catch (err) {
        this.log('Failed to save policy_all_prices to settings:', err.message);
      }
    })();

    return {
      currentRate,
      nextRateChange:     nextChange,
      gridPower,
      isImporting:        gridPower > 0,
      isExporting:        gridPower < 0,
      currentPrice,
      priceWithoutMarkup: currentPrice,
      statistics:         stats,
      top3Lowest,
      top3Highest,
      allPrices,
      next24Hours,
      timestamp:          now,
      source:             this.activeProvider || 'unknown'
    };
  }

  _getManualTariff(gridPower, now) {
    const currentRate = this._getCurrentRate(now);
    const nextChange  = this._getNextRateChange(now);

    return {
      currentRate,
      nextRateChange: nextChange,
      gridPower,
      isImporting:    gridPower > 0,
      isExporting:    gridPower < 0,
      currentPrice:   null,
      timestamp:      now,
      source:         'manual'
    };
  }

  _getCurrentRate(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    if (tariffType === 'fixed') return 'standard';
    if (tariffType === 'time_of_use') return this._getTimeOfUseRate(now);
    return 'standard';
  }

  _getTimeOfUseRate(now) {
    const hour           = now.getHours();
    const minute         = now.getMinutes();
    const currentMinutes = hour * 60 + minute;

    const peakPeriods         = this._parseTimePeriods(this.settings.peak_hours          || '17:00-21:00');
    const offPeakPeriods      = this._parseTimePeriods(this.settings.off_peak_hours      || '23:00-07:00');
    const superOffPeakPeriods = this._parseTimePeriods(this.settings.super_off_peak_hours || '');

    if (this._isInPeriod(currentMinutes, superOffPeakPeriods)) return 'super-off-peak';
    if (this._isInPeriod(currentMinutes, offPeakPeriods))      return 'off-peak';
    if (this._isInPeriod(currentMinutes, peakPeriods))         return 'peak';
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
            end:   this._timeToMinutes(end.trim())
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
        return currentMinutes >= period.start || currentMinutes <= period.end;
      }
      return currentMinutes >= period.start && currentMinutes <= period.end;
    });
  }

  _getNextRateChange(now) {
    const tariffType = this.settings.tariff_type || 'fixed';
    if (tariffType === 'fixed') return null;

    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const boundaries     = this._getAllBoundaries();

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

    addBoundaries(this.settings.peak_hours           || '', 'peak');
    addBoundaries(this.settings.off_peak_hours       || '', 'off-peak');
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