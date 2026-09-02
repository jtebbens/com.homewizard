'use strict';

/**
 * LearningEngine - Tracks historical performance and learns patterns
 *
 * Features:
 * - 15-minute consumption patterns by day-of-week (7 × 24 × 4 = 672 slots)
 * - PV production accuracy tracking
 * - Policy decision success rate
 * - Adaptive confidence scoring
 */

const debug = false;

const { SAT_YF_PRIOR, SAT_MIN_ELEV_DEG, GTI_GHI_CLAMP_MIN } = require('./sat-yield-factors');
const { ENSEMBLE_MODELS } = require('./weather-forecaster');
const { MIN_PAIRED_HOURS } = require('./model-hindcast');
const { classifyKt } = require('./kt-buckets');

// A hindcast older than this describes a window the weather has moved past; fall back to the EMA.
const HINDCAST_MAX_AGE_MS = 48 * 3600 * 1000;

// Cached formatter: constructing Intl.DateTimeFormat per call was the top CPU
// hotspot in profiling (244 samples in one busy bucket, more than the DP itself) —
// _getAmsterdamTime() is called per-slot from the DP forecast lookups.
const _amsterdamFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'short',
  hour: 'numeric',
  hour12: false,
  minute: 'numeric',
});

class LearningEngine {
  constructor(homey, device) {
    this.homey = homey;
    this.device = device;
    this.log = (...args) => debug && homey.log('[LearningEngine]', ...args);
  }

  /**
   * Initialize or load historical data from device store
   */
  async initialize() {
    const stored = await this.device.getStoreValue('learning_data');
    
    if (stored) {
      this.data = stored;
      this.log('Loaded learning data:', Object.keys(this.data));

      // ── One-time migration: hourly → 15-min quarter resolution ────────────
      // Detect old format: patterns[day][hour] = {sum, count, avg} (no sub-key 0).
      // Spread the hourly average evenly across all 4 quarter slots.
      const sample = this.data.consumption_patterns?.[0]?.[0];
      if (sample && 'avg' in sample && !(0 in sample)) {
        this.homey.log('[LearningEngine] Migrating consumption patterns: hourly → 15-min quarters');
        const newPatterns = this._initializeConsumptionPatterns();
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour++) {
            const old = this.data.consumption_patterns[day][hour];
            if (old && old.count > 0) {
              for (let q = 0; q < 4; q++) {
                newPatterns[day][hour][q] = { sum: old.avg * old.count, count: old.count, avg: old.avg };
              }
            }
          }
        }
        this.data.consumption_patterns = newPatterns;
        await this._saveData();
        this.homey.log('[LearningEngine] Migration complete — 15-min patterns active');
      }

      // ── One-time migration: UTC → Amsterdam local time ────────────────────
      // Historical data was recorded using getHours() which returns UTC on Homey.
      // After switching to _getAmsterdamTime(), old data sits at wrong hour indices
      // (e.g. 7:00 CET kettle recorded at UTC slot 6, displayed as "06:00").
      // Reset patterns so they re-learn with correct Amsterdam local time indexing.
      // Re-learning takes ~24-48h (P1 polls every 15s → ~60 samples/slot/day).
      if (!this.data.consumption_tz_migrated_v1) {
        this.homey.log('[LearningEngine] Resetting consumption patterns — old data used UTC hours, now using Amsterdam local time');
        this.data.consumption_patterns = this._initializeConsumptionPatterns();
        this.data.consumption_tz_migrated_v1 = true;
        await this._saveData();
        this.homey.log('[LearningEngine] Consumption patterns reset — will re-learn within 24-48h');
      }

      // ── One-time migration: add variance tracking to existing slots ──────────
      // Existing slots have {sum, count, avg} only — add sumSq and variance.
      // sumSq is initialised to avg²×count which implies variance=0 initially;
      // it will build up from new observations without disrupting the avg.
      if (!this.data.consumption_variance_migrated_v1) {
        this.homey.log('[LearningEngine] Adding variance tracking to consumption patterns');
        for (let day = 0; day < 7; day++) {
          for (let hour = 0; hour < 24; hour++) {
            for (let q = 0; q < 4; q++) {
              const p = this.data.consumption_patterns[day][hour][q];
              if (p && p.sumSq === undefined) {
                p.sumSq    = p.avg * p.avg * p.count;
                p.variance = 0;
              }
            }
          }
        }
        this.data.consumption_variance_migrated_v1 = true;
        await this._saveData();
        this.homey.log('[LearningEngine] Variance migration complete');
      }

      // ── One-time seed: pv_model_accuracy from pv_predictions buffer ─────────
      // Pre-815ff66 values came from the dead daily-radiation path (wrong scale,
      // ~0.87) and rank the submodels nearly inverted. Recompute each model's
      // accuracy as the mean per-slot accuracy over the existing buffer so
      // getModelWeights() starts from a correct ranking instead of waiting
      // 1-2 days for the EMA to converge.
      if (!this.data.pv_model_accuracy_seeded_v1) {
        const FIELD_TO_MODEL = {
          mf:   'meteofrance_arpege_europe',
          gfs:  'gfs_seamless',
          icon: 'icon_seamless',
          knmi: 'knmi_harmonie_arome_netherlands',
        };
        const seeded = {};
        for (const [f, m] of Object.entries(FIELD_TO_MODEL)) {
          let sum = 0, n = 0;
          for (const s of this.data.pv_predictions ?? []) {
            const w = s[f];
            if (w == null || w <= 50 || s.actual == null) continue;
            sum += 1 - Math.abs(s.actual - w) / Math.max(s.actual, w, 1);
            n++;
          }
          if (n >= 50) seeded[m] = sum / n;
        }
        if (Object.keys(seeded).length === 4) {
          this.data.pv_model_accuracy = seeded;
          this.log(`Seeded pv_model_accuracy from buffer: ${Object.entries(seeded).map(([m, a]) => `${m.split('_')[0]}=${a.toFixed(3)}`).join(' ')}`);
        }
        this.data.pv_model_accuracy_seeded_v1 = true;
        await this._saveData();
      }

      // One-time reset: if a corrupted bias snapshot pushed the factor above 1.5 and the
      // reset has not yet been applied, restore to neutral. The flag prevents repeated resets
      // on every restart so a legitimately high factor can still be learned over time.
      if ((this.data.radiation_bias_factor ?? 1.0) > 1.5 && !this.data.radiation_bias_reset_v1) {
        this.log(`Resetting corrupted radiation_bias_factor (${this.data.radiation_bias_factor?.toFixed(2)}) → 1.0`);
        this.data.radiation_bias_factor = 1.0;
        this.data.radiation_bias_samples = [];
        this.data.radiation_bias_reset_v1 = true;
        await this._saveData();
      }

      // Cleanup: decorrelation scaffold removed (Cabauw nowcast abandoned — measurement
      // week showed unstable magnitude). Drop the stored samples; key absent → no-op.
      if (this.data.decorrelation_samples) {
        delete this.data.decorrelation_samples;
        await this._saveData();
      }

      // v2 reset: clear bias samples collected with old 3-model ensemble (ECMWF+GFS+ICON).
      // KNMI Harmonie added to ensemble → radiation baseline changed, old samples no longer valid.
      if (!this.data.radiation_bias_reset_v2) {
        this.homey.log(`[LearningEngine] Resetting radiation bias samples — new 4-model ensemble (+ KNMI Harmonie) active`);
        this.data.radiation_bias_factor = 1.0;
        this.data.radiation_bias_samples = [];
        this.data.radiation_bias_reset_v2 = true;
        await this._saveData();
      }

      // v1 normalize: yield factors learned while radiation_bias_factor > 1 was active are
      // calibrated against biased radiation, but forecasting uses unbiased radiation (bias
      // suppressed at ≥10 slots). Factors are ~biasFactor× too low → systematic underestimate.
      // Reset them so they re-learn consistently with unbiased radiation from scratch.
      // Only runs when bias is significant (>1.5); users near 1.0 are unaffected.
      if (!this.data.solar_yield_normalize_v1) {
        this.data.solar_yield_normalize_v1 = true;
        const bF = this.data.radiation_bias_factor ?? 1.0;
        const count = this.getSolarLearnedSlotCount();
        if (bF > 1.5 && count > 0) {
          this.homey.log(`[LearningEngine] Resetting ${count} yield slots — calibrated against biased radiation (factor ${bF.toFixed(2)}), re-learning with unbiased radiation`);
          this.data.solar_yield_factors = new Array(96).fill(null);
          this.data.solar_slot_max_radiation = new Array(96).fill(0);
        }
        await this._saveData();
      }

      // v3 normalize: the v1 reset only fired above bias 1.5, so moderate biases (e.g. 1.218)
      // slipped through — their yield factors stay ~biasFactor× too low against unbiased radiation,
      // a permanent PV underestimate the intraday corrector papers over daily. Instead of wiping
      // and re-learning, normalize in place: multiply each learned factor by the bias so it matches
      // unbiased radiation, preserving the learned per-slot shape. One-time, threshold 1.15.
      if (!this.data.solar_yield_normalize_v3) {
        this.data.solar_yield_normalize_v3 = true;
        const bF = this.data.radiation_bias_factor ?? 1.0;
        const count = this.getSolarLearnedSlotCount();
        if (bF > 1.15 && count > 0) {
          this.data.solar_yield_factors = this.data.solar_yield_factors.map(v => v != null ? v * bF : v);
          this.homey.log(`[LearningEngine] Normalized ${count} yield slots ×${bF.toFixed(3)} — were calibrated against biased radiation, now matched to unbiased radiation`);
        }
        await this._saveData();
      }

      // v2: also reset the radiation bias factor — it was inflated to 2.0 by the
      // mis-calibrated yield factors (actual_radiation was back-calculated from pv_power
      // / wrong_yf → too high → pushed bias to cap). Reset so fallback PR estimates are
      // not doubled. Only runs when bias is still at the inflated cap (>1.5).
      if (!this.data.solar_yield_normalize_v2) {
        this.data.solar_yield_normalize_v2 = true;
        const bF = this.data.radiation_bias_factor ?? 1.0;
        if (bF > 1.5) {
          this.homey.log(`[LearningEngine] Resetting radiation_bias_factor ${bF.toFixed(2)} → 1.0 (was inflated by mis-calibrated yield factors)`);
          this.data.radiation_bias_factor = 1.0;
          this.data.radiation_bias_samples = [];
        }
        await this._saveData();
      }

