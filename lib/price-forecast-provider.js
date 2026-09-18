'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');
const { importPrice, exportPrice } = require('./price-formulas');

// Cached formatter — a fresh Intl.DateTimeFormat per slot is a confirmed CPU hotspot
// (same reason as entsoe-fallback-provider.js / kwhprice-provider.js).
const _amsHourMinuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false });

// en-CA gives YYYY-MM-DD, so local dates compare as strings.
const _amsDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });

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
 * Source is the self-hosted EpexPredictor on the own LXC proxy (pv.tebbens.net,
 * forecast_<zone>_epex.json), cut off at 23:45 Amsterdam of day+2. The earlier
 * energypriceforecast feed was dropped (18-09): it stopped around 13:00 NL on day+2, so that
 * evening's peak never reached the planner. Data is 15-min EUR/MWh wholesale and goes through
 * the same importPrice()/exportPrice() helpers as the real ENTSOE prices, so there is one
 * retail conversion for both.
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

  async _fetchJson(url) {
    const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10000);
    if (!response.ok) throw new Error(`price forecast fetch error: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.data) || data.data.length === 0) throw new Error('price forecast: no data');
    return data;
  }

  /**
   * @param {boolean} force - bypass the 1h cache
   * @param {Date} now - injectable clock, for tests (sets the day+2 boundary)
   */
  async fetchPrices(force = false, now = new Date()) {
    if (!force && this.cache15min && this.cacheExpiry > Date.now()) {
      return this.cache15min;
    }

    try {
      const data = await this._fetchJson(`https://pv.tebbens.net/api/prices/forecast_${this.zone}_epex.json`);
      // Local date of day+2. Adding 48h to the UTC instant never skips a local calendar day;
      // the ±1h DST shift is discarded by reading only the date (same approach as
      // merged-price-provider._coversThroughTomorrow).
      const endDate = _amsDateFormatter.format(new Date(now.getTime() + 48 * 3600 * 1000));
      const slots = this._expandToSlots(data.data, data.res)
        .filter(s => _amsDateFormatter.format(s.timestamp) <= endDate);

      this.cache15min = slots;
      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      const until = slots.length ? slots[slots.length - 1].timestamp.toISOString() : '-';
      this.log(`🔮 Price forecast: ${slots.length} estimated 15-min slots (epex ${data.res || '1h'}, until ${until}, updated ${data.updated})`);
      return this.cache15min;
    } catch (err) {
      this.error('Price forecast fetch failed:', err.message);
      if (this.cache15min) return this.cache15min;
      throw err;
    }
  }

  /**
   * EUR/MWh rows → 15-min retail slots, shaded, tagged as estimates.
   * @param {string} res - '15m' rows map 1:1 to slots; anything else is hourly (4 slots per row)
   */
  _expandToSlots(rows, res = '1h') {
    const perRow = res === '15m' ? 1 : 4;
    const out = [];
    for (const row of rows) {
      const hourStart = new Date(row.time);
      const spotEur = (row.price / 1000) * this.shade;   // EUR/MWh → EUR/kWh
      if (!Number.isFinite(hourStart.getTime()) || !Number.isFinite(spotEur)) continue;

      const price = importPrice(spotEur, this.markup);
      const exp = exportPrice(spotEur, this.exportAddon, this.exportMultiplier);

      for (let q = 0; q < perRow; q++) {
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
