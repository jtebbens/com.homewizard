'use strict';

const https = require('https');
const fetchWithTimeout = require('../includes/utils/fetchWithTimeout');
const fetchWithRetry = require('../includes/utils/fetchWithRetry');
const { fetchKnmiObservations, fetchKnmiCloudObservations, MAX_OKTA_DIST_KM } = require('./knmi-stations');
const userdata = require('./userdata-store');
const { classifyKt } = require('./kt-buckets');

// Cache file on /userdata, not a settings key: settings.set ships the whole settings object, so
// this 15.8 kB rode along on every unrelated write. See lib/userdata-store.js.
const CACHE_FILE = 'weather-forecast-cache';

// Reuse TCP connections for pv.tebbens.net upwind fetches (4 parallel calls per weather update)
const _upwindAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// Satellite-specific yield factors: actual_panelW / sat_ghi per UTC hour.
// Derived from 327 matched hourly pairs (Jun 16-22 2026). Implicitly captures
// GHI→GTI transposition + panel efficiency for this installation's tilt/azimuth.
const { SAT_YF_PRIOR, SAT_MIN_ELEV_DEG, GTI_GHI_CLAMP_MIN } = require('./sat-yield-factors');

// Open-Meteo ensemble models blended into shortwave_radiation. Single source of truth —
// used for the fetch param, the weighted blend, and the per-model radiation arrays.
// ecmwf_ifs = IFS HRES 9km (not ecmwf_ifs04 — that identifier is retired/dead, returns
// null radiation for every slot; verified live 2026-07-09, see project_ecmwf_ensemble_model).
const ENSEMBLE_MODELS = ['meteofrance_arpege_europe', 'gfs_seamless', 'icon_seamless', 'knmi_harmonie_arome_netherlands', 'ecmwf_ifs'];

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
    // Active clear-sky denominator for every kt this instance hands out. Set by the device from
    // the `pv_clearsky_haurwitz` setting each policy run; see `_clearSkyGhi`. Kept here rather
    // than threaded through every getter so KNMI kt and satellite kt cannot drift apart.
    this.clearSkyModel = 'simple';
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
      this._maybeRecordKnmiActual(latitude, longitude);
      await this._applySatelliteIfActive();
      return this.cache;
    }

    // On restart, try to restore from persistent settings cache before hitting the API
    if (!this.cache) {
      const restored = this._loadCache();
      if (restored) {
        this.cache       = restored.cache;
        this.cacheExpiry = restored.expiry;
        this.log(`Restored weather forecast from settings (expires in ${Math.round((restored.expiry - Date.now()) / 60000)}min)`);
        this._maybeRecordKnmiActual(latitude, longitude);
        await this._applySatelliteIfActive();
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
      // Cached for _satCoords() — the satellite elevation gate needs real coords
      // synchronously, and this is the one resolution point already shared by the
      // whole forecast pipeline (ensemble/standard/tilted fetches below).
      this._lastLat = lat;
      this._lastLon = lon;

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

      const modelWeights = this.learningEngine?.getModelWeights?.() ?? null;
      const rawData = this._mergeApiResponses(ensembleData, standardData, tiltedData, lat, lon, modelWeights, useTilted ? tilt : null, useTilted ? azimuth : null);
      // ensembleData no longer needed — perModelGhiAvgToday extracted into rawData during merge

      await this._learnFromYesterday(rawData);
      await this._maybeRecordKnmiActual(lat, lon);

      const newForecast = this._processForecast(rawData);
      this.cache = this._blendForecast(this.cache, newForecast, !ensembleData);
      this.cacheExpiry = Date.now() + (60 * 60 * 1000); // 1 hour

      if (this._satUrl) {
        try {
          const sat = await this._fetchSatelliteNowcast(this._satUrl);
          if (sat) this._applySatelliteOverlay(sat);
        } catch (_) { /* silent */ }
      }

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
      hourly: 'shortwave_radiation,diffuse_radiation,direct_normal_irradiance,cloud_cover,cloud_cover_low,weather_code,precipitation_probability',
      models: ENSEMBLE_MODELS.join(','),
      past_days: '1',
      forecast_days: '2',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching ensemble radiation: ${url}`);
    const res = await fetchWithRetry(url, {}, 15000);
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
      hourly: 'shortwave_radiation,sunshine_duration,temperature_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,cape,cin,wind_gusts_10m,freezing_level_height,uv_index,precipitation_probability,precipitation,weather_code,windspeed_10m,winddirection_10m',
      daily: 'sunrise,sunset',
      past_days: '1',
      forecast_days: '2',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching standard hourly: ${url}`);
    const res = await fetchWithRetry(url, {}, 20000);
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
      forecast_days: '2',
      timezone: 'UTC'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    this.log(`Fetching tilted radiation (tilt=${tilt}°, az=${azimuth}°): ${url}`);
    const res = await fetchWithRetry(url, {}, 10000);
    if (!res.ok) throw new Error(`Tilted API error: ${res.status} ${res.statusText}`);
    return res.json();
  }

  /**
   * Merge ensemble, standard, and optional tilted API responses into a single
   * rawData object compatible with _processForecast and _learnFromYesterday.
   * @private
   */
  _mergeApiResponses(ensembleData, standardData, tiltedData, lat, lon, modelWeights = null, tilt = null, azimuth = null) {
    const times = standardData.hourly.time;
    // Weights from learned per-model accuracy; falls back to equal weights if unavailable.
    // Shared by the radiation blend below and the cloud_cover blend further down.
    const equalW = 1 / ENSEMBLE_MODELS.length;
    const w = modelWeights ?? Object.fromEntries(ENSEMBLE_MODELS.map(m => [m, equalW]));

    let shortwave_radiation;
    if (ensembleData) {
      // Weighted blend across models (p50). Disagreement (std) is tracked for observability
      // only — it is NOT discounted into the point forecast (two-sided uncertainty ≠ downward bias).
      let spreadSlotsAdjusted = 0;
      shortwave_radiation = times.map((_, i) => {
        const modelVals = ENSEMBLE_MODELS
          .map(m => ({ m, v: ensembleData.hourly[`shortwave_radiation_${m}`]?.[i] }))
          .filter(({ v }) => typeof v === 'number');
        if (modelVals.length === 0) return 0;
        // Weighted mean
        const totalW = modelVals.reduce((s, { m }) => s + (w[m] ?? equalW), 0);
        const wMean = modelVals.reduce((s, { m, v }) => s + (w[m] ?? equalW) * v, 0) / totalW;
        if (modelVals.length < 2) return Math.round(wMean);
        // Model disagreement is two-sided uncertainty, not a downward bias — do NOT discount
        // the p50. Track spread for observability only (count slots where models diverge).
        const uMean = modelVals.reduce((s, { v }) => s + v, 0) / modelVals.length;
        const std = Math.sqrt(modelVals.reduce((s, { v }) => s + (v - uMean) ** 2, 0) / modelVals.length);
        if (std > 30) spreadSlotsAdjusted++;
        return Math.round(wMean);
      });
      const sampleAvg = shortwave_radiation.slice(0, 24).filter(v => v > 0);
      if (sampleAvg.length > 0) {
        const wLog = modelWeights
          ? ENSEMBLE_MODELS.map(m => `${m.replace('knmi_harmonie_arome_netherlands','knmi').replace('_seamless','')}=${(w[m]*100).toFixed(0)}%`).join(' ')
          : 'equal';
        this.log(`Ensemble radiation blended from ${ENSEMBLE_MODELS.length} models [${wLog}] (sample avg: ${Math.round(sampleAvg.reduce((a, b) => a + b, 0) / sampleAvg.length)} W/m²${spreadSlotsAdjusted > 0 ? `, spread-detected ${spreadSlotsAdjusted} slots (p50 not discounted)` : ''})`);
        // [OMGHI] per-slot forecast dump for satellite skill-comparison (same unit W/m² as KNMI qg).
        // One line per future hour 0-5h ahead; scraped off-Homey into a lead-time MAE harness. Observe-only.
        const _nowMs = Date.now();
        for (let i = 0; i < times.length; i++) {
          // Shift to actual data period (OM "preceding hour" convention)
          const tMs = new Date(times[i] + 'Z').getTime() - 3_600_000;
          const leadH = (tMs - _nowMs) / 3600000;
          if (leadH >= -0.5 && leadH <= 5) {
            this.log(`[OMGHI] issue=${new Date(_nowMs).toISOString()} t=${new Date(tMs).toISOString().slice(0,16)} ghi=${shortwave_radiation[i]}`);
          }
        }
      }
    } else {
      // Fallback: use standard single-model shortwave_radiation
      shortwave_radiation = standardData.hourly.shortwave_radiation;
    }

    // Cloud cover: same weighted-blend across the 4-model ensemble as radiation above — was
    // previously fetched from a separate single-model (best_match) call and passed through
    // unblended, the one signal in this pipeline that never got the ensemble treatment.
    const blendCloudField = (fieldKey) => {
      if (!ensembleData) return standardData.hourly[fieldKey];
      return times.map((_, i) => {
        const modelVals = ENSEMBLE_MODELS
          .map(m => ({ m, v: ensembleData.hourly[`${fieldKey}_${m}`]?.[i] }))
          .filter(({ v }) => typeof v === 'number');
        if (modelVals.length === 0) return standardData.hourly[fieldKey]?.[i] ?? null;
        const totalW = modelVals.reduce((s, { m }) => s + (w[m] ?? equalW), 0);
        return Math.round(modelVals.reduce((s, { m, v }) => s + (w[m] ?? equalW) * v, 0) / totalW);
      });
    };
    const cloud_cover     = blendCloudField('cloud_cover');
    const cloud_cover_low = blendCloudField('cloud_cover_low');
    const precipitation_probability = blendCloudField('precipitation_probability');

    // wxFactor (weather-attenuation for fog/snow/rain/thunderstorm): weather_code is a
    // categorical WMO code, so averaging raw codes across models is meaningless. Instead,
    // compute _weatherAttenuation PER MODEL (its own code+precip-prob), then weighted-blend
    // the resulting continuous factors — same weights as radiation/cloud_cover above.
    // weather_code itself stays single-model passthrough below (display-only, e.g. currentWmoCode).
    let wxFactorEnsemble = null;
    if (ensembleData) {
      wxFactorEnsemble = times.map((_, i) => {
        const modelFactors = ENSEMBLE_MODELS
          .map(m => {
            const code = ensembleData.hourly[`weather_code_${m}`]?.[i];
            const prob = ensembleData.hourly[`precipitation_probability_${m}`]?.[i];
            if (typeof code !== 'number') return null;
            return { m, v: WeatherForecaster._weatherAttenuation(code, prob ?? 100) };
          })
          .filter(Boolean);
        if (modelFactors.length === 0) return null;
        const totalW = modelFactors.reduce((s, { m }) => s + (w[m] ?? equalW), 0);
        return modelFactors.reduce((s, { m, v }) => s + (w[m] ?? equalW) * v, 0) / totalW;
      });
    }

    // Per-model radiation arrays aligned to `times`. When tilt/azimuth are configured,
    // values are GTI (W/m² on the panel plane) computed via isotropic transposition.
    // Without tilt/azimuth, falls back to GHI (shortwave_radiation per model).
    const perModelRadiation = {};
    const perModelGhi = {};
    if (ensembleData) {
      const useGti = typeof tilt === 'number' && typeof azimuth === 'number';
      for (const m of ENSEMBLE_MODELS) {
        perModelGhi[m] = times.map((t, i) => {
          const v = ensembleData.hourly[`shortwave_radiation_${m}`]?.[i];
          return typeof v === 'number' ? v : null;
        });
        perModelRadiation[m] = times.map((t, i) => {
          const ghi = ensembleData.hourly[`shortwave_radiation_${m}`]?.[i] ?? null;
          const dhi = ensembleData.hourly[`diffuse_radiation_${m}`]?.[i] ?? null;
          const dni = ensembleData.hourly[`direct_normal_irradiance_${m}`]?.[i] ?? null;
          // Open-Meteo omits shortwave_radiation for some past/current slots in ensemble
          // but still provides DNI+DHI. GHI is optional — only used for reflected component.
          if (!useGti) return typeof ghi === 'number' ? ghi : null;
          if (dhi == null || dni == null) return typeof ghi === 'number' ? ghi : null;
          const { elev, azimuth: solAz } = WeatherForecaster._solarElevAz(new Date(t + 'Z'), lat, lon);
          return WeatherForecaster._computeGTI(dhi, dni, ghi ?? 0, elev, solAz, tilt, azimuth);
        });
      }
    }

    return {
      latitude: lat,
      longitude: lon,
      timezone: standardData.timezone || 'UTC',
      hourly: {
        time: times,
        shortwave_radiation,
        perModelRadiation,
        perModelGhi,
        sunshine_duration: standardData.hourly.sunshine_duration,
        temperature_2m: standardData.hourly.temperature_2m,
        cloud_cover,
        cloud_cover_low,
        precipitation_probability,
        wxFactorEnsemble,
        precipitation: standardData.hourly.precipitation,
        weather_code: standardData.hourly.weather_code,
        windspeed_10m: standardData.hourly.windspeed_10m,
        winddirection_10m: standardData.hourly.winddirection_10m,
        ...(tiltedData ? { global_tilted_irradiance: tiltedData.hourly.global_tilted_irradiance } : {})
      },
      daily: standardData.daily,
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
      // Preserve observed satellite GHI across refresh: the overlay only re-fills a
      // forward window near the latest issue, so without carry-over every OM refresh
      // (~1h TTL) would wipe satGhiWm2 from past hours and the chart loses them.
      const carry = old.satGhiWm2 != null ? { satGhiWm2: old.satGhiWm2 } : {};
      if (slot.time.getTime() <= now && ensembleFallback) {
        return { ...slot, radiationWm2: old.radiationWm2, sunshine: old.sunshine, ...carry };
      }
      return { ...slot,
        radiationWm2: Math.round(α * slot.radiationWm2 + (1 - α) * old.radiationWm2),
        sunshine:               α * slot.sunshine      + (1 - α) * old.sunshine,
        ...carry,
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
    // Operational: ensemble-GTI blends the 4 per-model GTI values by learned accuracy weights
    // (rerouted from best_match-only 2026-06-07, see _processForecast below).
    const _ensWeights = this.learningEngine?.getModelWeights?.() ?? null;

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
      const cloudCoverLow  = hourly.cloud_cover_low?.[idx] ?? 0;
      const rawRadiation   = (hourly.global_tilted_irradiance?.[idx] ?? hourly.shortwave_radiation?.[idx]) ?? 0;
      const rawSunshineSec = hourly.sunshine_duration?.[idx] ?? 0;
      const weatherCode    = hourly.weather_code?.[idx] ?? 0;
      const precipProb     = hourly.precipitation_probability?.[idx] ?? 0;
      const precipMmh      = hourly.precipitation?.[idx] ?? 0;

      // Weather-based PV attenuation: fog, snow cover, heavy rain, thunderstorms.
      // Open-Meteo GHI already accounts for cloud cover, but these phenomena
      // cause additional losses that the irradiance model doesn't capture
      // (e.g. snow on panels, extreme scattering from heavy precipitation).
      const wxFactor = hourly.wxFactorEnsemble?.[idx] ?? WeatherForecaster._weatherAttenuation(weatherCode, precipProb);

      // Cloud factor for sunshine_duration only — shortwave_radiation already
      // includes cloud attenuation (Open-Meteo GHI), so applying cloudFactor to
      // radiation would double-penalise clouds and create artificial dips.
      const cloudFactor = cloudCover <= 40 ? 1.0
        : cloudCover >= 90 ? 0.0
        : (90 - cloudCover) / 50;

      // Operational radiation: ensemble-GTI (weighted per-model blend) when available,
      // else best_match GTI. Same bias/wx factors. Rerouted 2026-06-07 from best_match-only
      // after bm-vs-ens compare showed ensemble consistently better (best_match underforecasts
      // PV ~2× in afternoon; tilt users were on single best_match model).
      // gtiOverGhi: the ensemble's own GTI/GHI transposition ratio for this slot. The
      // satellite leg only observes GHI; reusing this ratio (instead of a crude Erbs
      // decomposition) keeps the sat chart/accuracy line on the same panel-plane geometry
      // as the operational OM forecast. Erbs overestimates GTI at low morning sun
      // (1/sin(elev) on an inflated DNI), which made the sat line ~20-30% too high.
      let gtiOverGhi = 1;
      const _ensOut = {};
      const ensRadiationWm2 = WeatherForecaster._ensRadiationForIndex(
        hourly, idx, biasFactor, wxFactor, _ensWeights, _ensOut);
      if (_ensOut.gtiOverGhi != null) gtiOverGhi = _ensOut.gtiOverGhi;

      // Per-slot model disagreement as a relative spread (std/mean over the ensemble
      // models, scale-invariant so the uniform bias/wx factor drops out). Feeds the DP
      // discharge-cap spread-band: where models disagree on this slot's PV, the decision
      // assumes less PV (band widens) without touching the displayed p50.
      const radiationSpreadFrac = (() => {
        if (!hourly.perModelRadiation) return 0;
        const vals = Object.values(hourly.perModelRadiation)
          .map(arr => arr?.[idx]).filter(v => typeof v === 'number');
        if (vals.length < 2) return 0;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (mean < 1) return 0;
        const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
        return Math.min(1, std / mean);
      })();

      // Open-Meteo "preceding hour" convention: T04:00 = avg during 03:00–04:00.
      // Shift to the start of the actual data period so downstream Amsterdam-hour
      // mapping and YF slot lookup align with real-time PV measurements.
      const slotTime = new Date(new Date(`${hourly.time[idx]}Z`).getTime() - 3_600_000);
      hourlyForecast.push({
        time: slotTime,
        sunshine: (rawSunshineSec * cloudFactor * wxFactor) / 3600, // seconds → hours (max 1h per slot)
        cloudCover,
        cloudCoverLow,
        temp: hourly.temperature_2m?.[idx] ?? 0,
        precipProb,
        precipMmh,
        weatherCode,
        radiationWm2: ensRadiationWm2 ?? Math.round(rawRadiation * biasFactor * wxFactor),
        gtiOverGhi,
        radiationSpreadFrac,
        perModelWm2: hourly.perModelRadiation
          ? Object.fromEntries(
              Object.entries(hourly.perModelRadiation).map(([m, arr]) => [m, arr?.[idx] ?? null])
            )
          : null,
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
      // Same "preceding hour" shift as hourlyForecast — see comment there.
      const dataTime = new Date(new Date(`${t}Z`).getTime() - 3_600_000);
      const dateStr = dataTime.toISOString().slice(0, 10);
      if (dateStr !== todayUtcDate && dateStr !== tomorrowUtcDate) continue;

      const rawRadiation   = (hourly.global_tilted_irradiance?.[i] ?? hourly.shortwave_radiation?.[i]) ?? 0;
      const rawSunshineSec = hourly.sunshine_duration?.[i] ?? 0;
      const cloudCover     = hourly.cloud_cover?.[i] ?? 100;
      const wCode          = hourly.weather_code?.[i] ?? 0;
      const pProb          = hourly.precipitation_probability?.[i] ?? 0;
      const wxF     = hourly.wxFactorEnsemble?.[i] ?? WeatherForecaster._weatherAttenuation(wCode, pProb);
      const cloudF  = cloudCover <= 40 ? 1.0 : cloudCover >= 90 ? 0.0 : (90 - cloudCover) / 50;

      // Per-slot GHI→GTI transposition ratio straight from Open-Meteo's own tilted vs
      // horizontal series. dailyProfiles spans the full day (incl. past hours), so the
      // satellite chart line can reuse this geometry for past hours too — hourlyForecast
      // is forward-only and would leave the morning on the Erbs fallback (which overshoots).
      const ghiRaw = hourly.shortwave_radiation?.[i];
      const gtiRaw = hourly.global_tilted_irradiance?.[i];
      const gtiOverGhi = (typeof gtiRaw === 'number' && typeof ghiRaw === 'number' && ghiRaw > 0)
        ? Math.max(0.3, Math.min(2.5, gtiRaw / ghiRaw)) : 1;

      dailyProfiles.push({
        time:         dataTime,
        cloudCover,
        sunshine:     (rawSunshineSec * cloudF * wxF) / 3600,
        // Same ensemble radiation the DP eats via hourlyForecast. dailyProfiles used to run
        // on the single default Open-Meteo run, so the chart's past hours were built from a
        // second, less accurate radiation series while the DP planned on the ensemble — same
        // yield factors, same formula, different irradiance underneath.
        radiationWm2: WeatherForecaster._ensRadiationForIndex(hourly, i, biasFactor, wxF, _ensWeights)
          ?? Math.round(rawRadiation * biasFactor * wxF),
        gtiOverGhi,
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

    const currentWindMs  = hourly.windspeed_10m?.[currentIndex] != null
      ? Math.round(hourly.windspeed_10m[currentIndex] / 3.6 * 10) / 10  // km/h → m/s
      : null;
    const currentWindDeg = hourly.winddirection_10m?.[currentIndex] ?? null;
    const currentWmoCode = hourly.weather_code?.[currentIndex] ?? null;

    return {
      sunshineNext4Hours: this._sumSunshine(hourlyForecast, 0, 4),
      sunshineNext8Hours: this._sumSunshine(hourlyForecast, 0, 8),
      sunshineTodayRemaining: this._sumSunshineToday(hourlyForecast, now),
      sunshineTomorrow: this._sumSunshineTomorrow(hourlyForecast, now),
      todaySunrise,
      todaySunset,
      tomorrowSunrise,
      tomorrowSunset,
      currentWindMs,
      currentWindDeg,
      currentWmoCode,
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

      // Prefer KNMI station ground-truth over OpenMeteo's own historical data (circular otherwise)
      const knmiAvg = this.learningEngine.getKnmiDailyAvg?.(yDate) ?? null;
      const actualAvg = knmiAvg ?? (actualSum / actualCount);
      if (knmiAvg != null) this.log(`[KNMI] Using station qg=${knmiAvg.toFixed(0)} W/m² as actual for ${yDate}`);

      // Load yesterday's forecasted radiation snapshot from device store (survives app redeploys)
      const snapshot = this.learningEngine.getForecastSnapshot(yDate);
      if (!snapshot || typeof snapshot.forecastAvgWm2 !== 'number') {
        this.log(`No forecast snapshot for ${yDate} — skipping bias learning`);
      } else {
        await this.learningEngine.recordRadiationAccuracy(snapshot.forecastAvgWm2, actualAvg);
        this.log(`Radiation bias for ${yDate} (${useGti ? 'GTI' : 'GHI'}): forecast=${snapshot.forecastAvgWm2.toFixed(0)} actual=${actualAvg.toFixed(0)} W/m²`);
      }

      let cloudSum = 0, cloudCount = 0;
      for (let i = 0; i < currentIndex; i++) {
        if (!hourly.time[i].startsWith(yDate)) continue;
        const cc = hourly.cloud_cover?.[i];
        if (typeof cc === 'number') { cloudSum += cc; cloudCount++; }
      }
      const avgCloudPct = cloudCount > 0 ? cloudSum / cloudCount : null;

      // Compute clearness index (kt) from KNMI hourly actuals vs clear-sky GHI.
      // kt is more reliable than OM cloud% for bias EMA classification.
      const lat = rawData.latitude, lon = rawData.longitude;
      const knmiKt = (lat != null && lon != null) ? this._computeKnmiKt(yDate, lat, lon) : null;
      if (knmiKt != null) this.log(`[KNMI] kt=${knmiKt.toFixed(2)} from KNMI hourly actuals for ${yDate}`);
      // Both clear-sky models for yesterday, so the day can be scored later without switching the
      // setting on. Scoring by flipping the setting is not possible after the fact: the per-type
      // bias EMAs re-learn on whatever labels are active, so the effect of the relabelling and the
      // effect of the re-learning arrive together and cannot be told apart.
      const ktModels = (lat != null && lon != null) ? {
        simple: this._computeKnmiKt(yDate, lat, lon, 'simple'),
        haurwitz: this._computeKnmiKt(yDate, lat, lon, 'haurwitz'),
        active: this.clearSkyModel,
      } : null;
      await this.learningEngine.recordDailyPvBiasFromPredictions(yDate, avgCloudPct, knmiKt, ktModels);

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
        this.log(`[Snapshot] ${todayDate} rad=${Math.round(todaySum/todayCount)} hourlyLen=${hourly.time.length}`);
        await this.learningEngine.saveForecastSnapshot(todayDate, todaySum / todayCount);
      }

    } catch (err) {
      this.error('_learnFromYesterday error:', err.message);
    }
  }

  /**
   * Rate-limited wrapper: calls _recordKnmiActual at most once per hour.
   * Safe to call on every fetchForecast invocation (incl. cache hits).
   * @private
   */
  _maybeRecordKnmiActual(lat, lon) {
    const now = Date.now();
    if (this._knmiLastFetch && now - this._knmiLastFetch < 55 * 60 * 1000) return;
    this._knmiLastFetch = now;
    this._recordKnmiActual(lat, lon).catch(() => {});
  }

  /**
   * Fetch current KNMI station qg and record in learning engine for ground-truth accuracy tracking.
   * Silently skips if no API key or on any error — KNMI is non-critical.
   * @private
   */
  async _recordKnmiActual(lat, lon) {
    if (!this.learningEngine) return;
    const apiKey = this.knmiApiKey;
    if (!apiKey) { this.log('[KNMI] no API key configured, skipping'); return; }
    try {
      const result = await fetchKnmiObservations(apiKey, lat, lon);
      if (!result || result.qg == null) return;
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const hour = now.getUTCHours();
      this.learningEngine.recordKnmiHourlyActual(result.qg, dateStr, hour);
      if (typeof result.ss === 'number') this.learningEngine.recordKnmiHourlySunshine(result.ss, dateStr, hour);
      this.log(`[KNMI] ${result.stationName} (${result.distKm}km): qg=${result.qg} W/m² n=${result.n ?? '?'} okta ss=${result.ss ?? '?'} min ta=${result.ta ?? '?'}°C`);
      // Update today's partial kt for use by getDailyPvBiasFactor / cloud-uncertainty gate.
      this._resetTodayKtIfNewDay(dateStr);
      // Cloud cover comes from a separately chosen station: the nearest one need not report it.
      // Never let that break the qg path — okta is an extra signal, qg is the ground truth.
      await this._recordOktaActual(apiKey, lat, lon, dateStr, hour)
        .catch((err) => this.error('[OKTA] fetch failed:', err.message));
      const todayKt = this._computeKnmiKt(dateStr, lat, lon, 'simple');
      if (todayKt != null) {
        this._todayKnmiKt = todayKt;
        this.log(`[KNMI] today kt=${todayKt.toFixed(2)} (partial)`);
      }
      // Both models, every fetch, whichever one is active. Fires even when nothing would change:
      // a line that only speaks up when it has news cannot be told apart from a dead one
      // (feedback_verify_instrument_cadence_not_value). The bucket pair is the decision-relevant
      // part — a kt shift that stays inside one bucket changes no behaviour at all.
      const todayKtH = this._computeKnmiKt(dateStr, lat, lon, 'haurwitz');
      if (todayKtH != null) this._todayKnmiKtHaurwitz = todayKtH;
      if (todayKt != null || todayKtH != null) {
        const bS = classifyKt(todayKt);
        const bH = classifyKt(todayKtH);
        const fmt = (v) => (v != null ? v.toFixed(2) : 'null');
        this.log(`[KT MODEL] kt_simple=${fmt(todayKt)} (${bS ?? 'n/a'}) kt_haurwitz=${fmt(todayKtH)} (${bH ?? 'n/a'})`
          + ` → ${bS === bH ? 'zelfde bucket' : 'ZOU WISSELEN'} | actief=${this.clearSkyModel}`);
      }
    } catch (err) {
      this.error('[KNMI] fetch failed:', err.message);
    }
  }

  /**
   * Fetch and record measured cloud cover (okta) from the nearest station that reports it.
   * Separate from the qg station: for this location the nearest station (Cabauw) never reports
   * `n`, so cover would otherwise only ever be a forecast, never a measurement.
   * @private
   */
  async _recordOktaActual(apiKey, lat, lon, dateStr, hour) {
    const okta = await fetchKnmiCloudObservations(apiKey, lat, lon);
    if (!okta || okta.oktaFrac == null) {
      // Without this line every failure mode is invisible: that is exactly how the first live
      // attempt (16-08) looked like nothing at all had run.
      this.log(`[OKTA] no station reporting cloud cover within ${MAX_OKTA_DIST_KM}km`);
      return;
    }
    this._todayOkta = okta.oktaFrac;
    this._todayOktaTs = Date.now();
    this._oktaStationName = okta.stationName;
    this.learningEngine?.recordKnmiHourlyCloud(okta.oktaFrac, dateStr, hour);
    this.log(`[OKTA] ${okta.stationName} (${okta.distKm}km): n=${okta.n} → cover=${Math.round(okta.oktaFrac * 100)}%`);
  }

  /**
   * Compute KNMI clearness index (kt = actual_GHI / clear-sky_GHI) for a given UTC date.
   * Returns null when fewer than 4 daylight hours of KNMI data are available.
   * @private
   */
  /**
   * Clear-sky GHI on a horizontal surface, from solar elevation alone. The kt denominator.
   *
   * ONE implementation for every kt on the app side — `_computeKnmiKt` and `_computeSatKt` must
   * land on the same scale or the 0.30/0.65 buckets mean two different things depending on which
   * source classified the day.
   *
   * 'simple' (`1000*sin(e)`) prices only the oblique incidence: the same beam spread over more
   * ground. It leaves out the second effect — at a low sun the light crosses far more atmosphere
   * and loses part of itself on the way (~10x the air mass at 5° versus overhead). So it sets the
   * bar too high exactly where the sun is low: 174 vs 137 W/m² at 10°, 87 vs 50 W/m² at 5°.
   *
   * That error is seasonal, not random, because kt is a ratio of SUMS: in summer the sub-15°
   * hours carry ~5% of the denominator, in December they carry all of it. Measured over 2 years
   * of ERA5 (project_clearsky_formula_seasonal_bias_0902): the p90 of daily kt — the clearest
   * days of each month, which no atmosphere makes clearer in April than in December — runs
   * 0.687 (Dec) to 0.952 (Apr) under 'simple', and 0.836 to 0.974 under 'haurwitz'. Spread
   * halves, so 'haurwitz' is the more season-stationary scale.
   *
   * @param {number} elevDeg - solar elevation in degrees
   * @param {'simple'|'haurwitz'} [model]
   * @returns {number} W/m²
   */
  /**
   * Dewpoint via Magnus-Tetens (water, standard a/b constants).
   * @param {number} tC   Air temperature, °C
   * @param {number} rhPct Relative humidity, 0-100
   * @returns {number} Dewpoint, °C
   */
  static _dewpointC(tC, rhPct) {
    const a = 17.27, b = 237.7;
    const alpha = (a * tC) / (b + tC) + Math.log(Math.max(rhPct, 0.1) / 100);
    return (b * alpha) / (a - alpha);
  }

  static _clearSkyGhi(elevDeg, model = 'simple') {
    const sinE = Math.sin(elevDeg * Math.PI / 180);
    if (sinE <= 0) return 0;
    return model === 'haurwitz'
      ? 1098 * sinE * Math.exp(-0.057 / sinE)   // Haurwitz 1945, fitted on measurements
      : 1000 * sinE;
  }

  _computeKnmiKt(dateStr, lat, lon, model = 'simple') {
    const knmiHourly = this.learningEngine?.data?.knmi_hourly_actuals?.[dateStr];
    if (!knmiHourly) return null;
    let ksActual = 0, ksClear = 0, ksCount = 0;
    for (const [hourStr, ghi] of Object.entries(knmiHourly)) {
      if (typeof ghi !== 'number' || ghi <= 10) continue;
      const hour = parseInt(hourStr);
      const d = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:30:00Z`);
      const { elev } = WeatherForecaster._solarElevAz(d, lat, lon);
      if (elev < 5) continue;
      const ghiClear = WeatherForecaster._clearSkyGhi(elev, model);
      if (ghiClear <= 10) continue;
      ksActual += ghi;
      ksClear  += ghiClear;
      ksCount++;
    }
    return ksCount >= 4 && ksClear > 0 ? ksActual / ksClear : null;
  }

  /**
   * Returns today's KNMI clearness index (partial day, updated each KNMI fetch).
   * @param {'simple'|'haurwitz'} [model] - clear-sky denominator; see `_clearSkyGhi`
   */
  getTodayKt(model = this.clearSkyModel) {
    return (model === 'haurwitz' ? this._todayKnmiKtHaurwitz : this._todayKnmiKt) ?? null;
  }

  /**
   * Satellite-derived clearness index for a UTC date, from the 15-min GHI buckets already
   * accumulated in `_satGhi15min`.
   *
   * Deliberately the SAME formula as `_computeKnmiKt` — ratio of sums, ghi > 10, elev >= 5,
   * clear-sky from the shared `_clearSkyGhi` under the same model — so this lands on the same
   * scale as the KNMI kt and the existing 0.30 / 0.65 bucket thresholds carry over untouched.
   * The `model` argument therefore has to move with `_computeKnmiKt`'s, never independently. That also makes the two directly
   * comparable in the shadow line once KNMI's own kt arrives.
   *
   * The point is the morning: `_computeKnmiKt` needs >=4 daylight HOURS, so kt is null until
   * roughly 08:06-09:43 UTC, and `getDailyPvBiasFactor` falls back to OM cloud > 75% until then.
   * The satellite runs at 4 samples/hour, so SAT_KT_MIN_BUCKETS = 8 is ~2 hours of sky — a
   * verdict around 07:45 UTC in August. Not lower: a wrong "overcast" costs one morning, a wrong
   * "clear" puts the uplift bucket (>1.0) on every slot including tomorrow's.
   *
   * PAST BUCKETS ONLY. `_satGhi15min` holds the whole satellite curve, which runs hours FORWARD
   * from its issue time — counting those would make kt part nowcast instead of a measurement of
   * the day so far, and would let a forecast of the coming afternoon decide the morning's weather
   * type. `_computeKnmiKt` cannot have this problem: KNMI actuals are past by construction.
   *
   * @param {string} dateStr - UTC date, YYYY-MM-DD
   * @param {number} [nowMs] - upper bound; buckets at or after this are forecast, not observation
   * `n` alone cannot say WHY there is no verdict: an emptied accumulator, a day that has not
   * accumulated enough past buckets yet, and missing coordinates all read as `n: 0`, and the
   * three need different actions. So the counts before each gate come out too: `mapN` (buckets
   * held at all), `raw` (today's past daylight buckets, before the elevation gate) and `coords`.
   *
   * @returns {{kt: number|null, n: number, raw: number, mapN: number, coords: boolean}}
   *          kt is null below the bucket minimum or without coords
   * @private
   */
  _computeSatKt(dateStr, nowMs = Date.now(), model = this.clearSkyModel) {
    const buckets = this._satGhi15min;
    const mapN = buckets ? Object.keys(buckets).length : 0;
    const coords = this._satCoords() != null;
    let ksActual = 0, ksClear = 0, ksCount = 0, raw = 0;
    for (const [msStr, ghi] of Object.entries(buckets || {})) {
      if (typeof ghi !== 'number' || ghi <= 10) continue;
      const ms = +msStr;
      if (ms >= nowMs) continue;
      if (new Date(ms).toISOString().slice(0, 10) !== dateStr) continue;
      raw++;
      if (!coords) continue;
      const elev = this.satElevAt(ms);
      if (elev == null || elev < 5) continue;
      const ghiClear = WeatherForecaster._clearSkyGhi(elev, model);
      if (ghiClear <= 10) continue;
      ksActual += ghi;
      ksClear  += ghiClear;
      ksCount++;
    }
    const enough = ksCount >= WeatherForecaster.SAT_KT_MIN_BUCKETS && ksClear > 0;
    return { kt: enough ? ksActual / ksClear : null, n: ksCount, raw, mapN, coords };
  }

  /**
   * Today's satellite clearness index plus the sample count behind it. `n` is part of the answer,
   * not decoration: `_satGhi15min` is in-memory, so a restart empties it and the shadow line has
   * to be able to say "no data" instead of falling silent.
   * @param {string} [dateStr] - UTC date, defaults to today
   * @param {number} [nowMs] - upper bound for observed buckets, defaults to now
   */
  getTodaySatKtInfo(dateStr = new Date().toISOString().slice(0, 10), nowMs = Date.now(), model = this.clearSkyModel) {
    return this._computeSatKt(dateStr, nowMs, model);
  }

  /**
   * Measured cloud cover as a 0-1 fraction, or null when absent or stale.
   * Fetch cadence is 55 min, so a reading older than OKTA_MAX_AGE_MS means fetches are failing —
   * a stale sky must not keep releasing the cloud gate.
   */
  getTodayOkta() {
    if (this._todayOkta == null || this._todayOktaTs == null) return null;
    return (Date.now() - this._todayOktaTs) > WeatherForecaster.OKTA_MAX_AGE_MS
      ? null
      : this._todayOkta;
  }

  // _todayKnmiKt only gets overwritten by _recordKnmiActual when _computeKnmiKt succeeds
  // (needs ≥4 qualifying daylight hours). Without this guard it would silently keep
  // exposing yesterday's kt as "today" for the first few hours of a new day — the
  // cloud-uncertainty gate would then cross-check today's cloud reality against
  // yesterday's sky (2026-07-08 incident: gate saw stale kt=0.80 from the prior evening
  // while today was actually overcast).
  _resetTodayKtIfNewDay(dateStr) {
    if (this._todayKnmiKtDate !== dateStr) {
      this._todayKnmiKt = null;
      this._todayKnmiKtHaurwitz = null;
      this._todayOkta = null;
      this._todayOktaTs = null;
      this._todayKnmiKtDate = dateStr;
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
    userdata.removeJson(CACHE_FILE);
    this.log('Weather cache invalidated');
  }

  _saveCache() {
    // Debounce 5min — kept from when this was a settings.set (~30 MB V8 heap per call,
    // framework-internal, independent of payload). In-memory this.cache is already the
    // primary source; persistence is only for restart recovery.
    if (this._saveCacheTimer) clearTimeout(this._saveCacheTimer);
    this._saveCacheTimer = setTimeout(() => {
      this._saveCacheTimer = null;
      const ok = userdata.writeJson(CACHE_FILE, {
        expiry: this.cacheExpiry,
        cache:  this.cache
      });
      if (!ok) this.error('Failed to persist weather cache to /userdata');
    }, 5 * 60 * 1000);
  }

  // Like _loadCache but accepts stale data up to maxAgeMs old (for API-failure fallback)
  _loadStaleCache(maxAgeMs) {
    try {
      const stored = userdata.readJson(CACHE_FILE);
      if (!stored || !stored.expiry) return null;
      if (stored.expiry <= Date.now() - maxAgeMs) return null; // too old
      return this._reviveCache(stored.cache);
    } catch (e) {
      return null;
    }
  }

  _loadCache() {
    try {
      const stored = userdata.readJson(CACHE_FILE);
      if (!stored || !stored.expiry || stored.expiry <= Date.now()) return null;
      return { cache: this._reviveCache(stored.cache), expiry: stored.expiry };
    } catch (e) {
      this.error('Failed to load weather cache from /userdata:', e.message);
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
    // Fetch 5 points (center + N/S/E/W ±0.05°) in parallel.
    // Average factor per timestep — catches incoming rain cells better than a single point.
    const D = 0.05;
    const points = [
      [lat,      lon     ],
      [lat + D,  lon     ],
      [lat - D,  lon     ],
      [lat,      lon + D ],
      [lat,      lon - D ],
    ];
    const fetchPoint = async ([la, lo]) => {
      const url = `https://gpsgadget.buienradar.nl/data/raintext?lat=${la.toFixed(2)}&lon=${lo.toFixed(2)}`;
      const response = await fetchWithTimeout(url, {}, 8000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      return text.trim().split('\n').map(line => {
        const value = parseInt(line.split('|')[0], 10);
        return isNaN(value) ? 0 : (value > 0 ? Math.pow(10, (value - 109) / 32) : 0);
      });
    };
    try {
      const now = Date.now();
      const results = await Promise.allSettled(points.map(p => fetchPoint(p)));
      const valid = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (valid.length === 0) throw new Error('all points failed');
      const len = Math.min(...valid.map(v => v.length));
      const result = Array.from({ length: len }, (_, i) => {
        const avgMmh = valid.reduce((s, v) => s + (v[i] ?? 0), 0) / valid.length;
        return { time: new Date(now + i * 5 * 60000), mmPerHour: avgMmh, factor: WeatherForecaster._buienradarFactor(avgMmh) };
      });
      this._buienradarCache  = result;
      this._buienradarExpiry = now + 15 * 60000;
      return result;
    } catch (err) {
      this.error('Buienradar fetch failed:', err.message);
      return [];
    }
  }

  async fetchUpwindData(lat, lon, windFromDeg = null) {
    if (!this._satUrl) return null;
    const baseUrl = new URL(this._satUrl).origin + '/api';
    const R = 6371, dist = 40;
    const rad = d => d * Math.PI / 180;
    const _ag = { agent: _upwindAgent };
    try {
      // OM windFromDeg = FROM direction (surface, reliable) — use for upwind coords
      let upLat = null, upLon = null;
      if (windFromDeg != null) {
        upLat = lat + (dist / R) * Math.cos(rad(windFromDeg)) * (180 / Math.PI);
        upLon = lon + (dist / R) * Math.sin(rad(windFromDeg)) / Math.cos(rad(lat)) * (180 / Math.PI);
      }
      const [thisQg, thisPoint, upQg, upPoint] = await Promise.all([
        fetchWithTimeout(`${baseUrl}/qg?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, _ag, 10000).then(r => r.ok ? r.json() : null),
        fetchWithTimeout(`${baseUrl}/point?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, _ag, 10000).then(r => r.ok ? r.json() : null),
        upLat != null ? fetchWithTimeout(`${baseUrl}/qg?lat=${upLat.toFixed(4)}&lon=${upLon.toFixed(4)}`, _ag, 10000).then(r => r.ok ? r.json() : null) : Promise.resolve(null),
        upLat != null ? fetchWithTimeout(`${baseUrl}/point?lat=${upLat.toFixed(4)}&lon=${upLon.toFixed(4)}`, _ag, 10000).then(r => r.ok ? r.json() : null) : Promise.resolve(null),
      ]);
      const thisStation = thisQg?.station ?? null;
      const _ddArr = thisQg?.dd;
      const _ffArr = thisQg?.ff;
      const thisDd = Array.isArray(_ddArr) && _ddArr.length ? _ddArr[_ddArr.length - 1].deg : null;
      const _lastFf = Array.isArray(_ffArr) && _ffArr.length ? _ffArr[_ffArr.length - 1] : null;
      const thisFf = _lastFf ? _lastFf.ms : null;
      // Dewpoint depression (ta - dewpoint): already fetched by /qg as ta+rh but never
      // extracted before now. Wide depression = dry air; narrowing toward 0 as a front
      // approaches is the classic synoptic precursor — recorded here as a raw signal only,
      // no forecast use yet (project_pv_forecast_open_leads_0902 spoor 3).
      const _taArr = thisQg?.ta;
      const _rhArr = thisQg?.rh;
      const _lastTa = Array.isArray(_taArr) && _taArr.length ? _taArr[_taArr.length - 1] : null;
      const _lastRh = Array.isArray(_rhArr) && _rhArr.length ? _rhArr[_rhArr.length - 1] : null;
      const thisDewDepression = (_lastTa?.c != null && _lastRh?.pct != null)
        ? Math.round((_lastTa.c - WeatherForecaster._dewpointC(_lastTa.c, _lastRh.pct)) * 10) / 10
        : null;
      // KNMI EDR timestamps each reading (_lastFf.t) — use it, not fetch-time, so a
      // DP tick late in the hourly _updateWeather cycle can tell the wind reading is stale.
      const windObsMs = _lastFf?.t ? new Date(_lastFf.t).getTime() : Date.now();
      const thisCot = Math.max(thisPoint?.cot ?? 0, 0);
      let station = null, upwindCot = null, upwindKt = null, dcot = null;
      if (upQg || upPoint) {
        station   = upQg?.station ?? null;
        upwindCot = Math.max(upPoint?.cot ?? 0, 0);
        dcot      = Math.round((upwindCot - thisCot) * 10) / 10;
        upwindKt  = (upPoint?.sds_wm2 != null && (upPoint?.cs_wm2 ?? 0) > 10)
          ? Math.min(upPoint.sds_wm2 / upPoint.cs_wm2, 1.0)
          : null;
      }
      // point_proxy.py's /point also timestamps its own reading (real WCS satellite-scan
      // time, not fetch-time) — this is what upwindKt is actually derived from, so gate on
      // it too, not just the wind reading's timestamp.
      const pointObsMs = upPoint?.t ? new Date(upPoint.t).getTime() : null;
      const result = { station, upwindCot, upwindKt, thisCot, dcot, thisStation, thisDd, thisFf, thisDewDepression, windObsMs, pointObsMs };
      this.log(`[Upwind] thuis=${thisStation ?? '?'} dd=${thisDd}° ff=${thisFf}m/s dewDep=${thisDewDepression ?? '?'}°C · verklikker=${station ?? '?'} COT thuis=${thisCot} up=${upwindCot ?? '-'} Δ=${dcot ?? '-'}`);
      if (thisDewDepression != null && this.learningEngine) {
        const d = new Date(windObsMs);
        this.learningEngine.recordKnmiHourlyDewDepression(
          thisDewDepression, d.toISOString().slice(0, 10), d.getUTCHours());
      }
      return result;
    } catch (e) {
      this.log(`[Upwind] fetch error: ${e.message}`);
      return null;
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

  // Conservative additional factor applied to OM-based PV slots.
  // OM irradiance already captures most cloud/rain attenuation; this corrects
  // residual underestimation during active precipitation (optical depth effects).
  static _omPrecipFactor(mmh) {
    if (mmh < 0.3) return 1.00;
    if (mmh < 1.0) return 0.95;
    if (mmh < 5.0) return 0.90;
    if (mmh < 10)  return 0.82;
    return 0.80;
  }

  // Ensemble-weighted radiation for one hourly index: weighted mean over the per-model series,
  // scaled by the same daily-bias and weather-attenuation factors the single-model path uses.
  // Returns null when no model has data for this index, so callers fall back to the default
  // Open-Meteo run. perModelRadiation spans the full time array, past hours included.
  // `out` collects the ensemble's own GTI/GHI transposition ratio for callers that want it;
  // dailyProfiles keeps its own ratio from Open-Meteo's raw tilted-vs-horizontal series.
  static _ensRadiationForIndex(hourly, idx, biasFactor, wxFactor, ensWeights, out = null) {
    if (!hourly.perModelRadiation) return null;
    let sum = 0, sumGhi = 0, wTot = 0;
    for (const [m, arr] of Object.entries(hourly.perModelRadiation)) {
      const v = arr?.[idx];
      if (typeof v !== 'number') continue;
      const w = ensWeights?.[m] ?? 0.25;
      sum += w * v; wTot += w;
      const g = hourly.perModelGhi?.[m]?.[idx];
      if (typeof g === 'number') sumGhi += w * g;
    }
    if (wTot <= 0) return null;
    if (out && sumGhi > 0) out.gtiOverGhi = Math.max(GTI_GHI_CLAMP_MIN, Math.min(2.5, sum / sumGhi));
    return Math.round((sum / wTot) * biasFactor * wxFactor);
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

  /**
   * Solar elevation and azimuth from UTC datetime, lat/lon.
   * Azimuth convention: 0=south, negative=east, positive=west (matches Open-Meteo panel azimuth).
   * Accuracy: ~0.1° — sufficient for GTI transposition.
   */
  static _solarElevAz(utcDate, latDeg, lonDeg) {
    const d2r = Math.PI / 180;
    const n   = utcDate.getTime() / 86400000 + 2440587.5 - 2451545.0; // days from J2000
    const L   = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
    const g   = ((357.528 + 0.9856003 * n) % 360 + 360) % 360;
    const gR  = g * d2r;
    const lam = L + 1.915 * Math.sin(gR) + 0.020 * Math.sin(2 * gR);
    const eps = 23.439 - 4.0e-7 * n;
    const lamR = lam * d2r, epsR = eps * d2r;
    const decl = Math.asin(Math.sin(epsR) * Math.sin(lamR));
    const RA   = Math.atan2(Math.cos(epsR) * Math.sin(lamR), Math.cos(lamR)) / d2r;
    const EoT  = (L - RA) / 15; // equation of time in hours
    const UTh  = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60 + utcDate.getUTCSeconds() / 3600;
    const H    = (UTh + lonDeg / 15 + EoT - 12) * 15; // solar hour angle (degrees)
    const HR   = H * d2r, latR = latDeg * d2r;
    const sinElev = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(HR);
    const elev    = Math.asin(Math.max(-1, Math.min(1, sinElev))) / d2r;
    if (elev <= 0) return { elev, azimuth: 0 };
    // atan2 gives correctly signed azimuth from south (positive=west, negative=east).
    // acos+sign-flip fails: acos always returns 0–180° and the quadrant logic is wrong.
    const az = Math.atan2(
      Math.sin(HR),
      Math.cos(HR) * Math.sin(latR) - Math.tan(decl) * Math.cos(latR)
    ) / d2r;
    return { elev, azimuth: az };
  }

  /**
   * Isotropic sky transposition: GHI/DHI/DNI on a horizontal surface → GTI on tilted panel.
   * @param {number} dhi - Diffuse horizontal irradiance (W/m²)
   * @param {number} dni - Direct normal irradiance (W/m²)
   * @param {number} ghi - Global horizontal irradiance (W/m²)
   * @param {number} elevDeg - Solar elevation (degrees above horizon)
   * @param {number} solarAzDeg - Solar azimuth (0=south, neg=east, pos=west)
   * @param {number} tiltDeg - Panel tilt from horizontal (degrees)
   * @param {number} panelAzDeg - Panel azimuth (0=south, neg=east, pos=west)
   * @param {number} albedo - Ground reflectance (default 0.20)
   */
  static _computeGTI(dhi, dni, ghi, elevDeg, solarAzDeg, tiltDeg, panelAzDeg, albedo = 0.20) {
    if (elevDeg <= 0) return 0;
    const d2r     = Math.PI / 180;
    const tiltR   = tiltDeg * d2r;
    const azDiff  = (solarAzDeg - panelAzDeg) * d2r;
    const cosTheta = Math.cos(elevDeg * d2r) * Math.sin(tiltR) * Math.cos(azDiff)
                   + Math.sin(elevDeg * d2r) * Math.cos(tiltR);
    const direct    = dni * Math.max(0, cosTheta);
    const diffuse   = dhi * (1 + Math.cos(tiltR)) / 2;
    const reflected = ghi * albedo * (1 - Math.cos(tiltR)) / 2;
    return Math.max(0, Math.round(direct + diffuse + reflected));
  }

  // Erbs (1982) diffuse-fraction model: split a horizontal GHI into DHI + DNI.
  // The ensemble path gets DHI/DNI straight from Open-Meteo; the satellite gives
  // GHI-only, so to put it on the same tilted plane as OM we decompose here.
  static _decomposeErbs(ghi, elevDeg, doy) {
    if (elevDeg <= 0 || ghi <= 0) return { dhi: 0, dni: 0 };
    const cosZ = Math.cos((90 - elevDeg) * Math.PI / 180);
    if (cosZ <= 0.01) return { dhi: ghi, dni: 0 };
    const B = 2 * Math.PI * (doy - 1) / 365;
    const ecc = 1.00011 + 0.034221 * Math.cos(B) + 0.001280 * Math.sin(B)
              + 0.000719 * Math.cos(2 * B) + 0.000077 * Math.sin(2 * B);
    const I0 = 1361 * ecc * cosZ;
    if (I0 <= 0) return { dhi: ghi, dni: 0 };
    const kt = Math.min(ghi / I0, 1.0);
    let df;
    if (kt <= 0.22) df = 1.0 - 0.09 * kt;
    else if (kt <= 0.80) df = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
    else df = 0.165;
    const dhi = ghi * df;
    return { dhi: Math.max(0, dhi), dni: Math.max(0, (ghi - dhi) / cosZ) };
  }

  // Full GHI → tilted-plane (GTI) for the satellite, so its chart/accuracy line
  // shares OM's representation (OM already feeds _computeGTI tilted GTI). Returns
  // raw GHI unchanged when geometry/tilt is missing.
  static _ghiToGti(ghi, date, lat, lon, tilt, azimuth) {
    if (!(ghi > 0)) return 0;
    const { elev, azimuth: solAz } = WeatherForecaster._solarElevAz(date, lat, lon);
    if (elev <= 0) return 0;
    const doy = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
              - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
    const { dhi, dni } = WeatherForecaster._decomposeErbs(ghi, elev, doy);
    return WeatherForecaster._computeGTI(dhi, dni, ghi, elev, solAz, tilt, azimuth);
  }

  // Single source of truth for the upwind-cloud DP modulation trigger — shared by
  // device.js (actual pvForecast rewrite) and explainability-engine.js (user-facing
  // reason text), so the two can never disagree about whether modulation fired.
  // Also gates on wind-reading staleness: fetchUpwindData runs hourly but this is
  // consulted every 15-min DP tick, so a reading can be up to ~55min old by the next
  // fetch — beyond 90min (one full refresh cycle + margin) treat it as unusable.
  static getUpwindModulation(upwind, nowMs = Date.now()) {
    if (!upwind || upwind.upwindKt == null || upwind.upwindKt >= 0.98) return { active: false };
    const thisFf = upwind.thisFf ?? 0;
    if (thisFf <= 1) return { active: false };
    // Gate on whichever underlying reading is older — thisFf/leadMs comes from the wind
    // timestamp, upwindKt from the point (COT/sds_wm2) timestamp. Either being stale means
    // the modulation itself is unreliable.
    const obsMsCandidates = [upwind.windObsMs, upwind.pointObsMs].filter(v => v != null);
    const oldestObsMs = obsMsCandidates.length ? Math.min(...obsMsCandidates) : null;
    if (oldestObsMs != null && (nowMs - oldestObsMs) > 90 * 60_000) return { active: false };
    const leadMs = (40_000 / thisFf) * 1000;
    return { active: true, upwindKt: upwind.upwindKt, leadMs, leadMin: Math.round(leadMs / 60_000) };
  }

  // ── Satellite nowcast (pySTEPS SSI via LXC proxy) ──

  async _fetchSatelliteNowcast(url) {
    try {
      const appId = this.homey.manifest?.id || 'com.homewizard';
      const appVer = this.homey.manifest?.version || '?';
      const res = await fetchWithTimeout(url, {
        headers: { 'X-Client-Id': `${appId}/${appVer}` },
      }, 5000);
      if (!res.ok) { this.log(`[SAT] fetch failed: HTTP ${res.status}`); return null; }
      const data = await res.json();
      if (!data.issue || !Array.isArray(data.curve) || data.curve.length === 0) { this.log(`[SAT] reject: missing issue/curve (issue=${data.issue}, curve=${data.curve?.length ?? 'null'})`); return null; }
      const issueAge = Date.now() - new Date(data.issue).getTime();
      if (issueAge > 60 * 60 * 1000 || issueAge < -5 * 60 * 1000) {
        // Overnight, the LXC satellite fetcher itself skips scans (no sun), so the
        // issue timestamp naturally goes stale for hours. Suppress the log then —
        // it's expected, not a fetch problem — but keep logging it in daylight.
        const params = new URLSearchParams(url.split('?')[1] || '');
        const lat = parseFloat(params.get('lat'));
        const lon = parseFloat(params.get('lon'));
        const elev = Number.isFinite(lat) && Number.isFinite(lon)
          ? WeatherForecaster._solarElevAz(new Date(), lat, lon).elev
          : 90;
        if (elev > 0) this.log(`[SAT] reject: stale issue age=${Math.round(issueAge/60000)}min (issue=${data.issue})`);
        return null;
      }
      if (data.curve.some(c => typeof c.wm2 !== 'number' || c.wm2 < 0)) { this.log(`[SAT] reject: invalid wm2 in curve`); return null; }
      this.log(`[SAT] fetch OK: issue=${data.issue} curve=${data.curve.length} entries`);
      return data;
    } catch (e) {
      this.log(`[SAT] fetch error: ${e.message}`);
      return null;
    }
  }

  async _applySatelliteIfActive() {
    if (!this._satUrl || !this.cache) return;
    try {
      const sat = await this._fetchSatelliteNowcast(this._satUrl);
      if (sat) this._applySatelliteOverlay(sat);
    } catch (_) { /* silent */ }
  }

  _applySatelliteOverlay(satData) {
    const slots = this.cache?.hourlyForecast;
    if (!slots) { this.log('[SAT] overlay skip: no cache yet'); return; }
    if (!satData?.curve?.length) return;
    const issueMs = new Date(satData.issue).getTime();
    // Matches the live curve horizon (15-min steps, 15-240min after issue — verified against
    // /api/sat 2026-08-21). Slots beyond this get no satPanelW at all; the lead/freshness ramp
    // in device.js's blend then tapers the last stretch instead of a hard cliff at the edge.
    const maxLeadMs = 4 * 3600 * 1000;
    const coords = this._satCoords();

    // A pre-dawn image carries no signal: the retrieval has no sunlight to work with, so the
    // whole curve reads ~0 and projects that zero onto hours that ARE sunlit (2026-07-29
    // 04:23Z: issue 03:44Z, 9 min before sunrise, drove slot 06:00Z to sat=0 against om=1017
    // / sc=1308). The per-slot elevation gate cannot catch this — it scores the target hour,
    // where the sun is already up. Gate on the sun at the IMAGE, and do not update
    // _satIssueMs: nothing usable arrived, so freshness must keep ageing.
    // Note this is deliberately not a "sat == 0" filter — a zero under daylight is real cloud.
    const issueElev = coords
      ? WeatherForecaster._solarElevAz(new Date(issueMs), coords.lat, coords.lon).elev
      : null;
    if (issueElev != null && issueElev <= 0) {
      this.log(`[SAT] overlay skip: issue ${new Date(issueMs).toISOString()} is pre-dawn (elev=${issueElev.toFixed(1)}°)`);
      return;
    }

    this._satIssueMs = issueMs; // for satFcW freshness/lead labelling (see getSatIssueMs)

    for (const slot of slots) {
      const slotMs = slot.time.getTime();
      const lead = slotMs - issueMs;
      // Forward-only: never back-fill a slot that starts before the satellite issue.
      // A pre-issue hour would only catch the dim edge curve point and project to ~0 W,
      // recording a fake sat=0 that scores as a 100% miss in the accuracy pill.
      if (lead < 0 || lead >= maxLeadMs) continue;

      const slotHourStart = slotMs;
      const slotHourEnd = slotMs + 3600_000;
      const readings = satData.curve.filter(c => {
        const t = new Date(c.t).getTime();
        return t >= slotHourStart && t < slotHourEnd;
      });
      if (readings.length === 0) continue;

      // Observation-only: store raw satellite GHI for accuracy tracking + future
      // sat-specific YF learning. Do NOT overwrite radiationWm2 — the DP/blend leg
      // stays on Open-Meteo until sat earns its own conversion (no OM bias, no wx
      // double-count of clouds the satellite already sees).
      const satGhi = Math.round(readings.reduce((s, c) => s + c.wm2, 0) / readings.length);
      slot.satGhiWm2 = satGhi;
      const utcH = slot.time.getUTCHours();
      const elevDeg = coords ? WeatherForecaster._solarElevAz(slot.time, coords.lat, coords.lon).elev : null;
      slot.satPanelW = this.satGhiToPanelW(satGhi, utcH, slot.gtiOverGhi, elevDeg);
      // Stamp the issue that produced THIS slot's value. Slots that fall out of the lead
      // window keep their previous satPanelW (the loop `continue`s above), so a global
      // "latest issue is fresh" check would pass a value that is hours old.
      slot.satIssueMs = issueMs;
      const lowConf = elevDeg != null && elevDeg < 15 ? ` (elev=${elevDeg.toFixed(1)}°<15, low-confidence, ignored)` : '';
      this.log(`[SAT] h=${slot.time.getUTCHours()} sat=${satGhi} om=${slot.radiationWm2} satPanelW=${slot.satPanelW}${lowConf}`);
    }

    // Retain the raw 15-min curve so the accuracy sampler can record sat at 15-min
    // resolution — the hourly satGhiWm2 above loses 3 of every 4 points, so the sat
    // line had gaps SC (sampled every 15 min) does not, making the accuracy pills
    // incomparable. Keyed by 15-min bucket; pruned to ~36h. See getSatGhiAt.
    if (!this._satGhi15min) this._satGhi15min = {};
    for (const c of satData.curve) {
      const ct = new Date(c.t).getTime();
      this._satGhi15min[Math.floor(ct / 900_000) * 900_000] = Math.round(c.wm2);
    }
    const cutoff = Date.now() - 36 * 3600_000;
    for (const k of Object.keys(this._satGhi15min)) {
      if (+k < cutoff) delete this._satGhi15min[k];
    }
  }

  // Raw satellite GHI for the 15-min bucket containing `ms`, or null. Lets the
  // accuracy sampler match Solcast's 15-min cadence instead of the hourly slot.
  getSatGhiAt(ms) {
    const v = this._satGhi15min?.[Math.floor(ms / 900_000) * 900_000];
    return typeof v === 'number' ? v : null;
  }

  // Issue timestamp (ms) of the most recent satellite overlay, or null if none applied.
  // Lets the accuracy tracker record how old the sat data behind a satFcW sample was
  // (freshness is bounded to ≤60min by the reject in _fetchSatelliteNowcast).
  getSatIssueMs() {
    return this._satIssueMs ?? null;
  }

  // Satellite GHI × sat-YF → panel W for the 15-min bucket containing `ms`. Pass the
  // containing hour's gtiOverGhi (ensemble GTI/GHI transposition ratio) so the sat leg
  // shares the operational forecast's tilt/azimuth geometry — see satGhiToPanelW.
  getSatPanelWAt(ms, gtiOverGhi) {
    const ghi = this.getSatGhiAt(ms);
    if (ghi == null) return null;
    const utcH = new Date(ms).getUTCHours();
    return this.satGhiToPanelW(ghi, utcH, gtiOverGhi, this.satElevAt(ms));
  }

  // Solar elevation at the satellite location for `ms`, or null when the coordinates the
  // forecast pipeline caches are unavailable. Single source for both the conversion gate
  // above and the yield-factor training gate (device.js → recordSatYield).
  satElevAt(ms) {
    const coords = this._satCoords();
    return coords ? WeatherForecaster._solarElevAz(new Date(ms), coords.lat, coords.lon).elev : null;
  }

  // Learned (EMA) scalar sat yield factor (panel-plane basis), falling back to the
  // SAT_YF_PRIOR warm-start until the EMA has samples. Single source of truth — every
  // satGhi→panelW conversion (live overlay, accuracy sampling, chart history) must go
  // through this, or the surfaces silently diverge. utcHour is ignored (kept for the
  // caller signature): the yield factor is hour-independent under the panel-plane basis.
  resolveSatYieldFactor(_utcHour) {
    return this.learningEngine?.getSatYieldFactor?.() ?? SAT_YF_PRIOR;
  }

  // Satellite GHI, optionally transposed to the panel plane via the ensemble's own
  // gtiOverGhi ratio (so the sat leg shares OM's tilt/azimuth geometry instead of
  // undershooting an east-tilt morning boost), × learned/hardcoded yield-factor → panel W.
  // Single conversion — live overlay, accuracy sampling, and chart history all route
  // through this, or the surfaces silently diverge (2026-07-07 incident).
  // elevDeg gates on solar elevation: below ~15° the satellite GHI retrieval is known-noisy
  // (clear-sky GHI itself is already low at grazing angles, so a near-zero reading can't be
  // told apart from a retrieval artifact — confirmed 2026-07-10, sat=0 at elev 1.8-9.8° while
  // OM's healthy 645-801W forecast got overridden to 0). null/omitted = elevation unknown,
  // gate skipped (caller couldn't resolve lat/lon).
  satGhiToPanelW(ghi, utcHour, gtiOverGhi, elevDeg = null) {
    if (ghi == null) return null;
    if (elevDeg != null && elevDeg < SAT_MIN_ELEV_DEG) return null;
    const panelGhi = typeof gtiOverGhi === 'number' && gtiOverGhi > 0 ? ghi * gtiOverGhi : ghi;
    const yf = this.resolveSatYieldFactor(utcHour);
    return yf ? Math.round(panelGhi * yf) : null;
  }

  // Real lat/lon, cached from _doFetch's geolocation resolution (same source the
  // whole forecast pipeline uses). NOT parsed from _satUrl — that string can lack
  // a query entirely (device.js falls back to a coord-less URL when its
  // weather_latitude/weather_longitude settings are unset), which silently
  // disabled the elevation gate below for coord-less deployments — confirmed
  // 2026-07-10 (this device's own settings were 0/0). Returns null until the
  // first weather fetch completes.
  _satCoords() {
    return Number.isFinite(this._lastLat) && Number.isFinite(this._lastLon)
      ? { lat: this._lastLat, lon: this._lastLon }
      : null;
  }

  // Ordered array of future 15-min SAT buckets in [nowMs, nowMs+horizonMs).
  // Returns [{ms, panelW}]; skips buckets with no SAT data or no yield factor.
  getSat15minCurve(nowMs, horizonMs = 7_200_000) {
    if (!this._satGhi15min) return [];
    const result = [];
    const endMs = nowMs + horizonMs;
    const startBucket = Math.ceil(nowMs / 900_000) * 900_000;
    for (let ms = startBucket; ms < endMs; ms += 900_000) {
      const panelW = this.getSatPanelWAt(ms);
      if (panelW != null) result.push({ ms, panelW });
    }
    return result;
  }

  // First contiguous dip in SAT curve within horizonMs of nowMs (default 4h,
  // matching the raw satellite data extent — _satGhi15min holds up to 36h).
  // dipThresholdW defaults to dipThresholdFrac * maxChargePowerW (≈120W at 800W).
  // Returns {dipStartMs, dipEndMs, minPanelW, leadMin} or null.
  getNextSatDip(nowMs, dipThresholdFrac = 0.15, maxChargePowerW = 800, horizonMs = 14_400_000) {
    const dipThresholdW = dipThresholdFrac * maxChargePowerW;
    const curve = this.getSat15minCurve(nowMs, horizonMs);
    if (curve.length < 2) return null;
    let dipStart = null, minPanelW = Infinity;
    for (const { ms, panelW } of curve) {
      if (panelW < dipThresholdW) {
        if (dipStart == null) dipStart = ms;
        minPanelW = Math.min(minPanelW, panelW);
      } else if (dipStart != null) {
        return { dipStartMs: dipStart, dipEndMs: ms, minPanelW, leadMin: Math.round((dipStart - nowMs) / 60_000) };
      }
    }
    if (dipStart != null) {
      const last = curve[curve.length - 1];
      return { dipStartMs: dipStart, dipEndMs: last.ms + 900_000, minPanelW, leadMin: Math.round((dipStart - nowMs) / 60_000) };
    }
    return null;
  }

  static getSatYieldFactor(_utcHour) {
    return SAT_YF_PRIOR;
  }

  startSatelliteLoop(url, _unused, onOverlay) {
    this.stopSatelliteLoop();
    this._satUrl = url;
    this._satOnOverlay = typeof onOverlay === 'function' ? onOverlay : null;
    const tick = async () => {
      if (this._satFetching) return;
      this._satFetching = true;
      try {
        const sat = await this._fetchSatelliteNowcast(this._satUrl);
        if (sat) {
          this._applySatelliteOverlay(sat);
          if (this._satOnOverlay) try { this._satOnOverlay(); } catch (_) {}
        }
      } catch (_) { /* silent */ }
      this._satFetching = false;
    };
    tick();
    this._satInterval = setInterval(tick, 900_000);
    this.log(`[SAT] Satellite loop started (15-min cycle, url=${url})`);
  }

  stopSatelliteLoop() {
    if (this._satInterval) {
      clearInterval(this._satInterval);
      this._satInterval = null;
    }
    this._satUrl = null;
    this._satFetching = false;
  }
}

// Okta is fetched on the same 55-min cadence as qg; 2h means fetches are failing, not that the
// sky is unchanged.
WeatherForecaster.OKTA_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Minimum 15-min satellite buckets before kt_sat may classify the day: 8 = ~2h of observed sky.
// See _computeSatKt for why not lower.
WeatherForecaster.SAT_KT_MIN_BUCKETS = 8;

module.exports = WeatherForecaster;
// Single source of truth for the ensemble model list — also consumed by lib/model-hindcast.js.
module.exports.ENSEMBLE_MODELS = ENSEMBLE_MODELS;
