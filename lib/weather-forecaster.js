'use strict';

const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');

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
  async fetchForecast(latitude, longitude, tilt = null, azimuth = null) {
    // Check in-memory cache first (3 hours)
    if (this.cache && this.cacheExpiry && this.cacheExpiry > Date.now()) {
      this.log('Using cached weather forecast');
      return this.cache;
    }

    // On restart, try to restore from persistent settings cache before hitting the API
    if (!this.cache) {
      const restored = this._loadCache();
      if (restored) {
        this.cache       = restored.cache;
        this.cacheExpiry = restored.expiry;
        this.log(`Restored weather forecast from settings (expires in ${Math.round((restored.expiry - Date.now()) / 60000)}min)`);
        return this.cache;
      }
    }

    // Deduplicate concurrent fetch calls (e.g. policy check + onSettings firing simultaneously)
    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._doFetch(latitude, longitude, tilt, azimuth)
      .finally(() => { this._fetchPromise = null; });
    return this._fetchPromise;
  }

  async _doFetch(latitude, longitude, tilt, azimuth) {
    try {
      let loc;
      if (typeof latitude === 'number' && typeof longitude === 'number') {
        loc = { latitude, longitude };
      } else {
        loc = await this.getLocation();
      }

      const { latitude: lat, longitude: lon } = loc;
      this.log(`Fetching weather for lat: ${lat}, lon: ${lon}`);

      const useTilted = typeof tilt === 'number' && typeof azimuth === 'number';

      // Run all API calls in parallel
      const [ensembleResult, standardResult, tiltedResult] = await Promise.allSettled([
        this._fetchEnsembleRadiation(lat, lon),
        this._fetchStandardHourly(lat, lon),
        useTilted ? this._fetchTiltedRadiation(lat, lon, tilt, azimuth) : Promise.resolve(null)
      ]);

      // Standard hourly + daily is required
      if (standardResult.status === 'rejected') {
        throw standardResult.reason;
      }

      const ensembleData = ensembleResult.status === 'fulfilled' ? ensembleResult.value : null;
      const standardData = standardResult.value;
      const tiltedData = tiltedResult.status === 'fulfilled' ? tiltedResult.value : null;

      if (!ensembleData) {
        this.error('Ensemble radiation fetch failed, falling back to standard shortwave_radiation:', ensembleResult.reason);
      }

      const rawData = this._mergeApiResponses(ensembleData, standardData, tiltedData, lat, lon);

      await this._learnFromYesterday(rawData);

      const newForecast = this._processForecast(rawData);
      this.cache = this._blendForecast(this.cache, newForecast, !ensembleData);
      this.cacheExpiry = Date.now() + (60 * 60 * 1000); // 1 hour

      this._saveCache();
      this.log('Weather forecast fetched and cached successfully');
      return this.cache;
    } catch (error) {
      this.error('Failed to fetch weather forecast:', error);

      // Return in-memory cache if available, even if expired
      if (this.cache) {
        this.log('Returning stale in-memory cache due to fetch error');
        return this.cache;
      }

      // On restart: try persistent cache even if expired (max 24h stale)
      const stale = this._loadStaleCache(24 * 60 * 60 * 1000);
      if (stale) {
        this.cache = stale;
        this.log('Returning stale persistent cache due to fetch error (API unavailable)');
        return this.cache;
      }

      // Return pessimistic default if no cache at all
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

      const res = await fetchWithTimeout(url, {}, 10000);
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
   * Fetch shortwave_radiation from 4-model ensemble (ECMWF, GFS, ICON, KNMI Harmonie) in parallel.
   * KNMI Harmonie AROME Netherlands: 2km resolution, hourly updates, 2.5-day horizon — improves
   * accuracy for partial cloud cover in NL. Falls back gracefully if model returns no data.
   * Models= param is isolated here because it conflicts with daily= (no sunrise/sunset)
   * and causes all variables to return with model-specific suffixes.
   * @private
   */
  async _fetchEnsembleRadiation(lat, lon) {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      hourly: 'shortwave_radiation',
      models: 'ecmwf_ifs04,gfs_seamless,icon_seamless,knmi_harmonie_arome_netherlands',
      past_days: '1',
      forecast_days: '3',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching ensemble radiation: ${url}`);
    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) throw new Error(`Ensemble API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Fetch all non-radiation hourly variables + daily sunrise/sunset.
   * Also includes shortwave_radiation as fallback if ensemble fetch fails.
   * @private
   */
  async _fetchStandardHourly(lat, lon) {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      hourly: 'shortwave_radiation,sunshine_duration,temperature_2m,cloud_cover,precipitation_probability,weather_code',
      daily: 'sunrise,sunset',
      past_days: '1',
      forecast_days: '3',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching standard hourly: ${url}`);
    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) throw new Error(`Standard API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Fetch panel-angle-adjusted irradiance (only when tilt/azimuth are configured).
   * Uses best_match model — not all models support global_tilted_irradiance.
   * @private
   */
  async _fetchTiltedRadiation(lat, lon, tilt, azimuth) {
    const params = new URLSearchParams({
      latitude: lat.toString(),
      longitude: lon.toString(),
      hourly: 'global_tilted_irradiance',
      tilt: tilt.toString(),
      azimuth: azimuth.toString(),
      past_days: '1',
      forecast_days: '3',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching tilted radiation (tilt=${tilt}°, az=${azimuth}°): ${url}`);
    const res = await fetchWithTimeout(url, {}, 10000);
    if (!res.ok) throw new Error(`Tilted API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Merge ensemble, standard, and optional tilted API responses into a single
   * rawData object compatible with _processForecast and _learnFromYesterday.
   * @private
   */
  _mergeApiResponses(ensembleData, standardData, tiltedData, lat, lon) {
    const ENSEMBLE_MODELS = ['ecmwf_ifs04', 'gfs_seamless', 'icon_seamless', 'knmi_harmonie_arome_netherlands'];
    const times = standardData.hourly.time;

    let shortwave_radiation;
    if (ensembleData) {
      // Average shortwave_radiation across all models that returned data
      shortwave_radiation = times.map((_, i) => {
        let sum = 0;
        let count = 0;
        for (const model of ENSEMBLE_MODELS) {
          const val = ensembleData.hourly[`shortwave_radiation_${model}`]?.[i];
          if (typeof val === 'number') { sum += val; count++; }
        }
        return count > 0 ? Math.round(sum / count) : 0;
      });
      const sampleAvg = shortwave_radiation.slice(0, 24).filter(v => v > 0);
      if (sampleAvg.length > 0) {
        this.log(`Ensemble radiation averaged from ${ENSEMBLE_MODELS.length} models (sample avg: ${Math.round(sampleAvg.reduce((a, b) => a + b, 0) / sampleAvg.length)} W/m²)`);
      }
    } else {
      // Fallback: use standard single-model shortwave_radiation
      shortwave_radiation = standardData.hourly.shortwave_radiation;
    }

    return {
      latitude: lat,
      longitude: lon,
      timezone: standardData.timezone || 'UTC',
      hourly: {
        time: times,
        shortwave_radiation,
        sunshine_duration: standardData.hourly.sunshine_duration,
        temperature_2m: standardData.hourly.temperature_2m,
        cloud_cover: standardData.hourly.cloud_cover,
        precipitation_probability: standardData.hourly.precipitation_probability,
        weather_code: standardData.hourly.weather_code,
        ...(tiltedData ? { global_tilted_irradiance: tiltedData.hourly.global_tilted_irradiance } : {})
      },
      daily: standardData.daily
    };
  }

  /**
   * Process raw API response into usable format
   * @private
   */
  _blendForecast(oldCache, newForecast, ensembleFallback = false) {
    if (!oldCache) return newForecast;

    const α = 0.6;
    const now = Date.now();

    const oldProfileMap = new Map(oldCache.dailyProfiles.map(p => [p.time.getTime(), p]));
    const oldHourlyMap  = new Map(oldCache.hourlyForecast.map(p => [p.time.getTime(), p]));

    const dailyProfiles = newForecast.dailyProfiles.map(slot => {
      if (slot.time.getTime() <= now) {
        // Past slots: when ensemble timed out, keep cached radiation to avoid jumps from GHI fallback
        if (ensembleFallback) {
          const old = oldProfileMap.get(slot.time.getTime());
          if (old) return { ...slot, radiationWm2: old.radiationWm2, sunshine: old.sunshine };
        }
        return slot;
      }
      const old = oldProfileMap.get(slot.time.getTime());
      if (!old) return slot;
      return { ...slot,
        radiationWm2: Math.round(α * slot.radiationWm2 + (1 - α) * old.radiationWm2),
        sunshine:               α * slot.sunshine      + (1 - α) * old.sunshine,
      };
    });

    const hourlyForecast = newForecast.hourlyForecast.map(slot => {
      const old = oldHourlyMap.get(slot.time.getTime());
      if (!old) return slot;
      if (slot.time.getTime() <= now && ensembleFallback) {
        return { ...slot, radiationWm2: old.radiationWm2, sunshine: old.sunshine };
      }
      return { ...slot,
        radiationWm2: Math.round(α * slot.radiationWm2 + (1 - α) * old.radiationWm2),
        sunshine:               α * slot.sunshine      + (1 - α) * old.sunshine,
      };
    });

    const blendedNow = new Date(now);
    return {
      ...newForecast,
      dailyProfiles,
      hourlyForecast,
      sunshineNext4Hours:      this._sumSunshine(hourlyForecast, 0, 4),
      sunshineNext8Hours:      this._sumSunshine(hourlyForecast, 0, 8),
      sunshineTodayRemaining:  this._sumSunshineToday(hourlyForecast, blendedNow),
      sunshineTomorrow:        this._sumSunshineTomorrow(hourlyForecast, blendedNow),
    };
  }

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

    const biasFactor = this.learningEngine?.getRadiationBiasFactor() ?? 1.0;

    // Extract sunrise/sunset for today and tomorrow (needed for boundary correction below).
    // Open-Meteo returns daily values as "YYYY-MM-DDTHH:MM" without timezone suffix when
    // timezone=UTC is requested — must append Z to parse as UTC, not local time.
    const daily = rawData.daily || {};
    const parseDailyTime = v => v ? new Date(`${v}Z`) : null;
    // With past_days=1 the daily array is [yesterday, today, tomorrow] → indices 1 and 2.
    const todaySunrise    = parseDailyTime(daily.sunrise?.[1]);
    const todaySunset     = parseDailyTime(daily.sunset?.[1]);
    const tomorrowSunrise = parseDailyTime(daily.sunrise?.[2]);
    const tomorrowSunset  = parseDailyTime(daily.sunset?.[2]);

    // All available sunrise times for sunrise boundary correction (see below).
    const allSunrises = (daily.sunrise || []).map(v => parseDailyTime(v)).filter(Boolean);

    // Process next 36 hourly slots.
    const hourlyForecast = [];
    const maxHours = Math.min(36, hourly.time.length - currentIndex);

    for (let i = 0; i < maxHours; i++) {
      const idx = currentIndex + i;

      const cloudCover     = hourly.cloud_cover?.[idx] ?? 100;
      const rawRadiation   = (hourly.global_tilted_irradiance?.[idx] ?? hourly.shortwave_radiation?.[idx]) ?? 0;
      const rawSunshineSec = hourly.sunshine_duration?.[idx] ?? 0;
      const weatherCode    = hourly.weather_code?.[idx] ?? 0;
      const precipProb     = hourly.precipitation_probability?.[idx] ?? 0;

      // Weather-based PV attenuation: fog, snow cover, heavy rain, thunderstorms.
      // Open-Meteo GHI already accounts for cloud cover, but these phenomena
      // cause additional losses that the irradiance model doesn't capture
      // (e.g. snow on panels, extreme scattering from heavy precipitation).
      const wxFactor = WeatherForecaster._weatherAttenuation(weatherCode, precipProb);

      // Cloud factor for sunshine_duration only — shortwave_radiation already
      // includes cloud attenuation (Open-Meteo GHI), so applying cloudFactor to
      // radiation would double-penalise clouds and create artificial dips.
      const cloudFactor = cloudCover <= 40 ? 1.0
        : cloudCover >= 90 ? 0.0
        : (90 - cloudCover) / 50;

      hourlyForecast.push({
        time: new Date(`${hourly.time[idx]}Z`), // Append Z — Open-Meteo returns UTC ISO without tz offset
        sunshine: (rawSunshineSec * cloudFactor * wxFactor) / 3600, // seconds → hours (max 1h per slot)
        cloudCover,
        temp: hourly.temperature_2m?.[idx] ?? 0,
        precipProb,
        weatherCode,
        radiationWm2: Math.round(rawRadiation * biasFactor * wxFactor),
      });
    }

    // Sunrise boundary correction: Open-Meteo averages radiation over the full 60-min slot,
    // so the slot containing sunrise (e.g., 05:00–06:00 with sunrise at 05:27) only has
    // 33 min of sun diluted over 60 min → ~55% of peak value. Scale up to the expected
    // peak irradiance so PV forecast and optimizer aren't penalised for partial sunrise slots.
    // sunshine_duration already reflects actual sun minutes, so no correction needed there.
    for (const slot of hourlyForecast) {
      const slotStartMs = slot.time.getTime();
      const slotEndMs   = slotStartMs + 3_600_000;
      for (const sunrise of allSunrises) {
        const sunriseMs = sunrise.getTime();
        if (sunriseMs > slotStartMs && sunriseMs < slotEndMs) {
          const sunMinutes = (slotEndMs - sunriseMs) / 60_000;
          if (sunMinutes >= 2 && sunMinutes <= 58) {
            slot.radiationWm2 = Math.round(slot.radiationWm2 * 60 / sunMinutes);
          }
        }
      }
    }

    // Build full-day radiation profiles for today + tomorrow (all 24h, including past hours
    // from past_days=1 data). Used for PV visualization — hourlyForecast only has future hours.
    const todayUtcDate = now.toISOString().slice(0, 10);
    const tomorrowDate = new Date(now);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrowUtcDate = tomorrowDate.toISOString().slice(0, 10);

    const dailyProfiles = [];
    for (let i = 0; i < hourly.time.length; i++) {
      const t = hourly.time[i];
      const dateStr = t.slice(0, 10);
      if (dateStr !== todayUtcDate && dateStr !== tomorrowUtcDate) continue;

      const rawRadiation   = (hourly.global_tilted_irradiance?.[i] ?? hourly.shortwave_radiation?.[i]) ?? 0;
      const rawSunshineSec = hourly.sunshine_duration?.[i] ?? 0;
      const cloudCover     = hourly.cloud_cover?.[i] ?? 100;
      const wCode          = hourly.weather_code?.[i] ?? 0;
      const pProb          = hourly.precipitation_probability?.[i] ?? 0;
      const wxF     = WeatherForecaster._weatherAttenuation(wCode, pProb);
      const cloudF  = cloudCover <= 40 ? 1.0 : cloudCover >= 90 ? 0.0 : (90 - cloudCover) / 50;

      dailyProfiles.push({
        time:         new Date(`${t}Z`),
        cloudCover,
        sunshine:     (rawSunshineSec * cloudF * wxF) / 3600,
        radiationWm2: Math.round(rawRadiation * biasFactor * wxF),
        weatherCode:  wCode
      });
    }

    // Apply the same sunrise boundary correction to dailyProfiles (used for past-hours
    // PV chart via learned yield factors in device.js pvForecastByDay).
    for (const slot of dailyProfiles) {
      const slotStartMs = slot.time.getTime();
      const slotEndMs   = slotStartMs + 3_600_000;
      for (const sunrise of allSunrises) {
        const sunriseMs = sunrise.getTime();
        if (sunriseMs > slotStartMs && sunriseMs < slotEndMs) {
          const sunMinutes = (slotEndMs - sunriseMs) / 60_000;
          if (sunMinutes >= 2 && sunMinutes <= 58) {
            slot.radiationWm2 = Math.round(slot.radiationWm2 * 60 / sunMinutes);
          }
        }
      }
    }

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
      dailyProfiles,
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

      // Use GTI when available (tilt/azimuth configured) — same source as _processForecast uses.
      // Bias factor must be trained on the same radiation quantity we predict with.
      const useGti = Array.isArray(hourly.global_tilted_irradiance);
      const radField = h => useGti
        ? (hourly.global_tilted_irradiance?.[h] ?? hourly.shortwave_radiation?.[h])
        : hourly.shortwave_radiation?.[h];

      // Extract yesterday's actual radiation for daylight hours (radiation > 10 W/m²)
      let actualSum = 0, actualCount = 0;

      for (let i = 0; i < currentIndex; i++) {
        const t = hourly.time[i];
        if (!t.startsWith(yDate)) continue;
        const rad = radField(i);
        if (typeof rad === 'number' && rad > 10) {
          actualSum += rad;
          actualCount++;
        }
      }

      if (actualCount === 0) return; // no daylight data for yesterday

      const actualAvg = actualSum / actualCount;

      // Load yesterday's forecasted radiation snapshot from device store (survives app redeploys)
      const snapshot = this.learningEngine.getForecastSnapshot(yDate);
      if (!snapshot || typeof snapshot.forecastAvgWm2 !== 'number') {
        this.log(`No forecast snapshot for ${yDate} — skipping bias learning`);
      } else {
        await this.learningEngine.recordRadiationAccuracy(snapshot.forecastAvgWm2, actualAvg);
        this.log(`Radiation bias for ${yDate} (${useGti ? 'GTI' : 'GHI'}): forecast=${snapshot.forecastAvgWm2.toFixed(0)} actual=${actualAvg.toFixed(0)} W/m²`);
      }

      // Save today's full-day radiation as snapshot for tomorrow's comparison.
      // Use ALL slots for today (past + future) so the snapshot always covers the full
      // solar day, even when this runs late in the afternoon after peak hours have passed.
      const todayDate = now.toISOString().slice(0, 10);
      let todaySum = 0, todayCount = 0;

      for (let i = 0; i < hourly.time.length; i++) {
        const t = hourly.time[i];
        if (!t.startsWith(todayDate)) continue;
        const rad = radField(i);
        if (typeof rad === 'number' && rad > 10) {
          todaySum += rad;
          todayCount++;
        }
      }

      if (todayCount > 0) {
        await this.learningEngine.saveForecastSnapshot(todayDate, todaySum / todayCount);
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
    if (this._saveCacheTimer) {
      clearTimeout(this._saveCacheTimer);
      this._saveCacheTimer = null;
    }
    this.homey.settings.unset('weather_forecast_cache');
    this.log('Weather cache invalidated');
  }

  _saveCache() {
    // Debounce 5min — homey.settings.set allocates ~30 MB V8 heap per call
    // (framework-internal, independent of payload). In-memory this.cache is
    // already the primary source; persistence is only for restart recovery.
    if (this._saveCacheTimer) clearTimeout(this._saveCacheTimer);
    this._saveCacheTimer = setTimeout(() => {
      this._saveCacheTimer = null;
      try {
        this.homey.settings.set('weather_forecast_cache', {
          expiry: this.cacheExpiry,
          cache:  this.cache
        });
      } catch (e) {
        this.error('Failed to persist weather cache:', e.message);
      }
    }, 5 * 60 * 1000);
  }

  // Like _loadCache but accepts stale data up to maxAgeMs old (for API-failure fallback)
  _loadStaleCache(maxAgeMs) {
    try {
      const stored = this.homey.settings.get('weather_forecast_cache');
      if (!stored || !stored.expiry) return null;
      if (stored.expiry <= Date.now() - maxAgeMs) return null; // too old
      return this._reviveCache(stored.cache);
    } catch (e) {
      return null;
    }
  }

  _loadCache() {
    try {
      const stored = this.homey.settings.get('weather_forecast_cache');
      if (!stored || !stored.expiry || stored.expiry <= Date.now()) return null;
      return { cache: this._reviveCache(stored.cache), expiry: stored.expiry };
    } catch (e) {
      this.error('Failed to load weather cache from settings:', e.message);
      return null;
    }
  }

  _reviveCache(c) {
    const revive = v => v ? new Date(v) : null;
    if (Array.isArray(c.hourlyForecast)) {
      c.hourlyForecast.forEach(h => { h.time = revive(h.time); });
    }
    if (Array.isArray(c.dailyProfiles)) {
      c.dailyProfiles.forEach(h => { h.time = revive(h.time); });
    }
    c.todaySunrise    = revive(c.todaySunrise);
    c.todaySunset     = revive(c.todaySunset);
    c.tomorrowSunrise = revive(c.tomorrowSunrise);
    c.tomorrowSunset  = revive(c.tomorrowSunset);
    if (c.fetchedAt)  c.fetchedAt = revive(c.fetchedAt);
    return c;
  }

  /**
   * PV attenuation factor based on WMO weather codes.
   * Returns 0–1 multiplier for radiation and sunshine.
   *
   * Open-Meteo GHI accounts for clouds but misses:
   * - Ground-level fog (not a cloud layer)
   * - Snow cover on panels (blocks PV even if sun shines)
   * - Extreme precipitation scattering
   * - Thunderstorm turbulence / hail
   *
   * WMO code groups:
   *   45, 48       — Fog / rime fog → 0.12
   *   71, 73       — Light/moderate snowfall → 0.30 (partial panel coverage)
   *   75, 77       — Heavy snow / snow grains → 0.05 (near-total panel blockage)
   *   85, 86       — Snow showers (light/heavy) → 0.15
   *   65, 67       — Heavy rain / freezing rain → 0.50 (severe scattering)
   *   95, 96, 99   — Thunderstorm (±hail) → 0.30 (extreme cloud + scattering)
   *
   * precipProb is used as a confidence gate: if probability < 40%, moderate the
   * attenuation (blend towards 1.0) since the event may not materialise.
   *
   * @param {number} wmoCode - WMO weather code from Open-Meteo
   * @param {number} precipProb - Precipitation probability 0–100
   * @returns {number} Attenuation factor 0–1 (1 = no attenuation)
   * @static
   */
  /**
   * Fetch 2-hour precipitation forecast from Buienradar (5-min intervals).
   * Returns [{time: Date, mmPerHour: number, factor: number}] or [] on error.
   */
  async fetchBuienradar(lat, lon) {
    if (this._buienradarCache && this._buienradarExpiry > Date.now()) {
      return this._buienradarCache;
    }
    try {
      const url = `https://gpsgadget.buienradar.nl/data/raintext?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
      const response = await fetchWithTimeout(url, {}, 8000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const now = Date.now();
      const result = text.trim().split('\n').map((line, i) => {
        const value = parseInt(line.split('|')[0], 10);
        const mmPerHour = value > 0 ? Math.pow(10, (value - 109) / 32) : 0;
        return { time: new Date(now + i * 5 * 60000), mmPerHour, factor: WeatherForecaster._buienradarFactor(mmPerHour) };
      }).filter(s => !isNaN(s.mmPerHour));
      this._buienradarCache  = result;
      this._buienradarExpiry = now + 15 * 60000;
      return result;
    } catch (err) {
      this.error('Buienradar fetch failed:', err.message);
      return [];
    }
  }

  static _buienradarFactor(mmh) {
    if (mmh < 0.1) return 1.00;
    if (mmh < 0.5) return 0.90;
    if (mmh < 2.0) return 0.75;
    if (mmh < 5.0) return 0.55;
    if (mmh < 10)  return 0.35;
    if (mmh < 20)  return 0.20;
    return 0.10;
  }

  static _weatherAttenuation(wmoCode, precipProb = 100) {
    let factor = 1.0;
    switch (wmoCode) {
      case 45: case 48:                 factor = 0.12; break; // fog / rime fog
      case 75: case 77:                 factor = 0.05; break; // heavy snow / snow grains
      case 71: case 73:                 factor = 0.30; break; // light/moderate snow
      case 85:                          factor = 0.20; break; // light snow showers
      case 86:                          factor = 0.10; break; // heavy snow showers
      case 65: case 67:                 factor = 0.50; break; // heavy rain / freezing rain
      case 95: case 96: case 99:        factor = 0.30; break; // thunderstorm (±hail)
      default:                          return 1.0;           // no special attenuation
    }
    // Confidence gate: if precipitation probability is low, blend towards 1.0
    // (the severe weather may not materialise). Fog codes (45, 48) bypass this
    // since precipProb doesn't apply to fog events.
    if (wmoCode !== 45 && wmoCode !== 48 && precipProb < 40) {
      const confidence = precipProb / 40; // 0 at 0%, 1 at 40%+
      factor = 1.0 - (1.0 - factor) * confidence;
    }
    return factor;
  }
}

module.exports = WeatherForecaster;