      // v4 shift: correct 1h slot mismatch introduced by OM preceding-hour timestamp fix.
      // After weather-forecaster shifted hourlyForecast timestamps -1h, pvForecast building
      // now looks up yfs[T*4] for radiation[T→T+1], but yfs[T*4] was calibrated against
      // radiation[T-1→T]. Shift all YF slots left by 4 (1 UTC hour) so the lookup aligns:
      // new yf[T] = old yf[T+1] (old yf[T+1] was calibrated for radiation[T→T+1]).
      if (!this.data.yf_shift_migration_v1) {
        this.data.yf_shift_migration_v1 = true;
        const yf = this.data.solar_yield_factors;
        if (Array.isArray(yf) && yf.some(v => v != null)) {
          const n = yf.filter(v => v != null).length;
          const shifted = new Array(96).fill(null);
          for (let s = 0; s < 92; s++) shifted[s] = yf[s + 4] ?? null;
          this.data.solar_yield_factors = shifted;
          this.homey.log(`[LearningEngine] Migrated ${n} YF slots −1h UTC (OM preceding-hour fix)`);
        }
        const mr = this.data.solar_slot_max_radiation;
        if (Array.isArray(mr)) {
          const shifted = new Array(96).fill(0);
          for (let s = 0; s < 92; s++) shifted[s] = mr[s + 4] ?? 0;
          this.data.solar_slot_max_radiation = shifted;
        }
        const mf = this.data.solar_slot_max_yield_factor;
        if (Array.isArray(mf)) {
          const shifted = new Array(96).fill(0);
          for (let s = 0; s < 92; s++) shifted[s] = mf[s + 4] ?? 0;
          this.data.solar_slot_max_yield_factor = shifted;
        }
        await this._saveData();
      }

      // v1 reset: pv_accuracy_score corrupted by unbounded error formula (|a-p|/p).
      // New formula uses max(a,p) as denominator → score bounded [0,1]. Reset once.
      if (!this.data.pv_accuracy_reset_v1) {
        this.homey.log('[LearningEngine] Resetting pv_accuracy_score — bounded error formula active');
        this.data.pv_accuracy_score = 1.0;
        this.data.pv_predictions = [];
        this.data.pv_accuracy_reset_v1 = true;
        await this._saveData();
      }

      // v1 reset: pv_daily_bias and pv_daily_bias_clear corrupted by _recordPvAccuracySample
      // bug — _getPvForSlot was called without _buildPvIndex, so predicted was always slot[0]
      // value instead of the interpolated forecast for the current hour. Daily ratio
      // sumActual/sumPredicted was therefore wrong, driving pv_daily_bias to ~0.3 (68% cut).
      if (!this.data.pv_daily_bias_reset_v1) {
        this.homey.log(`[LearningEngine] Resetting pv_daily_bias (${(this.data.pv_daily_bias ?? 1.0).toFixed(3)}) and pv_daily_bias_clear (${(this.data.pv_daily_bias_clear ?? 1.0).toFixed(3)}) — corrupted by slot[0] predicted bug`);
        this.data.pv_daily_bias               = 1.0;
        this.data.pv_daily_bias_clear         = 1.0;
        this.data.pv_daily_bias_samples       = 0;
        this.data.pv_daily_bias_clear_samples = 0;
        this.data.pv_predictions              = [];
        this.data.pv_accuracy_score           = 1.0;
        this.data.pv_accuracy_om              = null;
        this.data.pv_accuracy_sc              = null;
        this.data.pv_model_accuracy           = {};
        this.data.pv_daily_bias_reset_v1      = true;
        await this._saveData();
      }

      // v1-v2: sat used wrong yieldFactor index (Amsterdam hour / single-slot instead of UTC×4 avg)
      if (!this.data.sat_accuracy_reset_v3) {
        const preds = this.data.pv_predictions || [];
        for (const p of preds) p.sat = null;
        this.data.pv_accuracy_sat = null;
        this.data.sat_accuracy_reset_v3 = true;
        this.homey.log('[LearningEngine] Cleared stale sat entries (v3: yf-index fix)');
        await this._saveData();
      }

      // v1: solar_sat_yield_factors may contain corrupt low values (~0.8) from an early
      // run with wrong units. Valid daytime yf ≥ 2.5 for this installation. Reset once.
      if (!this.data.sat_yf_reset_v1) {
        this.data.sat_yf_reset_v1 = true;
        const syf = this.data.solar_sat_yield_factors;
        if (syf && typeof syf === 'object') {
          const vals = Object.values(syf).filter(v => typeof v === 'number');
          const gMax = vals.length > 0 ? Math.max(...vals) : 0;
          if (gMax > 0 && gMax < 1.5) {
            this.homey.log(`[LearningEngine] Resetting solar_sat_yield_factors — corrupt values (globalMax=${gMax.toFixed(3)})`);
            this.data.solar_sat_yield_factors = {};
            this.data.solar_sat_max_radiation = {};
          }
        }
        await this._saveData();
      }

      // v2: recordSatYield is now fed panel-plane GHI (raw × ensemble gtiOverGhi) instead
      // of raw horizontal GHI — the east-tilt transposition that was dropped when the F2
      // per-hour learned YF replaced it (2026-06-19 fix silently orphaned by c16ac98).
      // Values learned under the old (no-transposition) basis no longer mean the same
      // thing, so the table must relearn from scratch under the new basis.
      if (!this.data.sat_yf_reset_v2) {
        this.data.sat_yf_reset_v2 = true;
        this.homey.log('[LearningEngine] Resetting solar_sat_yield_factors — gtiOverGhi transposition added (v2)');
        this.data.solar_sat_yield_factors = {};
        this.data.solar_sat_max_radiation = {};
        await this._saveData();
      }

      // scalar_v1: collapsed the per-hour solar_sat_yield_factors object to a single scalar
      // solar_sat_yield_factor. Per-hour double-counted the tilt geometry (already in the
      // panel-plane GHI feed), ramping 1.5→5.8 across the day and never settling. Seed the
      // scalar from SAT_YF_PRIOR and let the pooled EMA refine it within a day; drop the
      // stale per-hour object and its reject-streak state.
      if (!this.data.sat_yf_scalar_v1) {
        this.data.sat_yf_scalar_v1 = true;
        this.data.solar_sat_yield_factor = SAT_YF_PRIOR;
        delete this.data.solar_sat_yield_factors;
        delete this.data.solar_sat_yield_reject_streak;
        this.homey.log(`[LearningEngine] Collapsed solar_sat_yield_factors → scalar (seed ${SAT_YF_PRIOR}, scalar_v1)`);
        await this._saveData();
      }

