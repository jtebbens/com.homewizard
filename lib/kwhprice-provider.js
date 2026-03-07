'use strict';

const fetch = require('node-fetch');

/**
 * kWhPrice.eu Day-Ahead Prices Provider
 *
 * ✅ MODIFIED: Now exports BOTH 15-minute intervals AND hourly averages
 * 
 * - cache: Hourly averages (backward compatible)
 * - cache15min: Full 15-minute intervals (new)
 */
class KwhPriceProvider {
  constructor(homey, options = {}) {
    this.homey = homey;
    this.cache = null;           // Hourly averages (existing)
    this.cache15min = null;       // ✅ NEW: 15-minute intervals
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);

    this.markup = options.markup || 0.11;
    this.log(`KwhPrice provider initialized with markup: €${this.markup}/kWh`);

    this._loadCache();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  async _loadCache() {
    try {
      const cached = await this.homey.settings.get('kwhprice_cache');
      if (cached && cached.expiry > Date.now()) {
        this.cache = cached.prices.map(p => ({
          ...p,
          timestamp: new Date(p.timestamp)
        }));
        // ✅ NEW: Load 15-min cache too
        this.cache15min = cached.prices15min?.map(p => ({
          ...p,
          timestamp: new Date(p.timestamp)
        })) || null;
        
        this.cacheExpiry = cached.expiry;
        this.log(
          `Loaded ${this.cache.length} hourly + ${this.cache15min?.length || 0} 15-min prices from storage ` +
          `(expires in ${Math.round((this.cacheExpiry - Date.now()) / 60000)}min)`
        );
      }
    } catch (err) {
      this.log('Failed to load cached prices:', err.message);
    }
  }

  async _saveCache() {
    // Cache is saved centrally by MergedPriceProvider — skip individual save
    // to reduce settings store pressure and memory churn
  }

  // ─── Scraping ─────────────────────────────────────────────────────────────────

  /**
   * Parse the HTML table on kwhprice.eu/en/netherlands.
   *
   * Handles two layouts:
   *   - Single column:  | Period | €/kWh |           (today only)
   *   - Two columns:    | Period | Today | Tomorrow | (after ~13:15 CET)
   *
   * Returns an array of { periodStart: Date, spotEur: number } covering
   * all available slots across both days.
   */
  _parseHtml(html, todayAms) {
    const slots = [];
    const [y, mo, d] = todayAms;

    const todayUtcMidnight    = new Date(Date.UTC(y, mo - 1, d));
    const tomorrowUtcMidnight = new Date(todayUtcMidnight.getTime() + 24 * 3600 * 1000);
    const tmY  = tomorrowUtcMidnight.getUTCFullYear();
    const tmMo = tomorrowUtcMidnight.getUTCMonth() + 1;
    const tmD  = tomorrowUtcMidnight.getUTCDate();

    const offsetToday    = (this._isSummerTime(todayUtcMidnight)    ? 2 : 1) * 3600 * 1000;
    const offsetTomorrow = (this._isSummerTime(tomorrowUtcMidnight) ? 2 : 1) * 3600 * 1000;

    const toUtc = (hh, mm, [yr, mr, dr], offsetMs) =>
      new Date(Date.UTC(yr, mr - 1, dr, hh, mm, 0) - offsetMs);

    /** Strip all HTML tags, decode &nbsp; and collapse whitespace to plain text. */
    const tdText = td => td
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#[0-9]+;/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    /** Extract text of every <td>…</td> in a <tr> block. */
    const rowCells = tr => {
      const cells = [];
      const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let m;
      while ((m = re.exec(tr)) !== null) cells.push(tdText(m[1]));
      return cells;
    };

    // Walk every <tr> that contains <td> elements
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let hasTomorrow = null;
    let match;

    while ((match = trRe.exec(html)) !== null) {
      const cells = rowCells(match[1]);
      if (cells.length < 2) continue;

      // First cell must be a time range "HH:MM - HH:MM"
      const timeMatch = cells[0].match(/^(\d{2}):(\d{2})\s*-\s*\d{2}:\d{2}$/);
      if (!timeMatch) continue;

      const hh = parseInt(timeMatch[1], 10);
      const mm = parseInt(timeMatch[2], 10);

      // Detect single vs two-column layout from first valid data row
      if (hasTomorrow === null) {
        hasTomorrow = cells.length >= 3;
        this.log(
          `kWhPrice layout: ${hasTomorrow ? 'two columns (today + tomorrow)' : 'single column (today only)'} ` +
          `[cells per row: ${cells.length}]`
        );
      }

      // Today price — cells[1]
      const todayPrice = parseFloat(cells[1].replace(',', '.'));
      if (!isNaN(todayPrice) && todayPrice > 0) {
        slots.push({ periodStart: toUtc(hh, mm, [y, mo, d], offsetToday), spotEur: todayPrice });
      }

      // Tomorrow price — cells[2] (only after ~13:15 CET)
      if (hasTomorrow && cells.length >= 3) {
        const tomorrowPrice = parseFloat(cells[2].replace(',', '.'));
        if (!isNaN(tomorrowPrice) && tomorrowPrice > 0) {
          slots.push({ periodStart: toUtc(hh, mm, [tmY, tmMo, tmD], offsetTomorrow), spotEur: tomorrowPrice });
        }
      }
    }

    return slots;
  }

