'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const CACHE_KEY      = 'solcast_forecast_cache';
const CACHE_TTL_DAY  = 2 * 60 * 60 * 1000; // 2h during daylight → 8 fetches in 16h window
const CACHE_TTL_NIGHT = 8 * 60 * 60 * 1000; // 8h at night → ~1 fetch, data barely changes
const BASE_URL    = 'https://api.solcast.com.au';

// Amsterdam local hour (UTC+1 winter, UTC+2 summer). Night = 22:00–06:00.
function _amsterdamHour() {
  const now = new Date();
  const ams = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  return ams.getHours();
}

function _cacheTtl() {
  const h = _amsterdamHour();
  return (h >= 6 && h < 22) ? CACHE_TTL_DAY : CACHE_TTL_NIGHT;
}

/**
 * SolcastProvider — fetches rooftop PV forecast from Solcast API.
 *
 * Caches results in homey.settings to survive app restarts.
 * TTL is time-aware: 2h during daylight (06:00–22:00 Amsterdam), 8h at night.
 *
 * Returns array of { timestamp: string (ISO), pvPowerW: number }
 * at 30-min resolution — compatible with optimization-engine._getPvForSlot().
 */
class SolcastProvider {
  constructor(homey) {
    this.homey = homey;
  }

  /**
   * Get PV forecast. Returns cached data if fresh, otherwise fetches.
   * @param {string} apiKey
   * @param {string} resourceId
   * @returns {Promise<Array<{timestamp: string, pvPowerW: number}>|null>}
   */
  async getForecast(apiKey, resourceId) {
    const cached = this._loadCache();
    if (cached) {
      this.homey.log('[Solcast] Using cached forecast');
      return cached;
    }

    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._fetch(apiKey, resourceId).finally(() => { this._fetchPromise = null; });
    const result = await this._fetchPromise;
    if (result) return result;

    // Fresh fetch failed (e.g. 429 rate limit) — return stale cache rather than nothing
    const stale = this._loadStaleCache();
    if (stale) {
      this.homey.log('[Solcast] Using stale cache (fetch failed)');
      return stale;
    }
    return null;
  }

  async _fetch(apiKey, resourceId) {
    const url = `${BASE_URL}/rooftop_sites/${encodeURIComponent(resourceId)}/forecasts?format=json&hours=48`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }, 10000);

      if (!res.ok) {
        this.homey.log(`[Solcast] Fetch failed: HTTP ${res.status}`);
        return null;
      }

      const json = await res.json();
      const data = this._process(json.forecasts);
      if (data) {
        this._saveCache(data);
        this.homey.log(`[Solcast] Fetched ${data.length} slots (30-min)`);
      }
      return data;
    } catch (err) {
      this.homey.log(`[Solcast] Fetch error: ${err.message}`);
      return null;
    }
  }

  /**
   * Convert Solcast forecasts array → { timestamp, pvPowerW }[].
   * period_end is end of 30-min slot; timestamp = start of slot.
   * @private
   */
  _process(forecasts) {
    if (!Array.isArray(forecasts) || forecasts.length === 0) return null;
    return forecasts.map(f => ({
      timestamp: new Date(new Date(f.period_end).getTime() - 30 * 60 * 1000).toISOString(),
      pvPowerW:   Math.round((f.pv_estimate   ?? 0) * 1000), // kW → W p50
      pvPowerW10: Math.round((f.pv_estimate10 ?? 0) * 1000), // kW → W p10 (conservative)
    }));
  }

  _loadCache() {
    try {
      const stored = this.homey.settings.get(CACHE_KEY);
      if (!stored || !stored.fetchedAt || !stored.data) return null;
      if (Date.now() - stored.fetchedAt > _cacheTtl()) return null;
      return stored.data;
    } catch (_) {
      return null;
    }
  }

  _loadStaleCache() {
    try {
      const stored = this.homey.settings.get(CACHE_KEY);
      if (!stored || !stored.data) return null;
      return stored.data;
    } catch (_) {
      return null;
    }
  }

  _saveCache(data) {
    try {
      this.homey.settings.set(CACHE_KEY, { data, fetchedAt: Date.now() });
    } catch (err) {
      this.homey.log(`[Solcast] Cache save failed: ${err.message}`);
    }
  }

  /**
   * Invalidate the cache (e.g. when API key changes).
   */
  invalidateCache() {
    try {
      this.homey.settings.unset(CACHE_KEY);
    } catch (_) {}
  }
}

module.exports = SolcastProvider;
