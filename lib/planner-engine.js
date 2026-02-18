/**
 * PlannerEngine - Simplified policy engine for 48-hour planning view
 * 
 * Unlike PolicyEngine which makes real-time decisions with live sensor data,
 * PlannerEngine projects recommendations for future hours based only on:
 * - Price forecasts
 * - Top-3 hour badges  
 * - Sun forecasts
 * - Battery SoC projections
 * 
 * Used by: Settings page planning view (HTML)
 */

class PlannerEngine {
  constructor(settings) {
    // Battery specs
    this.RTE = settings.battery_efficiency || 0.75; // 75% round-trip efficiency
    this.BREAKEVEN_MULTIPLIER = 1 / this.RTE; // 1.333 for 75% RTE
    this.MIN_PROFIT_MARGIN = settings.min_profit_margin ?? 0.02; // €0.02/kWh default
    
    // User thresholds
    this.maxChargePrice = settings.max_charge_price || 0.15;
    this.minDischargePrice = settings.min_discharge_price || 0.30;
    this.minSOC = settings.min_soc || 10;
    this.maxSOC = settings.max_soc || 95;
    
    // Mode
    this.tariffType = settings.tariff_type || 'dynamic';
  }
  
  /**
   * Get mode recommendation for a specific hour
   * @param {Object} hourData - { hour, price, isPeak, isCheap, hasSun, projectedSOC, hoursFromNow }
   * @param {Array} allPrices - Full price array with {price, hour, timestamp, index}
   * @returns {string} - Mode: 'charge', 'discharge', 'pv_only', 'standby'
   */
  getRecommendationForHour(hourData, allPrices) {
    const { hour, price, isPeak, isCheap, hasSun, projectedSOC, hoursFromNow } = hourData;
    
    // If no price data, can't make recommendation
    if (price === null || price === undefined) {
      return 'standby';
    }
    
    // Battery limits
    if (projectedSOC >= this.maxSOC) {
      return 'discharge'; // Battery full, must discharge
    }
    if (projectedSOC <= this.minSOC) {
      return 'charge'; // Battery empty, must charge
    }
    
    // Peak shaving mode
    if (this.tariffType === 'fixed') {
      if (isPeak) return 'discharge';
      if (isCheap) return 'charge';
      if (hasSun && hour >= 8 && hour <= 17) return 'pv_only';
      return 'standby';
    }
    
    // Dynamic pricing mode
    
    // Priority 1: Top-3 badges (most reliable signals)
    if (isPeak) {
      // Top-3 expensive hour → discharge to avoid buying at this price
      return 'discharge';
    }
    
    if (isCheap) {
      // Top-3 cheap hour → check if profitable vs future
      const futureExpensive = this._getFutureExpensiveHours(price, hoursFromNow, allPrices);
      if (futureExpensive && futureExpensive.length > 0) {
        const avgFuture = futureExpensive.reduce((s, h) => s + h.price, 0) / futureExpensive.length;
        const profitPerKwh = (avgFuture * this.RTE) - price;
        
        if (profitPerKwh > this.MIN_PROFIT_MARGIN) {
          return 'charge'; // Profitable arbitrage available
        }
      }
      // Top-3 cheap but no profitable future → wait for PV or better opportunity
      return hasSun ? 'pv_only' : 'standby';
    }
    
    // Priority 2: Threshold checks
    if (price <= this.maxChargePrice) {
      // Cheap by absolute threshold → check profitability
      const futureExpensive = this._getFutureExpensiveHours(price, hoursFromNow, allPrices);
      if (futureExpensive && futureExpensive.length > 0) {
        const avgFuture = futureExpensive.reduce((s, h) => s + h.price, 0) / futureExpensive.length;
        const profitPerKwh = (avgFuture * this.RTE) - price;
        
        if (profitPerKwh > this.MIN_PROFIT_MARGIN) {
          return 'charge';
        }
      }
      return hasSun ? 'pv_only' : 'standby';
    }
    
    if (price >= this.minDischargePrice) {
      // Expensive by absolute threshold → discharge
      return 'discharge';
    }
    
    // Priority 3: Relative price position + arbitrage check
    // Even if price doesn't hit absolute thresholds, check if arbitrage is available
    const futureExpensive = this._getFutureExpensiveHours(price, hoursFromNow, allPrices);
    if (futureExpensive && futureExpensive.length > 0) {
      const avgFuture = futureExpensive.reduce((s, h) => s + h.price, 0) / futureExpensive.length;
      const profitPerKwh = (avgFuture * this.RTE) - price;
      
      // If profitable arbitrage exists and battery not nearly full
      if (profitPerKwh > this.MIN_PROFIT_MARGIN && projectedSOC < this.maxSOC - 10) {
        return 'charge'; // Grid charge profitable
      }
    }
    
    // Priority 4: Sun forecast (daytime hours only)
    if (hasSun && hour >= 8 && hour <= 17) {
      return 'pv_only';
    }
    
    // Default: standby (wait for better signal)
    return 'standby';
  }
  
