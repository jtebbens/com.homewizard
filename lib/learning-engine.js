'use strict';

/**
 * LearningEngine - Tracks historical performance and learns patterns
 * 
 * Features:
 * - Hourly consumption patterns by day-of-week
 * - PV production accuracy tracking
 * - Policy decision success rate
 * - Adaptive confidence scoring
 */

const debug = false;

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
    } else {
      // Initialize fresh data structure
      this.data = {
        // Hourly consumption patterns: [day_of_week][hour] = { sum, count, avg }
        consumption_patterns: this._initializeConsumptionPatterns(),
        
        // PV prediction accuracy: track predicted vs actual
        pv_predictions: [],
        pv_accuracy_score: 1.0, // 1.0 = perfect, adjusts over time

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
        }
      };
      
      await this._saveData();
    }
  }

  /**
   * Initialize consumption pattern structure
   * 7 days × 24 hours with sum/count/avg
   */
  _initializeConsumptionPatterns() {
    const patterns = {};
    for (let day = 0; day < 7; day++) {
      patterns[day] = {};
      for (let hour = 0; hour < 24; hour++) {
        patterns[day][hour] = { sum: 0, count: 0, avg: 0 };
      }
    }
    return patterns;
  }

  /**
   * Record actual consumption for learning
   * @param {number} powerW - Current grid import power
   */
  async recordConsumption(powerW) {
    if (powerW < 0) return; // Only track import, not export
    
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = now.getHours();
    
    const pattern = this.data.consumption_patterns[dayOfWeek][hour];
    // Use exponential moving average once we have enough data to avoid
    // sum/count growing unboundedly (which bloats the store over years).
    if (pattern.count < 100) {
      pattern.sum += powerW;
      pattern.count += 1;
      pattern.avg = pattern.sum / pattern.count;
    } else {
      // EMA with alpha=0.01 — memory-efficient rolling average
      const alpha = 0.01;
      pattern.avg = alpha * powerW + (1 - alpha) * pattern.avg;
      // Keep sum/count in sync so getPredictedConsumption still works;
      // cap count at 100 to prevent overflow
      pattern.sum = pattern.avg * pattern.count;
    }
    
    this.data.stats.total_samples += 1;
    
    // Save periodically (every 100 samples)
    if (this.data.stats.total_samples % 100 === 0) {
      await this._saveData();
    }
  }

  /**
   * Get predicted consumption for a specific time
   * @param {Date} targetTime - Time to predict for
   * @returns {number} Predicted power in W
   */
  getPredictedConsumption(targetTime = new Date()) {
    const dayOfWeek = targetTime.getDay();
    const hour = targetTime.getHours();
    
    const pattern = this.data.consumption_patterns[dayOfWeek][hour];
    
    // If we have data, return average
    if (pattern.count > 0) {
      return pattern.avg;
    }
    
    // Fallback: try same hour on other days
    let totalSum = 0;
    let totalCount = 0;
    
    for (let day = 0; day < 7; day++) {
      const dayPattern = this.data.consumption_patterns[day][hour];
      if (dayPattern.count > 0) {
        totalSum += dayPattern.sum;
        totalCount += dayPattern.count;
      }
    }
    
    return totalCount > 0 ? totalSum / totalCount : 0;
  }

  /**
   * Get consumption prediction confidence
   * @param {Date} targetTime - Time to predict for
   * @returns {number} Confidence 0-100
   */
  getConsumptionConfidence(targetTime = new Date()) {
    const dayOfWeek = targetTime.getDay();
    const hour = targetTime.getHours();
    
    const pattern = this.data.consumption_patterns[dayOfWeek][hour];
    
    // Confidence based on sample count
    // 0-10 samples: 0-50%, 10-50 samples: 50-90%, 50+ samples: 90-100%
    if (pattern.count === 0) return 0;
    if (pattern.count < 10) return Math.min(50, pattern.count * 5);
    if (pattern.count < 50) return 50 + ((pattern.count - 10) * 1);
    return Math.min(100, 90 + ((pattern.count - 50) * 0.2));
  }

  /**
   * Record PV prediction vs actual for learning
   * @param {number} predictedW - What we predicted
   * @param {number} actualW - What actually happened
   */
  async recordPvAccuracy(predictedW, actualW) {
    const now = Date.now();
    
    // Calculate error percentage
    const error = predictedW > 0 
      ? Math.abs(actualW - predictedW) / predictedW 
      : 0;
    
    this.data.pv_predictions.push({
      timestamp: now,
      predicted: predictedW,
      actual: actualW,
      error: error
    });
    
    // Keep only last 1000 predictions (~ 3-4 days at 5min intervals)
    if (this.data.pv_predictions.length > 1000) {
      this.data.pv_predictions = this.data.pv_predictions.slice(-1000);
    }
    
    // Update accuracy score (exponential moving average)
    const accuracy = 1.0 - error; // 1.0 = perfect, 0.0 = completely wrong
    const alpha = 0.1; // Smoothing factor
    this.data.pv_accuracy_score = 
      (alpha * accuracy) + ((1 - alpha) * this.data.pv_accuracy_score);
    
    this.log(`PV accuracy: predicted=${predictedW}W, actual=${actualW}W, error=${(error*100).toFixed(1)}%, score=${this.data.pv_accuracy_score.toFixed(2)}`);
    
    // Throttle saves: only persist every 10th call (~50 min at 5-min intervals)
    this._pvSaveCounter = (this._pvSaveCounter || 0) + 1;
    if (this._pvSaveCounter % 10 === 0) await this._saveData();
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
   * Record Open-Meteo radiation forecast accuracy for a day.
   * Call once per day after comparing yesterday's forecasted vs actual radiation.
   * @param {number} forecastAvgWm2 - Average radiation forecasted for yesterday's daylight hours
   * @param {number} actualAvgWm2   - Average radiation actually observed (from past_days=1)
   */
  async recordRadiationAccuracy(forecastAvgWm2, actualAvgWm2) {
    if (forecastAvgWm2 <= 0) return; // no daylight to compare

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
    return this.data.radiation_bias_factor ?? 1.0;
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
    if (radiationWm2 < 10) return; // absolute floor — ignore dawn/dusk sensor noise

    const d = new Date(timestamp);
    const slotIndex = (d.getUTCHours() * 4) + Math.floor(d.getUTCMinutes() / 15);

    // Dynamic threshold: only learn when radiation is meaningful for this slot.
    // Tracks the highest radiation ever seen per slot, learns only above 15% of that.
    // Prevents low-quality dawn/dusk samples from corrupting the slot model.
    this.data.solar_slot_max_radiation = this.data.solar_slot_max_radiation || new Array(96).fill(0);
    if (radiationWm2 > this.data.solar_slot_max_radiation[slotIndex]) {
      this.data.solar_slot_max_radiation[slotIndex] = radiationWm2;
    }
    const dynamicThreshold = Math.max(50, this.data.solar_slot_max_radiation[slotIndex] * 0.15);
    if (radiationWm2 < dynamicThreshold) return;

    const yf = Math.max(0, powerW) / radiationWm2;
    if (!Number.isFinite(yf) || yf < 0.01 || yf > 500) return;

    this.data.solar_yield_factors = this.data.solar_yield_factors || new Array(96).fill(null);
    const old = this.data.solar_yield_factors[slotIndex];

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

    // Asymmetric EMA: learn peaks quickly (0.20), forget slowly (0.05)
    const alpha = old === null ? 1.0 : (yf >= old ? 0.20 : 0.05);
    const newYf  = old === null ? yf : alpha * yf + (1 - alpha) * old;

    this.data.solar_yield_factors[slotIndex] = newYf;
    this.log(`Solar yield slot ${slotIndex}: ${old !== null ? old.toFixed(2) : 'init'} → ${newYf.toFixed(2)} (inst=${yf.toFixed(2)}, P=${Math.round(powerW)}W, R=${Math.round(radiationWm2)}W/m²)`);

    // Fire-and-forget save (not awaited — too frequent to block on)
    this._saveData().catch(() => {});
  }

  /**
   * Return the learned per-slot yield factors (96 entries, null = not yet learned).
   * @returns {Array<number|null>}
   */
  getSolarYieldFactors() {
    return this.data.solar_yield_factors || new Array(96).fill(null);
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

  /**
   * Get confidence adjustment based on historical success
   * @param {string} mode - Proposed mode
   * @param {Object} context - Current context
   * @returns {number} Confidence adjustment (-20 to +20)
   */
  getConfidenceAdjustment(mode, context) {
    // If insufficient history, no adjustment
    if (this.data.policy_decisions.length < 50) return 0;
    
    // Find similar past decisions (same mode, similar SoC, similar sun forecast)
    const similar = this.data.policy_decisions.filter(d => {
      const socMatch = Math.abs(d.soc - context.soc) < 20; // Within 20%
      const sunMatch = Math.abs((d.sun_forecast || 0) - (context.sun4h || 0)) < 2; // Within 2h
      return d.mode === mode && socMatch && sunMatch;
    });
    
    if (similar.length < 10) return 0; // Need at least 10 similar cases
    
    // Calculate average confidence of similar decisions
    const avgConfidence = similar.reduce((sum, d) => sum + d.confidence, 0) / similar.length;
    
    // If we've been consistently confident in similar situations, boost slightly
    // If confidence was lower, reduce slightly
    const adjustment = (avgConfidence - 70) * 0.1; // Scale to ±3 points
    
    return Math.max(-20, Math.min(20, adjustment));
  }

  /**
   * Get learning statistics for display
   */
  getStatistics() {
    const daysTracking = (Date.now() - this.data.stats.learning_started) / (1000 * 60 * 60 * 24);
    
    // Count how many hour-slots have data
    let slotsWithData = 0;
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (this.data.consumption_patterns[day][hour].count > 0) {
          slotsWithData++;
        }
      }
    }
    
    return {
      days_tracking: Math.floor(daysTracking),
      total_samples: this.data.stats.total_samples,
      pattern_coverage: Math.round((slotsWithData / 168) * 100), // 168 = 7*24
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
