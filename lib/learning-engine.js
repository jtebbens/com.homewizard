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