  /**
   * Find future hours where price exceeds breakeven threshold
   * Same logic as PolicyEngine._getFutureExpensiveHours but simpler
   */
  _getFutureExpensiveHours(currentPrice, fromHoursFromNow, allPrices) {
    if (!allPrices || allPrices.length === 0) return null;
    
    // Breakeven: future price must be currentPrice / RTE to be profitable
    const breakeven = currentPrice * this.BREAKEVEN_MULTIPLIER;
    
    // Look 24 hours ahead from fromHoursFromNow
    const endHoursFromNow = fromHoursFromNow + 24;
    
    // Filter to future hours within window that exceed breakeven
    const expensiveHours = allPrices.filter(h => {
      const hourIndex = h.index ?? h.hoursFromNow ?? 0;
      return hourIndex > fromHoursFromNow && 
             hourIndex <= endHoursFromNow &&
             h.price >= breakeven;
    });
    
    return expensiveHours.length > 0 ? expensiveHours : null;
  }
  
  /**
   * Get a human-readable explanation of the recommendation
   */
  getExplanation(hourData, mode, allPrices) {
    const { hour, price, isPeak, isCheap, hasSun, projectedSOC, hoursFromNow } = hourData;
    
    if (mode === 'discharge') {
      if (isPeak) return `Peak hour (€${price.toFixed(3)}) - discharge to avoid buying expensive power`;
      if (price >= this.minDischargePrice) return `Expensive (≥€${this.minDischargePrice}) - discharge saves money`;
      if (projectedSOC >= this.maxSOC) return `Battery full (${projectedSOC}%) - must discharge`;
      return 'Discharge recommended';
    }
    
    if (mode === 'charge') {
      const futureExpensive = this._getFutureExpensiveHours(price, hoursFromNow, allPrices);
      if (futureExpensive && futureExpensive.length > 0) {
        const avgFuture = futureExpensive.reduce((s, h) => s + h.price, 0) / futureExpensive.length;
        const profit = (avgFuture * this.RTE) - price;
        return `Cheap (€${price.toFixed(3)}) vs future avg €${avgFuture.toFixed(3)} = +€${profit.toFixed(3)}/kWh profit`;
      }
      if (isCheap) return `Top-3 cheap hour (€${price.toFixed(3)})`;
      if (projectedSOC <= this.minSOC) return `Battery low (${projectedSOC}%) - must charge`;
      return 'Charge recommended';
    }
    
    if (mode === 'pv_only') {
      return `Sun expected - charge from PV only`;
    }
    
    // standby
    if (!isCheap && !isPeak) {
      return `Normal price (€${price.toFixed(3)}) - wait for PV or better opportunity`;
    }
    return 'Standby';
  }
}

// Export for use in both Node.js (settings page backend) and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlannerEngine;
}