      const biasSamples = (this.data.radiation_bias_samples || []).length;
      const biasFactor = this.data.radiation_bias_factor ?? 1.0;
      const learnedSlots = this.getSolarLearnedSlotCount();
      const biasActive = biasSamples >= 3 && learnedSlots < 10;
      this.homey.log(`[LearningEngine] radiation_bias_factor=${biasFactor.toFixed(3)} (${biasSamples} samples, ${learnedSlots} yield slots — ${biasActive ? 'ACTIVE' : 'inactive: yield factors in use'})`);

    } else {
      // Initialize fresh data structure
      this.data = {
        // Hourly consumption patterns: [day_of_week][hour] = { sum, count, avg }
        consumption_patterns: this._initializeConsumptionPatterns(),
        
        // PV prediction accuracy: track predicted vs actual
        pv_predictions: [],
        pv_accuracy_score: 1.0, // 1.0 = perfect, adjusts over time

        // Consumption forecast accuracy (observe-only, never fed back into the DP).
        // Raw predicted/actual pairs already live in policy_mode_history; these keep what
        // that 5-day buffer cannot: a score that outlives it, and per-hour structure.
        consumption_accuracy_score: 1.0,
        consumption_accuracy_hourly: {}, // [Amsterdam hour] = { emaAbsErrW, emaBiasW, count }

        // Weather radiation forecast bias: ratio of actual vs forecasted W/m²
        // < 1.0 = model over-predicts (too optimistic), > 1.0 = under-predicts
        radiation_bias_samples: [], // { ratio, timestamp }
        radiation_bias_factor: 1.0, // EMA of actual/forecast ratio

        // Per-slot solar yield factors: yieldFactor[slot] = W_actual / (W/m² radiation)
        // 96 slots × 15 min = 24h. Absorbs pvCapacity, panel angle, PR, shading in one number.
        // null = not yet learned. Requires PV power flow card to be active.
        solar_yield_factors: new Array(96).fill(null),

        // Historic max radiation seen per slot — used as dynamic learning threshold.
        // Only learn when current radiation > 15% of slot max (avoids dawn/dusk noise).
        solar_slot_max_radiation: new Array(96).fill(0),

        // Daily PV level bias: EMA of (actual_kWh / forecast_kWh) per day.
        // Corrects systematic level errors not captured by per-slot yield factors.
        pv_daily_bias: 1.0,
        pv_daily_bias_samples: 0,

        // Separate bias for clear days (avg cloud cover ≤ 40%). Clear days are
        // systematically underestimated by the mixed-weather EMA above.
        pv_daily_bias_clear: 1.0,
        pv_daily_bias_clear_samples: 0,

        // Policy decisions: track outcomes
        policy_decisions: [],
        policy_success_rate: 1.0,
        
        // Last updated timestamp
        last_updated: Date.now(),
        
        // Statistics
        stats: {
          total_samples: 0,
          days_tracked: 0,
          learning_started: Date.now()
        },

        // Net PV surplus prediction accuracy for terminal value correction.
        // Tracks pvKwhTomorrow (net, consumption-adjusted) vs actual next-day net.
        pv_net_surplus_factor: 1.0,   // EMA correction [0.4, 1.1]; <1 = we over-predicted
        pv_net_surplus_pending: null  // { date: 'YYYY-MM-DD', predicted: kWh }
      };

      await this._saveData();
    }
  }

  /**
   * Initialize consumption pattern structure.
   * 7 days × 24 hours × 4 quarters (0=:00, 1=:15, 2=:30, 3=:45) = 672 slots.
   */
  _initializeConsumptionPatterns() {
    const patterns = {};
    for (let day = 0; day < 7; day++) {
      patterns[day] = {};
      for (let hour = 0; hour < 24; hour++) {
        patterns[day][hour] = {};
        for (let q = 0; q < 4; q++) {
          patterns[day][hour][q] = { sum: 0, count: 0, avg: 0, sumSq: 0, variance: 0 };
        }
      }
    }
    return patterns;
  }

  /**
   * Extract Amsterdam local time components from a Date.
   * On Homey, getHours()/getDay() return UTC — always use this helper.
   * @private
   * @returns {{ dayOfWeek: number, hour: number, quarter: number }}
   */
  _getAmsterdamTime(date = new Date()) {
    const parts = {};
    for (const p of _amsterdamFormatter.formatToParts(date)) parts[p.type] = p.value;
    const hour   = parseInt(parts.hour, 10) % 24;
    const minute = parseInt(parts.minute, 10);
    return {
      dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
      hour,
      quarter: Math.floor(minute / 15),
    };
  }

  /**
   * Pause learning (e.g. during vacation). Consumption recording is skipped.
   * Solar yield and PV accuracy continue unaffected.
   */
  async pause() {
    this.data.paused = true;
    await this._saveData();
    this.homey.log('[LearningEngine] Learning paused');
  }

  /**
   * Resume learning after pause.
   */
  async resume() {
    this.data.paused = false;
    await this._saveData();
    this.homey.log('[LearningEngine] Learning resumed');
  }

  /**
   * @returns {boolean} True when learning is paused
   */
  isPaused() {
    return this.data.paused === true;
  }

  /**
   * Record actual consumption for learning.
   * @param {number} powerW - Current grid import power
   */
  async recordConsumption(powerW) {
    if (this.data.paused) return; // Away mode — do not corrupt patterns
    if (powerW < 0) return; // Only track import, not export

    const { dayOfWeek, hour, quarter } = this._getAmsterdamTime();

    const pattern = this.data.consumption_patterns[dayOfWeek][hour][quarter];
    // Ensure variance fields exist (guard for slots initialised before migration)
    if (pattern.sumSq    === undefined) pattern.sumSq    = pattern.avg * pattern.avg * pattern.count;
    if (pattern.variance === undefined) pattern.variance = 0;

    // Winsorize: cap outliers at avg + 2σ so intermittent appliance spikes
    // (dishwasher, dryer) don't permanently inflate the typical-load profile.
    // Variance is updated with the uncapped value to preserve spike awareness.
    let cappedW = powerW;
    if (pattern.count >= 20 && pattern.variance > 0) {
      const cap = pattern.avg + 2 * Math.sqrt(pattern.variance);
      cappedW = Math.min(powerW, cap);
    }

    // Use exponential moving average once we have enough data to avoid
    // sum/count growing unboundedly (which bloats the store over years).
    if (pattern.count < 100) {
      pattern.sum   += cappedW;
      pattern.sumSq += powerW * powerW;
      pattern.count += 1;
      pattern.avg      = pattern.sum   / pattern.count;
      pattern.variance = pattern.sumSq / pattern.count - pattern.avg * pattern.avg;
    } else {
      const alpha  = 0.02;
      const alphaV = 0.005;
      const delta  = powerW - pattern.avg;
      pattern.avg      = alpha  * cappedW + (1 - alpha)  * pattern.avg;
      pattern.variance = (1 - alphaV) * pattern.variance + alphaV * delta * delta;
      // Keep sum/count in sync; cap count at 100 to prevent overflow
      pattern.sum   = pattern.avg * pattern.count;
      pattern.sumSq = (pattern.variance + pattern.avg * pattern.avg) * pattern.count;
    }

    this.data.stats.total_samples += 1;

    // Save periodically (every 100 samples)
    if (this.data.stats.total_samples % 100 === 0) {
      await this._saveData();
    }
  }

  /**
   * Core prediction logic for a specific day/hour/quarter combination.
   * Shared by getPredictedConsumption() and getDailyProfile().
   * @private
   * @returns {number} Predicted power in W
   */
  _predictFromPattern(dayOfWeek, hour, quarter) {
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const groupDays = isWeekend ? [0, 6] : [1, 2, 3, 4, 5];

    // 1. Specific day + hour + quarter
    const pattern = this.data.consumption_patterns[dayOfWeek][hour][quarter];
    if (pattern.count >= 4) return pattern.avg;

    // 2. Same day + same hour, all quarters combined (e.g. early in learning)
    let hourSum = 0, hourCount = 0;
    for (let q = 0; q < 4; q++) {
      const p = this.data.consumption_patterns[dayOfWeek][hour][q];
      if (p.count > 0) { hourSum += p.avg * p.count; hourCount += p.count; }
    }
    if (hourCount >= 4) return hourSum / hourCount;

    // 3. Day-group (weekday/weekend) + same hour + same quarter
    let groupSum = 0, groupCount = 0;
    for (const d of groupDays) {
      const p = this.data.consumption_patterns[d][hour][quarter];
      if (p.count > 0) { groupSum += p.avg * p.count; groupCount += p.count; }
    }
    if (groupCount > 0) return groupSum / groupCount;

    // 4. All days + same hour + same quarter
    let totalSum = 0, totalCount = 0;
    for (let d = 0; d < 7; d++) {
      const p = this.data.consumption_patterns[d][hour][quarter];
      if (p.count > 0) { totalSum += p.avg * p.count; totalCount += p.count; }
    }
    return totalCount > 0 ? totalSum / totalCount : 0;
  }

  /**
   * Get predicted consumption for a specific time (15-min resolution).
   * @param {Date} targetTime - Time to predict for
   * @returns {number} Predicted power in W
   */
  getPredictedConsumption(targetTime = new Date()) {
    const { dayOfWeek, hour, quarter } = this._getAmsterdamTime(targetTime);
    return this._predictFromPattern(dayOfWeek, hour, quarter);
  }

  /**
   * Get predicted consumption using explicit Amsterdam local hour/minute.
   * Preferred over getPredictedConsumption() for price-slot lookups where the
   * provider already gives the Amsterdam-local hour/minute directly (PBTH,
   * ENTSOE fallback), avoiding any UTC/local timestamp parsing ambiguity.
   * @param {Date} date - Used only for dayOfWeek derivation
   * @param {number} localHour - Amsterdam local hour (0-23)
   * @param {number} localMinute - Amsterdam local minute (0, 15, 30, 45)
   * @returns {number} Predicted power in W
   */
  getPredictedConsumptionForSlot(date, localHour, localMinute) {
    const { dayOfWeek } = this._getAmsterdamTime(date);
    const quarter = Math.floor(localMinute / 15);
    return this._predictFromPattern(dayOfWeek, localHour, quarter);
  }

  /**
   * Return the learned 15-min consumption profile for a given day-of-week.
   * Returns 96 slots (24h × 4 quarters) with predicted W and sample count.
   * Suitable for rendering a consumption chart in the settings UI.
   *
   * @param {number} dayOfWeek  0=Sunday … 6=Saturday (Amsterdam local)
   * @returns {Array<{slot:number, hour:number, quarter:number, avgW:number, count:number}>}
   */
  getDailyProfile(dayOfWeek) {
    const slots = [];
    for (let hour = 0; hour < 24; hour++) {
      for (let q = 0; q < 4; q++) {
        const p      = this.data.consumption_patterns[dayOfWeek][hour][q];
        const avgW   = Math.round(this._predictFromPattern(dayOfWeek, hour, q));
        const count  = p?.count ?? 0;
        const stddev = (p?.variance > 0) ? Math.round(Math.sqrt(p.variance)) : 0;
        slots.push({ slot: hour * 4 + q, hour, quarter: q, avgW, count, stddev });
      }
    }
    return slots;
  }

  /**
   * Get number of recorded samples for a specific day+hour+quarter slot.
   * @param {Date} targetTime
   * @returns {number} Sample count (0–100)
   */
  getConsumptionSampleCount(targetTime = new Date()) {
    const { dayOfWeek, hour, quarter } = this._getAmsterdamTime(targetTime);
    return this.data.consumption_patterns[dayOfWeek][hour][quarter]?.count ?? 0;
  }

  /**
   * Get consumption prediction confidence (0–100).
   * @param {Date} targetTime
   */
  getConsumptionConfidence(targetTime = new Date()) {
    const { dayOfWeek, hour, quarter } = this._getAmsterdamTime(targetTime);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const groupDays = isWeekend ? [0, 6] : [1, 2, 3, 4, 5];

    // Per-day confidence curve (0-10: 0-50%, 10-50: 50-90%, 50+: 90-100%)
    const dayConf = count => {
      if (count === 0) return 0;
      if (count < 10) return count * 5;
      if (count < 50) return 50 + (count - 10);
      return Math.min(100, 90 + (count - 50) * 0.2);
    };

    const pattern = this.data.consumption_patterns[dayOfWeek][hour][quarter];
    let baseConf;
    if (pattern.count >= 4) {
      baseConf = dayConf(pattern.count);
    } else {
      // Fallback to day-group confidence, capped at 60%
      const groupTotal = groupDays.reduce(
        (sum, d) => sum + (this.data.consumption_patterns[d][hour][quarter]?.count ?? 0), 0
      );
      baseConf = Math.min(60, dayConf(groupTotal));
    }

    // Variance penalty: high coefficient of variation → less confidence.
    // CV = stddev / avg. Penalty kicks in above CV=0.6, max 40pt reduction.
    // Ignore when avg < 50W (near-zero consumption has high relative variance by nature).
    const variance = pattern.variance ?? 0;
    if (variance > 0 && pattern.avg >= 50) {
      const cv = Math.sqrt(variance) / pattern.avg;
      const penalty = cv > 0.6 ? Math.min(40, (cv - 0.6) * 80) : 0;
      baseConf = Math.max(0, baseConf - penalty);
    }

    return baseConf;
  }

  /**
   * Get coefficient of variation (stddev/avg) for a specific time slot.
   * Returns null when avg < 50W or no variance data yet.
   * @param {Date} targetTime
   * @returns {number|null} CV (0 = stable, 1.0 = very variable)
   */
  getConsumptionCV(targetTime = new Date()) {
    const { dayOfWeek, hour, quarter } = this._getAmsterdamTime(targetTime);
    const pattern = this.data.consumption_patterns[dayOfWeek][hour][quarter];
    if (!pattern || pattern.count < 20 || pattern.avg < 50) return null;
    const variance = pattern.variance ?? 0;
    if (variance <= 0) return null;
    return Math.sqrt(variance) / pattern.avg;
  }

  /**
   * Get CV using explicit Amsterdam local hour/minute (see getPredictedConsumptionForSlot).
   * @param {Date} date - Used only for dayOfWeek derivation
   * @param {number} localHour - Amsterdam local hour (0-23)
   * @param {number} localMinute - Amsterdam local minute (0, 15, 30, 45)
   * @returns {number|null} CV or null
   */
  getConsumptionCVForSlot(date, localHour, localMinute) {
    const { dayOfWeek } = this._getAmsterdamTime(date);
    const quarter = Math.floor(localMinute / 15);
    const pattern = this.data.consumption_patterns[dayOfWeek][localHour][quarter];
    if (!pattern || pattern.count < 20 || pattern.avg < 50) return null;
    const variance = pattern.variance ?? 0;
    if (variance <= 0) return null;
    return Math.sqrt(variance) / pattern.avg;
  }

  /**
   * Record consumption forecast vs actual. Observe-only — nothing reads this back into
   * the DP. It exists because the load side had no predicted-vs-actual signal at all,
   * so forecast quality could only be reconstructed by scraping policy_mode_history.
   *
   * No ring buffer here on purpose: policy_mode_history already persists the raw pairs
   * (consumFcW/consumW), is externally readable, and holds up to 2200 entries (~23d) —
   * a second buffer would duplicate it. Those raw pairs are the right source for any
   * "is this hour's bias stable" question, since they can be split into sub-windows.
   * What is kept here is what expires with them: a slow per-hour trend (~25d memory)
   * that outlives the cap, plus a same-day score. Neither is a multi-month signal —
   * read the alphas, not the field names.
   *
   * @param {number} predictedW - raw slot forecast (pre-consumptionMargin)
   * @param {number} actualW - measured house load
   * @param {Date} [when] - sample time; injectable for tests
   * @returns {boolean} true when a sample was recorded — the caller uses this to mark a
   *   15-min bucket as done only once real data landed, so a rejected sample (e.g. the
   *   houseConsumption=0 that P1 reports for a few minutes after a restart) doesn't
   *   consume the bucket and lock out the good sample behind it.
   */
  recordConsumptionAccuracy(predictedW, actualW, when = new Date()) {
    if (!Number.isFinite(predictedW) || !Number.isFinite(actualW)) return false;
    if (predictedW <= 0 || actualW <= 50) return false;

    // Same bounded error as recordPvAccuracy: max() in the denominator keeps it in [0,1]
    // whichever side overshoots.
    const denom = Math.max(actualW, predictedW, 1);
    const error = Math.abs(actualW - predictedW) / denom;

    // Alphas are set from EFFECTIVE MEMORY (~1/alpha samples), not copied from the PV side.
    // pv_accuracy_score uses 0.1 at this same 15-min cadence = ~10 samples = ~2.5h, which has
    // already been mistaken once for a long-run signal (feedback_verify_ema_stability_before_claiming).
    // 0.01 at ~96 samples/day = ~100 samples = ~1 day. This is "how is today going", nothing more.
    const alpha = 0.01;
    this.data.consumption_accuracy_score =
      (alpha * (1.0 - error)) + ((1 - alpha) * (this.data.consumption_accuracy_score ?? 1.0));

    // Per-hour buckets. Each hour gets ~4 samples/day (four 15-min buckets), so 0.01 =
    // ~100 samples = ~25 days of memory. That is deliberately just past policy_mode_history's
    // 2200-entry (~23d) cap: the raw pairs there answer "is this hour's bias stable" better
    // than any single EMA read can, and this carries the slow trend beyond where they expire.
    // Amsterdam local hour — getHours() is UTC on Homey.
    const { hour } = this._getAmsterdamTime(when);
    this.data.consumption_accuracy_hourly = this.data.consumption_accuracy_hourly ?? {};
    const b = this.data.consumption_accuracy_hourly[hour];
    const absErr = Math.abs(actualW - predictedW);
    const bias = actualW - predictedW; // + = under-forecast, matches the 🎯 plan-accuracy block
    if (!b) {
      // Seed on the first sample; starting an EMA at 0 would understate the bucket for hours.
      this.data.consumption_accuracy_hourly[hour] = { emaAbsErrW: absErr, emaBiasW: bias, count: 1 };
    } else {
      const hAlpha = 0.01; // ~25 days at ~4 samples/hour-bucket/day — see note above
      b.emaAbsErrW = (hAlpha * absErr) + ((1 - hAlpha) * b.emaAbsErrW);
      b.emaBiasW = (hAlpha * bias) + ((1 - hAlpha) * b.emaBiasW);
      b.count++;
    }

    // Persist on a throttle. Staying in sync (no await) keeps the boolean return usable for
    // the caller's bucket dedup — an async fn returns a truthy Promise, which would mark the
    // bucket done even for a rejected sample. Every 4th sample = hourly at the 15-min policy
    // cadence; a restart then costs at most an hour of a months-long trend. Riding on some
    // other writer's _saveData would work (this.data is one object) but leaves the meter's
    // persistence depending on a counter it does not own.
    this._consumAccSaveCounter = (this._consumAccSaveCounter ?? 0) + 1;
    if (this._consumAccSaveCounter % 4 === 0) {
      this._saveData().catch(() => {}); // never let a store hiccup break the policy run
    }
    return true;
  }

  /**
   * Record PV prediction vs actual for learning
   * @param {number} predictedW - What we predicted
   * @param {number} actualW - What actually happened
   */
  // predictedLiveW is the same slot taken from the UN-frozen blended forecast. predictedW stays
  // the day-start snapshot, so pv_accuracy_score keeps measuring planning accuracy; the live
  // vintage is scored separately below. Appended last on purpose — inserting it next to
  // predictedW would silently shift every existing caller's arguments.
  async recordPvAccuracy(predictedW, actualW, omW = null, scW = null, perModelW = null, satW = null, chartW = null, predictedLiveW = null) {
    const now = Date.now();

    // Calculate error as fraction of max(actual, predicted) — bounded [0, 1].
    // Using max rather than predicted avoids unbounded errors when forecast >> actual
    // or actual >> forecast (e.g. dawn ramp-up, weather transitions).
    const denom = Math.max(actualW, predictedW, 1);
    const error = Math.abs(actualW - predictedW) / denom;

    // chartW carries corrected per-source values for the accuracy chart ONLY. The EMAs below
    // learn from the RAW omW/scW/perModelW/satW so model-weight ranking is judged against actual,
    // not against the ensemble mean. Falls back to raw when no correction was applied.
    const _cm = chartW?.perModel ?? null;
    this.data.pv_predictions.push({
      timestamp: now,
      predicted: predictedW,
      predictedLive: predictedLiveW ?? null,
      actual:    actualW,
      om:        omW ?? null,
      sc:        scW ?? null,
      error:     error,
      mf:        _cm?.['meteofrance_arpege_europe']        ?? perModelW?.['meteofrance_arpege_europe']        ?? null,
      gfs:       _cm?.['gfs_seamless']                     ?? perModelW?.['gfs_seamless']                     ?? null,
      icon:      _cm?.['icon_seamless']                    ?? perModelW?.['icon_seamless']                    ?? null,
      knmi:      _cm?.['knmi_harmonie_arome_netherlands']  ?? perModelW?.['knmi_harmonie_arome_netherlands']  ?? null,
      ecmwf:     _cm?.['ecmwf_ifs']                        ?? perModelW?.['ecmwf_ifs']                        ?? null,
      sat:       chartW?.sat ?? satW ?? null,
      satRaw:    satW ?? null,   // raw, uncorrected — for OM-vs-SAT trend comparison (_logOmTrend)
    });

    // Keep only last 300 predictions (enough for accuracy calculation, uses slice(-100))
    if (this.data.pv_predictions.length > 300) {
      this.data.pv_predictions = this.data.pv_predictions.slice(-300);
    }

    // Update blended accuracy score (exponential moving average)
    const accuracy = 1.0 - error;
    const alpha = 0.1;
    this.data.pv_accuracy_score =
      (alpha * accuracy) + ((1 - alpha) * this.data.pv_accuracy_score);

    // Same slot, same actual, same formula — only the forecast vintage differs. Shadow metric:
    // nothing reads this yet. It exists because pv_accuracy_score above gates a discount on the
    // LIVE forecast (device.js "PV conservatism"), and judging a live forecast by a day-start
    // snapshot systematically understates it whenever a provider revises mid-day.
    if (predictedLiveW != null && predictedLiveW > 50) {
      if (this.data.pv_accuracy_score_live == null) this.data.pv_accuracy_score_live = this.data.pv_accuracy_score;
      const liveErr = Math.abs(actualW - predictedLiveW) / Math.max(actualW, predictedLiveW, 1);
      this.data.pv_accuracy_score_live = (alpha * (1 - liveErr)) + ((1 - alpha) * this.data.pv_accuracy_score_live);
    }

    // Per-model accuracy (only when both models provided a meaningful prediction).
    // Also require a valid satellite reading for this hour so all three accuracy
    // scores are evaluated over the same sample set — otherwise OM/SC get credit
    // on dawn/dusk edge-hours satellite's coverage (SAT_YIELD_FACTORS UTC4-18 +
    // forward-only guard, weather-forecaster.js) never gets scored on, making the
    // three settings-page percentages not actually comparable.
    if (omW != null && omW > 50 && satW != null && satW > 50) {
      if (this.data.pv_accuracy_om == null) this.data.pv_accuracy_om = 1.0;
      const omErr = Math.abs(actualW - omW) / Math.max(actualW, omW, 1);
      this.data.pv_accuracy_om = (alpha * (1 - omErr)) + ((1 - alpha) * this.data.pv_accuracy_om);
    }
    if (scW != null && scW > 50 && satW != null && satW > 50) {
      if (this.data.pv_accuracy_sc == null) this.data.pv_accuracy_sc = 1.0;
      const scErr = Math.abs(actualW - scW) / Math.max(actualW, scW, 1);
      this.data.pv_accuracy_sc = (alpha * (1 - scErr)) + ((1 - alpha) * this.data.pv_accuracy_sc);
    }

    // Per-OM-submodel accuracy EMA, same cadence/alpha as om/sc above — feeds getModelWeights()
    if (perModelW) {
      this.data.pv_model_accuracy = this.data.pv_model_accuracy || {};
      for (const m of Object.keys(perModelW)) {
        const mW = perModelW[m];
        if (mW == null || mW <= 50) continue;
        if (this.data.pv_model_accuracy[m] == null) this.data.pv_model_accuracy[m] = this._modelPrior(m);
        const mErr = Math.abs(actualW - mW) / Math.max(actualW, mW, 1);
        this.data.pv_model_accuracy[m] = (alpha * (1 - mErr)) + ((1 - alpha) * this.data.pv_model_accuracy[m]);
      }
    }

    if (satW != null && satW > 50) {
      if (this.data.pv_accuracy_sat == null) this.data.pv_accuracy_sat = 1.0;
      const satErr = Math.abs(actualW - satW) / Math.max(actualW, satW, 1);
      this.data.pv_accuracy_sat = (alpha * (1 - satErr)) + ((1 - alpha) * this.data.pv_accuracy_sat);
    }

    const _liveStr = this.data.pv_accuracy_score_live != null
      ? `, live=${predictedLiveW ?? '-'}W scoreLive=${this.data.pv_accuracy_score_live.toFixed(2)}`
      : '';
    this.log(`PV accuracy: predicted=${predictedW}W, actual=${actualW}W, om=${omW ?? '-'}W, sc=${scW ?? '-'}W, sat=${satW ?? '-'}W, error=${(error*100).toFixed(1)}%, score=${this.data.pv_accuracy_score.toFixed(2)}${_liveStr}`);

    // Throttle saves: only persist every 10th call (~50 min at 5-min intervals)
    this._pvSaveCounter = (this._pvSaveCounter || 0) + 1;
    if (this._pvSaveCounter % 10 === 0) await this._saveData();
  }

  /**
   * Returns blend weights for OM and Solcast based on learned per-model accuracy.
   * Falls back to 0.5/0.5 until both models have been observed.
   * Clamped to [0.2, 0.8] to avoid fully discarding either model.
   * @returns {{ wOM: number, wSC: number }}
   */
  getPvBlendWeights() {
    const preds = (this.data.pv_predictions ?? [])
      .filter(r => typeof r.actual === 'number' && r.actual > 300
        && typeof r.om === 'number' && typeof r.sc === 'number');
    if (preds.length < 20) return { wOM: 0.5, wSC: 0.5 };
    const buf = preds.slice(-50);
    let bw = 0.5, bm = Infinity;
    for (let w = 0; w <= 1.0001; w += 0.05) {
      let ae = 0;
      for (const r of buf) ae += Math.abs(w * r.om + (1 - w) * r.sc - r.actual);
      if (ae < bm) { bm = ae; bw = w; }
    }
    const wOM = Math.min(0.8, Math.max(0.2, bw));
    return { wOM, wSC: 1 - wOM };
  }

  /**
   * Get PV prediction adjustment multiplier
   * @returns {number} Multiplier to apply to predictions (0.5 - 1.5)
   */
  getPvAdjustmentMultiplier() {
    // If we have no history, trust predictions fully
    if (this.data.pv_predictions.length < 10) return 1.0;
    
    // Calculate average error over recent predictions
    const recent = this.data.pv_predictions.slice(-100);
    const avgError = recent.reduce((sum, p) => sum + p.error, 0) / recent.length;
    
    // If consistently over-predicting (actual < predicted), reduce multiplier
    // If consistently under-predicting (actual > predicted), increase multiplier
    const avgRatio = recent.reduce((sum, p) => {
      return sum + (p.predicted > 0 ? p.actual / p.predicted : 1.0);
    }, 0) / recent.length;
    
    // Clamp adjustment between 0.5 and 1.5
    return Math.max(0.5, Math.min(1.5, avgRatio));
  }

  /**
   * Compute yesterday's actual vs forecast PV ratio from stored pv_predictions,
   * then update the daily level bias EMA. Maintains separate EMAs for clear days
   * (avg cloud cover ≤ 40%) and mixed/overcast days.
   * @param {string} yDateStr     - ISO date string 'YYYY-MM-DD' (UTC)
   * @param {number|null} avgCloudPct - Average cloud cover % for yesterday (0–100), or null if unknown
   */
  async recordDailyPvBiasFromPredictions(yDateStr, avgCloudPct = null, knmiKt = null, ktModels = null) {
    const preds = this.data.pv_predictions ?? [];
    const dayPreds = preds.filter(p => {
      if (!p.predicted || !p.actual || p.predicted <= 50 || p.actual <= 50) return false;
      return new Date(p.timestamp).toISOString().slice(0, 10) === yDateStr;
    });

    if (dayPreds.length < 4) {
      this.log(`Daily PV bias skipped for ${yDateStr}: only ${dayPreds.length} valid samples`);
      return;
    }

    const sumActual    = dayPreds.reduce((s, p) => s + p.actual,    0);
    const sumPredicted = dayPreds.reduce((s, p) => s + p.predicted, 0);
    if (sumPredicted <= 0) return;

    const ratio = Math.max(0.3, Math.min(2.0, sumActual / sumPredicted));
    const alpha = 0.15;

    // One scoreboard row per day, so the clear-sky formula can be judged on realised outcome
    // instead of on argument. `ratio` is the whole point: it is how far the PV forecast for that
    // day actually landed off, and it is otherwise computed here and thrown away
    // (feedback_persist_state_for_posthoc_analysis).
    //
    // Written BEFORE the EMA update below: the factor that mattered is the one in force during
    // that day, not the one this very sample shifts it to.
    //
    // Only the days where the two models disagree carry information, and those are winter days —
    // in summer both label everything the same. Retention is sized for that: 250 days spans a
    // whole dark season plus the shoulder months on either side.
    if (ktModels) {
      const bS = LearningEngine.classifyKt(ktModels.simple);
      const bH = LearningEngine.classifyKt(ktModels.haurwitz);
      const row = {
        d: yDateStr,
        ratio: Math.round(ratio * 1000) / 1000,
        ktS: ktModels.simple != null ? Math.round(ktModels.simple * 1000) / 1000 : null,
        ktH: ktModels.haurwitz != null ? Math.round(ktModels.haurwitz * 1000) / 1000 : null,
        bS,
        bH,
        fS: Math.round(this.getDailyPvBiasFactor(avgCloudPct, ktModels.simple) * 1000) / 1000,
        fH: Math.round(this.getDailyPvBiasFactor(avgCloudPct, ktModels.haurwitz) * 1000) / 1000,
        active: ktModels.active ?? 'simple',
        n: dayPreds.length,
      };
      this.data.kt_model_scoreboard = (this.data.kt_model_scoreboard ?? [])
        .filter((r) => r.d !== yDateStr)
        .concat(row)
        .slice(-250);
      // |ratio - factor| is the scoring quantity: which label's correction sat closer to what the
      // day actually did. Logged per day so the verdict is readable without dumping the store.
      const errS = Math.abs(ratio - row.fS), errH = Math.abs(ratio - row.fH);
      // this.homey.log, NOT this.log: `debug` at the top of this file is a hardcoded false, so
      // every this.log() in this class is dead — which is also why the "Daily PV bias" lines have
      // never appeared in a log. The row is persisted either way; this line is the readable surface.
      this.homey.log(`[KT SCORE] ${yDateStr} ratio=${row.ratio} | simple kt=${row.ktS} ${bS} f=${row.fS} err=${errS.toFixed(3)}`
        + ` | haurwitz kt=${row.ktH} ${bH} f=${row.fH} err=${errH.toFixed(3)}`
        + ` | ${bS === bH ? 'zelfde bucket' : (errH < errS ? 'WISSEL, haurwitz beter' : 'WISSEL, simple beter')}`);
    }

    // Prefer KNMI clearness index (kt) over OM cloud% — OM systematically over-predicts cloud cover.
    // kt = actual GHI / clear-sky GHI: ≥0.65 = clear, <0.30 = overcast, otherwise mixed.
    let isClear, isOvercast, classLabel;
    if (knmiKt != null) {
      const cls = LearningEngine.classifyKt(knmiKt);
      isClear    = cls === 'clear';
      isOvercast = cls === 'overcast';
      classLabel = `kt=${knmiKt.toFixed(2)}`;
    } else {
      isClear    = avgCloudPct != null && avgCloudPct <= 20;
      isOvercast = avgCloudPct != null && avgCloudPct >  75;
      classLabel = avgCloudPct != null ? `cloud=${avgCloudPct.toFixed(0)}%` : 'cloud=unknown';
    }

    if (isClear) {
      this.data.pv_daily_bias_clear = alpha * ratio + (1 - alpha) * (this.data.pv_daily_bias_clear ?? 1.0);
      this.data.pv_daily_bias_clear_samples = (this.data.pv_daily_bias_clear_samples ?? 0) + 1;
      this.log(`Daily PV bias (clear, ${classLabel}) for ${yDateStr}: ratio=${ratio.toFixed(3)}, bias=${this.data.pv_daily_bias_clear.toFixed(3)} (n=${this.data.pv_daily_bias_clear_samples})`);
    } else if (isOvercast) {
      this.data.pv_daily_bias_overcast = alpha * ratio + (1 - alpha) * (this.data.pv_daily_bias_overcast ?? 1.0);
      this.data.pv_daily_bias_overcast_samples = (this.data.pv_daily_bias_overcast_samples ?? 0) + 1;
      this.log(`Daily PV bias (overcast, ${classLabel}) for ${yDateStr}: ratio=${ratio.toFixed(3)}, bias=${this.data.pv_daily_bias_overcast.toFixed(3)} (n=${this.data.pv_daily_bias_overcast_samples})`);
    } else {
      this.data.pv_daily_bias = alpha * ratio + (1 - alpha) * (this.data.pv_daily_bias ?? 1.0);
      this.data.pv_daily_bias_samples = (this.data.pv_daily_bias_samples ?? 0) + 1;
      this.log(`Daily PV bias (mixed, ${classLabel}) for ${yDateStr}: ratio=${ratio.toFixed(3)}, bias=${this.data.pv_daily_bias.toFixed(3)} (n=${this.data.pv_daily_bias_samples})`);
    }

    await this._saveData();
  }

  /**
   * Record Open-Meteo radiation forecast accuracy for a day.
   * Call once per day after comparing yesterday's forecasted vs actual radiation.
   * @param {number} forecastAvgWm2 - Average radiation forecasted for yesterday's daylight hours
   * @param {number} actualAvgWm2   - Average radiation actually observed (from past_days=1)
   */
  async recordRadiationAccuracy(forecastAvgWm2, actualAvgWm2) {
    if (forecastAvgWm2 <= 0) return; // no daylight to compare
    // Reject samples where the forecast snapshot is suspiciously low — likely a data
    // glitch or saved during a period with no valid radiation data. A threshold of 30 W/m²
    // is below any real cloudy-day average but above noise/zeros from bad API responses.
    if (forecastAvgWm2 < 30) {
      this.log(`Radiation bias skipped: forecast avg ${forecastAvgWm2.toFixed(0)} W/m² too low — likely bad snapshot`);
      return;
    }

    // Cap ratio to avoid single weather-model misses (e.g. predicted cloudy, turned sunny)
    // from dominating the EMA. A 3× ratio already signals a major miss.
    const ratio = Math.min(actualAvgWm2 / forecastAvgWm2, 3.0);
    const now = Date.now();

    this.data.radiation_bias_samples = this.data.radiation_bias_samples || [];
    this.data.radiation_bias_samples.push({ ratio, timestamp: now });

    // Keep last 30 days of daily samples
    if (this.data.radiation_bias_samples.length > 30) {
      this.data.radiation_bias_samples = this.data.radiation_bias_samples.slice(-30);
    }

    // EMA update (alpha=0.15: slower than PV — weather bias shifts seasonally)
    const alpha = 0.15;
    const prev = this.data.radiation_bias_factor ?? 1.0;
    this.data.radiation_bias_factor = Math.max(0.3, Math.min(2.0,
      alpha * ratio + (1 - alpha) * prev
    ));

    this.log(`Radiation bias: forecast=${forecastAvgWm2.toFixed(0)}W/m², actual=${actualAvgWm2.toFixed(0)}W/m², ratio=${ratio.toFixed(2)}, factor=${this.data.radiation_bias_factor.toFixed(2)}`);

    await this._saveData();
  }

  /**
   * Get the learned radiation bias correction factor.
   * Multiply forecasted W/m² values by this before using in planning.
   * 1.0 = model is accurate, 0.8 = model over-predicts by 20%
   * @returns {number} Correction factor clamped to 0.3–2.0
   */
  getRadiationBiasFactor() {
    // Need at least 3 samples before trusting the bias
    if (!this.data.radiation_bias_samples || this.data.radiation_bias_samples.length < 3) return 1.0;
    // Once yield factors are learned (≥10 slots), they already absorb the relationship between
    // Open-Meteo radiation and actual PV output. Applying bias on top double-counts the correction.
    if (this.getSolarLearnedSlotCount() >= 10) return 1.0;
    return this.data.radiation_bias_factor ?? 1.0;
  }

  /**
   * Returns the learned daily PV level bias factor.
   * Prefers KNMI clearness index (kt) for classification when available — same logic as
   * recordDailyPvBiasFromPredictions to avoid record/apply mismatch.
   * Falls back to OM cloud% when kt unavailable.
   * @param {number|null} avgCloudPct - Today's average forecast cloud cover (0–100), or null
   * @param {number|null} knmiKt      - Today's KNMI clearness index, or null
   * @returns {number} Correction factor clamped to 0.3–2.0
   */
  /**
   * Weather-type bucket for a clearness index. THE single place the 0.30 / 0.65 thresholds live —
   * they sat inline at three call sites (this getter, the EMA write path in
   * `recordDailyPvBias`, and `_groundClear` in the battery-policy device), which made any change
   * to the kt scale move two gates nobody was looking at.
   *
   * The thresholds are constants while the kt scale is not season-neutral, so they are only as
   * meaningful as the clear-sky denominator behind them — see `WeatherForecaster._clearSkyGhi`.
   *
   * @param {number|null} kt
   * @returns {'clear'|'mixed'|'overcast'|null} null when there is no kt to classify
   */
  static classifyKt(kt) { return classifyKt(kt); }

  getDailyPvBiasFactor(avgCloudPct = null, knmiKt = null) {
    // Per-weather-type bias corrects the residual that single-blend yield factors
    // miss: clear days have higher effective yf (more direct beam on tilted panels),
    // overcast days lower. This is NOT double-counting — yf captures the average,
    // daily bias captures the weather-type deviation from that average.
    let isClear, isOvercast;
    if (knmiKt != null) {
      const cls = LearningEngine.classifyKt(knmiKt);
      isClear    = cls === 'clear';
      isOvercast = cls === 'overcast';
    } else {
      isClear    = avgCloudPct != null && avgCloudPct <= 20;
      isOvercast = avgCloudPct != null && avgCloudPct >  75;
    }
    if (isClear && (this.data.pv_daily_bias_clear_samples ?? 0) >= 5) {
      return this.data.pv_daily_bias_clear ?? 1.0;
    }
    if (isOvercast && (this.data.pv_daily_bias_overcast_samples ?? 0) >= 5) {
      return this.data.pv_daily_bias_overcast ?? 1.0;
    }
    // Fallback: mixed EMA (covers intermediate kt/cloud and any class with < 5 samples)
    if ((this.data.pv_daily_bias_samples ?? 0) < 5) return 1.0;
    return this.data.pv_daily_bias ?? 1.0;
  }

  /**
   * Update the per-slot solar yield factor from a live PV power measurement.
   * Approach inspired by de Gruijter's SolarLearningStrategy (com.gruijter.powerhour).
   * Core concept: yieldFactor = W_actual / (W/m²) — absorbs capacity, orientation, PR and shading.
   * Called every time the PV flow card fires; radiation is interpolated from weather data.
   *
   * @param {Date}   timestamp    - Current time
   * @param {number} powerW       - Actual PV production in watts
   * @param {number} radiationWm2 - Current radiation (GTI or GHI) in W/m²
   */
  updateSolarYieldFactor(timestamp, powerW, radiationWm2) {
    if (radiationWm2 < 30) return; // absolute floor — ignore dawn/dusk where ratio is too noisy

    const d = new Date(timestamp);
    const slotIndex = (d.getUTCHours() * 4) + Math.floor(d.getUTCMinutes() / 15);

    // Dynamic threshold: only learn when radiation is meaningful for this slot.
    // Tracks the highest radiation ever seen per slot, learns only above 15% of that.
    // Prevents low-quality dawn/dusk samples from corrupting the slot model.
    this.data.solar_slot_max_radiation = this.data.solar_slot_max_radiation || new Array(96).fill(0);
    if (radiationWm2 > this.data.solar_slot_max_radiation[slotIndex]) {
      this.data.solar_slot_max_radiation[slotIndex] = radiationWm2;
    }
    const dynamicThreshold = this.data.solar_slot_max_radiation[slotIndex] * 0.15;
    if (radiationWm2 < dynamicThreshold) return;

    const yf = Math.max(0, powerW) / radiationWm2;
    if (!Number.isFinite(yf) || yf < 0.01 || yf > 500) return;

    this.data.solar_yield_factors = this.data.solar_yield_factors || new Array(96).fill(null);
    const old = this.data.solar_yield_factors[slotIndex];

    // Curtailment guard: near-zero power (<30W) when the model expects significant output
    // means the inverter was likely off (net outage, startup delay, grid protection), not cloudy.
    // Cloudy days produce gradual reduction caught by the 80% drop filter; curtailment causes
    // an abrupt floor. Only active once the slot has a learned baseline (old !== null).
    if (powerW < 30 && old !== null && old > 0) {
      const expectedW = old * radiationWm2;
      if (expectedW > 200) {
        this.log(`Solar yield slot ${slotIndex}: curtailment suspected (${Math.round(powerW)}W actual, ${Math.round(expectedW)}W expected) — skipped`);
        return;
      }
    }

    // Spike protection: ignore readings >1.25× current global max
    const globalMax = Math.max(...this.data.solar_yield_factors.filter(v => v !== null), 0);
    if (globalMax > 0 && yf > globalMax * 1.25) {
      this.log(`Solar yield slot ${slotIndex}: spike ignored (${yf.toFixed(2)} > 1.25×${globalMax.toFixed(2)})`);
      return;
    }

    // Outlier rejection: transient cloud causing >80% drop vs learned model
    if (old !== null && old > 0 && yf < old * 0.2) {
      this.log(`Solar yield slot ${slotIndex}: drop ignored (${yf.toFixed(2)} vs model ${old.toFixed(2)})`);
      return;
    }

    // Symmetric EMA (α=0.10): unbiased convergence to the typical yield for this slot.
    // An asymmetric EMA (fast up, slow down) was tried but caused upward drift toward
    // the all-time peak, producing unrealistically high forecasts (e.g. 4.6 kW on 3500 Wp).
    const alpha = old === null ? 1.0 : 0.10;
    const newYf  = old === null ? yf : alpha * yf + (1 - alpha) * old;

    this.data.solar_yield_factors[slotIndex] = newYf;
    this.log(`Solar yield slot ${slotIndex}: ${old !== null ? old.toFixed(2) : 'init'} → ${newYf.toFixed(2)} (inst=${yf.toFixed(2)}, P=${Math.round(powerW)}W, R=${Math.round(radiationWm2)}W/m²)`);

    // Track per-slot peak yield factor for clear-sky ceiling (only from spike-checked readings).
    this.data.solar_slot_max_yield_factor = this.data.solar_slot_max_yield_factor || new Array(96).fill(0);
    if (yf > (this.data.solar_slot_max_yield_factor[slotIndex] || 0)) {
      this.data.solar_slot_max_yield_factor[slotIndex] = yf;
    }

    // At the exact moment we cross from <10 to 10 learned slots, the bias factor transitions
    // from active (applied to radiation) to inactive (returns 1.0). Normalize all stored yield
    // factors by the bias factor so they remain calibrated for unbiased-radiation forecasting.
    const countNow = this.getSolarLearnedSlotCount();
    if (countNow === 10 && !this.data.solar_yield_normalize_at10) {
      this.data.solar_yield_normalize_at10 = true;
      const bF = this.data.radiation_bias_factor ?? 1.0;
      if (bF > 1.01) {
        for (let i = 0; i < 96; i++) {
          if (this.data.solar_yield_factors[i] !== null) {
            this.data.solar_yield_factors[i] *= bF;
          }
        }
        this.log(`Solar yield: normalized 10 slots ×${bF.toFixed(2)} at bias→yield-factor transition`);
      }
    }

    // Fire-and-forget save (not awaited — too frequent to block on)
    this._saveData().catch(() => {});
  }

  /**
   * Check if panel geometry changed since YFs were learned. Resets YFs on mismatch.
   * Called from _updateWeather where tilt/azimuth are available.
   */
  async checkPanelGeometry(tilt, azimuth) {
    if (tilt == null && azimuth == null) return;
    const key = `${tilt ?? ''}|${azimuth ?? ''}`;
    const stored = this.data.solar_yield_geometry;
    if (stored === key) return;
    if (stored != null) {
      const count = this.getSolarLearnedSlotCount();
      if (count > 0) {
        this.homey.log(`[LearningEngine] Panel geometry changed (${stored} → ${key}) — resetting ${count} yield slots`);
        this.data.solar_yield_factors = new Array(96).fill(null);
        this.data.solar_slot_max_radiation = new Array(96).fill(0);
      }
    }
    this.data.solar_yield_geometry = key;
    await this._saveData();
  }

  /**
   * Return the learned per-slot yield factors (96 entries, null = not yet learned).
   * @returns {Array<number|null>}
   */
  getSolarYieldFactors() {
    return this.data.solar_yield_factors || new Array(96).fill(null);
  }

  getSolarSlotMaxYieldFactors() {
    return this.data.solar_slot_max_yield_factor || new Array(96).fill(0);
  }

  /**
   * How many slots have been learned (0–96). Fewer than ~10 means insufficient data.
   * @returns {number}
   */
  getSolarLearnedSlotCount() {
    return (this.data.solar_yield_factors || []).filter(v => v !== null).length;
  }

  /**
   * Return yield factors smoothed and gap-filled for use in forecasting.
   *
   * Step 1 — fill null slots: linear interpolation between nearest learned neighbours.
   *   Slots with no learned neighbours stay 0 (e.g. deep night with no sun).
   * Step 2 — 3-pass weighted smoothing (0.25 / 0.5 / 0.25): removes quantisation
   *   noise while preserving the physical curve shape.
   *
   * The raw learned values are never modified; this only affects forecast output.
   * @returns {Array<number>} 96 numbers (0 where no data and no interpolation possible)
   */
  getSolarYieldFactorsSmoothed() {
    const raw = this.data.solar_yield_factors || new Array(96).fill(null);
    if (raw.filter(v => v !== null).length < 5) return raw.map(v => v ?? 0);

    // Step 1: fill null gaps by linear interpolation
    const filled = raw.map((v, i) => {
      if (v !== null) return v;
      let li = -1, ri = -1;
      for (let j = i - 1; j >= 0;  j--) { if (raw[j] !== null) { li = j; break; } }
      for (let j = i + 1; j < 96; j++) { if (raw[j] !== null) { ri = j; break; } }
      if (li < 0 && ri < 0) return 0;
      if (li < 0) return raw[ri];
      if (ri < 0) return raw[li];
      const t = (i - li) / (ri - li);
      return raw[li] + (raw[ri] - raw[li]) * t;
    });

    // Step 2: 3-pass weighted smoothing
    let result = filled;
    for (let pass = 0; pass < 3; pass++) {
      const s = [...result];
      for (let i = 1; i < 95; i++) {
        s[i] = 0.25 * result[i - 1] + 0.5 * result[i] + 0.25 * result[i + 1];
      }
      s[0]  = 0.75 * result[0]  + 0.25 * result[1];
      s[95] = 0.75 * result[95] + 0.25 * result[94];
      result = s;
    }

    return result;
  }

  /**
   * Save a daily radiation forecast snapshot for tomorrow's bias comparison.
   * Stored in device store (survives app restarts and redeployments).
   * @param {string} dateStr - 'YYYY-MM-DD' UTC date
   * @param {number} forecastAvgWm2 - Average forecasted radiation (W/m²) for daylight hours
   */
  async saveForecastSnapshot(dateStr, forecastAvgWm2) {
    this.data.forecast_snapshots = this.data.forecast_snapshots || {};
    this.data.forecast_snapshots[dateStr] = { forecastAvgWm2, savedAt: Date.now() };

    // Keep only last 5 days
    const keys = Object.keys(this.data.forecast_snapshots).sort();
    if (keys.length > 5) {
      for (const old of keys.slice(0, keys.length - 5)) {
        delete this.data.forecast_snapshots[old];
      }
    }

    await this._saveData();
  }

  /**
   * Retrieve a previously saved radiation forecast snapshot.
   * @param {string} dateStr - 'YYYY-MM-DD' UTC date
   * @returns {{ forecastAvgWm2: number, savedAt: number } | null}
   */
  getForecastSnapshot(dateStr) {
    return this.data.forecast_snapshots?.[dateStr] ?? null;
  }

  /**
   * Domain-knowledge prior for NL conditions: Harmonie/ICON beat ECMWF/GFS at day+1.
   * Used as EMA start value — learned accuracy drifts from here over time.
   */
  _modelPrior(m) {
    const PRIORS = {
      knmi_harmonie_arome_netherlands: 0.90,
      icon_seamless:                   0.87,
      meteofrance_arpege_europe:       0.82,
      ecmwf_ifs:                       0.80,
      gfs_seamless:                    0.77,
    };
    return PRIORS[m] ?? 0.84;
  }

  /**
   * Store an hourly KNMI station qg reading for use as ground-truth in accuracy tracking.
   * Keeps last 2 calendar days (UTC) — pruned on write.
   * @param {number} wm2      Global solar radiation from nearest station (W/m²)
   * @param {string} dateStr  UTC date 'YYYY-MM-DD'
   * @param {number} hour     UTC hour 0-23
   */
  recordKnmiHourlyActual(wm2, dateStr, hour) {
    if (typeof wm2 !== 'number' || !isFinite(wm2)) return;
    if (!this.data.knmi_hourly_actuals) this.data.knmi_hourly_actuals = {};
    if (!this.data.knmi_hourly_actuals[dateStr]) this.data.knmi_hourly_actuals[dateStr] = {};
    this.data.knmi_hourly_actuals[dateStr][hour] = wm2;
    // Prune dates older than 2 days
    const cutoff = new Date(dateStr);
    cutoff.setUTCDate(cutoff.getUTCDate() - 2);
    for (const d of Object.keys(this.data.knmi_hourly_actuals)) {
      if (new Date(d) < cutoff) delete this.data.knmi_hourly_actuals[d];
    }
  }

  /**
   * Store an hourly measured cloud-cover fraction (0-1) from the okta station.
   * Kept alongside knmi_hourly_actuals so measured cover and measured radiation can be paired
   * per hour. Keeps last 2 calendar days (UTC) — pruned on write.
   * @param {number} frac     Cloud cover 0-1 (okta/8)
   * @param {string} dateStr  UTC date 'YYYY-MM-DD'
   * @param {number} hour     UTC hour 0-23
   */
  recordKnmiHourlyCloud(frac, dateStr, hour) {
    if (typeof frac !== 'number' || !isFinite(frac)) return;
    if (!this.data.knmi_hourly_cloud) this.data.knmi_hourly_cloud = {};
    if (!this.data.knmi_hourly_cloud[dateStr]) this.data.knmi_hourly_cloud[dateStr] = {};
    this.data.knmi_hourly_cloud[dateStr][hour] = frac;
    // Prune dates older than 2 days
    const cutoff = new Date(dateStr);
    cutoff.setUTCDate(cutoff.getUTCDate() - 2);
    for (const d of Object.keys(this.data.knmi_hourly_cloud)) {
      if (new Date(d) < cutoff) delete this.data.knmi_hourly_cloud[d];
    }
  }

  /**
   * Returns average W/m² from stored KNMI station readings for a given date (daylight only: > 10 W/m²).
   * @param {string} dateStr  UTC date 'YYYY-MM-DD'
   * @returns {number|null}
   */
  getKnmiDailyAvg(dateStr) {
    const hours = this.data.knmi_hourly_actuals?.[dateStr];
    if (!hours) return null;
    const vals = Object.values(hours).filter(v => v > 10);
    if (vals.length < 4) return null; // need at least 4h of daylight data
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  /**
   * Returns normalised blend weights per OM ensemble model, based on learned accuracy.
   * Falls back to domain-knowledge priors until data accumulates.
   * @returns {{ [model]: number }} weights summing to 1.0
   */
  /**
   * Store the 14-day per-model hindcast ranking (5 floats + meta — negligible for the store blob).
   * @param {{scores: object, n: number}} result  from model-hindcast.scoreModels()
   */
  async recordModelHindcast({ scores, n }) {
    if (!scores || typeof n !== 'number') return;
    this.data.pv_model_hindcast = { scores, n, computedAt: Date.now() };
    await this._saveData();
  }

  getModelWeights() {
    const MODELS = ENSEMBLE_MODELS;
    // 14-day hindcast ranking (lib/model-hindcast.js) replaces the ~3-day EMA when it is switched
    // on, wide enough to be a measurement, and fresh. Default off: the daily job logs both
    // rankings side by side first. Every other path below is untouched, so with the flag off this
    // returns exactly what it returned before the hindcast existed.
    const hc = this.data.pv_model_hindcast;
    const hcFresh = hc && (Date.now() - (hc.computedAt ?? 0)) < HINDCAST_MAX_AGE_MS;
    const useHindcast = this.hindcastEnabled === true && hcFresh && (hc.n ?? 0) >= MIN_PAIRED_HOURS;

    const acc = useHindcast
      ? MODELS.map(m => ({ m, acc: hc.scores?.[m] ?? 0 }))
      : MODELS.map(m => ({ m, acc: this.data.pv_model_accuracy?.[m] ?? this._modelPrior(m) }));
    // Rank-based gentle tilt: best-ranked model gets a mild edge, but no model is
    // ever zeroed. Measured 2026-06-20 (8 days): per-submodel rank rotates daily
    // (no model consistently best) so a harsh [6,3,1,0] chased noise and matched
    // plain equal-weight in mean AND tail. [4,3,2,1] keeps the diversification,
    // drops the noise-driven swings, and retains a weak guard against a model that
    // turns persistently bad. See project_om_submodel_ema. Extended to [5,4,3,2,1]
    // (same decreasing-tilt shape) when ECMWF was added as a 5th model.
    const RANK_WEIGHTS = [5, 4, 3, 2, 1];
    const ranked = [...acc].sort((a, b) => b.acc - a.acc);
    const total = RANK_WEIGHTS.reduce((a, b) => a + b, 0);
    const weightMap = Object.fromEntries(ranked.map((r, i) => [r.m, RANK_WEIGHTS[i] / total]));
    return Object.fromEntries(MODELS.map(m => [m, weightMap[m]]));
  }

  /**
   * Record policy decision and its outcome
   * @param {string} mode - Recommended mode
   * @param {Object} context - Decision context
   */
  async recordPolicyDecision(mode, context) {
    const now = Date.now();
    
    this.data.policy_decisions.push({
      timestamp: now,
      mode: mode,
      soc: context.soc,
      price: context.price,
      sun_forecast: context.sun4h,
      confidence: context.confidence
    });
    
    // Keep only last 500 decisions (~ 5 days at 15min intervals)
    if (this.data.policy_decisions.length > 500) {
      this.data.policy_decisions = this.data.policy_decisions.slice(-500);
    }
    
    // Throttle saves: only persist every 5th decision (~75 min at 15-min intervals)
    this._policySaveCounter = (this._policySaveCounter || 0) + 1;
    if (this._policySaveCounter % 5 === 0) await this._saveData();
  }

  // getConfidenceAdjustment() lived here until 2026-07-18. It scored a proposed mode by
  // averaging the confidence this app had itself assigned to similar past decisions — no
  // outcome anywhere in the loop, so confidence simply fed confidence. It dates from the
  // score-and-weights era (2026-02-14), a month before the DP arrived (2026-03-15); once the
  // DP path hardcoded confidence to `exception ? 75 : 90` (2026-04-13) its input stopped
  // varying and it emitted a constant +2.2 into a gate that has never fired. Removed rather
  // than repaired: see the note at its former call site in battery-policy/device.js.
  //
  // policy_decisions is still written by recordPolicyDecision() below, but now only feeds the
  // count in getStatistics(). Left in place deliberately — it is the raw material any real
  // outcome-based version would need.

  /**
   * Get learning statistics for display
   */
  getStatistics() {
    const daysTracking = (Date.now() - this.data.stats.learning_started) / (1000 * 60 * 60 * 24);
    
    // Count how many 15-min quarter-slots have data (7 × 24 × 4 = 672 total)
    let slotsWithData = 0;
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        for (let q = 0; q < 4; q++) {
          if (this.data.consumption_patterns[day][hour][q].count > 0) slotsWithData++;
        }
      }
    }

    return {
      days_tracking: Math.floor(daysTracking),
      total_samples: this.data.stats.total_samples,
      pattern_coverage: Math.round((slotsWithData / 672) * 100), // 672 = 7*24*4
      pv_predictions: this.data.pv_predictions.length,
      pv_accuracy: Math.round(this.data.pv_accuracy_score * 100),
      policy_decisions: this.data.policy_decisions.length
    };
  }

  /**
   * Clear all learning data (reset)
   */
  async reset() {
    this.data = {
      consumption_patterns: this._initializeConsumptionPatterns(),
      pv_predictions: [],
      pv_accuracy_score: 1.0,
      radiation_bias_samples: [],
      radiation_bias_factor: 1.0,
      policy_decisions: [],
      policy_success_rate: 1.0,
      last_updated: Date.now(),
      stats: {
        total_samples: 0,
        days_tracked: 0,
        learning_started: Date.now()
      }
    };
    
    await this._saveData();
    this.log('Learning data reset');
  }

  savePvNetSurplusPrediction(dateStr, predictedKwh) {
    this.data.pv_net_surplus_pending = { date: dateStr, predicted: predictedKwh };
  }

  settlePvNetSurplusAccuracy(dateStr, actualKwh) {
    const pending = this.data.pv_net_surplus_pending;
    if (!pending || pending.date !== dateStr || pending.predicted <= 0.1) return;
    const ratio = Math.min(2, actualKwh / pending.predicted);
    const alpha = 0.15;
    const prev = this.data.pv_net_surplus_factor ?? 1.0;
    this.data.pv_net_surplus_factor = Math.min(1.1, Math.max(0.4, alpha * ratio + (1 - alpha) * prev));
    this.homey.log(`[Learning] pvNetSurplus: date=${dateStr} predicted=${pending.predicted.toFixed(1)}kWh actual=${actualKwh.toFixed(1)}kWh ratio=${ratio.toFixed(2)} → factor=${this.data.pv_net_surplus_factor.toFixed(2)} (was ${prev.toFixed(2)})`);
    this.data.pv_net_surplus_pending = null;
    this._saveData().catch(() => {});
  }

  getPvNetSurplusAccuracyFactor() {
    return this.data.pv_net_surplus_factor ?? 1.0;
  }

  // Single scalar yield factor (panel-plane basis). satGhiWm2 here is the panel-plane
  // GHI (raw × gtiOverGhi, device.js) — the sun-angle geometry already lives in that
  // transposition, so the yield factor yf = actualW / panelPlaneGHI is ~constant across
  // the day and is pooled into ONE EMA over all daytime hours. Per-hour was legacy of the
  // horizontal basis and double-counted the tilt (see lib/sat-yield-factors.js). Pooling
  // ~30-50 samples/day converges in ~1 day, so the old per-hour cross-hour-cap / escape-hatch
  // machinery (needed only because sparse per-hour samples got stuck) is gone.
  // `quality` carries the two inputs that decide whether the panel-plane GHI handed in here
  // means anything: the transposition ratio it was built with, and the solar elevation of the
  // satellite bucket. Both gates mirror bars the consuming side already enforces — see
  // lib/sat-yield-factors.js. Omitted → gate inactive (older callers keep working).
  recordSatYield(utcHour, satGhiWm2, actualW, quality = {}) {
    if (satGhiWm2 <= 0 || utcHour < 0 || utcHour > 23 || actualW == null) return;
    const { gtiOverGhi = null, elevDeg = null } = quality;
    if (elevDeg != null && elevDeg < SAT_MIN_ELEV_DEG) {
      this.homey.log(`[SAT YF] reject: elev h=${utcHour} elev=${elevDeg.toFixed(1)}<${SAT_MIN_ELEV_DEG}`);
      return;
    }
    if (gtiOverGhi != null && gtiOverGhi <= GTI_GHI_CLAMP_MIN) {
      this.homey.log(`[SAT YF] reject: gti-clamp h=${utcHour} ratio=${gtiOverGhi.toFixed(3)}`);
      return;
    }
    this.data.solar_sat_max_radiation = this.data.solar_sat_max_radiation || {};
    if (satGhiWm2 > (this.data.solar_sat_max_radiation[utcHour] || 0)) {
      this.data.solar_sat_max_radiation[utcHour] = satGhiWm2;
    }
    const dynamicThreshold = (this.data.solar_sat_max_radiation[utcHour] || 0) * 0.15;
    if (satGhiWm2 < dynamicThreshold) return;
    const yf = Math.max(0, actualW) / satGhiWm2;
    if (!Number.isFinite(yf) || yf < 0.1 || yf > 20) return;
    const old = this.data.solar_sat_yield_factor ?? SAT_YF_PRIOR;
    if (actualW < 30 && old * satGhiWm2 > 200) return;
    // Reject one-off extreme outliers (satellite glint, cloud edge). Band is wide because
    // residual gtiOverGhi error still leaves legitimate hour-to-hour spread; a stuck-wrong
    // scalar self-heals within a day via pooling, so no escape hatch is needed.
    if (yf > old * 2.5 || yf < old * 0.4) return;
    const newYf = 0.10 * yf + 0.90 * old;
    this.data.solar_sat_yield_factor = newYf;
    this.homey.log(`[SAT YF] h=${utcHour} sample=${yf.toFixed(3)} → ema=${newYf.toFixed(3)}`);
  }

  getSatYieldFactor() {
    return this.data.solar_sat_yield_factor ?? null;
  }

  /**
   * Save data to device store
   */
  async _saveData() {
    this.data.last_updated = Date.now();
    await this.device.setStoreValue('learning_data', this.data);
    this.log('Learning data saved');
  }
}

module.exports = LearningEngine;
