'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

const CACHE_KEY   = 'solcast_forecast_cache';
const CACHE_TTL   = 3 * 60 * 60 * 1000; // 3 hours → ~8 calls/day, 2 margin on free tier (10/day)
const BASE_URL    = 'https://api.solcast.com.au';

/**
 * SolcastProvider — fetches rooftop PV forecast from Solcast API.
 *
 * Caches results in homey.settings to survive app restarts.
 * Only fetches when cache is older than CACHE_TTL (6h).
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

    return this._fetch(apiKey, resourceId);
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
      pvPowerW:  Math.round((f.pv_estimate ?? 0) * 1000), // kW → W
    }));
  }

  _loadCache() {
    try {
      const stored = this.homey.settings.get(CACHE_KEY);
      if (!stored || !stored.fetchedAt || !stored.data) return null;
      if (Date.now() - stored.fetchedAt > CACHE_TTL) return null;
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
