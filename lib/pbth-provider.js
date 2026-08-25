'use strict';

const { exportPrice: computeExportPrice } = require('./price-formulas');

// Cached formatter — constructing a fresh Intl.DateTimeFormat per slot was a confirmed CPU
// hotspot in the sibling providers (kwhprice-provider.js, entsoe-fallback-provider.js).
const _amsHourMinuteFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Power by the Hour (PBTH) Price Provider
 *
 * Fetches from the paired `com.gruijter.powerhour` app via Homey's app-to-app API. PBTH already
 * applies markup/BTW server-side (verified against Zonneplan's own price), so slots are used
 * directly as final retail prices — unlike xadi/kwhprice, price-formulas.js is NOT applied here.
 *
 * The paired device's `driverType` ('dap' = hourly, 'dap15' = quarter-hourly) decides whether
 * cache15min gets native data or stays null (falling back to hourly expansion upstream).
 *
 * Any failure (app not installed, no device paired, chosen deviceId not present) is swallowed
 * and yields an empty/falsy result — MergedPriceProvider treats that as "PBTH unavailable" and
 * falls through to ENTSOE, so this provider never throws.
 */
class PbthProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.deviceId = options.deviceId || null;
    this.cache = null;
    this.cache15min = null;
    this.cacheExpiry = null;
    this.driverType = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    // Stored for interface parity with the sibling providers, but unused here: PBTH slots
    // are already final retail prices, so price-formulas.js is never applied to this branch.
    this.markup = options.markup !== undefined ? options.markup : 0.11;
    this.exportMultiplier = options.exportMultiplier ?? 1.0;
    this.exportAddon = options.exportAddon ?? 0;
  }

  async _saveCache() {
    // Cache is saved centrally by MergedPriceProvider — no-op, same as sibling providers.
  }

  /**
   * Raw device list for the settings-page device selector — independent of any provider
   * instance's own deviceId/cache. Used by app.js's `pbth_poll_request` handler.
   */
  static async fetchDeviceList(homey) {
    try {
      const response = await homey.api.getApiApp('com.gruijter.powerhour').get('/dap-prices');
      const devices = response?.prices || [];
      return devices.map(d => ({ deviceId: d.deviceId, deviceName: d.deviceName, driverType: d.driverType }));
    } catch (err) {
      homey.log('PBTH device list fetch failed:', err.message);
      return [];
    }
  }

  _mapSlot(slot) {
    const ts = new Date(slot.time);
    const _parts = {};
    for (const p of _amsHourMinuteFormatter.formatToParts(ts)) _parts[p.type] = p.value;
    // PBTH's own exportPrice mirrors importPrice 1:1 — it doesn't model export
    // asymmetry (Zonnebonus and similar). Reconstruct the underlying spot from the
    // final retail price and re-derive export via the same formula the other
    // providers use (price-formulas.js), so asymmetric_2027 sees real per-slot
    // export values instead of import===export. Saldering ignores this field
    // (exportValue() returns priceSlot.price there), so this is inert on the live
    // default. Temporary until PBTH itself reports export separately.
    const _spot = slot.importPrice / 1.21 - this.markup;
    return {
      timestamp: ts,
      price: slot.importPrice,
      exportPrice: computeExportPrice(_spot, this.exportAddon, this.exportMultiplier),
      hour: parseInt(_parts.hour, 10),
      minute: parseInt(_parts.minute, 10),
      readingDate: ts.toISOString()
    };
  }

  _aggregateToHourly(slots15min) {
    const buckets = new Map();
    for (const s of slots15min) {
      const key = new Date(Date.UTC(
        s.timestamp.getUTCFullYear(), s.timestamp.getUTCMonth(), s.timestamp.getUTCDate(), s.timestamp.getUTCHours()
      )).toISOString();
      if (!buckets.has(key)) buckets.set(key, { price: 0, exportPrice: 0, count: 0 });
      const b = buckets.get(key);
      b.price += s.price;
      b.exportPrice += s.exportPrice;
      b.count += 1;
    }
    return Array.from(buckets.entries()).map(([isoKey, b]) => {
      const timestamp = new Date(isoKey);
      const _parts = {};
      for (const p of _amsHourMinuteFormatter.formatToParts(timestamp)) _parts[p.type] = p.value;
      return {
        timestamp,
        price: b.price / b.count,
        exportPrice: b.exportPrice / b.count,
        hour: parseInt(_parts.hour, 10),
        minute: 0,
        // How many quarters this average is built from. PBTH only serves slots ahead of now, so
        // the running hour arrives with 1-3 of them and its average is not the hour's average
        // (live 2026-08-10 15:00Z: 2 quarters → €0.2866 vs the full hour's €0.2619). The merge
        // in merged-price-provider uses this to let a complete ENTSOE hour win.
        slotCount: b.count,
        readingDate: timestamp.toISOString()
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
  }

  async fetchPrices(force = false) {
    if (!force && this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached PBTH prices');
      return this.cache;
    }

    if (!this.deviceId) {
      this.log('PBTH: no device selected (pbth_device_id not set) — skipping');
      return this.cache || [];
    }

    try {
      const response = await this.homey.api.getApiApp('com.gruijter.powerhour').get('/dap-prices');
      const devices = response?.prices || [];
      const device = devices.find(d => d.deviceId === this.deviceId);

      if (!device || !Array.isArray(device.slots) || device.slots.length === 0) {
        this.log(`PBTH: device ${this.deviceId} not present or has no slots — skipping`);
        return this.cache || [];
      }

      this.driverType = device.driverType;
      const slots = device.slots
        .filter(s => typeof s.importPrice === 'number' && Number.isFinite(s.importPrice))
        .map(s => this._mapSlot(s))
        .sort((a, b) => a.timestamp - b.timestamp);

      if (slots.length === 0) {
        this.log('PBTH: 0 valid-price slots after filtering — skipping');
        return this.cache || [];
      }

      if (this.driverType === 'dap15') {
        this.cache15min = slots;
        this.cache = this._aggregateToHourly(slots);
      } else {
        this.cache15min = null;
        this.cache = slots;
      }

      this.cacheExpiry = Date.now() + 60 * 60 * 1000;
      await this._saveCache();

      this.log(`✅ PBTH (${device.deviceName || this.deviceId}, ${this.driverType}): ${slots.length} slots → ${this.cache.length} hourly`);

      return this.cache;
    } catch (err) {
      this.log('PBTH fetch unavailable:', err.message);
      return this.cache || [];
    }
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
      hoursFromNow: Math.floor((p.timestamp - now) / (1000 * 60 * 60))
    }));
  }

  getCurrent15MinPrice() {
    if (!this.cache15min || this.cache15min.length === 0) return null;
    const now = new Date();
    const current = this.cache15min.find(p => {
      const end = new Date(p.timestamp.getTime() + 15 * 60 * 1000);
      return now >= p.timestamp && now < end;
    });
    return current ? current.price : null;
  }

  getCurrentRate() {
    if (!this.cache || this.cache.length === 0) return 'standard';
    const now = new Date();
    const current = this.cache.find(p => now >= p.timestamp && now < new Date(p.timestamp.getTime() + 3600 * 1000)) || this.cache[0];
    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const stdDev = this._calculateStdDev(prices, avg);
    if (current.price <= avg - stdDev * 0.5) return 'low';
    if (current.price >= avg + stdDev * 0.5) return 'peak';
    return 'standard';
  }

  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const current = this.cache.find(p => now >= p.timestamp && now < new Date(p.timestamp.getTime() + 3600 * 1000));
    return current ? current.price : null;
  }

  getNextRateChange() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const next = this.cache.find(p => p.timestamp > now);
    return next ? next.timestamp : null;
  }

  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) return { avg: null, min: null, max: null, stdDev: null };
    const prices = this.cache.map(p => p.price);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { avg, min: Math.min(...prices), max: Math.max(...prices), stdDev: this._calculateStdDev(prices, avg) };
  }

  getTop3Cheapest() {
    if (!this.cache || this.cache.length === 0) return [];
    return [...this.cache].sort((a, b) => a.price - b.price).slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  getTop3MostExpensive() {
    if (!this.cache || this.cache.length === 0) return [];
    return [...this.cache].sort((a, b) => b.price - a.price).slice(0, 3)
      .map(p => ({ hour: p.hour, price: p.price, timestamp: p.timestamp }));
  }

  hasPrices() {
    return !!(this.cache && this.cache.length > 0);
  }

  getAllHourlyPrices() {
    if (!this.cache || this.cache.length === 0) return [];
    const now = new Date();
    return this.cache.map(p => ({
      hour: p.hour,
      index: Math.floor((p.timestamp - now) / (1000 * 60 * 60)),
      price: p.price,
      exportPrice: p.exportPrice,
      timestamp: p.timestamp
    }));
  }

  getCoverageInfo() {
    if (!this.cache || this.cache.length === 0) {
      return { hasPrices: false, totalHours: 0, firstHour: null, lastHour: null, hoursFromNow: { min: 0, max: 0 } };
    }
    const now = new Date();
    const timestamps = this.cache.map(p => p.timestamp);
    const first = new Date(Math.min(...timestamps));
    const last = new Date(Math.max(...timestamps));
    const hoursFromNow = this.cache.map(p => Math.floor((p.timestamp - now) / (1000 * 60 * 60)));
    return {
      hasPrices: true,
      totalHours: this.cache.length,
      firstHour: first.toISOString(),
      lastHour: last.toISOString(),
      hoursFromNow: { min: Math.min(...hoursFromNow), max: Math.max(...hoursFromNow) }
    };
  }

  _calculateStdDev(values, mean) {
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }
}

module.exports = PbthProvider;