  /** Rough summer-time check for Europe/Amsterdam. */
  _isSummerTime(date) {
    // CEST runs last Sunday March → last Sunday October
    const year = date.getUTCFullYear();
    const lastSunMarch = this._lastSunday(year, 2); // month index 2 = March
    const lastSunOct = this._lastSunday(year, 9);   // month index 9 = October
    return date >= lastSunMarch && date < lastSunOct;
  }

  _lastSunday(year, monthIndex) {
    const d = new Date(Date.UTC(year, monthIndex + 1, 0)); // last day of month
    d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
    return d;
  }

  // ✅ NEW: Process 15-minute slots WITHOUT averaging
  _process15MinSlots(slots) {
    return slots.map(slot => {
      const finalPrice = (slot.spotEur + this.markup) * 1.21;
      
      const cetHour = parseInt(
        slot.periodStart.toLocaleString('en-US', {
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
          hour12: false
        })
      );
      
      const cetMinute = parseInt(
        slot.periodStart.toLocaleString('en-US', {
          timeZone: 'Europe/Amsterdam',
          minute: '2-digit'
        })
      );

      return {
        timestamp: slot.periodStart,
        price: finalPrice,
        originalPrice: slot.spotEur,
        hour: cetHour,
        minute: cetMinute,
        readingDate: slot.periodStart.toISOString()
      };
    }).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Average 15-min slots into hourly buckets (existing method, unchanged). */
  _aggregateToHourly(slots) {
    const buckets = {};

    for (const slot of slots) {
      // Key = UTC hour start
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
        const finalPrice = (spot + this.markup) * 1.21;

        const cetHour = parseInt(
          timestamp.toLocaleString('en-US', {
            timeZone: 'Europe/Amsterdam',
            hour: '2-digit',
            hour12: false
          })
        );

        return {
          timestamp,
          price: finalPrice,
          originalPrice: spot,
          hour: cetHour,
          readingDate: timestamp.toISOString()
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  // ─── Public API (matches EnergyZeroProvider exactly) ─────────────────────────

  async fetchPrices(force = false) {
    if (!force && this.cache && this.cacheExpiry > Date.now()) {
      this.log('Using cached kWhPrice prices');
      return this.cache;
    }

    const now = new Date();
    const amsDateStr = now.toLocaleString('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).split(',')[0];
    const todayAms = amsDateStr.split('-').map(Number); // [y, m, d]

    this.log(`Fetching kWhPrice prices for Amsterdam date ${amsDateStr}`);

    try {
      const response = await fetch('https://kwhprice.eu/en/netherlands', {
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'User-Agent': 'Mozilla/5.0 (compatible; dap-energy-app/1.0)'
        }
      });

      if (!response.ok) {
        throw new Error(`kWhPrice fetch error: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      const slots = this._parseHtml(html, todayAms);

      if (slots.length === 0) {
        this.log("kWhPrice: page returned no data → using empty list");
        return [];
      }

      // ✅ NEW: Store BOTH 15-minute and hourly data
      this.cache15min = this._process15MinSlots(slots);
      this.cache = this._aggregateToHourly(slots);
      this.cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
      await this._saveCache();

      const days = slots.length > 96 ? 'today + tomorrow' : 'today';
      this.log(
        `Fetched ${slots.length} 15-min slots (${days}) → ` +
        `${this.cache15min.length} 15-min prices + ${this.cache.length} hourly averages`
      );

      if (this.cache.length > 0) {
        const first = this.cache[0];
        const last = this.cache[this.cache.length - 1];
        this.log(
          `Hourly range: ${first.timestamp.toISOString()} (${first.hour}:00 AMS, €${first.price.toFixed(4)}) ` +
          `→ ${last.timestamp.toISOString()} (${last.hour}:00 AMS, €${last.price.toFixed(4)})`
        );
      }

      if (this.cache15min.length > 0) {
        const first15 = this.cache15min[0];
        const last15 = this.cache15min[this.cache15min.length - 1];
        this.log(
          `15-min range: ${first15.timestamp.toISOString()} (${first15.hour}:${String(first15.minute).padStart(2, '0')} AMS, €${first15.price.toFixed(4)}) ` +
          `→ ${last15.timestamp.toISOString()} (${last15.hour}:${String(last15.minute).padStart(2, '0')} AMS, €${last15.price.toFixed(4)})`
        );
      }

      return this.cache;

    } catch (err) {
      this.error('Failed to fetch kWhPrice prices:', err);
      if (this.cache) {
        this.log('Returning stale cache due to fetch error');
        return this.cache;
      }
      throw err;
    }
  }

  // ✅ NEW: Get 15-minute prices
  getAll15MinPrices() {
    if (!this.cache15min || this.cache15min.length === 0) return [];
    const now = new Date();
    return this.cache15min.map((p, idx) => ({
      hour: p.hour,
      minute: p.minute,
      index: idx,  // 0-95 for today, 96-191 for tomorrow
      price: p.price,
      timestamp: p.timestamp,
      hoursFromNow: Math.floor((p.timestamp - now) / (1000 * 60 * 60))
    }));
  }

  // ✅ NEW: Get current 15-minute price
  getCurrent15MinPrice() {
    if (!this.cache15min || this.cache15min.length === 0) return null;
    const now = new Date();
    const current = this.cache15min.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 15 * 60 * 1000); // 15 minutes
      return now >= start && now < end;
    });
    return current ? current.price : null;
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
      const currentHourCET = parseInt(
        now.toLocaleString('en-US', {
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
          hour12: false
        })
      );
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
    const next = this.cache.find(p => {
      const timestamp = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      return timestamp > now;
    });
    return next ? next.timestamp : null;
  }

  getCurrentPrice() {
    if (!this.cache || this.cache.length === 0) return null;
    const now = new Date();
    const current = this.cache.find(p => {
      const start = p.timestamp instanceof Date ? p.timestamp : new Date(p.timestamp);
      const end = new Date(start.getTime() + 3600 * 1000);
      return now >= start && now < end;
    });
    return current ? current.price : null;
  }

  getPriceStatistics() {
    if (!this.cache || this.cache.length === 0) {
      return { avg: null, min: null, max: null, stdDev: null };
    }
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

  _calculateStdDev(values, mean) {
    const squareDiffs = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / values.length);
  }
}

module.exports = KwhPriceProvider;