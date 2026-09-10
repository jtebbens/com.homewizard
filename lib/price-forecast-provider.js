'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');
const { importPrice, exportPrice } = require('./price-formulas');

// Cached formatter — a fresh Intl.DateTimeFormat per slot is a confirmed CPU hotspot
// (same reason as entsoe-fallback-provider.js / kwhprice-provider.js).
const _amsHourMinuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false });

const SLOT_MS = 900_000;

/**
 * Price Forecast Provider — estimated prices for slots the day-ahead auction has not
 * published yet.
 *
 * Before ~13:00 CEST no prices exist for tomorrow, so the planning horizon is truncated
 * to midnight and the charge ceiling is set by today's remaining peak. That measurably
 * suppresses charging (09-09: 2 vs 11 charge slots at the same real prices). These
 * estimates fill that gap and are replaced by the real day-ahead as soon as it arrives —
 * the merge in tariff-manager.getAll15MinPrices() ranks 'forecast' below every real
 * source, so no explicit replacement step is needed.
 *
 * Source is the own LXC proxy (pv.tebbens.net), which mirrors api.energypriceforecast.eu.
 * Data is hourly EUR/MWh wholesale; each hour expands to 4 identical 15-min slots and goes
 * through the same importPrice()/exportPrice() helpers as the real ENTSOE prices, so there
 * is one retail conversion for both. The upstream API also publishes its own retail totals;
 * those are deliberately ignored because they do not know this user's markup/tax settings.
 *
 * Every slot carries `estimated: true` so downstream code can tell an estimate from a
 * published price after the merge has flattened the sources.
 */
class PriceForecastProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache15min = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    this.markup = options.markup || 0.11;
    this.exportMultiplier = options.exportMultiplier ?? 1.0;
    this.exportAddon = options.exportAddon ?? 0;
    this.zone = options.zone || 'NL';
    // Shade < 1 pulls the estimated wholesale price down, so an over-optimistic estimate
    // moves the charge ceiling less far. Applied to the spot price, not the retail total —
    // taxes are a fixed addition and must not be shaded.
    this.shade = options.shade ?? 1.0;
  }

  async fetchPrices(force = false) {
    if (!force && this.cache15min && this.cacheExpiry > Date.now()) {
      return this.cache15min;
    }

    const url = `https://pv.tebbens.net/api/prices/forecast_${this.zone}.json`;

    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10000);
      if (!response.ok) throw new Error(`price forecast fetch error: ${response.status}`);

      const data = await response.json();
      if (!Array.isArray(data.data) || data.data.length === 0) throw new Error('price forecast: no data');

      this.cache15min = this._expandToSlots(data.data);
      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      this.log(`🔮 Price forecast: ${this.cache15min.length} estimated 15-min slots from ${data.points} hours (updated ${data.updated})`);
      return this.cache15min;
    } catch (err) {
      this.error('Price forecast fetch failed:', err.message);
      if (this.cache15min) return this.cache15min;
      throw err;
    }
  }

  /** Hourly EUR/MWh rows → 15-min retail slots, shaded, tagged as estimates. */
  _expandToSlots(rows) {
    const out = [];
    for (const row of rows) {
      const hourStart = new Date(row.time);
      const spotEur = (row.price / 1000) * this.shade;   // EUR/MWh → EUR/kWh
      if (!Number.isFinite(hourStart.getTime()) || !Number.isFinite(spotEur)) continue;

      const price = importPrice(spotEur, this.markup);
      const exp = exportPrice(spotEur, this.exportAddon, this.exportMultiplier);

      for (let q = 0; q < 4; q++) {
        const timestamp = new Date(hourStart.getTime() + q * SLOT_MS);
        const parts = {};
        for (const p of _amsHourMinuteFormatter.formatToParts(timestamp)) parts[p.type] = p.value;
        out.push({
          timestamp,
          price,
          exportPrice: exp,
          originalPrice: spotEur,
          hour: parseInt(parts.hour),
          minute: parseInt(parts.minute),
          estimated: true,
          readingDate: timestamp.toISOString(),
        });
      }
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  hasPrices() {
    return !!(this.cache15min && this.cache15min.length > 0);
  }

  getAll15MinPrices() {
    if (!this.cache15min || this.cache15min.length === 0) return [];
    const now = new Date();
    return this.cache15min.map((p, idx) => ({
      hour: p.hour,
      minute: p.minute,
      index: idx,
      price: p.price,
      exportPrice: p.exportPrice,
      timestamp: p.timestamp,
      estimated: true,
      hoursFromNow: Math.floor((p.timestamp - now) / (1000 * 60 * 60)),
    }));
  }
}

module.exports = PriceForecastProvider;
