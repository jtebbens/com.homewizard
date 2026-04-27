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
    const minDischarge = this.settings.min_discharge_price || 0.22;
    const maxByDischarge = (minDischarge * this.BATTERY_EFFICIENCY) - this.MIN_PROFIT_MARGIN;

    // Effective = opportunistic up to the discharge break-even, but never below staticMax
    const effectiveMax = Math.max(staticMax, Math.min(dynamicThreshold, maxByDischarge));

    this.log(`DynamicChargePrice: maxFuturePrice=€${maxFuturePrice.toFixed(3)}, dynamic=€${dynamicThreshold.toFixed(3)}, static=€${staticMax.toFixed(3)}, maxByDischarge=€${maxByDischarge.toFixed(3)}, effective=€${effectiveMax.toFixed(3)}`);

    return effectiveMax;
  }

  calculatePolicy(inputs) {
    this.log('--- POLICY RUN START ---');
    if (debug) this.log('Inputs:', JSON.stringify(inputs, null, 2));

    // ── Common setup ─────────────────────────────────────────────────────���───
    this.maxDischarge = inputs.battery?.maxDischargePowerW || 800;
    const grid        = inputs.p1?.resolved_gridPower ?? 0;
    const batt        = inputs.p1?.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    this.currentLoad  = Math.max(0, grid + dischargeNow);
    const batteryCanCover = this.currentLoad <= this.maxDischarge;
    const coverageRatio   = this.currentLoad > 0 ? Math.min(this.maxDischarge / this.currentLoad, 1.0) : 0;
    this.log(`Battery limits: max=${this.maxDischarge}W, load=${this.currentLoad}W, canCover=${batteryCanCover}, coverage=${Math.round(coverageRatio * 100)}%`);
    inputs.batteryLimits = { maxDischarge: this.maxDischarge, currentLoad: this.currentLoad, canCoverLoad: batteryCanCover, coverageRatio };

    const soc    = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;
    const minSoc = this.settings.min_soc ?? 0;

    // Cost model reset at min SoC
    if (inputs.batteryCost) {
      if (soc <= Math.max(minSoc, 1)) {
        if (inputs.batteryCost.avgCost !== 0 || inputs.batteryCost.energyKwh !== 0) {
          this.log(`[COST][RESET] SoC ${soc}% <= min_soc ${minSoc}% → battery empty, resetting cost model`);
        }
        inputs.batteryCost.avgCost   = 0;
        inputs.batteryCost.energyKwh = 0;
        inputs.batteryCost.breakEven = 0;
      }
    }

    // Pre-compute effectiveMinDischarge
    {
      const _respectMinMax = inputs.policyMode === 'balanced-dynamic'
        ? false
        : (this.settings.respect_minmax !== false);
      inputs.respectMinMax = _respectMinMax;
      if (_respectMinMax) {
        inputs.effectiveMinDischarge = this.settings.min_discharge_price || 0.22;
      } else {
        const _configuredEff = this.settings.battery_efficiency || 0.75;
        const _learnedEff    = inputs.batteryEfficiency ?? _configuredEff;
        const _effectiveEff  = Math.min(_configuredEff, _learnedEff, 0.95);
        const _cycleCost     = this.settings.cycle_cost_per_kwh ?? 0.075;
        const _settingsFloor = _cycleCost / _configuredEff;
        if (inputs.batteryCost?.avgCost > 0 && !inputs.batteryCost.breakEven) {
          inputs.batteryCost.breakEven = inputs.batteryCost.avgCost / _effectiveEff + _cycleCost * 0.5;
        }
        inputs.effectiveMinDischarge = (inputs.batteryCost?.breakEven > 0)
          ? inputs.batteryCost.breakEven
          : _settingsFloor;
      }
    }

    inputs.dynamicMaxChargePrice = this._getDynamicChargePrice(inputs.tariff, inputs.tariff?.currentPrice);

    // ── PV flags: _delayCharge, _pvStoreWins, _pvExporting (mapper inputs) ──
    this._computePvFlags(inputs);

    // ── Fixed tariff: rule-based scoring (unchanged) ─────────────────────────
    if (this.settings.tariff_type === 'fixed') {
      const scores = { charge: 0, discharge: 0, preserve: 0 };
      this._applySmartLowSocRule(scores, inputs);
      this._applyPeakShavingRules(scores, inputs);
      this._applyWeatherForecast(scores, inputs.weather, inputs.tariff, inputs.battery, inputs);
      const pvDetected = this._applyPVReality(scores, inputs.p1, inputs.battery?.mode, inputs);
      this._applyBatteryScore(scores, inputs.battery, pvDetected, inputs);
      this._applyPolicyMode(scores, inputs.policyMode);
      if (inputs._delayCharge) scores.charge = 0;
      scores.charge    = Math.max(0, scores.charge);
      scores.discharge = Math.max(0, scores.discharge);
      scores.preserve  = Math.max(0, scores.preserve);
      const recommendation = this._selectMode(scores, inputs);
      this.log('Final scores:', scores);
      this.log('Recommendation:', recommendation);
      this.log('--- POLICY RUN END ---');
      return this._buildLegacyResult(recommendation, scores, inputs);
    }

    // ── Dynamic tariff: DP-primary ────────────────────────────────────────────
    // Update PV sticky timer (used by mapper for standby/zero_charge_only decisions)
    this._refreshPvSticky(inputs);

    // Break-even (final computation)
    if (inputs.batteryCost?.avgCost > 0) {
      const configuredEff = this.settings.battery_efficiency || 0.75;
      const learnedEff    = inputs.batteryEfficiency ?? configuredEff;
      const effectiveEff  = Math.min(configuredEff, learnedEff, 0.95);
      const cycleCost     = this.settings.cycle_cost_per_kwh ?? 0.075;
      const breakEven     = inputs.batteryCost.avgCost / effectiveEff + cycleCost * 0.5;
      inputs.batteryCost.breakEven = breakEven;
      inputs.effectiveMinDischarge = inputs.respectMinMax
        ? (this.settings.min_discharge_price || 0.22)
        : breakEven;
    }

    // ── 1. DP decision ────────────────────────────────────────────────────────
    const dpAction = inputs.optimizer?.getSlot(new Date()) ?? null;

    if (!dpAction) {
      this.log('Optimizer: no schedule available → fallback preserve');
      const hwMode = this._mapPolicyToHwMode('preserve', inputs);
      this.log('--- POLICY RUN END ---');
      return this._buildDpResult('preserve', hwMode, 40, 'no_optimizer', inputs, null);
    }

    this.log(`Optimizer: 24h-DP → ${dpAction}`);

    // ── 2. Exceptions ─────────────────────────────────────────────────────────
    let finalAction = dpAction;
    let exception   = null;

    // Standby: DP chose PV export over battery storage — no exceptions apply.
    if (finalAction === 'standby') {
      const hwMode = this._mapPolicyToHwMode('standby', inputs);
      this.log('--- POLICY RUN END ---');
      return this._buildDpResult('standby', hwMode, 90, null, inputs, dpAction);
    }

    if (finalAction === 'discharge') {
      if (soc <= minSoc) {
        this.log(`Exception: discharge blocked — SoC ${soc}% <= min_soc ${minSoc}%`);
        finalAction = 'preserve';
        exception   = 'soc_too_low';
      }
    }

    if (finalAction === 'charge') {
      if (soc >= maxSoc) {
        this.log(`Exception: charge blocked — SoC ${soc}% >= max_soc ${maxSoc}%`);
        finalAction = 'preserve';
        exception   = 'soc_full';
      } else if (inputs._delayCharge) {
        this.log(`Exception: charge blocked — delay-charge active, PV exports to grid`);
        finalAction = 'preserve';
        exception   = 'delay_charge';
      }
    }

    // ── Exception: real-time peak shaving ────────────────────────────────────
    // If DP says preserve but grid import exceeds threshold → discharge to cover peak.
    // Only applies when DP says preserve (not charge — charging is intentional).
    if (finalAction === 'preserve' && !exception) {
      const peakThreshold = this.settings.peak_shaving_threshold ?? 0;
      if (peakThreshold > 0 && this.currentLoad > peakThreshold && soc > minSoc) {
        this.log(`Exception: peak shaving — load ${Math.round(this.currentLoad)}W > threshold ${peakThreshold}W → discharge`);
        finalAction = 'discharge';
        exception   = 'peak_shaving';
      }
    }

    // ── 3. Map to HW mode ─────────────────────────────────────────────────────
    const hwMode = this._mapPolicyToHwMode(finalAction, inputs);

    // ── 4. Confidence ─────────────────────────────────────────────────────────
    let confidence = exception ? 75 : 90;
    if (inputs.policyMode === 'eco')        confidence = Math.max(40, confidence - 5);
    if (inputs.policyMode === 'aggressive') confidence = Math.min(99, confidence + 5);

    // ── 5. Result ─────────────────────────────────────────────────────────────
    this.log('--- POLICY RUN END ---');
    return this._buildDpResult(finalAction, hwMode, confidence, exception, inputs, dpAction);
  }

  // ── PV flags: extracted from PV OVERSCHOT block, no score side-effects ─────
  // Sets inputs._delayCharge, _pvStoreWins, _pvExporting, _pvStoreValue, _pvCurrentPrice.
  _computePvFlags(inputs) {
    const soc    = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;
    const grid   = inputs.p1?.resolved_gridPower ?? 0;
    const batt   = inputs.p1?.battery_power ?? 0;

    const _cetHour = parseInt(new Date().toLocaleString('en-US', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
    }), 10);
    const _isDaylight       = _cetHour >= 7 && _cetHour < 20;
    const _pvSurplusDetected = grid < -200 || batt > 100 || (inputs.p1?.pv_power_estimated ?? 0) >= 200;

    if (!(_pvSurplusDetected && soc < maxSoc && _isDaylight)) return;

    const _pvCurrentPrice = inputs.tariff?.currentPrice ?? null;
    const _pvPricesArray  = inputs.tariff?.effectivePrices || inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
    const _sph            = Math.round(1 / (inputs.tariff?.slotHours ?? 1));
    const _pvNow          = new Date();
    const _pvFutureAll = _pvPricesArray
      .filter(h => h.timestamp ? new Date(h.timestamp) > _pvNow : (h.index ?? 0) >= 1)
      .map(h => h.price).filter(p => typeof p === 'number');
    const _pvFuturePrices = _pvFutureAll.filter(p => p > 0);
    const _pvMinFuture  = _pvFutureAll.length ? Math.min(..._pvFutureAll) : null;
    const _pvMaxFuture  = _pvFuturePrices.length ? Math.max(..._pvFuturePrices) : null;
    const _pvStoreValue = _pvMaxFuture !== null ? _pvMaxFuture * this.BATTERY_EFFICIENCY : null;

    inputs._pvExporting    = true;
    inputs._pvStoreValue   = _pvStoreValue;
    inputs._pvCurrentPrice = _pvCurrentPrice;

    // When strongly negative prices are coming, the DP has already planned discharge
    // to create room. Suppress pvStoreWins/delayCharge so we don't override that plan.
    if (_pvMinFuture !== null && _pvMinFuture < -0.10) {
      this.log(`PV OVERSCHOT: negatieve prijs €${_pvMinFuture.toFixed(3)} komend → DP beslist, pvStoreWins/delayCharge onderdrukt`);
      return;
    }

    // Delay-charge check
    const _targetSocForDelay = this.settings.max_soc ?? 95;
    const _battCapForDelay   = (inputs.battery?.maxChargePowerW
      ? Math.max(1, Math.round(inputs.battery.maxChargePowerW / 800)) * 2.688
      : 2.688);
    const _toChargeKwhCheck  = ((_targetSocForDelay - soc) / 100) * _battCapForDelay;

    let _canDelayCharge = false;
    if (_toChargeKwhCheck <= 0) {
      this.log(`PV OVERSCHOT: delay-charge skipped — battery already full (SoC ${soc}% >= target ${_targetSocForDelay}%)`);
    } else if (_pvCurrentPrice !== null && _pvCurrentPrice > 0) {
      const _dynamicMax        = inputs.dynamicMaxChargePrice ?? this.settings.max_charge_price ?? 0.15;
      const _maxFuture         = _pvMaxFuture ?? 0;
      const _spreadProfit      = (_maxFuture * this.BATTERY_EFFICIENCY) - _pvCurrentPrice;
      const _excellentArbitrage = _spreadProfit >= 0.10;
      const _minDelayPrice     = _dynamicMax + 0.08;

      if (_pvCurrentPrice <= _dynamicMax && _excellentArbitrage) {
        this.log(`PV OVERSCHOT: delay-charge SKIPPED — current price €${_pvCurrentPrice.toFixed(3)} is cheap + excellent spread €${_spreadProfit.toFixed(3)}/kWh → allow grid charging`);
      } else if (_pvCurrentPrice < _minDelayPrice) {
        this.log(`PV OVERSCHOT: delay-charge SKIPPED — current price €${_pvCurrentPrice.toFixed(3)} < min €${_minDelayPrice.toFixed(3)} (maxCharge €${_dynamicMax.toFixed(3)} + €0.08) → benefit too small, charge now`);
      } else {
        const _battChargePowerW = inputs.battery?.maxChargePowerW ||
          (inputs.battery?.totalCapacityKwh
            ? Math.max(1, Math.round(inputs.battery.totalCapacityKwh / 2.688)) * 800
            : 800);
        const _pvCapW       = this.settings.pv_capacity_w || 3000;
        const _targetSoc    = this.settings.max_soc ?? 95;
        const _estCapKwh    = (_battChargePowerW / 800) * 2.688;
        const _toChargeKwh  = ((_targetSoc - soc) / 100) * _estCapKwh;
        const _hoursNeeded  = _toChargeKwh / (_battChargePowerW / 1000);

        const _cheapLaterHours = _pvPricesArray.filter(p =>
          typeof p.index === 'number' && p.index > 2 * _sph && p.index <= 24 * _sph &&
          typeof p.price === 'number' && p.price < _pvCurrentPrice * 0.70
        );
        const _cheaperLater = _cheapLaterHours.length > 0 && _cheapLaterHours.length >= Math.ceil(_hoursNeeded * _sph);

        if (_cheaperLater) {
          const _pvCanSupport    = _pvCapW >= _battChargePowerW * 0.8;
          const _minRadiation    = _pvCapW > 0 ? (_battChargePowerW / _pvCapW) * 1000 : 0;
          const _hourlyForecast  = inputs.weather?.hourlyForecast;
          const _now             = Date.now();
          let _effectiveSunHours = 0;
          if (Array.isArray(_hourlyForecast) && _hourlyForecast.length > 0 && _minRadiation > 0) {
            for (const h of _hourlyForecast) {
              const hMs = h.time instanceof Date ? h.time.getTime() : new Date(h.time).getTime();
              if (hMs < _now) continue;
              if (typeof h.radiationWm2 === 'number' && h.radiationWm2 >= _minRadiation) _effectiveSunHours++;
            }
          } else {
            _effectiveSunHours = inputs.weather?.sunshineTodayRemaining ?? 0;
          }
          const _hasForecast  = Array.isArray(_hourlyForecast) && _hourlyForecast.length > 0;
          const _sunScore     = inputs.sun?.gfs ?? inputs.sun?.harmonie ?? 0;
          const _enoughSun    = _effectiveSunHours >= _hoursNeeded || (!_hasForecast && _sunScore >= 50);
          const _pvKwhRemaining = inputs.weather?.pvKwhRemaining ?? null;
          const _pvCanFill    = _pvKwhRemaining === null || _pvKwhRemaining >= _toChargeKwh * 1.2;

          if (_enoughSun && _pvCanSupport && _pvCanFill) {
            _canDelayCharge = true;
            const _sunSource      = _hasForecast ? `${_effectiveSunHours}h radiation≥${Math.round(_minRadiation)}W/m²` : `score ${_sunScore}`;
            const _pvRemainingStr = _pvKwhRemaining !== null ? `, PV remaining ${_pvKwhRemaining.toFixed(1)}kWh ≥ ${(_toChargeKwh * 1.2).toFixed(1)}kWh needed` : '';
            this.log(`PV OVERSCHOT: delay-charge possible — ${_sunSource} (need ${_hoursNeeded.toFixed(1)}h for ${_toChargeKwh.toFixed(1)}kWh @ ${_battChargePowerW}W)${_pvRemainingStr}, ${_cheapLaterHours.length} cheap slot(s) coming → export now, charge later`);
          } else if (_enoughSun && _pvCanSupport && !_pvCanFill) {
            this.log(`PV OVERSCHOT: delay-charge SKIPPED — PV remaining ${_pvKwhRemaining?.toFixed(1)}kWh < ${(_toChargeKwh * 1.2).toFixed(1)}kWh needed → charge now before sun fades`);
          } else {
            const _cheap24h = _pvPricesArray.filter(p =>
              typeof p.index === 'number' && p.index > 1 * _sph && p.index <= 24 * _sph &&
              typeof p.price === 'number' && p.price < _pvCurrentPrice * 0.75
            );
            if (_cheap24h.length >= Math.ceil(_hoursNeeded * _sph)) {
              _canDelayCharge = true;
              this.log(`PV OVERSCHOT: delay-charge via grid arbitrage — ${_cheap24h.length} cheap grid hour(s) coming → wait for cheap grid`);
            } else {
              this.log(`PV OVERSCHOT: delay-charge SKIPPED — ${_effectiveSunHours}h adequate sun (need ${_hoursNeeded.toFixed(1)}h) and no sufficient cheap grid hours → charge now`);
            }
          }
        }
      }
    }

    if (_canDelayCharge) {
      inputs._pvStoreWins = false;
      inputs._delayCharge = true;
      this.log(`PV OVERSCHOT: delay-charge wins → export at €${_pvCurrentPrice?.toFixed(3)}/kWh, charge later`);
    } else if (_pvCurrentPrice === null || _pvStoreValue === null || _pvStoreValue > _pvCurrentPrice) {
      inputs._pvStoreWins = true;
      this.log(`PV OVERSCHOT: storing beats exporting (max €${_pvMaxFuture?.toFixed(3) ?? '?'} × ${this.BATTERY_EFFICIENCY} = €${_pvStoreValue?.toFixed(3) ?? '?'} > current €${_pvCurrentPrice?.toFixed(3) ?? '?'}) → force charge`);
    } else {
      const _lowSocMarginRequired = soc < 50 ? 0.02 : 0;
      const _exportMargin = _pvCurrentPrice - _pvStoreValue;
      if (_exportMargin < _lowSocMarginRequired) {
        inputs._pvStoreWins = true;
        this.log(`PV OVERSCHOT: export margin €${_exportMargin.toFixed(3)} < low-SoC threshold €${_lowSocMarginRequired.toFixed(3)} (SoC ${soc}%) → store wins`);
      } else {
        inputs._pvStoreWins = false;
        this.log(`PV OVERSCHOT: export more profitable (€${_pvCurrentPrice.toFixed(3)} > €${_pvStoreValue.toFixed(3)}, margin €${_exportMargin.toFixed(3)}) → standby, PV to grid`);
      }
    }
  }

  // ── Build result for DP-primary path ─────────────────────────────────────────
  _buildDpResult(action, hwMode, confidence, exception, inputs, dpAction) {
    const allPrices = inputs.tariff?.effectivePrices || inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
    const nowMs     = Date.now();

    // Max future price for summary context
    const futurePrices  = allPrices
      .filter(p => p.timestamp && new Date(p.timestamp) > nowMs)
      .map(p => p.price).filter(p => typeof p === 'number' && p > 0);
    const maxFuturePrice = futurePrices.length ? Math.max(...futurePrices) : null;

    // Attach DP decision context so explainability engine can use it
    inputs.dpDecision = {
      dpAction,
      finalAction: action,
      exception,
      maxFuturePrice,
      breakEven: inputs.batteryCost?.breakEven ?? null,
    };

    // Debug snapshot (compatible with old format)
    const _diagPrices12h = allPrices
      .filter(p => p.timestamp && new Date(p.timestamp) > nowMs
                && new Date(p.timestamp) <= new Date(nowMs + 12 * 3600_000))
      .map(p => p.price).filter(p => typeof p === 'number' && p > 0);
    const debug = {
      ts:          new Date().toISOString(),
      price:       inputs.tariff?.currentPrice ?? null,
      soc:         inputs.battery?.stateOfCharge ?? null,
      currentLoad: this.currentLoad ?? null,
      scores:      { charge: 0, discharge: 0, preserve: 0 },
      policyMode:  action,
      hwMode,
      delayCharge: inputs._delayCharge === true,
      breakEven:   inputs.batteryCost?.breakEven != null ? +inputs.batteryCost.breakEven.toFixed(3) : null,
      avgCost:     inputs.batteryCost?.avgCost   != null ? +inputs.batteryCost.avgCost.toFixed(3)   : null,
      optimizer:   dpAction,
      exception,
      priceMin12h: _diagPrices12h.length ? +Math.min(..._diagPrices12h).toFixed(3) : null,
      priceMax12h: _diagPrices12h.length ? +Math.max(..._diagPrices12h).toFixed(3) : null,
    };

    this.log('Recommendation:', { policyMode: action, hwMode, confidence, exception });

    return {
      policyMode:  action,
      hwMode,
      confidence,
      scores:      { charge: 0, discharge: 0, preserve: 0 },
      debug,
    };
  }

  // ── Build result for legacy (fixed tariff) path ───────────────────────────
  _buildLegacyResult(recommendation, scores, inputs) {
    const allPrices = inputs.tariff?.effectivePrices || inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
    const nowMs     = Date.now();
    const _diagPrices12h = allPrices
      .filter(p => p.timestamp && new Date(p.timestamp) > nowMs
                && new Date(p.timestamp) <= new Date(nowMs + 12 * 3600_000))
      .map(p => p.price).filter(p => typeof p === 'number' && p > 0);
    recommendation.debug = {
      ts:          new Date().toISOString(),
      price:       inputs.tariff?.currentPrice ?? null,
      soc:         inputs.battery?.stateOfCharge ?? null,
      currentLoad: this.currentLoad ?? null,
      scores:      { charge: scores.charge, discharge: scores.discharge, preserve: scores.preserve },
      policyMode:  recommendation.policyMode,
      hwMode:      recommendation.hwMode,
      delayCharge: inputs._delayCharge === true,
      breakEven:   inputs.batteryCost?.breakEven != null ? +inputs.batteryCost.breakEven.toFixed(3) : null,
      avgCost:     inputs.batteryCost?.avgCost   != null ? +inputs.batteryCost.avgCost.toFixed(3)   : null,
      optimizer:   inputs.optimizer ? inputs.optimizer.getSlot(new Date()) : null,
      priceMin12h: _diagPrices12h.length ? +Math.min(..._diagPrices12h).toFixed(3) : null,
      priceMax12h: _diagPrices12h.length ? +Math.max(..._diagPrices12h).toFixed(3) : null,
    };
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

    // If the remaining PV forecast (from now until end of day) covers the remaining battery
    // capacity, charging from grid is wasteful — the sun will handle it for free.
    // Use pvKwhRemaining (future-only) rather than pvKwhToday (full day including past hours)
    // so that an already-sunny morning doesn't falsely suppress grid charge in the afternoon.
    const pvKwhRemaining = inputs.weather?.pvKwhRemaining ?? inputs.weather?.pvKwhToday ?? null;
    const capacityKwh    = inputs.battery?.totalCapacityKwh ?? 2.688;
    const remainingKwh   = capacityKwh * (1 - soc / 100);
    // Require 1.5× margin: PV must comfortably exceed the remaining capacity.
    // A tight ratio (e.g. 3kWh PV for 2.5kWh remaining) leaves no buffer for
    // household consumption or forecast error → charge from grid instead.
    const pvCoversGap  = pvKwhRemaining !== null && pvKwhRemaining >= remainingKwh * 1.5;

    if (pvCoversGap) {
      // PV will charge the battery for free — grid charging wastes money.
      // Set a flag so the post-scoring step can enforce preserve after DayAhead/Tariff rules run.
      inputs._pvCoversGap = true;
      this.log(`SmartLowSoC: PV remaining ${pvKwhRemaining.toFixed(1)}kWh covers remaining capacity ${remainingKwh.toFixed(1)}kWh → flagging _pvCoversGap, skip grid charge`);
      return;
    }

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
  // Guard: only apply when the battery is ACTUALLY receiving charge (batteryPower > 50W).
  // pvDetected can be true via pvEstimate (forecast) before sunrise, when batteryPower=0.
  // In that case there is no trickle-charge to protect — don't block profitable discharge.
  const currentHwMode = inputs.battery?.mode ?? null;
  const batteryActuallyCharging = (inputs.p1?.battery_power ?? 0) > 50;
  const pvTrickleCharging = currentHwMode === 'zero_charge_only' && pvDetected && batteryActuallyCharging;
  const pvTrickleHysteresis = Math.max(zeroModeThreshold + 20, 20);
  if (pvTrickleCharging && soc < pvTrickleHysteresis) {
    this.log(`BatteryScore: trickle-charging from PV (zero_charge_only, ${inputs.p1?.battery_power ?? 0}W), SoC ${soc}% < ${pvTrickleHysteresis}% → blocking discharge (RTE loss prevention)`);
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
    const minDischargePrice = inputs.effectiveMinDischarge ?? this.settings.min_discharge_price ?? 0.22;
    const atPeakPrice       = currentPrice !== null && currentPrice >= minDischargePrice;
    if (atPeakPrice) {
      this.log(`BatteryScore: PV detected (sticky) but price €${currentPrice.toFixed(3)} >= min_discharge €${minDischargePrice.toFixed(3)} → skip charge bonus (discharge favoured)`);
      scores.preserve += 5;
      return;
    }
    // After sunset, pvDetected=true is the dynamic-tariff fallback (not real PV).
    // Don't add a charge bonus — let the tariff module decide charge/discharge.
    const sunset     = inputs.weather?.todaySunset;
    const afterSunset = sunset instanceof Date && (Date.now() > sunset.getTime() + 30 * 60 * 1000);
    if (afterSunset) {
      this.log('BatteryScore: PV signal (dynamic fallback) but after sunset → no charge bonus');
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
  // ── _refreshPvSticky ──────────────────────────────────────────────────────
  // Pure PV detection + sticky timer update. No score side-effects.
  // Returns { detected: boolean, bonus: number } where bonus is the charge
  // score that _applyPVReality (fixed-tariff path) should add.
  _refreshPvSticky(inputs) {
    const p1          = inputs.p1;
    const batteryMode = inputs.battery?.mode;
    if (!p1) return { detected: false, bonus: 0 };

    const gridPower    = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;
    const pvEstimate   = p1.pv_power_estimated ?? 0;

    const now = Date.now();
    if (!this._pvStickyUntil) this._pvStickyUntil = 0;

    const sunset      = inputs.weather?.todaySunset;
    const afterSunset = sunset && (now > sunset.getTime() + 30 * 60 * 1000);
    const delayCharge = inputs._delayCharge === true;

    if (this._pvStickyUntil > now) {
      if (delayCharge) {
        this.log(`PV Reality: sticky PV active + delay-charge → standby (PV exports to grid)`);
      } else {
        this.log(`PV Reality: sticky PV active → charge allowed`);
      }
      return { detected: true, bonus: 50 };
    }

    if (batteryPower > 50 && gridPower < -50) {
      this._pvStickyUntil = now + 5 * 60 * 1000;
      if (delayCharge) {
        this.log(`💡 PV detected via batteryPower (${batteryPower}W) + export (${Math.abs(gridPower)}W) → sticky 5 min (delay-charge: no charge bonus)`);
      } else {
        this.log(`💡 PV detected via batteryPower (${batteryPower}W) + export (${Math.abs(gridPower)}W) → sticky 5 min`);
      }
      return { detected: true, bonus: 100 };
    }

    if (pvEstimate >= 100 && !afterSunset) {
      this._pvStickyUntil = now + 5 * 60 * 1000;
      if (delayCharge) {
        this.log(`💡 PV detected via pvEstimate (${pvEstimate}W) → sticky 5 min (delay-charge: no charge bonus)`);
      } else {
        this.log(`💡 PV detected via pvEstimate (${pvEstimate}W) → sticky 5 min`);
      }
      return { detected: true, bonus: 80 };
    }

    if (pvEstimate >= 100 && afterSunset) {
      this.log(`⚠️ pvEstimate ${pvEstimate}W ignored — after sunset + 30min (stale EMA)`);
    }

    if (gridPower < -100) {
      this._pvStickyUntil = now + 5 * 60 * 1000;
      if (delayCharge) {
        this.log(`💡 PV detected via export (${Math.abs(gridPower)}W) → sticky 5 min (delay-charge: no charge bonus)`);
      } else {
        this.log(`💡 PV detected via export (${Math.abs(gridPower)}W) → sticky 5 min`);
      }
      return { detected: true, bonus: 60 };
    }

    if (batteryMode === 'zero_charge_only') {
      const cetHour = parseInt(new Date().toLocaleString('en-GB', {
        hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
      }), 10);
      if (cetHour >= 7 && cetHour < 20) {
        this._pvStickyUntil = now + 2 * 60 * 1000;
        this.log(`PV Reality: zero_charge_only mode (daylight) → PV assumed`);
        return { detected: true, bonus: 40 };
      }
      this.log(`PV Reality: zero_charge_only mode but nighttime (${cetHour}h CET) → not assuming PV`);
    }

    if (this.settings.tariff_type === 'dynamic') {
      this.log('PV Reality: no PV surplus but dynamic pricing → tariff decides');
      return { detected: true, bonus: 0 };
    }

    this.log('PV Reality: no PV → blocking charge');
    return { detected: false, bonus: 0 };
  }

  _applyPVReality(scores, p1, batteryMode, inputs) {
    const { detected, bonus } = this._refreshPvSticky(inputs);
    if (detected && bonus > 0 && !inputs._delayCharge) {
      scores.charge += bonus;
    }
    return detected;
  }


  _applyWeatherForecast(scores, weather, tariff, battery, inputs) {
    if (!weather) return;

    const sun4h          = Number(weather.sunshineNext4Hours    ?? 0);
    const sun8h          = Number(weather.sunshineNext8Hours    ?? 0);
    const sunToday       = Number(weather.sunshineTodayRemaining ?? 0);
    const sunTomorrow    = Number(weather.sunshineTomorrow      ?? 0);
    const pvKwhTomorrow  = Number(weather.pvKwhTomorrow         ?? 0);
    const battCapKwh     = battery?.totalCapacityKwh ?? 3;
    const strongSunTomorrow = sunTomorrow >= 4 || pvKwhTomorrow >= battCapKwh * 0.8;
    const soc         = battery?.stateOfCharge ?? 50;
    const isDynamic   = this.settings.tariff_type === 'dynamic';

    // DP already accounts for tomorrow's PV in its lookahead — halve weather discharge
    // boosts when DP says preserve to avoid overriding a global-optimal decision.
    const dpSaysPreserve = inputs?.optimizer?.getSlot(new Date()) === 'preserve';

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

    // Discharge boosts are pointless at 0% SoC — skip to avoid log noise
    if (soc > 5) {
      if (strongSunTomorrow) {
        scores.charge -= 10;

        if (isDynamic) {
          const currentPrice      = tariff?.currentPrice || 0;
          const minDischargePrice = inputs?.effectiveMinDischarge ?? this.settings.min_discharge_price ?? 0.22;

          if (currentPrice >= minDischargePrice * 0.85) {
            const boost = dpSaysPreserve ? 12 : 25;
            scores.discharge += boost;
            this.log(`Weather: sunTomorrow >= 4 + expensive hour → BOOST discharge +${boost}${dpSaysPreserve ? ' (halved: DP=preserve)' : ''}`);
          } else {
            this.log(`Weather: sunTomorrow >= 4 → mild grid charge penalty`);
          }
        } else {
          const boost = dpSaysPreserve ? 8 : 15;
          scores.discharge += boost;
          this.log(`Weather: sunTomorrow >= 4 → encourage discharge +${boost}${dpSaysPreserve ? ' (halved: DP=preserve)' : ''}`);
        }
      }

      if (sunTomorrow >= 6.0 || pvKwhTomorrow >= battCapKwh * 1.5) {
        scores.charge -= 20;

        if (isDynamic) {
          const currentPrice      = tariff?.currentPrice || 0;
          const minDischargePrice = inputs?.effectiveMinDischarge ?? this.settings.min_discharge_price ?? 0.22;

          if (currentPrice >= minDischargePrice * 0.75) {
            const boost = dpSaysPreserve ? 18 : 35;
            scores.discharge += boost;
            this.log(`Weather: sunTomorrow >= 6 + moderate/high price → AGGRESSIVE discharge +${boost}${dpSaysPreserve ? ' (halved: DP=preserve)' : ''}`);
          } else {
            this.log('Weather: sunTomorrow >= 6 → avoid grid charging, ready to discharge');
          }
        } else {
          const currentHour = new Date().getHours();
          if (currentHour >= 17) {
            const boost = dpSaysPreserve ? 15 : 30;
            scores.discharge += boost;
            this.log(`Weather: sunTomorrow >= 6 + evening → AGGRESSIVE discharge +${boost}${dpSaysPreserve ? ' (halved: DP=preserve)' : ''}`);
          } else {
            const boost = dpSaysPreserve ? 10 : 20;
            scores.discharge += boost;
            this.log(`Weather: sunTomorrow >= 6 → boost discharge +${boost}${dpSaysPreserve ? ' (halved: DP=preserve)' : ''}`);
          }
        }
      }
    } else {
      // SoC ≤ 5%: still apply charge penalties, skip discharge boosts
      if (strongSunTomorrow)                                   scores.charge -= 10;
      if (sunTomorrow >= 6.0 || pvKwhTomorrow >= battCapKwh * 1.5) scores.charge -= 20;
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
      const sunTomorrow       = Number(weather.sunshineTomorrow ?? 0);
      const pvKwhTomorrow     = Number(weather.pvKwhTomorrow    ?? 0);
      const battCapKwh        = battery?.totalCapacityKwh ?? 3;
      const strongSunTomorrow = sunTomorrow >= 4 || pvKwhTomorrow >= battCapKwh * 0.8;
      const h                 = time.getHours();

      if ((sunTomorrow >= 5.0 || pvKwhTomorrow >= battCapKwh) && h >= 17 && h < 23) {
        scores.discharge += 20;
        scores.preserve  -= 10;
        this.log(`Peak: evening + ${sunTomorrow}h sun tomorrow / ${pvKwhTomorrow}kWh PV → boost discharge`);
      }

      const offPeak   = this._parseTimeRange(this.settings.off_peak_hours);
      const inOffPeak = offPeak && h >= offPeak.startHour && h < offPeak.endHour;

      if (inOffPeak && strongSunTomorrow) {
        scores.charge -= 30;
        this.log(`Peak: off-peak but ${sunTomorrow}h sun tomorrow / ${pvKwhTomorrow}kWh PV → skip grid charging`);
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

  _isChargeExecutable(ctx) {
    const price          = ctx.tariff?.currentPrice ?? null;
    const maxChargePrice = this.settings.max_charge_price ?? 0.19;
    if (price !== null && price <= maxChargePrice) return true;

    const gridPower      = ctx.p1?.resolved_gridPower ?? 0;
    const batteryPower   = ctx.p1?.battery_power ?? 0;
    const pvEstimate     = ctx.p1?.pv_power_estimated ?? 0;
    const stickyPvActive = this._pvStickyUntil && (this._pvStickyUntil > Date.now());
    const _sunset        = ctx.weather?.todaySunset;
    const _afterSunset   = _sunset && (Date.now() > _sunset.getTime() + 30 * 60 * 1000);
    return stickyPvActive ||
           gridPower < -100 ||
           (!_afterSunset && pvEstimate >= 100) ||
           (gridPower <= 0 && batteryPower > 50);
  }

  _selectMode(scores, ctx) {
    let policyMode = 'preserve';
    let winner     = scores.preserve;

    if (scores.charge > winner)    { policyMode = 'charge';    winner = scores.charge; }
    if (scores.discharge > winner) { policyMode = 'discharge'; winner = scores.discharge; }

    const hwMode = this._mapPolicyToHwMode(policyMode, ctx);

    // When charge wins on score but maps to standby (price too high, no PV),
    // re-evaluate using only discharge vs preserve.
    if (policyMode === 'charge' && hwMode === 'standby') {
      const execMode       = scores.discharge >= scores.preserve ? 'discharge' : 'preserve';
      const execWinner     = Math.max(scores.discharge, scores.preserve);
      const execHwMode     = this._mapPolicyToHwMode(execMode, ctx);
      const execTotal      = scores.discharge + scores.preserve;
      const execConfidence = Math.round((execWinner / (execTotal || 1)) * 100);
      this.log(`[MAPPING][CHARGE-BLOCKED] charge unexecutable → fallback ${execMode} (${execHwMode}), confidence ${execConfidence}%`);
      return { policyMode: execMode, hwMode: execHwMode, confidence: Math.min(execConfidence, 100) };
    }

    const chargeExecutable = this._isChargeExecutable(ctx);
    const total = chargeExecutable
      ? scores.charge + scores.discharge + scores.preserve
      : scores.discharge + scores.preserve;

    const confidence = Math.round((winner / (total || 1)) * 100);
    return { policyMode, hwMode, confidence: Math.min(confidence, 100) };
  }

_mapPolicyToHwMode(policyMode, ctx) {
  const tariffType     = this.settings.tariff_type;
  const soc            = ctx.battery?.stateOfCharge ?? 50;
  const minSoc         = this.settings.min_soc ?? 0;
  const maxSoc         = this.settings.max_soc ?? 95;
  const price          = ctx.tariff?.currentPrice ?? null;
  const maxChargePrice = this.settings.max_charge_price ?? 0.19;

  // balanced-dynamic always behaves opportunistically (post-saldering design).
  const isBalancedDynamic = ctx.policyMode === 'balanced-dynamic';
  const respectMinMax = isBalancedDynamic ? false : (this.settings.respect_minmax !== false);

  // NOTE: HomeWizard firmware handles 0-100% protection
  // Only respect user-configured min_soc for strategy, not safety

  if (soc < minSoc) {
    this.log(`[MAPPING] SoC ${soc}% < min_soc ${minSoc}% → forcing standby`);
    return 'standby';
  }

  // DP chose standby: PV exports to grid, battery stays idle.
  if (policyMode === 'standby') {
    this.log(`[MAPPING] standby (DP: PV export beats storage at current price)`);
    return 'standby';
  }

  const costModelActive =
    ctx.batteryCost?.avgCost > 0 &&
    ctx.batteryCost?.energyKwh >= 0.5;

  if (costModelActive) {
    const configuredEff  = this.settings.battery_efficiency || 0.75;
    const learnedEff     = ctx.batteryEfficiency ?? configuredEff;
    const effectiveEff   = Math.min(configuredEff, learnedEff, 0.95);
    const cycleCost      = this.settings.cycle_cost_per_kwh ?? 0.075;

    // Consistent with optimizer: cycle cost split 50/50 between charge and discharge
    const safeBreakEven  = ctx.batteryCost.avgCost / effectiveEff + cycleCost * 0.5;
    ctx.batteryCost.breakEven = safeBreakEven;

    this.log(`[MAPPING] safe break-even €${safeBreakEven.toFixed(3)} (eff=${effectiveEff.toFixed(3)}, cycleCost=€${cycleCost}/kWh)`);
  }

  // Effective discharge floor:
  // strict mode  → honour user-configured min_discharge_price
  // opportunistic → only require price > economic break-even (cycle cost / RTE)
  const _settingsFloor = (this.settings.cycle_cost_per_kwh ?? 0.075) / (this.settings.battery_efficiency || 0.75);
  const minDischarge = respectMinMax
    ? (this.settings.min_discharge_price || 0)
    : (costModelActive && ctx.batteryCost.breakEven > 0 ? ctx.batteryCost.breakEven : _settingsFloor);

  const profitableToDischarge =
    price !== null &&
    price >= minDischarge &&
    (!costModelActive || price >= ctx.batteryCost.breakEven);

  const gridPower    = ctx.p1?.resolved_gridPower ?? 0;
  const batteryPower = ctx.p1?.battery_power ?? 0;
  const pvEstimate   = ctx.p1?.pv_power_estimated ?? 0;

  // Check sticky PV flag first (set by _applyPVReality with 5min window)
  const stickyPvActive = this._pvStickyUntil && (this._pvStickyUntil > Date.now());

  // Sunset guard: pvEstimate uses EMA smoothing which causes stale values after sunset.
  // After sunset + 30min, only hard signals (grid export, battery charging) count.
  const _sunset = ctx.weather?.todaySunset;
  const _afterSunset = _sunset && (Date.now() > _sunset.getTime() + 30 * 60 * 1000);

  const actualPvNow =
    stickyPvActive ||
    gridPower < -100 ||
    (!_afterSunset && pvEstimate >= 100) ||
    (gridPower <= 0 && batteryPower > 50); // battery charging without grid import → PV surplus

  this.log(`[MAPPING] policyMode=${policyMode}, soc=${soc}, PV=${actualPvNow} (sticky=${stickyPvActive}), price=${price?.toFixed(3)}, maxCharge=€${maxChargePrice}`);

  if (ctx.policyMode === 'zero') {
    if (soc <= minSoc) return 'zero_charge_only';
    if (soc >= maxSoc) return 'zero_discharge_only';
    return 'zero';
  }

  if ((ctx.policyMode === 'balanced' || ctx.policyMode === 'balanced-dynamic') && tariffType === 'dynamic') {

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
      if (!profitableToDischarge) return 'standby';
      // During active PV production, zero_discharge_only is effectively standby
      // when PV surplus > house load (grid already negative, nothing to discharge
      // toward 0W). Use 'zero' instead: charges from free PV surplus when PV > load,
      // discharges to cover consumption when load > PV. Grid stays ~0W both ways.
      // Delay-charge path (above) intentionally exports PV at high price and is excluded.
      if (actualPvNow && soc > minSoc) {
        this.log(`[MAPPING][DISCHARGE] PV active (${pvEstimate}W) + profitable → zero (surplus charges, battery covers load peaks)`);
        return 'zero';
      }
      return 'zero_discharge_only';
    }

    if (policyMode === 'charge') {

      // Negative price: charging earns money — always pull from grid regardless of PV state.
      if (price !== null && price < 0) {
        this.log(`[MAPPING][CHARGE] negative price €${price.toFixed(3)} → to_full (grid charging earns money)`);
        return 'to_full';
      }

      // _pvStoreWins: storing PV surplus is more valuable than exporting.
      // Use zero_charge_only: only harvest from surplus, do not discharge.
      // When PV > consumption (the _pvStoreWins condition), the battery never
      // discharges in zero_charge_only anyway. If a cloud temporarily drops PV,
      // we want to preserve stored energy for the planned high-price discharge
      // slot — not spend it covering a transient load gap.
      // Skip when _chargeUrgent (grid charging needed).
      if (ctx._pvStoreWins && actualPvNow && !ctx._chargeUrgent) {
        this.log(`[MAPPING][CHARGE] _pvStoreWins + PV active (${pvEstimate}W), soc=${soc}% → zero_charge_only (store surplus for planned discharge)`);
        return 'zero_charge_only';
      }

      // When PV is producing strongly (≥400W), prefer zero_charge_only: harvest solar
      // surplus without pulling from the grid. Grid charging (to_full) adds unnecessary
      // import cost and slightly lower RTE when sun can do the job.
      // Only fall back to to_full when PV is weak or absent and the grid price is cheap.
      if (actualPvNow && pvEstimate >= 400 && !ctx._chargeUrgent) {
        this.log(`[MAPPING][CHARGE] PV strong (${pvEstimate}W) → zero_charge_only (harvest solar, skip grid import)`);
        return 'zero_charge_only';
      }

      if (ctx._chargeUrgent && price !== null && price <= maxChargePrice) {
        this.log(`[MAPPING][CHARGE] urgent pre-peak (PV ${pvEstimate}W but expensive hour imminent) → to_full`);
        return 'to_full';
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
      // Negative price: hold capacity for better grid-charge slots — standby even with PV.
      if (price !== null && price < 0) return 'standby';
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
   * Build a frontend-ready planning schedule from the optimizer's slot output.
   * Maps optimizer actions to hwModes using PV forecast — not real-time P1 data.
   * Called from device.js after each optimizer recompute; result is saved as
   * 'policy_optimizer_schedule' Homey setting for the frontend to render.
   *
   * @param {Array<{timestamp, action, price, socProjected}>} slots
   * @param {Array<{timestamp, pvPowerW}>|null} pvForecast
   * @returns {Array<{timestamp, action, hwMode, socProjected, price, pvW}>}
   */
  buildPlanningSchedule(slots, pvForecast, minDischargePriceOverride = null) {
    if (!slots || slots.length === 0) return [];

    const tariffType        = this.settings.tariff_type        || 'dynamic';
    const maxChargePrice    = this.settings.max_charge_price   ?? 0.19;
    const minSoc            = this.settings.min_soc            ?? 0;
    const maxSoc            = this.settings.max_soc            ?? 95;

    // Normalise policy_mode aliases
    const raw = this.settings.policy_mode || 'balanced';
    const userPolicyMode = ['balanced', 'balanced-fixed', 'balanced-dynamic'].includes(raw)
      ? 'balanced' : raw;

    // Mirror the runtime floor logic so the planning display is consistent with execution.
    // strict mode  → min_discharge_price
    // opportunistic → economic break-even derived from settings (cycle_cost / efficiency)
    const respectMinMax = (raw === 'balanced-dynamic')
      ? false
      : this.settings.respect_minmax !== false;
    const _settingsFloor = (this.settings.cycle_cost_per_kwh ?? 0.075) / (this.settings.battery_efficiency || 0.75);
    const baseMinDischargePrice = respectMinMax
      ? (this.settings.min_discharge_price || 0)
      : _settingsFloor;
    // minDischargePriceOverride may be a per-slot array (PV headroom mode) or a scalar.
    const isPerSlotOverride = Array.isArray(minDischargePriceOverride);
    const scalarMinDischarge = isPerSlotOverride
      ? baseMinDischargePrice
      : (minDischargePriceOverride !== null && minDischargePriceOverride < baseMinDischargePrice)
        ? minDischargePriceOverride
        : baseMinDischargePrice;

    return slots.map((slot, i) => {
      const minDischargePrice = isPerSlotOverride
        ? (minDischargePriceOverride[i] ?? baseMinDischargePrice)
        : scalarMinDischarge;
      const pvW    = this._getPvWForTimestamp(slot.timestamp, pvForecast);
      const hwMode = this._mapActionToHwModeForPlanning(slot.action, {
        price: slot.price, soc: slot.socProjected,
        pvW, tariffType, userPolicyMode,
        maxChargePrice, minDischargePrice, minSoc, maxSoc,
      });
      return {
        timestamp:    slot.timestamp,
        action:       slot.action,
        hwMode,
        socProjected: slot.socProjected,
        price:        slot.price,
        pvW,
        consumptionW: slot.consumptionW ?? null,
      };
    });
  }

  _getPvWForTimestamp(timestamp, pvForecast) {
    if (!pvForecast || pvForecast.length === 0) return 0;
    const tsMs = new Date(timestamp).getTime();

    // Return 0 outside daylight hours (6:00–21:00 local) — no PV possible at night.
    const cetHour = parseInt(new Date(tsMs).toLocaleString('en-GB', {
      hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam'
    }), 10);
    if (cetHour < 6 || cetHour >= 21) return 0;

    // Linear interpolation between surrounding hourly entries — consistent with
    // OptimizationEngine._getPvForSlot so planning and DP use the same pvW values.
    let left = null, right = null;
    for (const f of pvForecast) {
      const t = new Date(f.timestamp).getTime();
      if (t <= tsMs && (left  === null || t > new Date(left.timestamp).getTime()))  left  = f;
      if (t >= tsMs && (right === null || t < new Date(right.timestamp).getTime())) right = f;
    }
    if (!left && !right) return 0;
    if (!left)  return right.pvPowerW ?? 0;
    if (!right) return left.pvPowerW  ?? 0;
    const leftMs  = new Date(left.timestamp).getTime();
    const rightMs = new Date(right.timestamp).getTime();
    if (leftMs === rightMs) return left.pvPowerW ?? 0;
    const frac = (tsMs - leftMs) / (rightMs - leftMs);
    return Math.round((left.pvPowerW ?? 0) + ((right.pvPowerW ?? 0) - (left.pvPowerW ?? 0)) * frac);
  }

  /**
   * Simplified action→hwMode mapping for planning (uses PV forecast, not real-time P1).
   * The optimizer's DP already handles optimal timing (no cheaperSlotComing needed here).
   */
  _mapActionToHwModeForPlanning(action, { price, soc, pvW, tariffType, userPolicyMode, maxChargePrice, minDischargePrice, minSoc, maxSoc }) {
    const pvStrong  = pvW >= 400;
    const pvPresent = pvW >= 100;
    const profitableToDischarge = price !== null && price >= minDischargePrice;

    if (userPolicyMode === 'zero') {
      if (soc <= minSoc) return 'zero_charge_only';
      if (soc >= maxSoc) return 'zero_discharge_only';
      return 'zero';
    }

    if (action === 'standby') return 'standby'; // DP: PV export beats battery storage

    if (action === 'discharge') {
      // Trust the DP's discharge decision — it may be clearing room for upcoming negative prices.
      // (Real-time mapping gives 'zero' for discharge+PV, not zero_charge_only.)
      return profitableToDischarge ? 'zero_discharge_only' : 'standby';
    }

    if (action === 'charge') {
      if (price !== null && price < 0)               return 'to_full';
      if (pvStrong)                                  return 'zero_charge_only';
      if (price !== null && price <= maxChargePrice) return 'to_full';
      if (pvPresent)                                 return 'zero_charge_only';
      return 'standby';
    }

    // preserve: at negative prices → standby (hold capacity for better charge slots).
    // When battery is already full → standby (PV exports to grid, same as standby).
    // Otherwise with strong PV → zero_charge_only (charge battery + export surplus).
    if (price !== null && price < 0) return 'standby';
    if (soc >= maxSoc) return 'standby';
    return pvStrong ? 'zero_charge_only' : 'standby';
  }

  updateSettings(newSettings) {
    this.settings           = { ...this.settings, ...newSettings };
    this.BATTERY_EFFICIENCY = newSettings.battery_efficiency || this.BATTERY_EFFICIENCY;
    this.MIN_PROFIT_MARGIN  = newSettings.min_profit_margin ?? this.MIN_PROFIT_MARGIN;
  }
}

module.exports = PolicyEngine;