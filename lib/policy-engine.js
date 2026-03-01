'use strict';

// ======================================================
// CHANGES IN THIS VERSION:
// 1-9: (previous changes preserved)
// 10. respect_minmax setting: strict vs dynamic threshold enforcement
// ======================================================

const debug = false;

class PolicyEngine {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = (...args) => homey.log('[PolicyEngine]', ...args);

    this.BATTERY_EFFICIENCY = settings.battery_efficiency || 0.75;
    this.BREAKEVEN_MULTIPLIER = 1 / this.BATTERY_EFFICIENCY;
    this.MIN_PROFIT_MARGIN = settings.min_profit_margin ?? 0.01;

    this.currentLoad = 0;
    this.maxDischarge = 0;
  }

  _getDynamicChargePrice(tariff, currentPrice) {
    const staticMax = this.settings.max_charge_price || 0.15;

    if (!tariff) return staticMax;

    const pricesArray = tariff.allPrices || tariff.next24Hours;
    if (!Array.isArray(pricesArray) || pricesArray.length === 0) return staticMax;

    const now = new Date();

    const futurePrices = pricesArray
      .filter(h => {
        if (h.timestamp) {
          const ts = new Date(h.timestamp);
          return ts > now && ts <= new Date(now.getTime() + 24 * 3600_000);
        }
        const idx = h.index ?? 0;
        return idx >= 1 && idx <= 24;
      })
      .map(h => h.price)
      .filter(p => typeof p === 'number' && p > 0);

    if (futurePrices.length === 0) return staticMax;

    const maxFuturePrice = Math.max(...futurePrices);
    const dynamicThreshold = (maxFuturePrice * this.BATTERY_EFFICIENCY) - this.MIN_PROFIT_MARGIN;
    const effectiveMax = Math.min(dynamicThreshold, staticMax * 2.0);

    this.log(`DynamicChargePrice: maxFuturePrice=€${maxFuturePrice.toFixed(3)}, dynamic=€${dynamicThreshold.toFixed(3)}, static=€${staticMax.toFixed(3)}, effective=€${effectiveMax.toFixed(3)}`);

    return effectiveMax;
  }

  calculatePolicy(inputs) {
    const scores = { charge: 0, discharge: 0, preserve: 0 };

    this.log('--- POLICY RUN START ---');
    if (debug) this.log('Inputs:', JSON.stringify(inputs, null, 2));

    this.maxDischarge = inputs.battery?.maxDischargePowerW ??
                        inputs.battery?.battery_group_max_discharge_power_w ?? 800;

    const grid = inputs.p1?.resolved_gridPower ?? 0;
    const batt = inputs.p1?.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    this.currentLoad = grid > 0 ? grid + dischargeNow : 0;

    const batteryCanCover = this.currentLoad <= this.maxDischarge;
    const coverageRatio = this.currentLoad > 0 ? Math.min(this.currentLoad / this.maxDischarge, 1.0) : 0;

    this.log(`Battery limits: max=${this.maxDischarge}W, load=${this.currentLoad}W, canCover=${batteryCanCover}, coverage=${Math.round(coverageRatio * 100)}%`);

    inputs.batteryLimits = {
      maxDischarge: this.maxDischarge,
      currentLoad: this.currentLoad,
      canCoverLoad: batteryCanCover,
      coverageRatio
    };

    const soc    = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;
    const minSoc = this.settings.min_soc ?? 0;

    if (inputs.batteryCost) {
      const isDischarging = (inputs.p1?.battery_power ?? 0) < -50;
      if (soc <= minSoc && isDischarging) {
        this.log(`[COST][RESET] SoC ${soc}% <= min_soc ${minSoc}% while discharging → resetting cost model`);
        inputs.batteryCost.avgCost   = 0;
        inputs.batteryCost.energyKwh = 0;
        inputs.batteryCost.breakEven = 0;
      }
    }

    inputs.dynamicMaxChargePrice = this._getDynamicChargePrice(
      inputs.tariff, inputs.tariff?.currentPrice
    );

    const _cetHour = parseInt(new Date().toLocaleString('en-US', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
    }), 10);
    const _isDaylight = _cetHour >= 7 && _cetHour < 20;

    if (grid < -200 && soc < maxSoc && _isDaylight) {
      scores.charge += 1000;
      scores.preserve = -500;
      this.log('PV OVERSCHOT: forcing charge (PV is gratis, geen conversieverlies)');
    }

    this._applySmartLowSocRule(scores, inputs);

    if (this.settings.tariff_type === 'dynamic') {
      this._applyTariffScore(scores, inputs.tariff, inputs.battery, inputs);
      this._applyDayAheadStrategy(scores, inputs.tariff, inputs.battery, inputs.time, inputs);
    }

    if (this.settings.tariff_type === 'fixed') {
      this._applyPeakShavingRules(scores, inputs);
    }

    this._applyWeatherForecast(scores, inputs.weather, inputs.tariff, inputs.battery, inputs);

    const pvDetected = this._applyPVReality(
      scores,
      inputs.p1,
      inputs.battery?.mode,
      inputs
    );

    this._applyBatteryScore(scores, inputs.battery, pvDetected);

    this._applyPolicyMode(scores, inputs.policyMode);

    if (inputs.batteryCost?.avgCost > 0) {
      const configuredEff = this.settings.battery_efficiency || 0.75;
      const learnedEff    = inputs.batteryEfficiency ?? configuredEff;
      const effectiveEff  = Math.min(configuredEff, learnedEff, 0.95);

      const breakEven = inputs.batteryCost.avgCost / effectiveEff;
      inputs.batteryCost.breakEven = breakEven;

      const price = inputs.tariff?.currentPrice ?? null;
      const maxChargePrice = this.settings.max_charge_price ?? 0.19;

      if (price !== null) {
        if (price > breakEven + 0.01) {
          scores.discharge += 80;
          scores.preserve  -= 20;
          this.log(`Arbitrage: price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} → discharge +80`);
        } else if (price < breakEven - 0.01 && soc < maxSoc && price <= maxChargePrice) {
          scores.charge   += 80;
          scores.preserve -= 20;
          this.log(`Arbitrage: price €${price.toFixed(3)} < break-even AND <= max_charge_price €${maxChargePrice} → charge +80`);
        } else {
          scores.preserve += 10;
          this.log(`Arbitrage: price near break-even or above max_charge_price → preserve`);
        }
      }
    }

    scores.charge    = Math.max(0, scores.charge);
    scores.discharge = Math.max(0, scores.discharge);
    scores.preserve  = Math.max(0, scores.preserve);

    const recommendation = this._selectMode(scores, inputs);

    this.log('Final scores:', scores);
    this.log('Recommendation:', recommendation);
    this.log('--- POLICY RUN END ---');

    return { ...recommendation, scores };
  }

  _applySmartLowSocRule(scores, inputs) {
    const soc = inputs.battery?.stateOfCharge ?? 50;

    if (soc === 0) {
      this.log('SmartLowSoC skipped (SoC = 0)');
      return;
    }

    if (soc >= 30) return;

    const price = inputs.tariff?.currentPrice ?? null;
    const minDischargePrice = this.settings.min_discharge_price || 0;
    if (price !== null && price >= minDischargePrice) {
      this.log(`SmartLowSoC: skipped — peak price €${price.toFixed(3)} >= min discharge €${minDischargePrice.toFixed(3)}`);
      return;
    }

    const sun4h = inputs.weather?.sunshineNext4Hours ?? 0;
    const multi = inputs.sun;

    const gfs  = multi?.gfs      ?? null;
    const icon = multi?.harmonie ?? null;

    const arr    = [sun4h, gfs, icon].filter(v => typeof v === 'number');
    const avgSun = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const noSun     = avgSun < 5;
    const lightSun  = avgSun >= 5  && avgSun < 25;
    const strongSun = avgSun >= 25;

    const dynamicMax = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
    const priceLow   = price !== null && price <= dynamicMax;

    const futureMax = inputs.tariff?.statistics?.max ?? null;
    const eff = this.BATTERY_EFFICIENCY;
    const spreadProfitable = price !== null && futureMax !== null &&
      (futureMax * eff) - price > 0;

    if (noSun && !priceLow && !spreadProfitable) {
      scores.preserve += 40;
      this.log('SmartLowSoC: noSun, no spread → preserve (low SoC)');
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

    if (priceLow || spreadProfitable) {
      scores.charge += 60;
      scores.preserve += 10;
      this.log(`SmartLowSoC: ${priceLow ? 'cheap price' : 'profitable spread'} → charge`);
      return;
    }
  }

  _applyBatteryScore(scores, battery, pvDetected) {
  const soc = battery.stateOfCharge ?? 50;
  const maxSoc = this.settings.max_soc ?? 95;

  // NOTE: HomeWizard firmware handles battery protection (0-100% safe range)
  // No artificial limits needed here - use full range for optimal planning

  if (soc === 0) {
    this.log('BatteryScore: SoC = 0 → ZERO MODE (charge-only, firmware may be calibrating)');
    scores.discharge = 0;
    scores.preserve  = 0;
    scores.charge   += 120;
    return;
  }

  if (soc >= maxSoc) {
    this.log('BatteryScore: max SoC reached → discharge');
    scores.discharge += 40;
    scores.charge     = 0;
    scores.preserve  += 10;
    return;
  }

  if (pvDetected) {
    this.log('BatteryScore: PV detected → prefer charging');
    scores.charge   += 40;
    scores.preserve += 5;
    return;
  }

  this.log('BatteryScore: normal range → preserve +10');
  scores.preserve += 10;
}


  _applyTariffScore(scores, tariff, battery, inputs) {
  if (!this.settings.enable_dynamic_pricing || tariff.currentPrice == null) return;

  const price             = tariff.currentPrice;
  const soc               = battery?.stateOfCharge ?? 0;
  const maxChargePrice    = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
  const minDischargePrice = this.settings.min_discharge_price || 0;
  
  // ✅ Get respect_minmax setting (default true = strict mode)
  const respectMinMax = this.settings.respect_minmax !== false;
  
  // ✅ Get configurable opportunistic parameters
  const oppChargeMultiplier = this.settings.opportunistic_charge_multiplier ?? 2.0;
  const oppDischargeFloor = this.settings.opportunistic_discharge_floor ?? 0.20;
  const oppDischargeSpreadThreshold = this.settings.opportunistic_discharge_spread_threshold ?? -0.05;

  const allPrices = tariff.allPrices || tariff.next24Hours || [];
  const now = new Date();

  const futurePrices48h = allPrices
    .filter(p => {
      if (p.timestamp) return new Date(p.timestamp) > now;
      return (p.index ?? 0) > 0;
    })
    .map(p => p.price)
    .filter(p => typeof p === 'number' && p > 0);

  const maxFuturePrice = futurePrices48h.length ? Math.max(...futurePrices48h) : null;

  const cheaperHourComing = allPrices.some(p =>
    typeof p.index === 'number' &&
    p.index > 0 &&
    p.index <= 8 &&
    typeof p.price === 'number' &&
    p.price < price - 0.005
  );

  const spreadProfit = maxFuturePrice !== null
    ? (maxFuturePrice * this.BATTERY_EFFICIENCY) - price
    : -1;

  const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

  // ------------------------------------------------------------
  // 1. DISCHARGE LOGIC
  // ------------------------------------------------------------
  if (respectMinMax) {
    // STRICT MODE: Only discharge when price >= minDischargePrice
    if (price >= minDischargePrice && minDischargePrice > 0) {
      const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
      const coverageRatio = this.maxDischarge > 0 ? coverableLoad / this.maxDischarge : 0;
      const priceRatio    = maxFuturePrice ? price / maxFuturePrice : 1;

      const baseScore = Math.round(100 * priceRatio * Math.max(0.5, coverageRatio));

      scores.discharge += baseScore;
      scores.preserve   = 0;

      this.log(`Tariff [STRICT]: discharge hour €${price.toFixed(3)} >= min €${minDischargePrice.toFixed(3)} → discharge +${baseScore}`);
      return;
    }
  } else {
    // DYNAMIC MODE: Discharge when profitable, even if below threshold
    if (price >= minDischargePrice && minDischargePrice > 0) {
      const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
      const coverageRatio = this.maxDischarge > 0 ? coverableLoad / this.maxDischarge : 0;
      const priceRatio    = maxFuturePrice ? price / maxFuturePrice : 1;

      const baseScore = Math.round(100 * priceRatio * Math.max(0.5, coverageRatio));

      scores.discharge += baseScore;
      scores.preserve   = 0;

      this.log(`Tariff [DYNAMIC]: discharge hour €${price.toFixed(3)} >= min €${minDischargePrice.toFixed(3)} → discharge +${baseScore}`);
      return;
    } else if (price > oppDischargeFloor && spreadProfit < oppDischargeSpreadThreshold) {
      // ✅ Opportunistic discharge: Use configurable parameters
      const score = Math.min(60, (price - oppDischargeFloor) * 300);
      scores.discharge += score;
      scores.preserve -= 10;
      this.log(`Tariff [DYNAMIC]: 🎯 opportunistic discharge €${price.toFixed(3)} (floor=€${oppDischargeFloor}, spread=${spreadProfit.toFixed(3)} < ${oppDischargeSpreadThreshold}) → discharge +${score}`);
      return;
    }
  }

  // ------------------------------------------------------------
  // 2. CHARGE LOGIC
  // ------------------------------------------------------------
  if (respectMinMax) {
    // STRICT MODE: Only charge when price <= maxChargePrice
    if (price <= maxChargePrice && maxChargePrice > 0) {

      if (sunExpected.source === 'actual_pv') {
        scores.charge += 300;
        scores.preserve = 0;
        this.log(`Tariff [STRICT]: cheap €${price.toFixed(3)} + actual PV → CHARGE +300`);
        return;
      }

      if (cheaperHourComing) {
        scores.preserve += 80;
        scores.charge     = 0;
        this.log(`Tariff [STRICT]: cheaper hours coming → preserve (waiting for cheaper window)`);
        return;
      }

      if (sunExpected.goodSunComing && sunExpected.hours <= 6) {
        scores.preserve += 20;
        scores.charge   -= 10;
        this.log(`Tariff [STRICT]: cheap €${price.toFixed(3)} but PV in ${sunExpected.hours}h → preserve`);
        return;
      }

      const boost = spreadProfit >= 0.10 ? 80 : 50;
      scores.charge  += boost;
      scores.preserve = 0;

      this.log(`Tariff [STRICT]: cheap €${price.toFixed(3)}, spread €${spreadProfit.toFixed(3)}/kWh → charge +${boost}`);
      return;
    }
  } else {
    // DYNAMIC MODE: Charge when profitable, even if slightly above threshold
    
    if (sunExpected.source === 'actual_pv') {
      scores.charge += 300;
      scores.preserve = 0;
      this.log(`Tariff [DYNAMIC]: actual PV → CHARGE +300`);
      return;
    }

    if (price <= maxChargePrice && maxChargePrice > 0) {
      
      if (cheaperHourComing) {
        scores.preserve += 80;
        scores.charge     = 0;
        this.log(`Tariff [DYNAMIC]: cheaper hours coming → preserve`);
        return;
      }

      if (sunExpected.goodSunComing && sunExpected.hours <= 6) {
        scores.preserve += 20;
        scores.charge   -= 10;
        this.log(`Tariff [DYNAMIC]: PV in ${sunExpected.hours}h → preserve`);
        return;
      }

      const boost = spreadProfit >= 0.10 ? 80 : 50;
      scores.charge  += boost;
      scores.preserve = 0;

      this.log(`Tariff [DYNAMIC]: cheap €${price.toFixed(3)}, spread €${spreadProfit.toFixed(3)}/kWh → charge +${boost}`);
      return;
      
    } else if (spreadProfit > this.MIN_PROFIT_MARGIN * oppChargeMultiplier) {
      // ✅ Opportunistic charge: Use configurable multiplier
      const threshold = this.MIN_PROFIT_MARGIN * oppChargeMultiplier;
      const boost = Math.min(80, spreadProfit * 400);
      scores.charge += boost;
      scores.preserve -= 10;
      this.log(`Tariff [DYNAMIC]: 🎯 opportunistic charge €${price.toFixed(3)}, exceptional spread €${spreadProfit.toFixed(3)}/kWh (threshold=€${threshold.toFixed(3)}, multiplier=${oppChargeMultiplier}) → charge +${boost}`);
      return;
    }
  }

  // ------------------------------------------------------------
  // 3. NORMAL PRICE RANGE
  // ------------------------------------------------------------
  scores.preserve += 5;
  this.log(`Tariff: normal price €${price.toFixed(3)} → preserve +5`);

  // ------------------------------------------------------------
  // 4. EXTREME OVERRIDES (always apply)
  // ------------------------------------------------------------
  if (price <= 0.05) {
    scores.charge  += 40;
    scores.preserve -= 5;
    this.log('Tariff: ultra cheap (≤€0.05) → charge +40');
  }

  if (price >= 0.40) {
    scores.discharge += 40;
    scores.preserve  -= 5;
    this.log('Tariff: ultra expensive (≥€0.40) → discharge +40');
  }

  // ------------------------------------------------------------
  // 5. NO SIGNAL FALLBACK
  // ------------------------------------------------------------
  if (scores.charge === 0 && scores.discharge === 0 && scores.preserve <= 10 && soc > 0) {
    scores.preserve += 5;
    this.log('Tariff: no signal → preserve +5');
  }
}


  _applyDayAheadStrategy(scores, tariff, battery, time, inputs) {
  if (!tariff || !Array.isArray(tariff.next24Hours)) return;

  const soc          = battery?.stateOfCharge ?? 50;
  const maxSoc       = this.settings.max_soc ?? 95;
  const currentHour  = time?.getHours() ?? 0;
  const currentPrice = tariff.currentPrice ?? 0;
  const dynamicMax   = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
  const next24       = tariff.next24Hours || [];

  if (soc === 0) {
    this.log("DayAhead: SoC = 0 → skipping day-ahead logic (ZERO MODE)");
    return;
  }

  let nextExpensiveHour = null;
  let hoursUntilExpensive = null;

  for (let i = 1; i < next24.length; i++) {
    const hourData  = next24[i];
    const breakeven = currentPrice * this.BATTERY_EFFICIENCY;

    if (hourData.price >= breakeven + this.MIN_PROFIT_MARGIN) {
      nextExpensiveHour   = hourData;
      hoursUntilExpensive = i;
      break;
    }
  }

  const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

  if (nextExpensiveHour && hoursUntilExpensive !== null) {

    if (hoursUntilExpensive <= 4 && soc < 80) {
      if (sunExpected.goodSunComing && sunExpected.hours < hoursUntilExpensive) {
        scores.preserve += 20;
        this.log(`DayAhead: expensive in ${hoursUntilExpensive}h, but PV in ${sunExpected.hours}h → preserve`);
      } else {
        scores.charge += 30;
        this.log(`DayAhead: expensive hour in ${hoursUntilExpensive}h → charge +30`);
      }
    }

    if (hoursUntilExpensive <= 2 && soc >= 80) {
      scores.preserve += 15;
      this.log(`DayAhead: expensive in ${hoursUntilExpensive}h, SoC ${soc}% → preserve`);
    }

    if (hoursUntilExpensive <= 3 && soc < 50) {
      if (!sunExpected.goodSunComing || sunExpected.hours >= hoursUntilExpensive) {
        scores.charge += 20;
        this.log(`DayAhead: low SoC ${soc}% with expensive hour in ${hoursUntilExpensive}h → charge +20`);
      }
    }
  }

  if (currentHour >= 12 && currentHour < 16 && soc < 70) {
    const priceReasonable = currentPrice <= dynamicMax * 1.2;

    if (!sunExpected.goodSunComing && priceReasonable) {
      scores.charge += 25;
      this.log(`DayAhead: pre-peak (${currentHour}:00), SoC ${soc}% → charge +25`);
    }
  }

  const sunTomorrow = inputs.weather?.sunshineTomorrow ?? 0;

  if (sunTomorrow >= 4 && soc >= 40 && currentHour >= 20) {
    scores.preserve += 15;
    this.log(`DayAhead: strong sun tomorrow (${sunTomorrow}h) → preserve`);
  }

  const postPeak = currentHour >= 21 || currentHour < 6;

  if (postPeak && soc < 80) {
    const cheapSoon = next24.findIndex(p =>
      typeof p.index === 'number' &&
      p.index > 0 &&
      p.index <= 8 &&
      typeof p.price === 'number' &&
      p.price <= dynamicMax
    );

    if (cheapSoon >= 0) {
      scores.charge += 40;
      this.log(`DayAhead: post-peak, cheap hours in ${cheapSoon}h → charge +40`);
    }
  }
}


  _getSunExpectation(weather, sunMulti, p1) {
    if (p1) {
      const gridPower    = p1.resolved_gridPower ?? 0;
      const batteryPower = p1.battery_power ?? 0;

      if (gridPower < -100 || (batteryPower > 100 && gridPower <= 0)) {
        return {
          goodSunComing: true,
          totalHours: 99,
          hours: 0,
          source: 'actual_pv',
          details: { gridPower, batteryPower }
        };
      }
    }

    if (!weather && !sunMulti) {
      return { goodSunComing: false, totalHours: 0, hours: null };
    }

    const sun4h       = weather?.sunshineNext4Hours    ?? 0;
    const sun8h       = weather?.sunshineNext8Hours    ?? 0;
    const sunToday    = weather?.sunshineTodayRemaining ?? 0;
    const sunTomorrow = weather?.sunshineTomorrow      ?? 0;

    const gfs     = sunMulti?.gfs      ?? null;
    const harmonie = sunMulti?.harmonie ?? null;

    let totalHours    = 0;
    let hoursUntil    = null;
    let goodSunComing = false;

    if (sunToday > 0)    { totalHours += sunToday;    if (hoursUntil === null) hoursUntil = 0; }
    if (sunTomorrow > 0) { totalHours += sunTomorrow; if (hoursUntil === null) hoursUntil = 24 - (new Date().getHours()); }
    if (sun4h > 0 && hoursUntil === null) hoursUntil = 2;
    if (sun8h > 0 && hoursUntil === null) hoursUntil = 4;

    if (totalHours >= 3) goodSunComing = true;
    if (gfs >= 25 || harmonie >= 25) {
      goodSunComing = true;
      if (hoursUntil === null) hoursUntil = 4;
    }

    return {
      goodSunComing,
      totalHours,
      hours: hoursUntil,
      details: { sun4h, sun8h, sunToday, sunTomorrow, gfs, harmonie }
    };
  }

  _getFutureExpensiveHours(tariff, currentPrice) {
    if (!tariff) return null;

    const breakeven = (currentPrice != null)
      ? currentPrice * this.BREAKEVEN_MULTIPLIER
      : (this.settings.min_discharge_price || 0.25);

    const pricesArray = tariff.allPrices || tariff.next24Hours;
    if (!Array.isArray(pricesArray)) return null;

    const now         = new Date();
    const lookAheadMs = 24 * 60 * 60 * 1000;

    const expensiveHours = pricesArray.filter((hour, idx) => {
      if (hour.timestamp) {
        const ts = new Date(hour.timestamp);
        return ts > now &&
               ts <= new Date(now.getTime() + lookAheadMs) &&
               (hour.price ?? 0) >= breakeven;
      }
      const hourIndex = hour.index ?? idx;
      return hourIndex >= 1 && hourIndex <= 24 && (hour.price ?? 0) >= breakeven;
    });

    const onTheHour = expensiveHours.filter(h => {
      const ts = new Date(h.timestamp);
      return ts.getMinutes() === 0;
    });
    const result = onTheHour.length > 0 ? onTheHour : expensiveHours;

    this.log(`_getFutureExpensiveHours: breakeven=€${breakeven.toFixed(4)}, found ${result.length} profitable hours`);
    return result.length > 0 ? result : null;
  }

  _applyPVReality(scores, p1, batteryMode, inputs) {
  if (!p1) return false;

  const gridPower    = p1.resolved_gridPower ?? 0;
  const batteryPower = p1.battery_power ?? 0;
  const pvEstimate   = p1.pv_power_estimated ?? 0;

  const now = Date.now();

  if (!this._pvStickyUntil) this._pvStickyUntil = 0;

  if (this._pvStickyUntil > now) {
    this.log(`PV Reality: sticky PV active → charge allowed`);
    scores.charge += 50;
    return true;
  }

  if (batteryPower > 50) {
    this._pvStickyUntil = now + 5 * 60 * 1000;
    this.log(`💡 PV detected via batteryPower (${batteryPower}W) → sticky 5 min`);
    scores.charge += 100;
    return true;
  }

  if (pvEstimate >= 100) {
    this._pvStickyUntil = now + 5 * 60 * 1000;
    this.log(`💡 PV detected via pvEstimate (${pvEstimate}W) → sticky 5 min`);
    scores.charge += 80;
    return true;
  }

  if (gridPower < -100) {
    const pvSurplus = Math.abs(gridPower);
    this._pvStickyUntil = now + 5 * 60 * 1000;
    this.log(`💡 PV detected via export (${pvSurplus}W) → sticky 5 min`);
    scores.charge += 60;
    return true;
  }

  if (batteryMode === 'zero_charge_only') {
    this._pvStickyUntil = now + 2 * 60 * 1000;
    this.log(`PV Reality: zero_charge_only mode → PV assumed`);
    scores.charge += 40;
    return true;
  }

  if (this.settings.tariff_type === 'dynamic') {
    this.log('PV Reality: no PV surplus but dynamic pricing → tariff decides');
    return true;
  }

  this.log('PV Reality: no PV → blocking charge');
  return false;
}


  _applyWeatherForecast(scores, weather, tariff, battery, inputs) {
    if (!weather) return;

    const sun4h       = Number(weather.sunshineNext4Hours    ?? 0);
    const sun8h       = Number(weather.sunshineNext8Hours    ?? 0);
    const sunToday    = Number(weather.sunshineTodayRemaining ?? 0);
    const sunTomorrow = Number(weather.sunshineTomorrow      ?? 0);
    const soc         = battery?.stateOfCharge ?? 50;
    const isDynamic   = this.settings.tariff_type === 'dynamic';

    if (sun4h >= 2.0) {
      scores.charge  -= 25;
      scores.preserve += 15;
      this.log(`Weather: sun4h >= 2 → preserve (PV coming in ~2h)`);
    }

    if (sun4h >= 1.0) {
      scores.preserve += 10;
      this.log('Weather: sun4h >= 1 → preserve');
    }

    if (sun8h >= 3.0) {
      scores.charge -= 20;
      this.log('Weather: sun8h >= 3 → avoid grid charging');
    }

    if (sunToday >= 4.0) {
      scores.charge  -= 15;
      scores.preserve += 10;
      this.log('Weather: sunToday >= 4 → avoid grid charging');
    }

    if (sunTomorrow >= 4.0) {
      scores.charge -= 10;

      if (isDynamic) {
        const currentPrice      = tariff?.currentPrice || 0;
        const minDischargePrice = this.settings.min_discharge_price || 0.25;

        if (currentPrice >= minDischargePrice * 0.85) {
          scores.discharge += 25;
          this.log('Weather: sunTomorrow >= 4 + expensive hour → BOOST discharge');
        } else {
          this.log('Weather: sunTomorrow >= 4 → mild grid charge penalty');
        }
      } else {
        scores.discharge += 15;
        this.log('Weather: sunTomorrow >= 4 → encourage discharge');
      }
    }

    if (sunTomorrow >= 6.0) {
      scores.charge -= 20;

      if (isDynamic) {
        const currentPrice      = tariff?.currentPrice || 0;
        const minDischargePrice = this.settings.min_discharge_price || 0.25;

        if (currentPrice >= minDischargePrice * 0.75) {
          scores.discharge += 35;
          this.log('Weather: sunTomorrow >= 6 + moderate/high price → AGGRESSIVE discharge');
        } else {
          this.log('Weather: sunTomorrow >= 6 → avoid grid charging, ready to discharge');
        }
      } else {
        const currentHour = new Date().getHours();
        if (currentHour >= 17) {
          scores.discharge += 30;
          this.log('Weather: sunTomorrow >= 6 + evening → AGGRESSIVE discharge');
        } else {
          scores.discharge += 20;
          this.log('Weather: sunTomorrow >= 6 → boost discharge');
        }
      }
    }
  }

  _applyPeakShavingRules(scores, inputs) {
    const { p1, time, battery } = inputs;
    if (!p1 || !time) return;

    const grid         = p1.resolved_gridPower ?? 0;
    const batt         = p1.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    const trueLoad     = grid + dischargeNow;
    const maxDischarge = this.maxDischarge;
    const coverageRatio = trueLoad > 0 ? Math.min(trueLoad / maxDischarge, 1.0) : 0;
    const canFullyCover = trueLoad <= maxDischarge;
    const hour          = time.getHours();
    const peak          = this._parseTimeRange(this.settings.peak_hours);
    const inPeak        = peak && hour >= peak.startHour && hour < peak.endHour;

    if (inPeak) {
      scores.charge = 0;

      if (canFullyCover) {
        scores.discharge += 40;
        scores.preserve  += 5;
        this.log(`Peak: battery can fully cover ${trueLoad}W → discharge +40`);
      } else {
        const partialScore = Math.round(40 * coverageRatio);
        scores.discharge  += partialScore;
        scores.preserve   += 5;
        this.log(`Peak: battery covers ${Math.round(coverageRatio * 100)}% of ${trueLoad}W → discharge +${partialScore}`);
      }
    }

    if (trueLoad > maxDischarge * 0.8) {
      if (canFullyCover) {
        scores.discharge += 30;
        scores.preserve  -= 5;
        this.log(`Peak: high load ${trueLoad}W (coverable) → discharge +30`);
      } else {
        scores.discharge += 15;
        scores.preserve  -= 5;
        this.log(`Peak: high load ${trueLoad}W (exceeds capacity) → discharge +15`);
      }
    }

    if (trueLoad < maxDischarge * 0.3) {
      scores.preserve  += 15;
      scores.discharge -= 5;
      this.log(`Peak: low load ${trueLoad}W → preserve +15`);
    }

    const weather = inputs.weather;
    if (weather) {
      const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
      const h           = time.getHours();

      if (sunTomorrow >= 5.0 && h >= 17 && h < 23) {
        scores.discharge += 20;
        scores.preserve  -= 10;
        this.log(`Peak: evening + ${sunTomorrow}h sun tomorrow → boost discharge`);
      }

      const offPeak   = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && h >= offPeak.startHour && h < offPeak.endHour;

      if (inOffPeak && sunTomorrow >= 4.0) {
        scores.charge -= 30;
        this.log(`Peak: off-peak but ${sunTomorrow}h sun tomorrow → skip grid charging`);
      }
    }

    if (trueLoad >= maxDischarge * 0.3 && trueLoad <= maxDischarge * 0.8) {
      scores.discharge += 10;
      this.log(`Peak: optimal load range ${trueLoad}W → discharge +10`);
    }
  }

  _parseTimeRange(range) {
    if (!range) return null;
    const [start, end] = range.split('-').map(s => parseInt(s, 10));
    if (isNaN(start) || isNaN(end)) return null;
    return { startHour: start, endHour: end };
  }

  _applyPolicyMode(scores, mode) {
    if (mode === 'eco') {
      scores.preserve  *= 1.3;
      scores.charge    *= 0.8;
      scores.discharge *= 0.8;
      this.log('PolicyMode: ECO (reduced cycling to minimize losses)');
    }

    if (mode === 'aggressive') {
      scores.charge    *= 1.2;
      scores.discharge *= 1.2;
      scores.preserve  *= 0.7;
      this.log('PolicyMode: AGGRESSIVE (maximize arbitrage opportunities)');
    }
  }

_mapPolicyToHwMode(policyMode, ctx) {
  const tariffType     = this.settings.tariff_type;
  const soc            = ctx.battery?.stateOfCharge ?? 50;
  const minSoc         = this.settings.min_soc ?? 0;
  const maxSoc         = this.settings.max_soc ?? 95;
  const price          = ctx.tariff?.currentPrice ?? null;
  const minDischarge   = this.settings.min_discharge_price || 0;
  const maxChargePrice = this.settings.max_charge_price ?? 0.19;

  // NOTE: HomeWizard firmware handles 0-100% protection
  // Only respect user-configured min_soc for strategy, not safety

  if (soc < minSoc) {
    this.log(`[MAPPING][SAFETY] SoC ${soc}% < min_soc ${minSoc}% → forcing standby`);
    return 'standby';
  }

  const costModelActive =
    ctx.batteryCost?.avgCost > 0 &&
    ctx.batteryCost?.energyKwh >= 0.5;

  if (costModelActive) {
    const configuredEff = this.settings.battery_efficiency || 0.75;
    const learnedEff    = ctx.batteryEfficiency ?? configuredEff;
    const effectiveEff  = Math.min(configuredEff, learnedEff, 0.95);

    const safeBreakEven = ctx.batteryCost.avgCost / effectiveEff;
    ctx.batteryCost.breakEven = safeBreakEven;

    this.log(`[MAPPING] safe break-even €${safeBreakEven.toFixed(3)} (eff=${effectiveEff.toFixed(3)})`);
  }

  const profitableToDischarge =
    price !== null &&
    price >= minDischarge &&
    (!costModelActive || price >= ctx.batteryCost.breakEven);

  const gridPower    = ctx.p1?.resolved_gridPower ?? 0;
  const batteryPower = ctx.p1?.battery_power ?? 0;
  const pvEstimate   = ctx.p1?.pv_power_estimated ?? 0;

  // Check sticky PV flag first (set by _applyPVReality with 5min window)
  const stickyPvActive = this._pvStickyUntil && (this._pvStickyUntil > Date.now());

  const actualPvNow =
    stickyPvActive ||
    gridPower < -100 ||
    batteryPower > 50 ||
    pvEstimate >= 100 ||
    (gridPower <= 0 && batteryPower > 50);

  this.log(`[MAPPING] policyMode=${policyMode}, soc=${soc}, PV=${actualPvNow} (sticky=${stickyPvActive}), price=${price?.toFixed(3)}, maxCharge=€${maxChargePrice}`);

  if (ctx.policyMode === 'zero') {
    if (soc <= minSoc) return 'to_full';
    if (soc >= maxSoc) return 'zero_discharge_only';
    return 'zero';
  }

  if (ctx.policyMode === 'balanced' && tariffType === 'dynamic') {

    if (policyMode === 'discharge') {
      return profitableToDischarge ? 'zero_discharge_only' : 'standby';
    }

    if (policyMode === 'charge') {

      if (actualPvNow) {
        this.log(`[MAPPING] PV detected → zero_charge_only`);
        return 'zero_charge_only';
      }

      if (price !== null && price <= maxChargePrice) {
        this.log(`[MAPPING][CHARGE] price €${price.toFixed(3)} <= max_charge_price €${maxChargePrice} → to_full`);
        return 'to_full';
      }

      this.log(`[MAPPING][CHARGE] price €${price?.toFixed(3)} > max_charge_price €${maxChargePrice} → standby`);
      return 'standby';
    }

    if (policyMode === 'preserve') {
      return actualPvNow ? 'zero_charge_only' : 'standby';
    }
  }

  if (tariffType === 'fixed') {
    if (policyMode === 'discharge') return 'zero_discharge_only';
    if (policyMode === 'charge')    return actualPvNow ? 'zero_charge_only' : 'to_full';
    return actualPvNow ? 'zero_charge_only' : 'standby';
  }

  return actualPvNow ? 'zero_charge_only' : 'standby';
}

  _selectMode(scores, ctx) {
    let policyMode = 'preserve';
    let winner     = scores.preserve;

    if (scores.charge > winner)    { policyMode = 'charge';    winner = scores.charge; }
    if (scores.discharge > winner) { policyMode = 'discharge'; winner = scores.discharge; }

    const total      = scores.charge + scores.discharge + scores.preserve;
    const confidence = Math.round((winner / (total || 1)) * 100);
    const hwMode     = this._mapPolicyToHwMode(policyMode, ctx);

    return { policyMode, hwMode, confidence: Math.min(confidence, 100) };
  }

  updateSettings(newSettings) {
    this.settings           = { ...this.settings, ...newSettings };
    this.BATTERY_EFFICIENCY = newSettings.battery_efficiency || this.BATTERY_EFFICIENCY;
    this.MIN_PROFIT_MARGIN  = newSettings.min_profit_margin ?? this.MIN_PROFIT_MARGIN;
  }
}

module.exports = PolicyEngine;