'use strict';

// ======================================================
// BUG FIXES IN THIS VERSION:
// 1. Fixed _getSunExpectation calls to pass 'inputs' parameter (line 146, 188, 235, 305, 348)
// 2. All methods now correctly receive inputs for sun awareness
// ======================================================

// ======================================================
// GLOBAL DEBUG SWITCH
// ======================================================
const debug = false;

class PolicyEngine {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = (...args) => homey.log('[PolicyEngine]', ...args);
    
    // Battery efficiency constants
    this.BATTERY_EFFICIENCY = settings.battery_efficiency || 0.80; // 80% round-trip
    this.BREAKEVEN_MULTIPLIER = 1.25; // Need 25% higher price to break even
    this.MIN_PROFIT_MARGIN = settings.min_profit_margin || 0.05; // €0.05/kWh minimum
    
    // Store current load and capacity for use across methods
    this.currentLoad = 0;
    this.maxDischarge = 0;
  }

  calculatePolicy(inputs) {
    const scores = { charge: 0, discharge: 0, preserve: 0 };

    this.log('--- POLICY RUN START ---');
    this.log('Inputs:', JSON.stringify(inputs, null, 2));

    // ======================================================
    // EXTRACT BATTERY CAPACITY AND CURRENT LOAD
    // ======================================================
    this.maxDischarge = inputs.battery?.maxDischargePowerW ?? 
                        inputs.battery?.battery_group_max_discharge_power_w ?? 800;
    
    const grid = inputs.p1?.resolved_gridPower ?? 0;
    const batt = inputs.p1?.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    this.currentLoad = grid > 0 ? grid + dischargeNow : 0; // Only count import as load
    
    const batteryCanCover = this.currentLoad <= this.maxDischarge;
    const coverageRatio = this.currentLoad > 0 ? Math.min(this.currentLoad / this.maxDischarge, 1.0) : 0;
    
    this.log(`Battery limits: max=${this.maxDischarge}W, load=${this.currentLoad}W, canCover=${batteryCanCover}, coverage=${Math.round(coverageRatio * 100)}%`);

    // Add battery limits to inputs for easy access
    inputs.batteryLimits = {
      maxDischarge: this.maxDischarge,
      currentLoad: this.currentLoad,
      canCoverLoad: batteryCanCover,
      coverageRatio
    };

    // ======================================================
    // PV PRODUCTION → CHARGE (PV IS FREE, NO LOSSES)
    // ======================================================
    const soc = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;

    if (grid < -100 && soc < maxSoc) {
      scores.charge += 1000;   // PV is free energy, ALWAYS prioritize over preserve
      scores.preserve = -500;  // Actively suppress preserve when PV available
      this.log('PV OVERSCHOT: forcing charge (PV is gratis, geen conversieverlies)');
    }

    // 1. Smart Low‑SoC Rule
    this._applySmartLowSocRule(scores, inputs);

    // 2. Dynamic pricing (now with efficiency calculations)
    if (this.settings.tariff_type === 'dynamic') {
      this._applyTariffScore(scores, inputs.tariff, inputs.battery, inputs); // FIX: Added inputs
      this._applyDayAheadStrategy(scores, inputs.tariff, inputs.battery, inputs.time, inputs);
    }

    // 3. Fixed peak‑shaving
    if (this.settings.tariff_type === 'fixed') {
      this._applyPeakShavingRules(scores, inputs);
    }

    // 4. Weather forecast (applies to ALL modes)
    this._applyWeatherForecast(scores, inputs.weather, inputs.tariff, inputs.battery);

    // 5. PV Reality (now pricing-aware with economic analysis)
    const pvDetected = this._applyPVReality(
      scores,
      inputs.p1,
      inputs.battery?.mode,
      inputs
    );

    // 6. BatteryScore ALWAYS LAST (force‑charge at 0%)
    this._applyBatteryScore(scores, inputs.battery, pvDetected);

    // 6. Policy mode (eco/aggressive)
    this._applyPolicyMode(scores, inputs.policyMode);

    // Clamp
    scores.charge = Math.max(0, scores.charge);
    scores.discharge = Math.max(0, scores.discharge);
    scores.preserve = Math.max(0, scores.preserve);

    const recommendation = this._selectMode(scores, inputs);

    this.log('Final scores:', scores);
    this.log('Recommendation:', recommendation);
    this.log('--- POLICY RUN END ---');

    return { ...recommendation, scores };
  }

  // ======================================================
  // SMART LOW-SOC RULE
  // ======================================================
  _applySmartLowSocRule(scores, inputs) {
    const soc = inputs.battery?.stateOfCharge ?? 50;

    if (soc === 0) {
      this.log('SmartLowSoC skipped (SoC = 0)');
      return;
    }

    if (soc >= 30) return;

    const sun4h = inputs.weather?.sunshineNext4Hours ?? 0;
    const multi = inputs.sun;

    const gfs = multi?.gfs ?? null;
    const icon = multi?.harmonie ?? null;

    const arr = [sun4h, gfs, icon].filter(v => typeof v === 'number');
    const avgSun = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const noSun = avgSun < 5;
    const lightSun = avgSun >= 5 && avgSun < 25;
    const strongSun = avgSun >= 25;

    const price = inputs.tariff?.currentPrice ?? null;
    const priceLow = price !== null && price <= (this.settings.max_charge_price || 0.10);

    if (noSun && !priceLow) {
      scores.discharge += 60;
      scores.preserve += 10;
      this.log('SmartLowSoC: noSun → discharge');
      return;
    }

    if (lightSun) {
      scores.preserve += 40;
      scores.discharge += 20;
      this.log('SmartLowSoC: lightSun → preserve');
      return;
    }

    if (strongSun) {
      scores.preserve += 60;
      scores.discharge += 10;
      this.log('SmartLowSoC: strongSun → preserve');
      return;
    }

    if (priceLow) {
      scores.charge += 60;
      scores.preserve += 10;
      this.log('SmartLowSoC: cheap price → charge');
      return;
    }
  }

  // ======================================================
  // BATTERY SCORE (ALWAYS LAST)
  // ======================================================
  _applyBatteryScore(scores, battery, pvDetected) {
    const soc = battery.stateOfCharge ?? 50;

    if (soc === 0) {
      this.log('BatteryScore: SoC = 0 → ZERO MODE (charge‑only)');
      scores.discharge = 0;
      scores.preserve = 0;
      scores.charge += 100;
      return;
    }

    const max = this.settings.max_soc ?? 95;

    if (soc >= max) {
      scores.discharge += 40;
      scores.charge = 0;
      scores.preserve += 10;
      this.log('BatteryScore: max SoC reached → discharge');
      return;
    }

    scores.preserve += 10;
    this.log('BatteryScore: normal range → preserve +10');
  }

  // ======================================================
  // DYNAMIC PRICING WITH EFFICIENCY CALCULATIONS
  // FIX: Added 'inputs' parameter
  // ======================================================
  _applyTariffScore(scores, tariff, battery, inputs) { // FIX: Added inputs parameter
    if (!this.settings.enable_dynamic_pricing || tariff.currentPrice == null) {
      return;
    }

    const price = tariff.currentPrice;
    const soc = battery?.stateOfCharge ?? 0;

    const maxChargePrice = this.settings.max_charge_price || 0;
    const minDischargePrice = this.settings.min_discharge_price || 0;

    // Helper: float-safe compare
    const isFloatEqual = (a, b) => Math.abs(a - b) < 0.00001;

    // ======================================================
    // TOP 3 CHEAP HOURS: Only charge if spread justifies losses AND no good PV coming
    // ======================================================
    if (Array.isArray(tariff.top3Lowest) &&
        tariff.top3Lowest.some(p => isFloatEqual(p, price))) {
      
      // Check if we have future expensive hours to make this worthwhile
      const futureExpensiveHours = this._getFutureExpensiveHours(tariff);
      
      if (futureExpensiveHours && futureExpensiveHours.length > 0) {
        const avgFuturePrice = futureExpensiveHours.reduce((sum, h) => sum + h.price, 0) / futureExpensiveHours.length;
        const profitPerKwh = (avgFuturePrice * this.BATTERY_EFFICIENCY) - price;
        
        // NEW: Check if good PV is coming (avoid grid charging losses if free PV available soon)
        const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1); // FIX: Pass inputs
        
        if (profitPerKwh > this.MIN_PROFIT_MARGIN) {
          // ✅ NEW: Check if PV is actually producing RIGHT NOW
          if (sunExpected.source === 'actual_pv') {
            // PV is producing NOW - charge from it (not grid)
            scores.charge += 500; // High score to charge from PV
            scores.preserve = 0;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → CHARGE from ACTUAL PV`);
            this.log(`  → PV detected NOW (${sunExpected.details.batteryPower}W battery charging or ${Math.abs(sunExpected.details.gridPower)}W export)`);
            this.log(`  → Free energy, no conversion loss!`);
          }
          // Check sun forecast before committing to grid charge
          else if (sunExpected.goodSunComing && sunExpected.hours <= 8) {
            // Good PV coming soon - skip grid charging to avoid 20% loss
            scores.preserve += 50;
            scores.charge -= 30;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (good PV in ${sunExpected.hours}h)`);
            this.log(`  → Expected sun: ${sunExpected.totalHours}h (free, no conversion loss)`);
            this.log(`  → Would profit €${profitPerKwh.toFixed(3)}/kWh but PV is better`);
          } else {
            // No good PV coming - worthwhile to charge from grid
            scores.charge += 100;
            scores.preserve = 0;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → CHARGE`);
            this.log(`  → Future avg price: €${avgFuturePrice.toFixed(3)}`);
            this.log(`  → Expected profit: €${profitPerKwh.toFixed(3)}/kWh after 20% loss`);
            if (!sunExpected.goodSunComing) {
              this.log(`  → Low sun expected (${sunExpected.totalHours}h), grid charge justified`);
            }
          }
        } else if (profitPerKwh > 0) {
          // Marginal profit - only charge if no PV coming at all
          if (sunExpected.totalHours < 2) {
            scores.charge += 50;
            scores.preserve -= 10;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → MARGINAL CHARGE`);
            this.log(`  → Marginal profit: €${profitPerKwh.toFixed(3)}/kWh, minimal PV expected`);
          } else {
            scores.preserve += 40;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (marginal + ${sunExpected.totalHours}h sun coming)`);
          }
        } else {
          // Not profitable after losses
          scores.preserve += 30;
          this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (unprofitable)`);
          this.log(`  → Would lose €${Math.abs(profitPerKwh).toFixed(3)}/kWh after conversion`);
        }
      } else {
        // No expensive hours coming, don't charge from grid
        scores.preserve += 30;
        this.log(`Tariff: TOP-3 CHEAP but no expensive hours ahead → SKIP charging`);
      }
    }

    // ======================================================
    // TOP 3 EXPENSIVE HOURS: Discharge to avoid buying expensive power
    // (No conversion loss when using battery for household consumption)
    // ======================================================
    if (Array.isArray(tariff.top3Highest) &&
        tariff.top3Highest.some(p => isFloatEqual(p, price))) {
      
      if (this.currentLoad > 0) {
        // We have actual load to cover - calculate real savings
        const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
        const savingsPerHour = (coverableLoad / 1000) * price;
        
        // Calculate load coverage ratio for scoring
        const coverageRatio = coverableLoad / this.maxDischarge;
        const baseScore = 300;
        const scaledScore = Math.round(baseScore * Math.max(0.5, coverageRatio));
        
        scores.discharge += scaledScore;
        scores.preserve = 0;
        
        this.log(`Tariff: TOP-3 EXPENSIVE (€${price.toFixed(3)}) → DISCHARGE (+${scaledScore})`);
        this.log(`  → Covering ${coverableLoad}W of ${this.currentLoad}W load`);
        this.log(`  → Avoiding €${savingsPerHour.toFixed(2)}/hour (no conversion loss on consumption)`);
        
        if (this.currentLoad > this.maxDischarge) {
          const uncoveredLoad = this.currentLoad - this.maxDischarge;
          const uncoveredCost = (uncoveredLoad / 1000) * price;
          this.log(`  → ⚠️ Load exceeds capacity, still importing ${uncoveredLoad}W (€${uncoveredCost.toFixed(2)}/hour)`);
        }
      } else {
        // No current load, but expensive hour - be ready
        scores.discharge += 150;
        scores.preserve = 0;
        const maxSavingsPerHour = (this.maxDischarge / 1000) * price;
        this.log(`Tariff: TOP-3 EXPENSIVE (€${price.toFixed(3)}) → STANDBY for load`);
        this.log(`  → Ready to save up to €${maxSavingsPerHour.toFixed(2)}/hour when load appears`);
      }
    }

    // ======================================================
    // REGULAR PRICE THRESHOLDS WITH EFFICIENCY CHECK AND SUN AWARENESS
    // ======================================================
    if (price <= maxChargePrice && maxChargePrice > 0) {
      // Only charge if min discharge price makes this profitable after losses
      const minProfitableDischarge = price * this.BREAKEVEN_MULTIPLIER;
      
      if (minDischargePrice >= minProfitableDischarge) {
        // Profitable spread, but check if PV coming soon
        const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1); // FIX: Pass inputs
        
        if (sunExpected.goodSunComing && sunExpected.hours <= 6) {
          // Good sun coming within 6 hours - prefer free PV over grid charging
          scores.preserve += 30;
          scores.charge -= 20;
          this.log(`Tariff: cheap (€${price.toFixed(3)}) but ${sunExpected.totalHours}h sun in ${sunExpected.hours}h → preserve`);
          this.log(`  → Waiting for free PV (no 20% conversion loss)`);
        } else {
          // No good PV coming - grid charge makes sense
          scores.charge += 35;
          this.log(`Tariff: cheap (€${price.toFixed(3)}) → charge +35`);
          this.log(`  → Profitable at €${minDischargePrice.toFixed(3)} discharge (need €${minProfitableDischarge.toFixed(3)}+)`);
          if (!sunExpected.goodSunComing) {
            this.log(`  → Low sun expected (${sunExpected.totalHours}h), grid charge justified`);
          }
        }
      } else {
        scores.preserve += 20;
        this.log(`Tariff: cheap (€${price.toFixed(3)}) but spread too small → preserve`);
        this.log(`  → Need €${minProfitableDischarge.toFixed(3)}+ discharge, have €${minDischargePrice.toFixed(3)}`);
      }
    } else if (price > maxChargePrice && soc > 0) {
      scores.charge = 0;
      scores.preserve += 15;
      this.log('Tariff: expensive → preserve +15');
    }

    if (price >= minDischargePrice && minDischargePrice > 0) {
      if (this.currentLoad > 0) {
        const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
        const savingsPerHour = (coverableLoad / 1000) * price;
        
        scores.discharge += 30;
        this.log(`Tariff: expensive (€${price.toFixed(3)}) → discharge +30`);
        this.log(`  → Saving €${savingsPerHour.toFixed(2)}/hour by covering ${coverableLoad}W`);
      } else {
        scores.discharge += 15;
        this.log(`Tariff: expensive (€${price.toFixed(3)}) but no load → discharge +15 (standby)`);
      }
    } else if (price < minDischargePrice) {
      scores.discharge = 0;
      scores.preserve += 10;
      this.log('Tariff: low price → preserve +10');
    }

    // ======================================================
    // FALLBACK
    // ======================================================
    if (scores.charge === 0 && scores.discharge === 0 && soc > 0) {
      scores.preserve += 10;
      this.log('Tariff: both zero → preserve +10');
    }

    // ======================================================
    // EXTREME PRICES
    // ======================================================
    if (price <= 0.05) {
      // Almost always profitable even with 20% loss
      scores.charge += 50;
      scores.preserve -= 10;
      this.log('Tariff: ultra cheap (≤€0.05) → charge +50 (profitable even with losses)');
    }

    if (price >= 0.40) {
      // Always discharge at very high prices if there's load
      scores.discharge += 50;
      scores.preserve -= 10;
      this.log('Tariff: ultra expensive (≥€0.40) → discharge +50');
    }
  }

  // ======================================================
  // DAY-AHEAD STRATEGY: Prepare for expensive hours (with sun awareness)
  // ======================================================
  _applyDayAheadStrategy(scores, tariff, battery, time, inputs) {
    if (!tariff || !Array.isArray(tariff.next24Hours)) return;

    const soc = battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;
    const currentHour = time?.getHours() ?? 0;

    // Find next expensive hour
    const next24 = tariff.next24Hours || [];
    let nextExpensiveHour = null;
    let hoursUntilExpensive = null;

    for (let i = 1; i < next24.length; i++) { // Start from i=1 to skip current hour
      const hourData = next24[i];
      if (hourData.price >= (this.settings.min_discharge_price || 0.25)) {
        nextExpensiveHour = hourData;
        hoursUntilExpensive = i;
        break;
      }
    }

    if (nextExpensiveHour && hoursUntilExpensive !== null) {
      const targetSoC = 80; // Want to be at 80% before expensive period
      const currentPrice = tariff.currentPrice ?? 0;
      
      // Calculate if charging now is profitable for future use
      const futureSavings = (nextExpensiveHour.price * this.BATTERY_EFFICIENCY) - currentPrice;
      
      // NEW: Check if we can rely on PV instead of grid charging
      const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1); // FIX: Pass inputs
      
      // If expensive hour is coming soon and SoC is low
      if (hoursUntilExpensive <= 4 && soc < targetSoC) {
        if (futureSavings > this.MIN_PROFIT_MARGIN) {
          // Check if PV will charge us before expensive hour
          if (sunExpected.goodSunComing && sunExpected.hours < hoursUntilExpensive) {
            // PV will charge before expensive hour - wait for free energy
            scores.preserve += 40;
            scores.charge -= 20;
            this.log(`DayAhead: expensive in ${hoursUntilExpensive}h, but PV in ${sunExpected.hours}h → preserve`);
            this.log(`  → Expected ${sunExpected.totalHours}h sun (free charging, no grid needed)`);
          } else {
            // No PV in time - charge now from grid
            scores.charge += 40;
            scores.preserve -= 10;
            this.log(`DayAhead: expensive hour in ${hoursUntilExpensive}h (€${nextExpensiveHour.price.toFixed(3)})`);
            this.log(`  → Charging now (€${currentPrice.toFixed(3)}) saves €${futureSavings.toFixed(3)}/kWh later (after losses)`);
            if (!sunExpected.goodSunComing) {
              this.log(`  → Low sun expected, grid charge necessary`);
            }
          }
        }
      }

      // If we're at good SoC and expensive hour is very close, preserve
      if (hoursUntilExpensive <= 2 && soc >= targetSoC) {
        scores.preserve += 30;
        scores.discharge -= 20;
        this.log(`DayAhead: expensive hour in ${hoursUntilExpensive}h, preserving battery (SoC ${soc}%)`);
      }

      // If expensive hour is coming and we're charging, add urgency
      if (hoursUntilExpensive <= 3 && soc < 50) {
        // But only if no PV coming soon
        if (!sunExpected.goodSunComing || sunExpected.hours >= hoursUntilExpensive) {
          scores.charge += 20;
          this.log(`DayAhead: low SoC (${soc}%) with expensive hour in ${hoursUntilExpensive}h → charge +20`);
        }
      }
    }

    // NEW: Tomorrow planning - if good sun tomorrow and SoC is okay, preserve today
    const sunTomorrow = inputs.weather?.sunshineTomorrow ?? 0;
    if (sunTomorrow >= 4 && soc >= 40 && currentHour >= 20) {
      scores.preserve += 20;
      scores.charge -= 15;
      this.log(`DayAhead: good sun tomorrow (${sunTomorrow}h), preserving battery for free PV recharge`);
    }
  }

  // ======================================================
  // HELPER: Evaluate sun expectations for charging decisions
  // ======================================================
  _getSunExpectation(weather, sunMulti, p1) {
    // ✅ PRIORITY 1: Actual PV production (reality beats forecasts)
    if (p1) {
      const gridPower = p1.resolved_gridPower ?? 0;
      const batteryPower = p1.battery_power ?? 0;
      
      // If exporting to grid OR battery charging from PV
      if (gridPower < -100 || (batteryPower > 100 && gridPower <= 0)) {
        // Sun is ACTUALLY here now - don't wait for forecasts
        return {
          goodSunComing: true,
          totalHours: 99, // Special value = sun is HERE NOW
          hours: 0,
          source: 'actual_pv',
          details: { gridPower, batteryPower }
        };
      }
    }

    if (!weather && !sunMulti) {
      return { goodSunComing: false, totalHours: 0, hours: null };
    }

    // Collect all sun forecast sources
    const sun4h = weather?.sunshineNext4Hours ?? 0;
    const sun8h = weather?.sunshineNext8Hours ?? 0;
    const sunToday = weather?.sunshineTodayRemaining ?? 0;
    const sunTomorrow = weather?.sunshineTomorrow ?? 0;
    
    // Multi-source forecasts (if available)
    const gfs = sunMulti?.gfs ?? null;
    const harmonie = sunMulti?.harmonie ?? null;

    // Calculate composite sun expectation
    let totalHours = 0;
    let hoursUntil = null;
    let goodSunComing = false;

    // Today's remaining sun
    if (sunToday > 0) {
      totalHours += sunToday;
      if (hoursUntil === null) hoursUntil = 0; // Sun available now/today
    }

    // Tomorrow's sun
    if (sunTomorrow > 0) {
      totalHours += sunTomorrow;
      if (hoursUntil === null) hoursUntil = 24 - (new Date().getHours()); // Hours until tomorrow
    }

    // Near-term forecasts (4h, 8h)
    if (sun4h > 0 && hoursUntil === null) hoursUntil = 2; // Average ~2h ahead
    if (sun8h > 0 && hoursUntil === null) hoursUntil = 4; // Average ~4h ahead

    // Define "good sun" threshold
    // Good sun = enough to charge battery meaningfully
    const goodSunThreshold = 3; // 3+ hours of sun

    if (totalHours >= goodSunThreshold) {
      goodSunComing = true;
    }

    // Also check multi-source forecasts
    if (gfs >= 25 || harmonie >= 25) {
      goodSunComing = true; // Strong sun expected
      if (hoursUntil === null) hoursUntil = 4; // Assume within 4h
    }

    return {
      goodSunComing,
      totalHours,
      hours: hoursUntil,
      details: {
        sun4h,
        sun8h,
        sunToday,
        sunTomorrow,
        gfs,
        harmonie
      }
    };
  }

  // ======================================================
  // HELPER: Find future expensive hours for profitability check
  // ======================================================
  _getFutureExpensiveHours(tariff) {
    if (!tariff) {
      return null;
    }

    const minDischargePrice = this.settings.min_discharge_price || 0.25;
    
    // Try to use allPrices (current provider structure) or fallback to next24Hours (legacy)
    const pricesArray = tariff.allPrices || tariff.next24Hours;
    
    if (!Array.isArray(pricesArray)) {
      return null;
    }
    
    // Find hours in next 12 hours that are above discharge threshold
    // index >= 0 means future hours (index < 0 are past hours)
    const expensiveHours = pricesArray
      .filter((hour, idx) => {
        const hourIndex = hour.index ?? idx;
        return hourIndex >= 0 && // Only future hours
               hourIndex <= 12 && // Only look 12 hours ahead (realistic battery planning)
               (hour.price ?? 0) >= minDischargePrice;
      });

    return expensiveHours.length > 0 ? expensiveHours : null;
  }

  // ======================================================
  // PV REALITY (NOW PRICING-AWARE WITH ECONOMIC ANALYSIS)
  // ======================================================
  _applyPVReality(scores, p1, batteryMode, inputs) {
    if (!p1) return false;

    const gridPower = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;
    const pvEstimate = p1.pv_power_estimated ?? 0;

    if (debug) this.log('PV Reality debug:', { gridPower, batteryPower, pvEstimate, batteryMode });

    let pvDetected = false;
    let pvSurplus = 0;

    // ------------------------------------------------------
    // 1. Use PV estimate if available (preferred method)
    // ------------------------------------------------------
    if (pvEstimate > 0) {
      // Calculate household load from grid and battery discharge
      const batteryDischarge = batteryPower < 0 ? Math.abs(batteryPower) : 0;
      const householdLoad = gridPower > 0 
        ? gridPower + batteryDischarge 
        : batteryDischarge;
      
      pvSurplus = pvEstimate - householdLoad;
      pvDetected = pvSurplus >= 75; // Surplus threshold for charging
      
      if (debug) this.log(`PV estimate: ${pvEstimate}W, household: ${householdLoad}W, surplus: ${pvSurplus}W`);
    }
    // ------------------------------------------------------
    // 2. Fallback: ZERO_CHARGE_ONLY → batteryPower > 0 = PV charging
    // ------------------------------------------------------
    else if (batteryMode === 'zero_charge_only') {
      pvDetected = batteryPower > 0;
    }
    // ------------------------------------------------------
    // 3. Fallback: Other modes → grid export indicates PV surplus
    // ------------------------------------------------------
    else {
      pvDetected = gridPower < -100;
    }

    // ------------------------------------------------------
    // 4. In dynamic pricing, allow grid charging during cheap hours
    // ------------------------------------------------------
    if (!pvDetected && this.settings.tariff_type === 'dynamic') {
      // Don't block charge in dynamic mode - let tariff scores decide
      this.log('PV Reality: no PV surplus but dynamic pricing → charge decision based on tariff economics');
      return true;
    }

    // ------------------------------------------------------
    // 5. In fixed mode or no PV → block charge
    // ------------------------------------------------------
    if (!pvDetected) {
      scores.charge = 0;
      this.log('PV Reality: no PV surplus in fixed mode → blocking charge');
      return false;
    }

    // ------------------------------------------------------
    // 6. PV surplus detected - always charge (battery cannot export to grid)
    // ------------------------------------------------------
    // NOTE: This battery cannot participate in imbalance market or grid export
    // It can only discharge to zero on P1 meter (cover household load)
    // Therefore: PV surplus should ALWAYS charge battery when there's capacity
    // The only export to grid is: (PV production - household load - battery charge rate)
    
    if (pvSurplus > 0) {
      this.log(`💡 PV surplus ${pvSurplus}W detected → CHARGE battery (cannot export to grid anyway)`);
      scores.charge += 100; // Strong preference to use free PV energy
      
      // Optional: Show what would happen if battery could export
      if (this.settings.tariff_type === 'dynamic' && debug) {
        const tariff = inputs?.tariff || {};
        const currentPrice = tariff.currentPrice || 0;
        const futureExpensiveHours = this._getFutureExpensiveHours(tariff);
        
        if (futureExpensiveHours && futureExpensiveHours.length > 0) {
          const avgFuturePrice = futureExpensiveHours.reduce((sum, h) => sum + h.price, 0) / futureExpensiveHours.length;
          const storageValue = avgFuturePrice * this.BATTERY_EFFICIENCY;
          const benefit = storageValue - currentPrice;
          
          this.log(`   [Info] Current export: €${currentPrice.toFixed(3)}/kWh, Future use value: €${storageValue.toFixed(3)}/kWh (benefit: €${benefit.toFixed(3)}/kWh)`);
        }
      }
    }

    this.log(`PV Reality: PV surplus detected (${pvSurplus > 0 ? pvSurplus + 'W' : 'yes'}) → charge allowed (free energy, no grid export)`);
    return true;
  }

  // ======================================================
  // WEATHER (APPLIES TO ALL MODES)
  // ======================================================
  _applyWeatherForecast(scores, weather, tariff, battery) {
    if (!weather) return;

    const sun4h = Number(weather.sunshineNext4Hours ?? 0);
    const sun8h = Number(weather.sunshineNext8Hours ?? 0);
    const sunToday = Number(weather.sunshineTodayRemaining ?? 0);
    const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
    const soc = battery?.stateOfCharge ?? 50;
    
    const isDynamic = this.settings.tariff_type === 'dynamic';
    const isFixed = this.settings.tariff_type === 'fixed';

    // Sun coming soon - avoid grid charging in ALL modes (PV is free, no conversion losses)
    if (sun4h >= 2.0) {
      scores.charge -= 25;
      scores.preserve += 15;
      this.log(`Weather: sun4h >= 2 → preserve (PV coming in ~2h, no grid charge needed)`);
    }

    if (sun4h >= 1.0) {
      // Don't penalize discharge - if sun is coming, use battery now and let PV recharge
      scores.preserve += 10;
      this.log('Weather: sun4h >= 1 → preserve (but allow discharge if needed)');
    }

    if (sun8h >= 3.0) {
      scores.charge -= 20;
      // Don't increase preserve - allow discharge if economically beneficial
      this.log('Weather: sun8h >= 3 → avoid grid charging (PV coming within 8h)');
    }

    if (sunToday >= 4.0) {
      scores.charge -= 15;
      scores.preserve += 10;
      this.log('Weather: sunToday >= 4 → avoid grid charging (good PV today)');
    }

    if (sunToday >= 4.0) {
      scores.charge -= 15;
      scores.preserve += 10;
      this.log('Weather: sunToday >= 4 → preserve');
    }

    if (sunTomorrow >= 2.0) {
      scores.charge -= 5;
      // Light sun tomorrow - neutral stance on discharge
      this.log('Weather: sunTomorrow >= 2 → avoid grid charging');
    }

    // Good sun tomorrow - use battery aggressively knowing free recharge is coming
    if (sunTomorrow >= 4.0) {
      scores.charge -= 15;
      
      if (isDynamic) {
        // Dynamic pricing: price-aware discharge boost
        const currentPrice = tariff?.currentPrice || 0;
        const minDischargePrice = this.settings.min_discharge_price || 0.25;
        
        if (currentPrice >= minDischargePrice * 0.85) {
          scores.discharge += 25;
          this.log('Weather: sunTomorrow >= 4 + expensive hour → BOOST discharge (free recharge coming!)');
        } else {
          this.log('Weather: sunTomorrow >= 4 → avoid grid charging, allow discharge if needed');
        }
      } else {
        // Peak shaving / Zero mode: encourage evening discharge
        scores.discharge += 15;
        this.log('Weather: sunTomorrow >= 4 → encourage discharge (free recharge tomorrow)');
      }
    }

    if (sunTomorrow >= 6.0) {
      scores.charge -= 25;
      
      if (isDynamic) {
        // Dynamic pricing: aggressive discharge at moderate prices
        const currentPrice = tariff?.currentPrice || 0;
        const minDischargePrice = this.settings.min_discharge_price || 0.25;
        
        if (currentPrice >= minDischargePrice * 0.75) {
          scores.discharge += 35;
          this.log('Weather: sunTomorrow >= 6 + moderate/high price → AGGRESSIVE discharge (excellent free recharge coming!)');
        } else {
          this.log('Weather: sunTomorrow >= 6 → avoid grid charging, ready to discharge');
        }
      } else {
        // Peak shaving / Zero mode: very aggressive discharge during evening
        const now = new Date();
        const currentHour = now.getHours();
        
        if (currentHour >= 17) {
          scores.discharge += 30;
          this.log('Weather: sunTomorrow >= 6 + evening → AGGRESSIVE discharge (excellent sun tomorrow)');
        } else {
          scores.discharge += 20;
          this.log('Weather: sunTomorrow >= 6 → boost discharge (excellent sun tomorrow)');
        }
      }
    }
  }

  // ======================================================
  // PEAK SHAVING (FIXED TARIFF) - CAPACITY AWARE
  // ======================================================
  _applyPeakShavingRules(scores, inputs) {
    const { p1, time, battery } = inputs;
    if (!p1 || !time) return;

    const grid = p1.resolved_gridPower ?? 0;
    const batt = p1.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    const trueLoad = grid + dischargeNow;

    const maxDischarge = this.maxDischarge;
    const coverageRatio = trueLoad > 0 ? Math.min(trueLoad / maxDischarge, 1.0) : 0;
    const canFullyCover = trueLoad <= maxDischarge;

    const hour = time.getHours();

    const peak = this._parseTimeRange(this.settings.peak_hours);
    const inPeak = peak && hour >= peak.startHour && hour < peak.endHour;

    if (inPeak) {
      scores.charge = 0;
      
      // Scale discharge score by battery's ability to help
      if (canFullyCover) {
        scores.discharge += 40;
        scores.preserve += 5;
        this.log(`Peak: battery can fully cover ${trueLoad}W → discharge +40`);
      } else {
        // Partial coverage: scale the bonus
        const partialScore = Math.round(40 * coverageRatio);
        scores.discharge += partialScore;
        scores.preserve += 5;
        this.log(`Peak: battery covers ${Math.round(coverageRatio * 100)}% of ${trueLoad}W → discharge +${partialScore}`);
      }
    }

    // High load relative to battery capacity
    if (trueLoad > maxDischarge * 0.8) {
      if (canFullyCover) {
        scores.discharge += 30;
        scores.preserve -= 5;
        this.log(`Peak: high load ${trueLoad}W (coverable) → discharge +30`);
      } else {
        scores.discharge += 15;
        scores.preserve -= 5;
        this.log(`Peak: high load ${trueLoad}W (exceeds ${maxDischarge}W capacity) → discharge +15`);
      }
    }

    // Low load that battery can easily handle
    if (trueLoad < maxDischarge * 0.3) {
      scores.preserve += 15;
      scores.discharge -= 5;
      this.log(`Peak: low load ${trueLoad}W (easily coverable) → preserve +15`);
    }
    
    // Weather-aware adjustments for peak shaving
    const weather = inputs.weather;
    if (weather) {
      const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
      const hour = time.getHours();
      
      // If good sun tomorrow and we're in evening peak, use battery more
      if (sunTomorrow >= 5.0 && hour >= 17 && hour < 23) {
        scores.discharge += 20;
        scores.preserve -= 10;
        this.log(`Peak: evening + ${sunTomorrow}h sun tomorrow → boost discharge (free recharge coming)`);
      }
      
      // Off-peak with sun tomorrow - avoid grid charging
      const offPeak = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && hour >= offPeak.startHour && hour < offPeak.endHour;
      
      if (inOffPeak && sunTomorrow >= 4.0) {
        scores.charge -= 30;
        this.log(`Peak: off-peak but ${sunTomorrow}h sun tomorrow → skip grid charging (PV will charge for free)`);
      }
    }

    // Sweet spot - moderate load, fully coverable
    if (trueLoad >= maxDischarge * 0.3 && trueLoad <= maxDischarge * 0.8) {
      scores.discharge += 10;
      this.log(`Peak: optimal load range ${trueLoad}W → discharge +10`);
    }
  }

  // Parse time range (kept as in original)
  _parseTimeRange(range) {
    if (!range) return null;
    const [start, end] = range.split('-').map(s => parseInt(s, 10));
    if (isNaN(start) || isNaN(end)) return null;
    return { startHour: start, endHour: end };
  }

  // ======================================================
  // POLICY MODE (ECO / AGGRESSIVE)
  // ======================================================
  _applyPolicyMode(scores, mode) {
    if (mode === 'eco') {
      scores.preserve *= 1.3;
      scores.charge *= 0.8;
      scores.discharge *= 0.8;
      this.log('PolicyMode: ECO (reduced cycling to minimize losses)');
    }

    if (mode === 'aggressive') {
      scores.charge *= 1.2;
      scores.discharge *= 1.2;
      scores.preserve *= 0.7;
      this.log('PolicyMode: AGGRESSIVE (maximize arbitrage opportunities)');
    }
  }

  // ======================================================
  // MAP INTERNAL POLICY MODE → HOMEWIZARD MODE
  // ======================================================
  _mapPolicyToHwMode(policyMode, ctx) {
    const tariffType = this.settings.tariff_type;
    const soc = ctx.battery?.stateOfCharge ?? 50;
    const minSoc = this.settings.min_soc ?? 0;
    const maxSoc = this.settings.max_soc ?? 95;

    const zeroModeActive = ctx.policyMode === 'zero';
    
    this.log(`[MAPPING-ENTRY] policyMode=${policyMode}, tariffType=${tariffType}, soc=${soc}%, ctx.policyMode=${ctx.policyMode}`);
    this.log(`[MAPPING-ENTRY] P1 data: grid=${ctx.p1?.resolved_gridPower}W, pvEst=${ctx.p1?.pv_power_estimated}W, battery=${ctx.p1?.battery_power}W`);

    // -----------------------------
    // ZERO‑MODE (battery firmware handles net-zero logic)
    // -----------------------------
    if (zeroModeActive) {
      // Battery firmware has built-in zero mode logic
      // Just pass through 'zero' and let firmware handle charge/discharge decisions
      
      // Battery protection - force charge/discharge if at limits
      if (soc <= minSoc) {
        this.log('Zero mode: SoC at minimum, forcing charge');
        return 'to_full';
      }
      if (soc >= maxSoc) {
        this.log('Zero mode: SoC at maximum, forcing discharge if needed');
        return 'zero_discharge_only';
      }

      // Normal operation - let battery firmware handle net-zero
      this.log('Zero mode: letting battery firmware handle net-zero logic');
      return 'zero';
    }

    // -----------------------------
    // BALANCED MODE - DYNAMIC PRICING
    // -----------------------------
    if (ctx.policyMode === 'balanced' && tariffType === 'dynamic') {
      const price = ctx.tariff?.currentPrice ?? null;
      const maxCharge = this.settings.max_charge_price || 0;
      const minDischarge = this.settings.min_discharge_price || 0;
      const grid = ctx.p1?.resolved_gridPower ?? 0;
      const pvEstimate = ctx.p1?.pv_power_estimated ?? 0;

      const isCheap = price !== null && price <= maxCharge && maxCharge > 0;
      const isExpensive = price !== null && price >= minDischarge && minDischarge > 0;
      
      // Weather-aware discharge threshold
      // If sunny tomorrow, lower the discharge threshold to use battery more aggressively
      const weather = ctx.weather || {};
      const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
      const now = new Date();
      const currentHour = now.getHours();
      let effectiveMinDischarge = minDischarge;
      
      if (sunTomorrow >= 4.0 && soc > 50) {
        // Dynamic time windows based on sunrise/sunset
        // Evening aggressive: sunset → midnight (use battery during peak, sun will refill tomorrow)
        // Pre-dawn conservative: midnight → 2h before sunrise (preserve for morning gap)
        
        const todaySunset = weather.todaySunset ? new Date(weather.todaySunset) : null;
        const tomorrowSunrise = weather.tomorrowSunrise ? new Date(weather.tomorrowSunrise) : null;
        
        // Calculate hour thresholds
        let eveningStartHour = 17; // Fallback
        let preDawnEndHour = 8; // Fallback
        
        if (todaySunset) {
          eveningStartHour = todaySunset.getHours();
          // If sunset minutes > 30, round up to next hour
          if (todaySunset.getMinutes() > 30) eveningStartHour += 1;
        }
        
        if (tomorrowSunrise) {
          preDawnEndHour = tomorrowSunrise.getHours() - 2;
          if (preDawnEndHour < 0) preDawnEndHour = 0;
        }
        
        // Aggressive discharge during evening peak (sunset to midnight)
        if (currentHour >= eveningStartHour || currentHour < 1) {
          effectiveMinDischarge = minDischarge * 0.50; // 50% more aggressive - use battery knowing sun will recharge
          this.log(`Weather-aware discharge: sunny tomorrow (${sunTomorrow}h), evening (${eveningStartHour}:00-00:59), threshold €${effectiveMinDischarge.toFixed(3)}`);
        } 
        // Conservative discharge pre-dawn (midnight to sunrise-2h)
        else if (currentHour >= 1 && currentHour < preDawnEndHour) {
          effectiveMinDischarge = minDischarge * 0.9; // Slightly more conservative before sunrise
          this.log(`Weather-aware discharge: sunny tomorrow (${sunTomorrow}h), pre-dawn (01:00-${preDawnEndHour}:00), threshold €${effectiveMinDischarge.toFixed(3)}`);
        }
      }
      
      const isExpensiveWeatherAware = price !== null && price >= effectiveMinDischarge && effectiveMinDischarge > 0;

      // Calculate PV surplus using estimate if available
      let pvSurplus = 0;
      if (pvEstimate > 0) {
        const batteryPower = ctx.p1?.battery_power ?? 0;
        const batteryDischarge = batteryPower < 0 ? Math.abs(batteryPower) : 0;
        const householdLoad = grid > 0 ? grid + batteryDischarge : batteryDischarge;
        pvSurplus = pvEstimate - householdLoad;
      }

      // Check if we're in top-3 hours (support both numeric arrays and {price} objects)
      const isTop3Cheap = Array.isArray(ctx.tariff?.top3Lowest) &&
        ctx.tariff.top3Lowest.some(p => {
          const val = (typeof p === 'number') ? p : (p?.price ?? null);
          return val !== null && Math.abs(val - price) < 0.00001;
        });

      const isTop3Expensive = Array.isArray(ctx.tariff?.top3Highest) &&
        ctx.tariff.top3Highest.some(p => {
          const val = (typeof p === 'number') ? p : (p?.price ?? null);
          return val !== null && Math.abs(val - price) < 0.00001;
        });

      // Check if PV surplus is available (free energy should always take priority)
      const hasPvSurplus = grid < -100 || pvSurplus >= 75;

      // DEBUG: Log PV detection for visibility
      this.log(`[PV-CHECK] grid=${grid}W, pvEstimate=${pvEstimate}W, pvSurplus=${pvSurplus}W, hasPvSurplus=${hasPvSurplus}`);

      // ----------------------------------------
      // If PV surplus exists, use the 25% rule
      // Decide whether to store PV (charge) or allow export
      // ----------------------------------------
      if (hasPvSurplus) {
        const futureExpensiveHours = this._getFutureExpensiveHours(ctx.tariff);
        this.log(`[PV-DECISION] futureExpensiveHours found: ${futureExpensiveHours ? futureExpensiveHours.length : 0}`);
        
        if (futureExpensiveHours && futureExpensiveHours.length > 0) {
          // There ARE expensive hours ahead - apply 25% rule
          const avgFuturePrice = futureExpensiveHours.reduce((s, h) => s + (h.price ?? 0), 0) / futureExpensiveHours.length;
          const breakevenPrice = price * this.BREAKEVEN_MULTIPLIER;
          const storageValue = avgFuturePrice * this.BATTERY_EFFICIENCY;
          const exportValue = price;
          const profitMargin = this.MIN_PROFIT_MARGIN || 0.02;

          if (storageValue > exportValue + profitMargin) {
            this.log(`PV @ €${price?.toFixed(3)} → STORE (future €${avgFuturePrice.toFixed(3)}, profit €${(storageValue - exportValue).toFixed(3)}/kWh)`);
            return 'zero_charge_only';
          } else {
            this.log(`PV @ €${price?.toFixed(3)} → EXPORT (need €${breakevenPrice.toFixed(3)}, have €${avgFuturePrice.toFixed(3)})`);
            return 'zero_discharge_only';
          }
        }

        // No expensive hours ahead - ALWAYS STORE PV (free energy, use for household later)
        this.log(`PV @ €${price?.toFixed(3)} → STORE (no expensive hours, but free energy to use for household)`);
        return 'zero_charge_only';
      }
      
      this.log(`[MAPPING] Discharge check: policyMode=${policyMode}, isTop3Expensive=${isTop3Expensive}, isExpensiveWeatherAware=${isExpensiveWeatherAware}, hasPvSurplus=${hasPvSurplus}`);

      // 1. Discharge mode → use battery for household load (but NOT when PV surplus available!)
      if ((policyMode === 'discharge' || isTop3Expensive || isExpensiveWeatherAware) && !hasPvSurplus) {
        const reason = isTop3Expensive ? 'TOP-3 EXPENSIVE' : 
                      isExpensiveWeatherAware && !isExpensive ? `WEATHER-AWARE (${sunTomorrow}h sun tomorrow)` :
                      'DISCHARGE';
        
        this.log(`[MAPPING] !! ENTERING DISCHARGE BLOCK: reason=${reason}`);
        
        // Check if there's actually load to cover
        if (this.currentLoad > 0) {
          const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
          this.log(`Mode: ${reason} (€${price?.toFixed(3)}) → zero_discharge_only`);
          this.log(`  → Will discharge ${coverableLoad}W to cover household load (${this.currentLoad}W total)`);
        } else {
          this.log(`Mode: ${reason} (€${price?.toFixed(3)}) → zero_discharge_only`);
          this.log(`  → ⚠️ No household load detected - battery will not discharge until load appears`);
          this.log(`  → Battery cannot export to grid, only cover household consumption`);
        }
        
        this.log(`[MAPPING] !! RETURNING: zero_discharge_only`);
        return 'zero_discharge_only';
      }

      this.log(`[MAPPING] Past discharge block, checking charge block next...`);

      // 2. Cheap hours → charge from grid OR PV (skip if we want to discharge)
      if ((policyMode === 'charge' || isCheap || isTop3Cheap) && policyMode !== 'discharge') {
        this.log(`[MAPPING] !! ENTERING CHARGE BLOCK`);
        this.log(`[MAPPING] Charge mode: grid=${grid}W, pvSurplus=${pvSurplus}W`);
        
        // PV surplus detected (measured or estimated)
        if (grid < -100 || pvSurplus >= 75) {
          const source = pvSurplus >= 75 ? `estimated ${Math.round(pvSurplus)}W surplus` : 'measured export';
          this.log(`Mode: PV surplus (${source}) → zero_charge_only (free energy, no losses)`);
          return 'zero_charge_only';
        }
        
        // Top-3 cheapest hour → check if arbitrage is profitable
        if (isTop3Cheap && soc < maxSoc) {
          // Calculate expected profit after 20% conversion loss
          const top3High = ctx.tariff?.top3Highest || [];
          const avgExpensive = top3High.length > 0 
            ? top3High.reduce((sum, p) => sum + p.price, 0) / top3High.length 
            : (this.settings.min_discharge_price || 0.30);
          const profit = (avgExpensive * this.BATTERY_EFFICIENCY) - price;
          
          // Only force grid charge if profitable
          if (profit > 0) {
            this.log(`Mode: TOP-3 CHEAP (€${price?.toFixed(3)}), profit €${profit.toFixed(3)}/kWh → to_full (max 800W grid charge)`);
            return 'to_full';
          } else {
            this.log(`Mode: TOP-3 CHEAP (€${price?.toFixed(3)}) but unprofitable (€${profit.toFixed(3)}/kWh) → zero_charge_only (wait for PV)`);
            return 'zero_charge_only';
          }
        }
        
        // Regular cheap hour + no surplus → wait for PV surplus (≥75W) naturally
        if (isCheap && grid > 100 && soc < maxSoc) {
          this.log(`Mode: Cheap (€${price?.toFixed(3)}) but no PV surplus (grid: ${Math.round(grid)}W) → zero_charge_only (wait for ≥75W surplus)`);
          return 'zero_charge_only';
        }
        
        // Charge mode but neutral conditions → PV standby (only if not discharge mode)
        if (policyMode === 'charge') {
          return 'zero_charge_only';
        }
      }

      // 3. Expensive hours → discharge to avoid buying expensive power
      if (isExpensive) {
        this.log(`Mode: Expensive (€${price?.toFixed(3)}) → zero_discharge_only (cover household load)`);
        return 'zero_discharge_only';
      }
      
      // 4. Normal hours + no PV + battery has charge → use it! (avoid grid costs)
      if (pvEstimate === 0 && soc > minSoc + 10 && !isCheap) {
        this.log(`Mode: No PV, battery at ${soc}%, normal price (€${price?.toFixed(3)}) → zero_discharge_only (use free solar from battery)`);
        return 'zero_discharge_only';
      }

      // 5. Preserve → wait for PV (no grid charging losses)
      if (policyMode === 'preserve') {
        this.log('Mode: PRESERVE → zero_charge_only (PV standby)');
        return 'zero_charge_only';
      }

      // Fallback
      return 'zero_charge_only';
    }

    // -----------------------------
    // BALANCED MODE - FIXED TARIFF
    // -----------------------------
    if (ctx.policyMode === 'balanced-fixed' || (ctx.policyMode === 'balanced' && tariffType === 'fixed')) {
      const p1 = ctx.p1 || {};
      const pvPower = p1.pv_power ?? 0;
      const grid = p1.resolved_gridPower ?? 0;

      // Check if we're in off-peak hours
      const time = ctx.time;
      const hour = time?.getHours() ?? 0;
      const offPeak = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && hour >= offPeak.startHour && hour < offPeak.endHour;

      // Discharge mode
      if (policyMode === 'discharge') {
        return 'zero_discharge_only';
      }

      // Charge mode
      if (policyMode === 'charge') {
        if (grid < -100) {
          return 'zero_charge_only'; // PV surplus
        }
        if (inOffPeak && soc < maxSoc) {
          this.log('Mode: Off-peak hour (fixed tariff) → to_full (grid charge)');
          return 'to_full';
        }
        return pvPower > 0 ? 'zero_charge_only' : 'standby';
      }

      // Preserve → PV-only
      return pvPower > 0 ? 'zero_charge_only' : 'standby';
    }

    // -----------------------------
    // LEGACY FIXED MODE (deprecated, use balanced-fixed instead)
    // -----------------------------
    if (tariffType === 'fixed') {
      const p1 = ctx.p1 || {};
      const pvPower = p1.pv_power ?? 0;
      const grid = p1.resolved_gridPower ?? 0;

      // Check if we're in off-peak hours
      const time = ctx.time;
      const hour = time?.getHours() ?? 0;
      const offPeak = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && hour >= offPeak.startHour && hour < offPeak.endHour;

      // Discharge mode
      if (policyMode === 'discharge') {
        return 'zero_discharge_only';
      }

      // Charge mode
      if (policyMode === 'charge') {
        if (grid < -100) {
          return 'zero_charge_only'; // PV surplus
        }
        if (inOffPeak && soc < maxSoc) {
          this.log('Mode: Off-peak hour (fixed tariff) → to_full (grid charge)');
          return 'to_full';
        }
        return pvPower > 0 ? 'zero_charge_only' : 'standby';
      }

      // Preserve → PV-only
      return pvPower > 0 ? 'zero_charge_only' : 'standby';
    }

    // Fallback
    return 'standby';
  }

  // ======================================================
  // SELECT MODE (INTERNAL + HW MODE)
  // ======================================================
  _selectMode(scores, ctx) {
    const maxScore = Math.max(scores.charge, scores.discharge, scores.preserve, 1);

    let policyMode = 'preserve';
    let winner = scores.preserve;

    if (scores.charge > winner) {
      policyMode = 'charge';
      winner = scores.charge;
    }

    if (scores.discharge > winner) {
      policyMode = 'discharge';
      winner = scores.discharge;
    }

    const total = scores.charge + scores.discharge + scores.preserve;
    const confidence = Math.round((winner / (total || 1)) * 100);

    const hwMode = this._mapPolicyToHwMode(policyMode, ctx);

    return {
      policyMode,          // internal: "charge" | "discharge" | "preserve"
      hwMode,              // external: "to_full" | "standby" | "zero_charge_only" | "zero_discharge_only"
      confidence: Math.min(confidence, 100)
    };
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    // Update efficiency constants if changed
    this.BATTERY_EFFICIENCY = newSettings.battery_efficiency || this.BATTERY_EFFICIENCY;
    this.MIN_PROFIT_MARGIN = newSettings.min_profit_margin || this.MIN_PROFIT_MARGIN;
  }
}

module.exports = PolicyEngine;