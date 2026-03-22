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

    const pricesArray = tariff.effectivePrices || tariff.allPrices || tariff.next24Hours;
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

    // Cap: never charge above the break-even of the configured discharge price.
    // Charging at more than (minDischarge × RTE - margin) means you can't profit
    // at minDischargePrice — there's no point.
    const minDischarge = this.settings.min_discharge_price || 0.30;
    const maxByDischarge = (minDischarge * this.BATTERY_EFFICIENCY) - this.MIN_PROFIT_MARGIN;

    // Effective = opportunistic up to the discharge break-even, but never below staticMax
    const effectiveMax = Math.max(staticMax, Math.min(dynamicThreshold, maxByDischarge));

    this.log(`DynamicChargePrice: maxFuturePrice=€${maxFuturePrice.toFixed(3)}, dynamic=€${dynamicThreshold.toFixed(3)}, static=€${staticMax.toFixed(3)}, maxByDischarge=€${maxByDischarge.toFixed(3)}, effective=€${effectiveMax.toFixed(3)}`);

    return effectiveMax;
  }

  calculatePolicy(inputs) {
    const scores = { charge: 0, discharge: 0, preserve: 0 };

    this.log('--- POLICY RUN START ---');
    if (debug) this.log('Inputs:', JSON.stringify(inputs, null, 2));

    this.maxDischarge = inputs.battery?.maxDischargePowerW ||
                        (inputs.battery?.totalCapacityKwh
                          ? Math.max(1, Math.round(inputs.battery.totalCapacityKwh / 2.688)) * 800
                          : 800);

    const grid = inputs.p1?.resolved_gridPower ?? 0;
    const batt = inputs.p1?.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    this.currentLoad = grid > 0 ? grid + dischargeNow : 0;

    const batteryCanCover = this.currentLoad <= this.maxDischarge;
    const coverageRatio = this.currentLoad > 0 ? Math.min(this.maxDischarge / this.currentLoad, 1.0) : 0;

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
      // Reset cost model whenever battery is at or below min SoC — firmware cuts power
      // flow to 0W when empty, so we can't rely on isDischarging being true
      if (soc <= Math.max(minSoc, 1)) {
        if (inputs.batteryCost.avgCost !== 0 || inputs.batteryCost.energyKwh !== 0) {
          this.log(`[COST][RESET] SoC ${soc}% <= min_soc ${minSoc}% → battery empty, resetting cost model`);
        }
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

    // Detect PV surplus: either exporting to grid OR battery is absorbing PV OR pvEstimate shows production
    const _pvSurplusDetected = grid < -200 || batt > 100 || (inputs.p1?.pv_power_estimated ?? 0) >= 200;

    if (_pvSurplusDetected && soc < maxSoc && _isDaylight) {
      // Compare: export surplus to grid NOW vs store in battery for later discharge
      // When battery is in zero_charge_only, PV goes to battery first → grid stays near 0
      // So we also detect PV via batteryPower and pvEstimate, not just grid export
      const _pvCurrentPrice = inputs.tariff?.currentPrice ?? null;
      const _pvPricesArray  = inputs.tariff?.effectivePrices || inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
      const _sph = Math.round(1 / (inputs.tariff?.slotHours ?? 1)); // slots per hour
      const _pvNow = new Date();
      const _pvFuturePrices = _pvPricesArray
        .filter(h => h.timestamp ? new Date(h.timestamp) > _pvNow : (h.index ?? 0) >= 1)
        .map(h => h.price)
        .filter(p => typeof p === 'number' && p > 0);
      const _pvMaxFuture = _pvFuturePrices.length ? Math.max(..._pvFuturePrices) : null;
      const _pvStoreValue = _pvMaxFuture !== null ? _pvMaxFuture * this.BATTERY_EFFICIENCY : null;
      // Store decision in inputs so Arbitrage block can respect same opportunity-cost logic
      inputs._pvExporting = true;
      inputs._pvStoreValue = _pvStoreValue;
      inputs._pvCurrentPrice = _pvCurrentPrice;

      // ✅ DELAY-CHARGE CHECK: If enough sun is coming later at cheaper prices,
      // "export now + charge from free PV later" beats "charge now" by €current/kWh.
      // Both paths charge for free (PV), but only the delay path earns grid export revenue too.
      let _canDelayCharge = false;
      if (_pvCurrentPrice !== null && _pvCurrentPrice > 0) {
        // ✅ CRITICAL: Don't delay during excellent arbitrage opportunities
        const _dynamicMax = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
        const _maxFuture = _pvMaxFuture ?? 0;
        const _spreadProfit = (_maxFuture * this.BATTERY_EFFICIENCY) - _pvCurrentPrice;
        const _excellentArbitrage = _spreadProfit >= 0.10; // €0.10/kWh spread is excellent
        
        if (_pvCurrentPrice <= _dynamicMax && _excellentArbitrage) {
          this.log(`PV OVERSCHOT: delay-charge SKIPPED — current price €${_pvCurrentPrice.toFixed(3)} is cheap + excellent spread €${_spreadProfit.toFixed(3)}/kWh → allow grid charging`);
        } else {
          // Calculate battery charge requirements first (needed for _cheaperLater check too)
          const _battChargePowerW = inputs.battery?.maxChargePowerW ||
                                    (inputs.battery?.totalCapacityKwh
                                      ? Math.max(1, Math.round(inputs.battery.totalCapacityKwh / 2.688)) * 800
                                      : 800);
          const _pvCapW = this.settings.pv_capacity_w || 3000;
          const _targetSoc = this.settings.max_soc ?? 95;
          const _estCapKwh = (_battChargePowerW / 800) * 2.688;
          const _toChargeKwh = ((_targetSoc - soc) / 100) * _estCapKwh;
          const _hoursNeeded = _toChargeKwh / (_battChargePowerW / 1000);

          // Check: are there significantly cheaper hours coming — AND enough of them to fill the battery?
          const _cheapLaterHours = _pvPricesArray.filter(p =>
            typeof p.index === 'number' &&
            p.index > 2 * _sph && p.index <= 12 * _sph &&
            typeof p.price === 'number' &&
            p.price < _pvCurrentPrice * 0.80  // At least 20% cheaper
          );
          const _cheaperLater = _cheapLaterHours.length > 0 && _cheapLaterHours.length >= Math.ceil(_hoursNeeded * _sph);

          if (_cheaperLater) {
            // Count remaining hours where radiation is high enough to actually charge the battery.
            // Minimum radiation threshold: W/m² needed so that PV output >= battery charge power.
            // At 1000 W/m² (STC) a pvCapW system produces full power; scale linearly.
            const _pvCanSupport = _pvCapW >= _battChargePowerW * 0.8;
            const _minRadiation = _pvCapW > 0 ? (_battChargePowerW / _pvCapW) * 1000 : 0;
            const _hourlyForecast = inputs.weather?.hourlyForecast;
            const _now = Date.now();

            let _effectiveSunHours = 0;
            if (Array.isArray(_hourlyForecast) && _hourlyForecast.length > 0 && _minRadiation > 0) {
              // Count future hours where radiation covers charge power
              for (const h of _hourlyForecast) {
                const hMs = h.time instanceof Date ? h.time.getTime() : new Date(h.time).getTime();
                if (hMs < _now) continue; // skip past hours
                if (typeof h.radiationWm2 === 'number' && h.radiationWm2 >= _minRadiation) {
                  _effectiveSunHours++;
                }
              }
            } else {
              // Fallback: use sunshineTodayRemaining when no hourly radiation data
              _effectiveSunHours = inputs.weather?.sunshineTodayRemaining ?? 0;
            }

            // Also accept sun score as last-resort fallback (no weather data at all)
            const _hasForecast = Array.isArray(_hourlyForecast) && _hourlyForecast.length > 0;
            const _sunScore = inputs.sun?.gfs ?? inputs.sun?.harmonie ?? 0;
            const _enoughSun = _effectiveSunHours >= _hoursNeeded || (!_hasForecast && _sunScore >= 50);

            if (_enoughSun && _pvCanSupport) {
              _canDelayCharge = true;
              const _sunSource = _hasForecast
                ? `${_effectiveSunHours}h radiation≥${Math.round(_minRadiation)}W/m²`
                : `score ${_sunScore}`;
              this.log(`PV OVERSCHOT: delay-charge possible — ${_sunSource} (need ${_hoursNeeded.toFixed(1)}h for ${_toChargeKwh.toFixed(1)}kWh @ ${_battChargePowerW}W), ${_cheapLaterHours.length} cheap slot(s) (${(_cheapLaterHours.length * 60 / _sph).toFixed(0)}min) coming → export now, charge later`);
            } else {
              // No adequate sun — fall back to grid price arbitrage over 24h window.
              // If there are enough significantly cheaper grid hours ahead, delay charging.
              const _cheap24h = _pvPricesArray.filter(p =>
                typeof p.index === 'number' &&
                p.index > 1 * _sph && p.index <= 24 * _sph &&
                typeof p.price === 'number' &&
                p.price < _pvCurrentPrice * 0.75  // At least 25% cheaper (grid arbitrage needs wider spread)
              );
              if (_cheap24h.length >= Math.ceil(_hoursNeeded * _sph)) {
                _canDelayCharge = true;
                this.log(`PV OVERSCHOT: delay-charge via grid arbitrage — no adequate sun (${_effectiveSunHours}h < ${_hoursNeeded.toFixed(1)}h needed), but ${_cheap24h.length} cheap grid hour(s) coming in 24h @ ≤€${Math.min(..._cheap24h.map(p => p.price)).toFixed(3)} → wait for cheap grid`);
              } else {
                this.log(`PV OVERSCHOT: delay-charge SKIPPED — ${_effectiveSunHours}h adequate sun (need ${_hoursNeeded.toFixed(1)}h) and no sufficient cheap grid hours → charge now`);
              }
            }
          }
        }
      }

      if (_canDelayCharge) {
        // Export now is optimal: earn €current export + charge for free from PV later.
        // This applies at ANY SoC — the battery firmware handles protection.
        // At low SoC there's nothing useful to discharge anyway, standby is best.
        inputs._pvStoreWins = false;
        inputs._delayCharge = true;
        scores.preserve += 200;
        scores.charge = 0;
        // Don't zero discharge — stored energy can still profitably discharge
        // during delay-charge. PV exports to grid, battery discharges to cover load.
        // HW mode zero_discharge_only handles both actions simultaneously.
        this.log(`PV OVERSCHOT: delay-charge wins → PV exports to grid at €${_pvCurrentPrice?.toFixed(3)}/kWh, charge battery later at cheaper hours (discharge still allowed)`);
      } else if (_pvCurrentPrice === null || _pvStoreValue === null || _pvStoreValue > _pvCurrentPrice) {
        // Storing beats exporting (or no price data, or can't delay) — charge from free PV
        inputs._pvStoreWins = true;
        scores.charge += 1000;
        scores.preserve = -500;
        this.log(`PV OVERSCHOT: storing beats exporting (max €${_pvMaxFuture?.toFixed(3)} × ${this.BATTERY_EFFICIENCY} = €${_pvStoreValue?.toFixed(3)} > current €${_pvCurrentPrice?.toFixed(3)}) → force charge`);
      } else {
        // Exporting now is more profitable — let all solar go to grid, price signals decide
        inputs._pvStoreWins = false;
        scores.preserve += 20;
        this.log(`PV OVERSCHOT: export now more profitable (€${_pvCurrentPrice.toFixed(3)} > max €${_pvMaxFuture.toFixed(3)} × ${this.BATTERY_EFFICIENCY} = €${_pvStoreValue.toFixed(3)}) → standby, PV to grid`);
      }
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

    this._applyBatteryScore(scores, inputs.battery, pvDetected, inputs);

    this._applyPolicyMode(scores, inputs.policyMode);

    if (inputs.batteryCost?.avgCost > 0) {
      const configuredEff = this.settings.battery_efficiency || 0.75;
      const learnedEff    = inputs.batteryEfficiency ?? configuredEff;
      const effectiveEff  = Math.min(configuredEff, learnedEff, 0.95);

      const breakEven = inputs.batteryCost.avgCost / effectiveEff;
      inputs.batteryCost.breakEven = breakEven;

      const price = inputs.tariff?.currentPrice ?? null;
      const maxChargePrice = this.settings.max_charge_price ?? 0.19;
      const minDischargePrice = this.settings.min_discharge_price ?? 0.25;
      const _arbitrageMinSoc = Math.max(this.settings.min_soc ?? 0, 5); // ✅ FIX: was 1, raised to 5 — consistent with BatteryScore floor

      if (price !== null) {
        if (price > breakEven + 0.01 && price >= minDischargePrice) {
          if (soc <= _arbitrageMinSoc) {
            this.log(`Arbitrage: price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} → discharge skipped (SoC ${soc}% at min_soc)`);
          } else if (inputs._pvExporting && inputs._pvStoreWins === true) {
            // PV OVERSCHOT already determined future store value > current price.
            // Discharging existing stored energy now also loses to holding for future peak.
            this.log(`Arbitrage: price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} BUT PV exporting & future store value €${inputs._pvStoreValue?.toFixed(3)} > current → discharge suppressed, hold for peak`);
            scores.preserve += 10;
          } else {
            // NOTE: delay-charge no longer blocks discharge — stored energy can be
            // profitably discharged while PV exports to grid independently.
            scores.discharge += 80;
            scores.preserve  -= 20;
            this.log(`Arbitrage: price €${price.toFixed(3)} > break-even €${breakEven.toFixed(3)} AND >= min_discharge €${minDischargePrice.toFixed(3)} → discharge +80${inputs._delayCharge ? ' (delay-charge: PV exports + battery discharges)' : ''}`);
          }
        } else if (price > breakEven + 0.01 && price < minDischargePrice) {
          scores.preserve += 10;
          this.log(`Arbitrage: price €${price.toFixed(3)} > break-even but below min_discharge €${minDischargePrice.toFixed(3)} → preserve`);
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

    // Peak Timing Guard: suppress discharge if better hours are coming
    this._applyPeakTimingGuard(scores, inputs);

    // Optimizer bias: 24-h DP lookahead hint (applied before delay-charge cleanup)
    this._applyOptimizerBias(scores, inputs);

    // Delay-charge: ensure charge stays zero — PV should export to grid, not charge battery.
    // Some downstream rules (DayAhead, Weather) may have re-added charge; clean up here.
    if (inputs._delayCharge) {
      scores.charge = 0;
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

  _applyBatteryScore(scores, battery, pvDetected, inputs = {}) {
  const soc = battery.stateOfCharge ?? 50;
  const maxSoc = this.settings.max_soc ?? 95;

  // NOTE: HomeWizard firmware handles battery protection (0-100% safe range)
  // No artificial limits needed here - use full range for optimal planning

  const zeroModeThreshold = this.settings.min_soc ?? 0;
  if (soc <= zeroModeThreshold) {
    // Prevent discharge — battery near-empty, firmware may be calibrating.
    // Do NOT zero preserve: if delay-charge determined exporting is more
    // profitable than storing, preserve/standby should still win.
    this.log(`BatteryScore: SoC ${soc}% <= ${zeroModeThreshold}% → ZERO MODE (no discharge)`);
    scores.discharge = 0;
    if (scores.charge <= 0 && scores.preserve <= 0) {
      // No price signal and no delay-charge: default to preserve
      scores.preserve += 20;
      this.log(`BatteryScore: ZERO MODE — no price signal, preserve +20`);
    }
    return;
  }

  if (soc >= maxSoc) {
    this.log('BatteryScore: max SoC reached → discharge');
    scores.discharge += 40;
    scores.charge     = 0;
    scores.preserve  += 10;
    return;
  }

  // ✅ FIX: PV trickle-charge hysteresis
  // If currently in zero_charge_only (actively charging from weak PV) and SoC is still
  // low, block discharge entirely. Switching to discharge now would immediately consume
  // the just-captured energy at a net RTE loss — pointless regardless of price.
  // Only allow discharge once enough has been stored (hysteresis: min_soc + 20%, min 20%).
  const currentHwMode = inputs.battery?.mode ?? null;
  const pvTrickleCharging = currentHwMode === 'zero_charge_only' && pvDetected;
  const pvTrickleHysteresis = Math.max(zeroModeThreshold + 20, 20);
  if (pvTrickleCharging && soc < pvTrickleHysteresis) {
    this.log(`BatteryScore: trickle-charging from PV (zero_charge_only), SoC ${soc}% < ${pvTrickleHysteresis}% → blocking discharge (RTE loss prevention)`);
    scores.discharge = 0;
    scores.charge += 30;
    return;
  }

  if (pvDetected) {
    if (inputs._delayCharge) {
      this.log('BatteryScore: PV detected + delay-charge → preserve (PV exports to grid)');
      scores.preserve += 10;
      return;
    }
    const currentPrice      = inputs.tariff?.currentPrice ?? null;
    const minDischargePrice = this.settings.min_discharge_price || 0.25;
    const atPeakPrice       = currentPrice !== null && currentPrice >= minDischargePrice;
    if (atPeakPrice) {
      this.log(`BatteryScore: PV detected (sticky) but price €${currentPrice.toFixed(3)} >= min_discharge €${minDischargePrice.toFixed(3)} → skip charge bonus (discharge favoured)`);
      scores.preserve += 5;
      return;
    }
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
  // balanced-dynamic overrides to opportunistic mode regardless of the setting —
  // designed for post-saldering (NL 2027+) where export price ≠ import price.
  const respectMinMax = inputs.policyMode === 'balanced-dynamic'
    ? false
    : this.settings.respect_minmax !== false;
  
  // ✅ Get configurable opportunistic parameters
  const oppChargeMultiplier = this.settings.opportunistic_charge_multiplier ?? 2.0;
  const oppDischargeFloor = this.settings.opportunistic_discharge_floor ?? 0.20;
  const oppDischargeSpreadThreshold = this.settings.opportunistic_discharge_spread_threshold ?? -0.05;

  const allPrices = tariff.effectivePrices || tariff.allPrices || tariff.next24Hours || [];
  const sph = Math.round(1 / (tariff.slotHours ?? 1)); // slots per hour
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
    p.index <= 8 * sph &&
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
  
  // ✅ SOLAR TIMING OPTIMIZATION: Prevent PV charging during expensive hours when more PV + cheaper prices coming
  // Scenario: Morning with sun + high price (€0.339), but more sun + lower prices coming later
  // Strategy: DON'T charge battery from PV now (boost discharge mode → standby/zero_discharge_only)
  // Benefit: Saves battery capacity for charging from PV during cheaper hours, PV exports to grid now
  //
  // ⚠️ GUARD: Skip at LOW SoC when PV is exporting — charging from free surplus beats discharging.
  //   At HIGH SoC (> 30%), allow the "discharge now + refill from future PV" arbitrage play,
  //   but only if the existing moreSunLater + capacity checks confirm PV can refill.
  // Also skip when SoC is near-empty — there is nothing meaningful to discharge.
  const _gridPowerST = inputs.p1?.resolved_gridPower ?? 0;
  const _pvExportingToGrid = _gridPowerST < -100;
  const _socNearEmpty = soc <= Math.max(this.settings.min_soc ?? 0, 5); // ✅ FIX: was 1, raised to 5
  // Below this SoC, free PV charge-in always wins over discharge-and-refill
  const _pvExportLowSocThreshold = 30;

  if (sunExpected.source === 'actual_pv' && price >= minDischargePrice * 0.85 && minDischargePrice > 0) {
    // PV is available RIGHT NOW during an expensive period

    if (soc <= _pvExportLowSocThreshold) {
      // At low SoC with PV active: standby is optimal — PV exports to grid at current price,
      // battery has nothing useful to discharge anyway. Charge later when prices drop.
      if (inputs._delayCharge) {
        this.log(`Tariff [SOLAR TIMING]: skipped — SoC ${soc}% <= ${_pvExportLowSocThreshold}%, delay-charge active → standby`);
        return;
      }
      this.log(`Tariff [SOLAR TIMING]: skipped — SoC ${soc}% <= ${_pvExportLowSocThreshold}%, PV charging from free solar`);
      // fall through to charge logic below
    } else if (_socNearEmpty) {
      this.log(`Tariff [SOLAR TIMING]: skipped — SoC ${soc}% near-empty, nothing to discharge`);
      // fall through to charge logic below
    } else {
    if (_pvExportingToGrid) {
      this.log(`Tariff [SOLAR TIMING]: SoC ${soc}% > ${_pvExportLowSocThreshold}% with PV exporting — evaluating discharge+solar-refill arbitrage`);
    }
    
    // Check if more sun is coming later (beyond current sun)
    const moreSunLater = sunExpected.totalHours >= 4 || 
                         (inputs.weather?.sunshineNext8Hours ?? 0) >= 2 ||
                         (inputs.weather?.sunshineTodayRemaining ?? 0) >= 3;
    
    // Check if cheaper prices are coming (where we could charge from solar instead)
    const cheaperPricesLater = allPrices.some(p =>
      typeof p.index === 'number' &&
      p.index > 2 * sph && // At least 2 hours from now
      p.index <= 12 * sph && // Within 12 hours
      typeof p.price === 'number' &&
      p.price < price * 0.75 // At least 25% cheaper
    );
    
    if (moreSunLater && cheaperPricesLater) {
      // ✅ CAPACITY CHECK: Verify PV system can charge battery in available time
      // Battery specs (1 unit = 2.688 kWh @ ~800W, 4 units = 10.752 kWh @ ~3200W)
      const batteryChargePowerW = inputs.battery?.maxChargePowerW ||
                                  (inputs.battery?.totalCapacityKwh
                                    ? Math.max(1, Math.round(inputs.battery.totalCapacityKwh / 2.688)) * 800
                                    : 800);
      const pvCapacityW = this.settings.pv_capacity_w || 3000; // User-configured PV peak capacity
      const currentSoc = soc;
      const targetSoc = this.settings.max_soc ?? 95;

      // Estimate battery capacity: 2.688 kWh per 800W unit (HW battery spec: 2688 Wh)
      const estimatedBatteryCapacityKwh = (batteryChargePowerW / 800) * 2.688;
      const capacityToChargeKwh = ((targetSoc - currentSoc) / 100) * estimatedBatteryCapacityKwh;
      
      // Time needed to charge (hours) at full battery charge power
      const hoursNeededToCharge = capacityToChargeKwh / (batteryChargePowerW / 1000);
      
      // Check if PV capacity is sufficient for battery charge power
      const pvCanSupport = pvCapacityW >= batteryChargePowerW * 0.8; // 80% threshold for real-world conditions
      
      // Check if enough sun hours remain
      const enoughSunTime = sunExpected.totalHours >= hoursNeededToCharge;
      
      if (pvCanSupport && enoughSunTime) {
        // OPTIMAL: Boost discharge mode to prevent charging from PV
        // Maps to: standby (no charge/discharge) or zero_discharge_only (discharge to house only)
        // Result: PV covers house + exports to grid, battery doesn't charge (saves capacity for later)
        const opportunityValue = price - (Math.min(...allPrices.filter(p => p.index > 2 * sph && p.index <= 12 * sph).map(p => p.price)) || price * 0.75);
        scores.discharge += 120;
        scores.charge = 0;
        scores.preserve = 0;
        this.log(`Tariff [SOLAR TIMING]: 🌞💰 PV NOW at expensive €${price.toFixed(3)} + more sun later (${sunExpected.totalHours}h) + cheaper prices coming → DISCHARGE +120`);
        this.log(`  Capacity check: battery ${estimatedBatteryCapacityKwh.toFixed(1)}kWh @ ${batteryChargePowerW}W, PV ${pvCapacityW}W, need ${hoursNeededToCharge.toFixed(1)}h to charge ${capacityToChargeKwh.toFixed(1)}kWh (${currentSoc}%→${targetSoc}%)`);
        this.log(`  Opportunity: €${opportunityValue.toFixed(3)}/kWh - PV exports to grid now, battery charges later at cheaper prices`);
        return;
      } else {
        const reason = !pvCanSupport 
          ? `PV capacity ${pvCapacityW}W < battery ${batteryChargePowerW}W needed` 
          : `sun hours ${sunExpected.totalHours}h < ${hoursNeededToCharge.toFixed(1)}h needed`;
        this.log(`Tariff [SOLAR TIMING]: ⚠️ Would delay charging but ${reason} - allowing normal PV charging`);
        // Fall through to normal logic
      }
    }
    } // end else (not exporting to grid, not near-empty)
  }
  
  if (respectMinMax) {
    // STRICT MODE: Only discharge when price >= minDischargePrice
    if (price >= minDischargePrice && minDischargePrice > 0) {
      // ✅ NEW: At extreme price peaks, ALWAYS discharge regardless of PV export strategy
      const isPricePeak = maxFuturePrice ? price >= maxFuturePrice * 0.90 : false;
      
      if (!isPricePeak && inputs._pvExporting && inputs._pvStoreWins === true) {
        this.log(`Tariff [STRICT]: discharge skipped — PV exporting & future store value €${inputs._pvStoreValue?.toFixed(3)} > current €${price.toFixed(3)} → hold for peak`);
        // fall through to charge logic
      } else {
        const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
        const coverageRatio = this.maxDischarge > 0 ? coverableLoad / this.maxDischarge : 0;
        const priceRatio    = maxFuturePrice ? price / maxFuturePrice : 1;

        const baseScore = Math.round(100 * priceRatio * Math.max(0.5, coverageRatio));

        scores.discharge += baseScore;
        scores.preserve   = 0;

        this.log(`Tariff [STRICT]: discharge hour €${price.toFixed(3)} >= min €${minDischargePrice.toFixed(3)} → discharge +${baseScore}${isPricePeak ? ' (🔴 PRICE PEAK)' : ''}${inputs._delayCharge ? ' (delay-charge: PV exports + battery discharges)' : ''}`);
        return;
      }
    }
  } else {
    // DYNAMIC MODE: Discharge when profitable, even if below threshold
    if (price >= minDischargePrice && minDischargePrice > 0) {
      // NOTE: delay-charge no longer blocks discharge (see STRICT comment above)
      if (inputs._pvExporting && inputs._pvStoreWins === true) {
        // fall through to charge logic
      } else {
        const coverableLoad = Math.min(this.currentLoad, this.maxDischarge);
        const coverageRatio = this.maxDischarge > 0 ? coverableLoad / this.maxDischarge : 0;
        const priceRatio    = maxFuturePrice ? price / maxFuturePrice : 1;

        const baseScore = Math.round(100 * priceRatio * Math.max(0.5, coverageRatio));

        scores.discharge += baseScore;
        scores.preserve   = 0;

        this.log(`Tariff [DYNAMIC]: discharge hour €${price.toFixed(3)} >= min €${minDischargePrice.toFixed(3)} → discharge +${baseScore}${inputs._delayCharge ? ' (delay-charge: PV exports + battery discharges)' : ''}`);
        return;
      }
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

      // ✅ ENHANCED: Check solar arbitrage opportunity
      if (sunExpected.goodSunComing && sunExpected.hours <= 6 && sunExpected.totalHours >= 3) {
        // Require reliable sun signal: active PV export, near-term forecast (sun4h), or model confidence.
        // sunshineTodayRemaining alone is too vague (includes theoretical sun on overcast/rainy days).
        const sunSignalReliable = sunExpected.source === 'actual_pv' ||
          (sunExpected.details?.sun4h ?? 0) > 0 ||
          (sunExpected.details?.gfs ?? 0) >= 25 ||
          (sunExpected.details?.harmonie ?? 0) >= 25;

        if (!sunSignalReliable) {
          this.log(`Tariff [STRICT]: sun signal not reliable (sun4h=0, gfs=${sunExpected.details?.gfs}, harmonie=${sunExpected.details?.harmonie}) → skip solar arbitrage`);
          // fall through to normal charge logic below
        } else {
        // Calculate solar arbitrage: free solar → discharge at peak (no charge RTE loss)
        const DISCHARGE_EFFICIENCY = 0.87; // One-way discharge efficiency (not round-trip)
        const solarArbitrageProfit = maxFuturePrice ? maxFuturePrice * DISCHARGE_EFFICIENCY : 0;
        
        // Calculate grid arbitrage: buy now → discharge at peak (with full RTE loss)
        const gridArbitrageProfit = spreadProfit;
        
        if (solarArbitrageProfit > gridArbitrageProfit + 0.05) {
          // Solar arbitrage significantly more profitable → preserve capacity
          scores.preserve += 90;
          scores.charge = 0;
          this.log(`Tariff [STRICT]: 🌞 solar arbitrage €${solarArbitrageProfit.toFixed(3)}/kWh > grid €${gridArbitrageProfit.toFixed(3)}/kWh → PRESERVE for PV in ${sunExpected.hours}h (${sunExpected.totalHours}h total)`);
          return;
        } else {
          // Grid arbitrage still better, but acknowledge sun coming
          scores.preserve += 20;
          scores.charge -= 10;
          this.log(`Tariff [STRICT]: cheap €${price.toFixed(3)} but PV in ${sunExpected.hours}h (solar: €${solarArbitrageProfit.toFixed(3)} vs grid: €${gridArbitrageProfit.toFixed(3)}) → mild preserve`);
          return;
        }
        }
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

      // ✅ ENHANCED: Check solar arbitrage opportunity
      if (sunExpected.goodSunComing && sunExpected.hours <= 6 && sunExpected.totalHours >= 3) {
        // Require reliable sun signal: active PV export, near-term forecast (sun4h), or model confidence.
        // sunshineTodayRemaining alone is too vague (includes theoretical sun on overcast/rainy days).
        const sunSignalReliable = sunExpected.source === 'actual_pv' ||
          (sunExpected.details?.sun4h ?? 0) > 0 ||
          (sunExpected.details?.gfs ?? 0) >= 25 ||
          (sunExpected.details?.harmonie ?? 0) >= 25;

        if (!sunSignalReliable) {
          this.log(`Tariff [DYNAMIC]: sun signal not reliable (sun4h=0, gfs=${sunExpected.details?.gfs}, harmonie=${sunExpected.details?.harmonie}) → skip solar arbitrage`);
          // fall through to normal charge logic below
        } else {
        // Calculate solar arbitrage: free solar → discharge at peak (no charge RTE loss)
        const DISCHARGE_EFFICIENCY = 0.87; // One-way discharge efficiency (not round-trip)
        const solarArbitrageProfit = maxFuturePrice ? maxFuturePrice * DISCHARGE_EFFICIENCY : 0;
        
        // Calculate grid arbitrage: buy now → discharge at peak (with full RTE loss)
        const gridArbitrageProfit = spreadProfit;
        
        if (solarArbitrageProfit > gridArbitrageProfit + 0.05) {
          // Solar arbitrage significantly more profitable → preserve capacity
          scores.preserve += 90;
          scores.charge = 0;
          this.log(`Tariff [DYNAMIC]: 🌞 solar arbitrage €${solarArbitrageProfit.toFixed(3)}/kWh > grid €${gridArbitrageProfit.toFixed(3)}/kWh → PRESERVE for PV in ${sunExpected.hours}h (${sunExpected.totalHours}h total)`);
          return;
        } else {
          // Grid arbitrage still better, but acknowledge sun coming
          scores.preserve += 20;
          scores.charge -= 10;
          this.log(`Tariff [DYNAMIC]: PV in ${sunExpected.hours}h (solar: €${solarArbitrageProfit.toFixed(3)} vs grid: €${gridArbitrageProfit.toFixed(3)}) → mild preserve`);
          return;
        }
        }
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
  const _daEffective = tariff?.effectivePrices || tariff?.next24Hours;
  if (!tariff || !Array.isArray(_daEffective)) return;

  const soc          = battery?.stateOfCharge ?? 50;
  const maxSoc       = this.settings.max_soc ?? 95;
  const currentHour  = time?.getHours() ?? 0;
  const currentPrice = tariff.currentPrice ?? 0;
  const dynamicMax   = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
  const sph          = Math.round(1 / (tariff.slotHours ?? 1)); // slots per hour
  const next24       = _daEffective;

  const zeroModeThresholdDA = Math.max(this.settings.min_soc ?? 0, 5); // ✅ FIX: was 1, raised to 5
  if (soc <= zeroModeThresholdDA) {
    this.log(`DayAhead: SoC ${soc}% <= ${zeroModeThresholdDA}% → skipping day-ahead logic (ZERO MODE)`);
    return;
  }

  let nextExpensiveHour = null;
  let hoursUntilExpensive = null;

  for (let i = 1; i < next24.length; i++) {
    const hourData  = next24[i];
    const breakeven = currentPrice * this.BATTERY_EFFICIENCY;

    if (hourData.price >= breakeven + this.MIN_PROFIT_MARGIN) {
      nextExpensiveHour   = hourData;
      hoursUntilExpensive = i / sph; // convert slot index to hours
      break;
    }
  }

  const sunExpected = this._getSunExpectation(inputs.weather, inputs.sun, inputs.p1);

  const minDischargePrice = this.settings.min_discharge_price || 0.25;
  const alreadyAtPeakPrice = currentPrice >= minDischargePrice;

  if (nextExpensiveHour && hoursUntilExpensive !== null) {

    if (hoursUntilExpensive <= 4 && soc < 80) {
      if (alreadyAtPeakPrice) {
        // We're already in a discharge hour — don't charge for a future expensive hour
        this.log(`DayAhead: expensive in ${hoursUntilExpensive}h but current €${currentPrice.toFixed(3)} >= min_discharge €${minDischargePrice.toFixed(3)} → skip charge (discharge NOW)`);
      } else if (sunExpected.goodSunComing && sunExpected.hours < hoursUntilExpensive) {
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
      if (alreadyAtPeakPrice) {
        // Already discharging this hour — skip charge boost
        this.log(`DayAhead: low SoC but current €${currentPrice.toFixed(3)} >= min_discharge → skip charge (discharge NOW)`);
      } else if (!sunExpected.goodSunComing || sunExpected.hours >= hoursUntilExpensive) {
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
      p.index <= 8 * sph &&
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

  // When delay-charge is active, PV should export to grid — don't add charge bonuses.
  // Still detect PV (return true) and maintain sticky flag for other logic.
  const delayChargeActive = inputs._delayCharge === true;

  if (this._pvStickyUntil > now) {
    if (delayChargeActive) {
      this.log(`PV Reality: sticky PV active + delay-charge → standby (PV exports to grid)`);
    } else {
      this.log(`PV Reality: sticky PV active → charge allowed`);
      scores.charge += 50;
    }
    return true;
  }

  // ONLY set sticky PV if we have actual PV export or grid is strongly exporting.
  // Don't use high batteryPower alone — it could be grid-charging in to_full mode!
  // A real PV signal requires either gridPower < 0 (net export) or high pvEstimate.
  if (batteryPower > 50 && gridPower < -50) {
    this._pvStickyUntil = now + 5 * 60 * 1000;
    if (delayChargeActive) {
      this.log(`💡 PV detected via batteryPower (${batteryPower}W) + export (${Math.abs(gridPower)}W) → sticky 5 min (delay-charge: no charge bonus)`);
    } else {
      this.log(`💡 PV detected via batteryPower (${batteryPower}W) + export (${Math.abs(gridPower)}W) → sticky 5 min`);
      scores.charge += 100;
    }
    return true;
  }

  if (pvEstimate >= 100) {
    this._pvStickyUntil = now + 5 * 60 * 1000;
    if (delayChargeActive) {
      this.log(`💡 PV detected via pvEstimate (${pvEstimate}W) → sticky 5 min (delay-charge: no charge bonus)`);
    } else {
      this.log(`💡 PV detected via pvEstimate (${pvEstimate}W) → sticky 5 min`);
      scores.charge += 80;
    }
    return true;
  }

  if (gridPower < -100) {
    const pvSurplus = Math.abs(gridPower);
    this._pvStickyUntil = now + 5 * 60 * 1000;
    if (delayChargeActive) {
      this.log(`💡 PV detected via export (${pvSurplus}W) → sticky 5 min (delay-charge: no charge bonus)`);
    } else {
      this.log(`💡 PV detected via export (${pvSurplus}W) → sticky 5 min`);
      scores.charge += 60;
    }
    return true;
  }

  if (batteryMode === 'zero_charge_only') {
    const _cetHour = parseInt(new Date().toLocaleString('en-GB', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
    }), 10);
    const _isDaylight = _cetHour >= 7 && _cetHour < 20;
    if (_isDaylight) {
      this._pvStickyUntil = now + 2 * 60 * 1000;
      this.log(`PV Reality: zero_charge_only mode (daylight) → PV assumed`);
      scores.charge += 40;
      return true;
    }
    this.log(`PV Reality: zero_charge_only mode but nighttime (${_cetHour}h CET) → not assuming PV`);
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
    const coverageRatio = trueLoad > 0 ? Math.min(maxDischarge / trueLoad, 1.0) : 0;
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
    this.log(`[MAPPING] SoC ${soc}% < min_soc ${minSoc}% → forcing standby`);
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
    if (soc <= minSoc) return 'zero_charge_only';
    if (soc >= maxSoc) return 'zero_discharge_only';
    return 'zero';
  }

  if (ctx.policyMode === 'balanced' && tariffType === 'dynamic') {

    // Delay-charge: PV exports to grid for revenue.
    // If discharge wins scoring, use zero_discharge_only: battery discharges to cover
    // house load while PV independently exports surplus to grid. Both actions are profitable.
    // Otherwise standby: PV exports, battery idle.
    if (ctx._delayCharge) {
      if (policyMode === 'discharge') {
        const hwMode = profitableToDischarge ? 'zero_discharge_only' : 'standby';
        this.log(`[MAPPING] delay-charge + discharge → ${hwMode} (PV exports to grid, battery covers house load)`);
        return hwMode;
      }
      this.log(`[MAPPING] delay-charge active → standby (PV exports to grid)`);
      return 'standby';
    }

    if (policyMode === 'discharge') {
      return profitableToDischarge ? 'zero_discharge_only' : 'standby';
    }

    if (policyMode === 'charge') {

      // When PV is producing strongly (≥400W), prefer zero_charge_only: harvest solar
      // surplus without pulling from the grid. Grid charging (to_full) adds unnecessary
      // import cost and slightly lower RTE when sun can do the job.
      // Only fall back to to_full when PV is weak or absent and the grid price is cheap.
      if (actualPvNow && pvEstimate >= 400) {
        this.log(`[MAPPING][CHARGE] PV strong (${pvEstimate}W) → zero_charge_only (harvest solar, skip grid import)`);
        return 'zero_charge_only';
      }

      // Weak/no PV: use price-based decision
      if (price !== null && price <= maxChargePrice) {
        this.log(`[MAPPING][CHARGE] PV weak/absent (${pvEstimate}W), price €${price.toFixed(3)} <= max_charge_price €${maxChargePrice} → to_full`);
        return 'to_full';
      }

      // Price above ceiling — capture any PV if available, else standby
      if (actualPvNow) {
        this.log(`[MAPPING][CHARGE] price €${price?.toFixed(3)} > max_charge_price, PV active (${pvEstimate}W) → zero_charge_only`);
        return 'zero_charge_only';
      }

      this.log(`[MAPPING][CHARGE] price €${price?.toFixed(3)} > max_charge_price €${maxChargePrice}, no PV → standby`);
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

  /**
   * Peak Timing Guard: ensure discharge happens during the most profitable hours.
   * With limited battery capacity (e.g. 2.7kWh @ 800W ≈ 3.4h), discharge should
   * target the top-N most expensive remaining hours, not just any hour above min_discharge.
   */
  _applyPeakTimingGuard(scores, inputs) {
    // Only relevant when discharge is winning
    if (scores.discharge <= 0) return;

    const price = inputs.tariff?.currentPrice;
    if (price == null) return;

    const allPrices = inputs.tariff?.effectivePrices || inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
    const now = new Date();

    // Get prices for the remaining hours (next 12h window — practical discharge horizon)
    const remainingPrices = allPrices
      .filter(p => {
        if (p.timestamp) {
          const t = new Date(p.timestamp);
          return t >= now && t <= new Date(now.getTime() + 12 * 3600_000);
        }
        return typeof p.index === 'number' && p.index >= 0 && p.index <= 12;
      })
      .map(p => p.price)
      .filter(p => typeof p === 'number' && p > 0);

    if (remainingPrices.length < 3) return; // Not enough data to judge

    // Calculate battery discharge duration in hours
    const maxDischargeW = this.maxDischarge || 800;
    const capacityKwh = (maxDischargeW / 800) * 2.688;
    const dischargeHours = Math.ceil(capacityKwh / (maxDischargeW / 1000)); // e.g. 2.688/0.8 = 3.36 → 4

    // Find top N most expensive prices in remaining window
    const sortedDesc = [...remainingPrices].sort((a, b) => b - a);
    const topN = sortedDesc.slice(0, Math.min(dischargeHours, sortedDesc.length));
    const peakThreshold = topN[topN.length - 1]; // Lowest price in the top-N
    const bestPrice = sortedDesc[0];

    // Only discharge now if price >= bestPrice × RTE
    // This means: "don't discharge at €0.258 when you could earn €0.405 later"
    // With 75% efficiency: threshold = €0.405 × 0.75 = €0.304
    const rteThreshold = bestPrice * this.BATTERY_EFFICIENCY;

    if (price < rteThreshold) {
      const savings = bestPrice - price;
      scores.discharge = Math.max(0, scores.discharge - 120);
      scores.preserve += 80;
      this.log(`PeakTiming: €${price.toFixed(3)} < best €${bestPrice.toFixed(3)} × ${this.BATTERY_EFFICIENCY} = €${rteThreshold.toFixed(3)} → suppress discharge, save €${savings.toFixed(3)}/kWh`);
    } else {
      this.log(`PeakTiming: €${price.toFixed(3)} >= RTE threshold €${rteThreshold.toFixed(3)} (best €${bestPrice.toFixed(3)} × ${this.BATTERY_EFFICIENCY}) → discharge OK`);
    }
  }

  /**
   * Apply a 60-point bias toward the action recommended by the OptimizationEngine.
   * The bias is strong enough to guide but does NOT override real-time rules
   * (PV surplus scores ≥300, delay-charge zeroes out charge after this call, etc.).
   */
  _applyOptimizerBias(scores, inputs) {
    const optimizer = inputs.optimizer;
    if (!optimizer) return;

    const action = optimizer.getSlot(new Date());
    if (!action) return;

    const BIAS = 60;
    const soc = inputs.battery?.stateOfCharge ?? 50;
    const zeroModeThreshold = this.settings.min_soc ?? 0;

    if (action === 'charge') {
      scores.charge += BIAS;
      this.log(`Optimizer: 24h-DP suggests charge → charge +${BIAS}`);
    } else if (action === 'discharge') {
      if (soc <= zeroModeThreshold) {
        this.log(`Optimizer: 24h-DP suggests discharge but SoC ${soc}% <= ${zeroModeThreshold}% (ZERO MODE) → skipped`);
        return;
      }
      scores.discharge += BIAS;
      this.log(`Optimizer: 24h-DP suggests discharge → discharge +${BIAS}`);
    } else {
      scores.preserve += BIAS;
      this.log(`Optimizer: 24h-DP suggests preserve → preserve +${BIAS}`);
    }
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