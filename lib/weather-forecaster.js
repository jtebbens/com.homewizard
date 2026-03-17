'use strict';

const fetch = require('node-fetch');

/**
 * WeatherForecaster
 * Fetches and processes weather forecast data from Open-Meteo API
 */
class WeatherForecaster {
  constructor(homey, learningEngine = null) {
    this.homey = homey;
    this.learningEngine = learningEngine;
    this.cache = null;
    this.cacheExpiry = null;
    this.log = homey.log.bind(homey);
    this.error = homey.error.bind(homey);
  }

  /**
   * Fetch weather forecast with caching
   * @param {number} [latitude]  Optional override
   * @param {number} [longitude] Optional override
   * @returns {Promise<Object>} Processed forecast data
   */
  async fetchForecast(latitude, longitude) {
    // Check cache validity (3 hours)
    if (this.cache && this.cacheExpiry && this.cacheExpiry > Date.now()) {
      this.log('Using cached weather forecast');
      return this.cache;
    }

    try {
      let loc;
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        loc = { latitude, longitude };
      } else {
        loc = await this.getLocation();
      }

      const { latitude: lat, longitude: lon } = loc;

      this.log(`Fetching weather for lat: ${lat}, lon: ${lon}`);

      const url = this._buildApiUrl(lat, lon);
      this.log(`Fetching weather from Open-Meteo: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Open-Meteo API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      await this._learnFromYesterday(data);

      this.cache = this._processForecast(data);
      this.cacheExpiry = Date.now() + (3 * 60 * 60 * 1000); // 3 hours

      this.log('Weather forecast fetched and cached successfully');

      return this.cache;
    } catch (error) {
      this.error('Failed to fetch weather forecast:', error);

      // Return cache if available, even if expired
      if (this.cache) {
        this.log('Returning stale cache due to fetch error');
        return this.cache;
      }

      // Return pessimistic default if no cache
      return this._getDefaultForecast();
    }
  }

  /**
   * Simple city lookup via Open-Meteo geocoding API
   * @param {string} name
   * @returns {Promise<{latitude:number, longitude:number, name:string} | null>}
   */
  async lookupCity(name) {
    try {
      const params = new URLSearchParams({
        name,
        count: '1',
        language: 'en',
        format: 'json'
      });

      const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
      this.log(`Geocoding city via Open-Meteo: ${url}`);

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Geocoding error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      if (!data.results || !data.results.length) {
        this.log(`No geocoding results for "${name}"`);
        return null;
      }

      const best = data.results[0];
      return {
        latitude: best.latitude,
        longitude: best.longitude,
        name: best.name
      };
    } catch (err) {
      this.error('Failed to lookup city:', err);
      return null;
    }
  }

  /**
   * Get Homey's geolocation
   * @returns {Promise<{latitude: number, longitude: number}>}
   */
  async getLocation() {
    try {
      const latitude = await this.homey.geolocation.getLatitude();
      const longitude = await this.homey.geolocation.getLongitude();

      return { latitude, longitude };
    } catch (error) {
      this.error('Failed to get Homey location:', error);
      // Default to Amsterdam if geolocation fails
      return { latitude: 52.3676, longitude: 4.9041 };
    }
  }

  /**
   * Build Open-Meteo API URL
   * @private
   */
  _buildApiUrl(latitude, longitude) {
    // NOTE: do NOT add models= here — it breaks daily (sunrise/sunset), ignores
    // forecast_days, and does not return model-specific keys anyway. Open-Meteo's
    // default best_match model gives consistent, internally coherent data.
    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      hourly: 'sunshine_duration,temperature_2m,cloud_cover,precipitation_probability,shortwave_radiation',
      daily: 'sunrise,sunset',
      past_days: '1',
      forecast_days: '3',
      timezone: 'UTC'
    });

    return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  }

  /**
   * Process raw API response into usable format
   * @private
   */
  _processForecast(rawData) {
    const now = new Date();
    const hourly = rawData.hourly;

    // Find current hour index (times are UTC, append Z for correct parsing)
    const currentIndex = hourly.time.findIndex(t =>
      new Date(`${t}Z`) > now
    );

    if (currentIndex === -1) {
      this.error('Could not find current hour in forecast data');
      return this._getDefaultForecast();
    }

    // Process hourly data (36h window: enough for tonight + full tomorrow even when run in the evening)
    const hourlyForecast = [];
    const maxHours = Math.min(36, hourly.time.length - currentIndex);

    for (let i = 0; i < maxHours; i++) {
      const idx = currentIndex + i;

      const cloudCover   = hourly.cloud_cover?.[idx] ?? 100;
      const rawRadiation = hourly.shortwave_radiation?.[idx] ?? 0;
      const biasFactor   = this.learningEngine?.getRadiationBiasFactor() ?? 1.0;
      const radiationWm2 = Math.round(rawRadiation * biasFactor); // bias-corrected
      const rawSunshineSec = hourly.sunshine_duration?.[idx] ?? 0;

      // Guard: sunshine_duration can be unreliable when cloud cover is high.
      // Taper linearly: full at ≤40% clouds, zero at ≥90% clouds.
      const cloudFactor = cloudCover <= 40 ? 1.0
        : cloudCover >= 90 ? 0.0
        : (90 - cloudCover) / 50;

      hourlyForecast.push({
        time: new Date(`${hourly.time[idx]}Z`), // Append Z — Open-Meteo returns UTC ISO without tz offset
        sunshine: (rawSunshineSec * cloudFactor) / 3600, // seconds → hours, cloud-corrected
        cloudCover,
        temp: hourly.temperature_2m?.[idx] ?? 0,
        precipProb: hourly.precipitation_probability?.[idx] ?? 0,
        radiationWm2
      });
    }

    // Extract sunrise/sunset for today and tomorrow
    const daily = rawData.daily || {};
    const todaySunrise = daily.sunrise && daily.sunrise[0] ? new Date(daily.sunrise[0]) : null;
    const todaySunset = daily.sunset && daily.sunset[0] ? new Date(daily.sunset[0]) : null;
    const tomorrowSunrise = daily.sunrise && daily.sunrise[1] ? new Date(daily.sunrise[1]) : null;
    const tomorrowSunset = daily.sunset && daily.sunset[1] ? new Date(daily.sunset[1]) : null;

    return {
      sunshineNext4Hours: this._sumSunshine(hourlyForecast, 0, 4),
      sunshineNext8Hours: this._sumSunshine(hourlyForecast, 0, 8),
      sunshineTodayRemaining: this._sumSunshineToday(hourlyForecast, now),
      sunshineTomorrow: this._sumSunshineTomorrow(hourlyForecast, now),
      todaySunrise,
      todaySunset,
      tomorrowSunrise,
      tomorrowSunset,
      hourlyForecast,
      fetchedAt: now,
      location: {
        latitude: rawData.latitude,
        longitude: rawData.longitude,
        timezone: rawData.timezone
      }
    };
  }

  /**
   * Compare yesterday's actual radiation (from past_days=1) against what was
   * forecasted for those hours, then feed the ratio into the learning engine.
   * @private
   */
  async _learnFromYesterday(rawData) {
    if (!this.learningEngine) return;

    try {
      const hourly = rawData.hourly;
      const now = new Date();

      // currentIndex = first hour > now; everything before it is "past" (includes yesterday)
      const currentIndex = hourly.time.findIndex(t => new Date(`${t}Z`) > now);
      if (currentIndex <= 0) return;

      // Identify yesterday's UTC date string
      const yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const yDate = yesterday.toISOString().slice(0, 10); // 'YYYY-MM-DD'

      // Extract yesterday's actual radiation for daylight hours (radiation > 10 W/m²)
      let actualSum = 0, actualCount = 0;
      const forecastSnapshotKey = `weatherForecastSnapshot_${yDate}`;

      for (let i = 0; i < currentIndex; i++) {
        const t = hourly.time[i];
        if (!t.startsWith(yDate)) continue;
        const rad = hourly.shortwave_radiation?.[i];
        if (typeof rad === 'number' && rad > 10) {
          actualSum += rad;
          actualCount++;
        }
      }

      if (actualCount === 0) return; // no daylight data for yesterday

      const actualAvg = actualSum / actualCount;

      // Load yesterday's forecasted radiation snapshot (saved on previous fetch)
      const snapshot = this.homey.settings.get(forecastSnapshotKey);
      if (!snapshot || typeof snapshot.forecastAvgWm2 !== 'number') {
        this.log(`No forecast snapshot for ${yDate} — skipping bias learning`);
      } else {
        await this.learningEngine.recordRadiationAccuracy(snapshot.forecastAvgWm2, actualAvg);
        this.log(`Radiation bias for ${yDate}: forecast=${snapshot.forecastAvgWm2.toFixed(0)} actual=${actualAvg.toFixed(0)} W/m²`);
      }

      // Save today's forecasted radiation as snapshot for tomorrow's comparison
      const todayDate = now.toISOString().slice(0, 10);
      const todayKey = `weatherForecastSnapshot_${todayDate}`;
      let todaySum = 0, todayCount = 0;

      for (let i = currentIndex; i < Math.min(currentIndex + 24, hourly.time.length); i++) {
        const t = hourly.time[i];
        if (!t.startsWith(todayDate)) break;
        const rad = hourly.shortwave_radiation?.[i];
        if (typeof rad === 'number' && rad > 10) {
          todaySum += rad;
          todayCount++;
        }
      }

      if (todayCount > 0) {
        this.homey.settings.set(todayKey, { forecastAvgWm2: todaySum / todayCount, savedAt: Date.now() });
      }

      // Clean up old snapshots (keep last 3 days)
      for (let d = 3; d <= 7; d++) {
        const old = new Date(now);
        old.setUTCDate(old.getUTCDate() - d);
        this.homey.settings.unset(`weatherForecastSnapshot_${old.toISOString().slice(0, 10)}`);
      }

    } catch (err) {
      this.error('_learnFromYesterday error:', err.message);
    }
  }

  /**
   * Sum sunshine hours for a range
   * @private
   */
  _sumSunshine(forecast, startHour, hours) {
    let total = 0;
    for (let i = startHour; i < startHour + hours && i < forecast.length; i++) {
      total += forecast[i].sunshine;
    }
    return total;
  }

  /**
   * Sum remaining sunshine for today
   * @private
   */
  _sumSunshineToday(forecast, now) {
    let total = 0;
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    for (const hour of forecast) {
      if (hour.time <= endOfDay) {
        total += hour.sunshine;
      } else {
        break;
      }
    }

    return total;
  }

  /**
   * Sum sunshine for tomorrow
   * @private
   */
  _sumSunshineTomorrow(forecast, now) {
    let total = 0;
    const startOfTomorrow = new Date(now);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
    startOfTomorrow.setHours(0, 0, 0, 0);

    const endOfTomorrow = new Date(startOfTomorrow);
    endOfTomorrow.setHours(23, 59, 59, 999);

    for (const hour of forecast) {
      if (hour.time >= startOfTomorrow && hour.time <= endOfTomorrow) {
        total += hour.sunshine;
      }
    }

    return total;
  }

  /**
   * Calculate sunshine score (0-100)
   * Higher score means better sunshine availability
   */
  calculateSunScore(weather) {
    const next4h = weather.sunshineNext4Hours;
    const today = weather.sunshineTodayRemaining;
    const tomorrow = weather.sunshineTomorrow;

    let score = 0;

    // Immediate sun (next 4h) = 50 points max
    // Full 4 hours of sun = 50 points
    score += Math.min(50, (next4h / 4) * 50);

    // Rest of today = 25 points max
    // 8 hours of sun = 25 points
    score += Math.min(25, (today / 8) * 25);

    // Tomorrow = 25 points max
    // 10 hours of sun = 25 points
    score += Math.min(25, (tomorrow / 10) * 25);

    return Math.round(score);
  }

  /**
   * Get default forecast when API fails
   * @private
   */
  _getDefaultForecast() {
    const now = new Date();
    return {
      sunshineNext4Hours: 0,
      sunshineNext8Hours: 0,
      sunshineTodayRemaining: 0,
      sunshineTomorrow: 0,
      hourlyForecast: [],
      fetchedAt: now,
      location: null
    };
  }

  /**
   * Invalidate cache (useful for testing or forced refresh)
   */
  invalidateCache() {
    this.cache = null;
    this.cacheExpiry = null;
    this.log('Weather cache invalidated');
  }
}

module.exports = WeatherForecaster;
