'use strict';

// ======================================================
// CHANGES IN THIS VERSION:
// 1. MIN_PROFIT_MARGIN reduced to 0.01 (small battery, capture every spread)
// 2. _applySmartLowSocRule: spread profitability check added so cheap night
//    hours trigger charging even when above max_charge_price
// 3. _applyTariffScore: TOP3 profit threshold halved (0.01 vs MIN_PROFIT_MARGIN)
// 4. _applyWeatherForecast: sunTomorrow charge penalty reduced — February sun
//    should not block overnight charging
// 5. _getDynamicChargePrice: uses max future price instead of top-half avg
//    so dynamic threshold better reflects actual peak opportunity
// 6. _applyDayAheadStrategy: evening charge window extended to ensure battery
//    full before 17:00 peak
// ======================================================

const debug = true;

class PolicyEngine {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = (...args) => homey.log('[PolicyEngine]', ...args);

    this.BATTERY_EFFICIENCY = settings.battery_efficiency || 0.75;
    this.BREAKEVEN_MULTIPLIER = 1 / this.BATTERY_EFFICIENCY;
    // FIX 1: Reduced from 0.02 to 0.01 — small battery, capture every spread
    this.MIN_PROFIT_MARGIN = settings.min_profit_margin ?? 0.01;

    this.currentLoad = 0;
    this.maxDischarge = 0;
  }

  // FIX 5: Use max future price instead of top-half average
  // This gives a more realistic ceiling for the dynamic charge threshold
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

    // FIX 5: Use the single highest future price as the ceiling
    const maxFuturePrice = Math.max(...futurePrices);

    // Break-even: charge price must leave profit after RTE losses
    const dynamicThreshold = (maxFuturePrice * this.BATTERY_EFFICIENCY) - this.MIN_PROFIT_MARGIN;

    // Allow up to 200% of static as safety valve (was 150%)
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

    const soc = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;

    inputs.dynamicMaxChargePrice = this._getDynamicChargePrice(
      inputs.tariff, inputs.tariff?.currentPrice
    );

    if (grid < -100 && soc < maxSoc) {
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

    // Arbitrage: price vs break-even
    if (inputs.batteryCost?.avgCost > 0) {
      const breakEven = inputs.batteryCost.breakEven;
      const price = inputs.tariff?.currentPrice ?? null;

      if (price !== null) {
        if (price > breakEven + 0.01) {
          const boost = 80;
          scores.discharge += boost;
          scores.preserve -= 20;
          this.log(`Arbitrage: price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} → discharge +${boost}`);
        } else if (price < breakEven - 0.01) {
          const boost = 80;
          scores.charge += boost;
          scores.preserve -= 20;
          this.log(`Arbitrage: price €${price.toFixed(3)} < break-even €${breakEven.toFixed(3)} → charge +${boost}`);
        } else {
          scores.preserve += 10;
          this.log(`Arbitrage: price near break-even → preserve`);
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

    const sun4h = inputs.weather?.sunshineNext4Hours ?? 0;
    const multi = inputs.sun;

    const gfs    = multi?.gfs      ?? null;
    const icon   = multi?.harmonie ?? null;

    const arr    = [sun4h, gfs, icon].filter(v => typeof v === 'number');
    const avgSun = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const noSun     = avgSun < 5;
    const lightSun  = avgSun >= 5  && avgSun < 25;
    const strongSun = avgSun >= 25;

    const dynamicMax = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
    const price      = inputs.tariff?.currentPrice ?? null;
    const priceLow   = price !== null && price <= dynamicMax;

    // FIX 2: Check if spread to future peak is profitable even if price > dynamicMax
    const futureMax = inputs.tariff?.statistics?.max ?? null;
    const eff = this.BATTERY_EFFICIENCY;
    const spreadProfitable = price !== null && futureMax !== null &&
      (futureMax * eff) - price > 0; // any positive spread after RTE losses

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

    if (soc === 0) {
      this.log('BatteryScore: SoC = 0 → ZERO MODE (charge-only)');
      scores.discharge = 0;
      scores.preserve  = 0;
      scores.charge   += 100;
      return;
    }

    const max = this.settings.max_soc ?? 95;

    if (soc >= max) {
      scores.discharge += 40;
      scores.charge     = 0;
      scores.preserve  += 10;
      this.log('BatteryScore: max SoC reached → discharge');
      return;
    }

    scores.preserve += 10;
    this.log('BatteryScore: normal range → preserve +10');
  }

  _applyTariffScore(scores, tariff, battery, inputs) {
    if (!this.settings.enable_dynamic_pricing || tariff.currentPrice == null) return;

    const price           = tariff.currentPrice;
    const soc             = battery?.stateOfCharge ?? 0;
    const maxChargePrice  = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
    const minDischargePrice = this.settings.min_discharge_price || 0;
    const isFloatEqual    = (a, b) => Math.abs(a - b) < 0.00001;

    if (Array.isArray(tariff.top3Lowest) &&
        tariff.top3Lowest.some(p => isFloatEqual(p.price ?? p, price))) {

      const futureExpensiveHours = this._getFutureExpensiveHours(tariff, price);

      if (futureExpensiveHours && futureExpensiveHours.length > 0) {
        const avgFuturePrice = futureExpensiveHours.reduce((sum, h) => sum + h.price, 0) / futureExpensiveHours.length;
        const profitPerKwh   = (avgFuturePrice * this.BATTERY_EFFICIENCY) - price;

        const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

        // FIX 3: Use half of MIN_PROFIT_MARGIN as threshold for top-3 cheap hours
        const TOP3_THRESHOLD = this.MIN_PROFIT_MARGIN * 0.5;

        if (profitPerKwh > TOP3_THRESHOLD) {
          if (sunExpected.source === 'actual_pv') {
            scores.charge += 500;
            scores.preserve = 0;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → CHARGE from ACTUAL PV`);
          } else if (sunExpected.goodSunComing && sunExpected.hours <= 8) {
            scores.preserve += 50;
            scores.charge   -= 30;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (good PV in ${sunExpected.hours}h)`);
          } else {
            const aggressiveThreshold = 0.10; // lowered from 0.15

            if (profitPerKwh >= aggressiveThreshold) {
              scores.charge  += 100;
              scores.preserve = 0;
              this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → CHARGE (aggressive)`);
            } else {
              scores.charge  += 60;
              scores.preserve = 10;
              this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → CHARGE (moderate)`);
            }
          }
        } else if (profitPerKwh > 0) {
          if (sunExpected.totalHours < 2) {
            scores.charge   += 50;
            scores.preserve -= 10;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → MARGINAL CHARGE`);
          } else {
            scores.preserve += 40;
            this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (marginal + ${sunExpected.totalHours}h sun coming)`);
          }
        } else {
          scores.preserve += 30;
          this.log(`Tariff: TOP-3 CHEAP (€${price.toFixed(3)}) → SKIP (unprofitable)`);
        }
      } else {
        scores.preserve += 30;
        this.log(`Tariff: TOP-3 CHEAP but no expensive hours ahead → SKIP charging`);
      }
    }

    if (Array.isArray(tariff.top3Highest) &&
        tariff.top3Highest.some(p => isFloatEqual(p.price ?? p, price))) {

      if (this.currentLoad > 0) {
        const coverableLoad  = Math.min(this.currentLoad, this.maxDischarge);
        const coverageRatio  = coverableLoad / this.maxDischarge;
        const baseScore      = 300;
        const scaledScore    = Math.round(baseScore * Math.max(0.5, coverageRatio));

        scores.discharge += scaledScore;
        scores.preserve   = 0;
        this.log(`Tariff: TOP-3 EXPENSIVE (€${price.toFixed(3)}) → DISCHARGE (+${scaledScore})`);
      } else {
        scores.discharge += 150;
        scores.preserve   = 0;
        this.log(`Tariff: TOP-3 EXPENSIVE (€${price.toFixed(3)}) → STANDBY for load`);
      }
    }

    if (price <= maxChargePrice && maxChargePrice > 0) {
      const minProfitableDischarge = price * this.BREAKEVEN_MULTIPLIER;

      if (minDischargePrice >= minProfitableDischarge) {
        const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

        if (sunExpected.goodSunComing && sunExpected.hours <= 6) {
          scores.preserve += 30;
          scores.charge   -= 20;
          this.log(`Tariff: cheap (€${price.toFixed(3)}) but ${sunExpected.totalHours}h sun in ${sunExpected.hours}h → preserve`);
        } else {
          scores.charge += 35;
          this.log(`Tariff: cheap (€${price.toFixed(3)}, dynamic max=€${maxChargePrice.toFixed(3)}) → charge +35`);
        }
      } else {
        scores.preserve += 20;
        this.log(`Tariff: cheap (€${price.toFixed(3)}) but spread too small → preserve`);
      }
    } else if (price >= minDischargePrice && minDischargePrice > 0 && price > maxChargePrice) {
      if (this.currentLoad > 0) {
        scores.discharge += 30;
        this.log(`Tariff: expensive (€${price.toFixed(3)}) → discharge +30`);
      } else {
        scores.discharge += 15;
        this.log(`Tariff: expensive (€${price.toFixed(3)}) but no load → discharge +15 (standby)`);
      }
    } else {
      scores.preserve += 5;
      this.log(`Tariff: normal price (€${price.toFixed(3)}) → preserve +5`);
    }

    if (scores.charge === 0 && scores.discharge === 0 && scores.preserve <= 10 && soc > 0) {
      scores.preserve += 5;
      this.log('Tariff: no signal → preserve +5');
    }

    if (price <= 0.05) {
      scores.charge  += 50;
      scores.preserve -= 10;
      this.log('Tariff: ultra cheap (≤€0.05) → charge +50');
    }

    if (price >= 0.40) {
      scores.discharge += 50;
      scores.preserve  -= 10;
      this.log('Tariff: ultra expensive (≥€0.40) → discharge +50');
    }
  }

  _applyDayAheadStrategy(scores, tariff, battery, time, inputs) {
    if (!tariff || !Array.isArray(tariff.next24Hours)) return;

    const soc        = battery?.stateOfCharge ?? 50;
    const maxSoc     = this.settings.max_soc ?? 95;
    const currentHour = time?.getHours() ?? 0;
    const currentPrice = tariff.currentPrice ?? 0;
    const dynamicMax   = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
    const next24       = tariff.next24Hours || [];

    // Find next profitable discharge hour
    let nextExpensiveHour  = null;
    let hoursUntilExpensive = null;

    for (let i = 1; i < next24.length; i++) {
      const hourData  = next24[i];
      const breakeven = currentPrice * this.BREAKEVEN_MULTIPLIER;
      if (hourData.price >= breakeven + this.MIN_PROFIT_MARGIN) {
        nextExpensiveHour   = hourData;
        hoursUntilExpensive = i;
        break;
      }
    }

    if (nextExpensiveHour && hoursUntilExpensive !== null) {
      const targetSoC    = 80;
      const futureSavings = (nextExpensiveHour.price * this.BATTERY_EFFICIENCY) - currentPrice;
      const sunExpected  = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

      if (hoursUntilExpensive <= 4 && soc < targetSoC) {
        if (futureSavings > this.MIN_PROFIT_MARGIN) {
          if (sunExpected.goodSunComing && sunExpected.hours < hoursUntilExpensive) {
            scores.preserve += 40;
            scores.charge   -= 20;
            this.log(`DayAhead: expensive in ${hoursUntilExpensive}h, but PV in ${sunExpected.hours}h → preserve`);
          } else {
            scores.charge  += 40;
            scores.preserve -= 10;
            this.log(`DayAhead: expensive hour in ${hoursUntilExpensive}h (€${nextExpensiveHour.price.toFixed(3)})`);
          }
        }
      }

      if (hoursUntilExpensive <= 2 && soc >= targetSoC) {
        scores.preserve  += 30;
        scores.discharge -= 20;
        this.log(`DayAhead: expensive hour in ${hoursUntilExpensive}h, preserving battery (SoC ${soc}%)`);
      }

      if (hoursUntilExpensive <= 3 && soc < 50) {
        if (!sunExpected.goodSunComing || sunExpected.hours >= hoursUntilExpensive) {
          scores.charge += 20;
          this.log(`DayAhead: low SoC (${soc}%) with expensive hour in ${hoursUntilExpensive}h → charge +20`);
        }
      }
    }

    // FIX 6: Ensure battery is full before evening peak (17:00-21:00)
    // If it's 12:00-16:00, SoC < 70%, and price is reasonable → charge to prepare for peak
    if (currentHour >= 12 && currentHour < 16 && soc < 70) {
      const priceReasonable = currentPrice <= dynamicMax * 1.2;
      const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

      if (!sunExpected.goodSunComing && priceReasonable) {
        scores.charge  += 30;
        scores.preserve -= 5;
        this.log(`DayAhead: pre-peak charge window (${currentHour}:00, SoC ${soc}%, €${currentPrice.toFixed(3)}) → charge +30`);
      }
    }

    // FIX 4 (partial): only penalize night charging if sun tomorrow is strong (>=4h)
    // Weak February sun (2-3h) should not block overnight charging
    const sunTomorrow = inputs.weather?.sunshineTomorrow ?? 0;
    if (sunTomorrow >= 4 && soc >= 40 && currentHour >= 20) {
      scores.preserve += 20;
      scores.charge   -= 15;
      this.log(`DayAhead: good sun tomorrow (${sunTomorrow}h), preserving battery for free PV recharge`);
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

    const sun4h      = weather?.sunshineNext4Hours   ?? 0;
    const sun8h      = weather?.sunshineNext8Hours   ?? 0;
    const sunToday   = weather?.sunshineTodayRemaining ?? 0;
    const sunTomorrow = weather?.sunshineTomorrow     ?? 0;

    const gfs     = sunMulti?.gfs      ?? null;
    const harmonie = sunMulti?.harmonie ?? null;

    let totalHours = 0;
    let hoursUntil = null;
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

    this.log(`_getFutureExpensiveHours: breakeven=€${breakeven.toFixed(4)}, window=24h, found ${result.length} profitable hours`);
    if (result.length > 0) {
      result.forEach(h => this.log(`  → ${new Date(h.timestamp).toISOString()}: €${h.price}`));
    }
    return result.length > 0 ? result : null;
  }

  _applyPVReality(scores, p1, batteryMode, inputs) {
    if (!p1) return false;

    const gridPower    = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;
    const pvEstimate   = p1.pv_power_estimated ?? 0;

    let pvDetected = false;
    let pvSurplus  = 0;

    if (pvEstimate > 0) {
      if (gridPower < -100) {
        pvSurplus  = Math.abs(gridPower);
        pvDetected = true;
      } else if (gridPower <= 0 && batteryPower > 50) {
        pvSurplus  = Math.abs(gridPower) + batteryPower;
        pvDetected = pvSurplus >= 75;
      } else {
        pvSurplus  = 0;
        pvDetected = false;
      }
    } else if (batteryMode === 'zero_charge_only') {
      pvDetected = batteryPower > 0;
    } else {
      pvDetected = gridPower < -100;
    }

    if (!pvDetected && this.settings.tariff_type === 'dynamic') {
      this.log('PV Reality: no PV surplus but dynamic pricing → charge decision based on tariff economics');
      return true;
    }

    if (!pvDetected) {
      scores.charge = 0;
      this.log('PV Reality: no PV surplus in fixed mode → blocking charge');
      return false;
    }

    if (pvSurplus > 0) {
      this.log(`💡 PV surplus ${pvSurplus}W detected → CHARGE battery`);
      scores.charge += 100;
    }

    this.log(`PV Reality: PV surplus detected (${pvSurplus > 0 ? pvSurplus + 'W' : 'yes'}) → charge allowed`);
    return true;
  }

  // FIX 4: Reduced sun-tomorrow charge penalties — weak winter sun should not
  // block overnight charging. Only penalize when sun is genuinely strong (>=4h).
  _applyWeatherForecast(scores, weather, tariff, battery, inputs) {
    if (!weather) return;

    const sun4h       = Number(weather.sunshineNext4Hours   ?? 0);
    const sun8h       = Number(weather.sunshineNext8Hours   ?? 0);
    const sunToday    = Number(weather.sunshineTodayRemaining ?? 0);
    const sunTomorrow = Number(weather.sunshineTomorrow     ?? 0);
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

    // FIX 4: Only penalize for sunTomorrow >= 4 (not >= 2 as before)
    // Weak winter sun (2-3h) is not enough to skip a profitable night charge
    if (sunTomorrow >= 4.0) {
      scores.charge -= 10; // reduced from original penalties

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
      scores.charge -= 20; // reduced from 25

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
        const now         = new Date();
        const currentHour = now.getHours();

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

    const grid        = p1.resolved_gridPower ?? 0;
    const batt        = p1.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    const trueLoad    = grid + dischargeNow;
    const maxDischarge = this.maxDischarge;
    const coverageRatio = trueLoad > 0 ? Math.min(trueLoad / maxDischarge, 1.0) : 0;
    const canFullyCover = trueLoad <= maxDischarge;
    const hour        = time.getHours();
    const peak        = this._parseTimeRange(this.settings.peak_hours);
    const inPeak      = peak && hour >= peak.startHour && hour < peak.endHour;

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
      const hour        = time.getHours();

      if (sunTomorrow >= 5.0 && hour >= 17 && hour < 23) {
        scores.discharge += 20;
        scores.preserve  -= 10;
        this.log(`Peak: evening + ${sunTomorrow}h sun tomorrow → boost discharge`);
      }

      const offPeak  = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && hour >= offPeak.startHour && hour < offPeak.endHour;

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
      scores.preserve *= 1.3;
      scores.charge   *= 0.8;
      scores.discharge *= 0.8;
      this.log('PolicyMode: ECO (reduced cycling to minimize losses)');
    }

    if (mode === 'aggressive') {
      scores.charge   *= 1.2;
      scores.discharge *= 1.2;
      scores.preserve *= 0.7;
      this.log('PolicyMode: AGGRESSIVE (maximize arbitrage opportunities)');
    }
  }

  _mapPolicyToHwMode(policyMode, ctx) {
    const tariffType = this.settings.tariff_type;
    const soc        = ctx.battery?.stateOfCharge ?? 50;
    const minSoc     = this.settings.min_soc ?? 0;
    const maxSoc     = this.settings.max_soc ?? 95;
    const price      = ctx.tariff?.currentPrice ?? null;
    const minDischarge = this.settings.min_discharge_price || 0;

    const dynamicMaxCharge = ctx.dynamicMaxChargePrice ?? this._getDynamicChargePrice(ctx.tariff, price);
    const breakeven        = price !== null ? price * this.BREAKEVEN_MULTIPLIER : 0;

    const profitableToCharge = price !== null &&
      price <= dynamicMaxCharge &&
      (breakeven - price) >= this.MIN_PROFIT_MARGIN;

    const profitableToDischarge = price !== null &&
      price >= minDischarge &&
      price >= breakeven;

    const grid         = ctx.p1?.resolved_gridPower ?? 0;
    const batteryPower = ctx.p1?.battery_power ?? 0;
    const pvEstimate   = ctx.p1?.pv_power_estimated ?? 0;

    // actualPvNow: real-time grid export only — no forecast contamination
    // Used for charge branch to decide to_full vs zero_charge_only
    const actualPvNow = grid < -100 || (batteryPower > 50 && grid <= 0);

    // hasPV: includes PV estimate for preserve/fallback branches
    const hasPV =
      actualPvNow ||
      pvEstimate > 100;

    const zeroModeActive = ctx.policyMode === 'zero';

    this.log(`[MAPPING] policyMode=${policyMode}, soc=${soc}, PV=${hasPV}, price=${price}, dynamicMax=€${dynamicMaxCharge.toFixed(3)}`);

    // Arbitrage override (battery cost model)
    if (ctx.batteryCost?.avgCost > 0 && price !== null) {
      const breakEven = ctx.batteryCost.breakEven;
      const margin    = 0.015;
      const lastMode  = ctx.lastModeApplied;

      if (lastMode === 'zero_discharge_only' && price > breakEven) {
        this.log(`[MAPPING][ARBITRAGE] Holding discharge (thrash-protect)`);
        return 'zero_discharge_only';
      }

      if (lastMode === 'to_full' && price < breakEven) {
        this.log(`[MAPPING][ARBITRAGE] Holding charge (thrash-protect)`);
        return 'to_full';
      }

      if (price > breakEven + margin && soc > minSoc) {
        this.log(`[MAPPING][ARBITRAGE] price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} → zero_discharge_only`);
        return 'zero_discharge_only';
      }

      if (price < breakEven - margin && soc < maxSoc) {
        this.log(`[MAPPING][ARBITRAGE] price €${price.toFixed(3)} < break-even €${breakEven.toFixed(3)} → to_full`);
        return 'to_full';
      }
    }

    // 1. ZERO / PEAK-SHAVING
    if (zeroModeActive) {
      if (soc <= minSoc) return 'to_full';
      if (soc >= maxSoc) return 'zero_discharge_only';
      return 'zero';
    }

    // 2. DYNAMIC TARIFF
    if (ctx.policyMode === 'balanced' && tariffType === 'dynamic') {
      if (policyMode === 'discharge') {
        return profitableToDischarge ? 'zero_discharge_only' : 'standby';
      }

      if (policyMode === 'charge') {
        if (profitableToCharge) return 'to_full';
        // Use real-time PV signal only — forecast can wrongly set hasPV at night
        if (actualPvNow) return 'zero_charge_only';
        // Engine says charge, no actual PV → charge from grid
        return 'to_full';
      }

      // preserve
      if (price !== null) {
        const futureExpensiveHours = this._getFutureExpensiveHours(ctx.tariff, price);
        if (futureExpensiveHours && futureExpensiveHours.length > 0) {
          const avgFuturePrice = futureExpensiveHours.reduce((s, h) => s + (h.price ?? 0), 0) / futureExpensiveHours.length;
          const profit = (avgFuturePrice * this.BATTERY_EFFICIENCY) - price;
          if (profit > this.MIN_PROFIT_MARGIN && soc < maxSoc - 10) return 'to_full';
        }
      }

      if (hasPV) return 'zero_charge_only';
      return 'standby';
    }

    // 3. FIXED TARIFF
    if (tariffType === 'fixed') {
      if (policyMode === 'discharge') return 'zero_discharge_only';
      if (policyMode === 'charge')    return hasPV ? 'zero_charge_only' : 'to_full';
      return hasPV ? 'zero_charge_only' : 'standby';
    }

    // 4. FALLBACK
    return hasPV ? 'zero_charge_only' : 'standby';
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
    this.settings            = { ...this.settings, ...newSettings };
    this.BATTERY_EFFICIENCY  = newSettings.battery_efficiency || this.BATTERY_EFFICIENCY;
    this.MIN_PROFIT_MARGIN   = newSettings.min_profit_margin ?? this.MIN_PROFIT_MARGIN;
  }
}

module.exports = PolicyEngine;