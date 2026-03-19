'use strict';

const MergedPriceProvider = require('./merged-price-provider');

/**
 * TariffManager with dynamic pricing support
 *
 * ✅ ADDED: 15-minute price support via getAll15MinPrices()
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

        // Save 15-min prices immediately after full fetch (both providers done).
        // This avoids the race where getCurrentTariff() saves prices before Xadi
        // finishes its /day/tomorrow fetch, causing missing slots in the planning.
        const all15min = this.getAll15MinPrices();
        if (all15min.length > 0) {
          this._lastPriceSettingsSave = Date.now(); // reset throttle
          await this.homey.settings.set('policy_all_prices_15min', all15min);
          this.log(`💾 Initial save: ${all15min.length} 15-min prices after full fetch`);
        }
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
    const stats        = this.dynamicProvider.getPriceStatistics();
    const top3Lowest   = this.dynamicProvider.getTop3Cheapest();
    const top3Highest  = this.dynamicProvider.getTop3MostExpensive();
    const allPrices    = this.dynamicProvider.getAllHourlyPrices();

    // Use 15-min price as currentPrice when available (more accurate for policy decisions)
    const allPrices15min = this.getAll15MinPrices();
    const currentPrice = this.getCurrent15MinPrice() ?? this.dynamicProvider.getCurrentPrice();

    // Build effectivePrices: 15-min slots with slot-based index (slots from now).
    // slotHours = 0.25 for native 15-min, 1.0 fallback to hourly.
    // Policy engine uses effectivePrices + slotHours for all future-price comparisons.
    const slotMs = 15 * 60 * 1000;
    const nowMs = now.getTime();
    let effectivePrices, slotHours;
    if (allPrices15min?.length > 0) {
      effectivePrices = allPrices15min
        .map(p => {
          const ts = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
          return { ...p, index: Math.round((ts.getTime() - nowMs) / slotMs) };
        })
        .sort((a, b) => a.index - b.index);
      slotHours = 0.25;
    } else {
      effectivePrices = null; // falls back to next24Hours in policy engine
      slotHours = 1.0;
    }

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

    // Throttle settings writes to at most once per 5 minutes to avoid
    // hammering Homey's settings store (getCurrentTariff is called every 15s).
    const _now = Date.now();
    if (!this._lastPriceSettingsSave || _now - this._lastPriceSettingsSave > 300_000) {
      this._lastPriceSettingsSave = _now;
      (async () => {
        try {
          await this.homey.settings.set('policy_all_prices', allPrices);
          // Save 15-min prices for planning view
          if (allPrices15min && allPrices15min.length > 0) {
            await this.homey.settings.set('policy_all_prices_15min', allPrices15min);
            this.log(`💾 Saved ${allPrices15min.length} 15-min prices to settings`);
          }
        } catch (err) {
          this.log('Failed to save policy prices to settings:', err.message);
        }
      })();
    }

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
      allPrices15min,
      effectivePrices,    // 15-min slots with slot index, or null (falls back to next24Hours)
      slotHours,          // 0.25 for 15-min, 1.0 for hourly
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

  // ═══════════════════════════════════════════════════════════════════
  // ✅ NEW: 15-MINUTE PRICE METHODS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Get all 15-minute price intervals
   * Returns array with 96 intervals (today) or 192 (today + tomorrow)
   * 
   * Falls back to expanding hourly prices if provider doesn't support 15-min
   */
  getAll15MinPrices() {
    if (!this.dynamicProvider) return [];

    try {
      const all15min = [];
      let foundNative = false;

      // Try KwhPrice provider first
      if (this.kwhpriceProvider && typeof this.kwhpriceProvider.getAll15MinPrices === 'function') {
        const kwhPrices = this.kwhpriceProvider.getAll15MinPrices();
        if (kwhPrices && kwhPrices.length > 0) {
          kwhPrices.forEach(p => all15min.push({ ...p, source: 'kwhprice' }));
          foundNative = true;
          // Logging moved to provider's fetch method
        }
      }

      // Try Xadi provider
      if (this.xadiProvider && typeof this.xadiProvider.getAll15MinPrices === 'function') {
        const xadiPrices = this.xadiProvider.getAll15MinPrices();
        if (xadiPrices && xadiPrices.length > 0) {
          xadiPrices.forEach(p => all15min.push({ ...p, source: 'xadi' }));
          foundNative = true;
          // Logging moved to provider's fetch method
        }
      }

      // If we got native 15-min data from either source, deduplicate and return
      if (foundNative && all15min.length > 0) {
        // Deduplicate by timestamp (prefer KwhPrice over Xadi)
        const seen = new Map();
        all15min.forEach(p => {
          const key = p.timestamp instanceof Date ? p.timestamp.getTime() : new Date(p.timestamp).getTime();
          if (!seen.has(key) || p.source === 'kwhprice') {
            seen.set(key, p);
          }
        });
        const deduplicated = Array.from(seen.values()).sort((a, b) => {
          const aTime = a.timestamp instanceof Date ? a.timestamp : new Date(a.timestamp);
          const bTime = b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp);
          return aTime - bTime;
        });
        // Only log once per hour to avoid spam
        if (!this._last15MinLog || Date.now() - this._last15MinLog > 3600000) {
          this.log(`📊 Serving ${deduplicated.length} cached 15-min intervals from providers`);
          this._last15MinLog = Date.now();
        }
        return deduplicated;
      }

      // Fallback: Expand hourly to 15-min intervals
      if (!this._lastExpandLog || Date.now() - this._lastExpandLog > 3600000) {
        this.log('📊 Expanding hourly prices to 15-min intervals (fallback)');
        this._lastExpandLog = Date.now();
      }
      return this._expandHourlyTo15Min();

    } catch (error) {
      this.log('Failed to get 15-min prices:', error.message);
      return [];
    }
  }

  /**
   * Get current 15-minute price (more accurate than hourly)
   */
  getCurrent15MinPrice() {
    if (!this.dynamicProvider) return null;

    try {
      // Try xadi (native 15-min intervals)
      if (this.xadiProvider && typeof this.xadiProvider.getCurrent15MinPrice === 'function') {
        const p = this.xadiProvider.getCurrent15MinPrice();
        if (p !== null && p !== undefined) return p;
      }

      // Try kwhprice
      if (this.kwhpriceProvider && typeof this.kwhpriceProvider.getCurrent15MinPrice === 'function') {
        const p = this.kwhpriceProvider.getCurrent15MinPrice();
        if (p !== null && p !== undefined) return p;
      }

      // Fallback to hourly
      return this.dynamicProvider.getCurrentPrice();

    } catch (error) {
      this.log('Failed to get current 15-min price:', error.message);
      return null;
    }
  }

  /**
   * Expand hourly prices to 15-minute intervals
   * Each hour gets 4 slots with the same price (00, 15, 30, 45)
   * 
   * This is a fallback when the provider doesn't have native 15-min data
   */
  _expandHourlyTo15Min() {
    const hourlyPrices = this.dynamicProvider.getAllHourlyPrices();
    const intervals = [];

    hourlyPrices.forEach(hourPrice => {
      for (let m = 0; m < 60; m += 15) {
        const ts = new Date(hourPrice.timestamp);
        ts.setMinutes(m);

        intervals.push({
          hour: hourPrice.hour,
          minute: m,
          index: intervals.length,
          price: hourPrice.price,
          timestamp: ts,
          hoursFromNow: Math.floor((ts - new Date()) / (1000 * 60 * 60)),
          source: hourPrice.source || 'merged'
          // Note: No 'isExpanded' flag - this is just converted data
        });
      }
    });

    return intervals;
  }

  // ═══════════════════════════════════════════════════════════════════
  // EXISTING METHODS (unchanged)
  // ═══════════════════════════════════════════════════════════════════

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