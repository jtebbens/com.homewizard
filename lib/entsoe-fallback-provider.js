'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');
const { importPrice, exportPrice } = require('./price-formulas');

// Cached formatter — constructing a fresh Intl.DateTimeFormat per slot inside
// _processSlots/_aggregateToHourly was a confirmed CPU hotspot (same pattern as
// kwhprice-provider.js, 473 samples in one profiled second there).
const _amsHourMinuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false });

const ZONES = {
  NL: '10YNL----------L',
  BE: '10YBE----------2',
};

/**
 * ENTSOE Fallback Price Provider
 *
 * Fetches day-ahead spot prices from pv.tebbens.net LXC proxy (backed by
 * ENTSOE direct API with Gruijter fallback). Used when both Xadi and KwhPrice
 * fail in MergedPriceProvider.
 *
 * Data is 15-min EUR/MWh spot. This provider applies markup + BTW to match
 * the same output format as KwhPriceProvider.
 */
class EntsoeFallbackProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache = null;
    this.cache15min = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    this.markup = options.markup || 0.11;
    this.exportMultiplier = options.exportMultiplier ?? 1.0;
    this.exportAddon = options.exportAddon ?? 0;
    this.zone = options.zone || 'NL';
  }

  async fetchPrices(force = false) {
    if (!force && this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached ENTSOE fallback prices');
      return this.cache;
    }

    const zoneCode = ZONES[this.zone] || ZONES.NL;
    const url = `https://pv.tebbens.net/api/prices/${zoneCode}.json`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: { 'Accept': 'application/json' }
      }, 10000);

      if (!response.ok) {
        throw new Error(`ENTSOE fallback fetch error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.data || data.data.length === 0) {
        throw new Error('ENTSOE fallback: no price data');
      }

      const is15min = data.res === '15m';
      const slots = data.data.map(p => ({
        periodStart: new Date(p.time),
        spotEur: p.price / 1000, // EUR/MWh → EUR/kWh
      }));

      this.cache15min = this._processSlots(slots, is15min);

      if (is15min) {
        this.cache = this._aggregateToHourly(slots);
      } else {
        this.cache = this.cache15min;
      }

      this.cacheExpiry = Date.now() + 60 * 60 * 1000;

      this.log(
        `✅ ENTSOE fallback: ${slots.length} ${is15min ? '15-min' : 'hourly'} slots ` +
        `(source: ${data.source || 'unknown'}, zone: ${data.name || this.zone})`
      );

      return this.cache;
    } catch (err) {
      this.error('ENTSOE fallback fetch failed:', err.message);
      if (this.cache) {
        this.log('Returning stale ENTSOE fallback cache');
        return this.cache;
      }
      throw err;
    }
  }

  _processSlots(slots, is15min) {
    return slots.map(slot => {
      const finalPrice = importPrice(slot.spotEur, this.markup);
      const finalExportPrice = exportPrice(slot.spotEur, this.exportAddon, this.exportMultiplier);
      const _parts = {};
      for (const p of _amsHourMinuteFormatter.formatToParts(slot.periodStart)) _parts[p.type] = p.value;
      const cetHour = parseInt(_parts.hour);
      const cetMinute = is15min ? parseInt(_parts.minute) : 0;

      return {
        timestamp: slot.periodStart,
        price: finalPrice,
        exportPrice: finalExportPrice,
        originalPrice: slot.spotEur,
        hour: cetHour,
        minute: cetMinute,
        readingDate: slot.periodStart.toISOString()
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
  }

  _aggregateToHourly(slots) {
    const buckets = {};
    for (const slot of slots) {
      const hourKey = new Date(
        Date.UTC(
          slot.periodStart.getUTCFullYear(),
          slot.periodStart.getUTCMonth(),
          slot.periodStart.getUTCDate(),
          slot.periodStart.getUTCHours()
        )
      ).toISOString();
      if (!buckets[hourKey]) buckets[hourKey] = { sum: 0, count: 0 };
      buckets[hourKey].sum += slot.spotEur;
      buckets[hourKey].count += 1;
    }

    return Object.entries(buckets)
      .map(([isoKey, { sum, count }]) => {
        const timestamp = new Date(isoKey);
        const spot = sum / count;
        const finalPrice = importPrice(spot, this.markup);
        const finalExportPrice = exportPrice(spot, this.exportAddon, this.exportMultiplier);
        const cetHour = parseInt(_amsHourMinuteFormatter.formatToParts(timestamp).find(p => p.type === 'hour').value);
        return {
          timestamp,
          price: finalPrice,
          exportPrice: finalExportPrice,
          originalPrice: spot,
          hour: cetHour,
          minute: 0,
          readingDate: timestamp.toISOString()
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  hasPrices() {
    return !!(this.cache && this.cache.length > 0);
  }

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
}

module.exports = EntsoeFallbackProvider;
