'use strict';

class ExplainabilityEngine {
  constructor(homey) {
    this.homey = homey;
    this.log = homey.log.bind(homey);
  }

  generateExplanation(recommendation, inputs, scores) {
    const policyMode = recommendation.policyMode || recommendation.mode;
    const hwMode = recommendation.hwMode || null;

    const normalized = {
      policyMode,
      hwMode,
      confidence: recommendation.confidence
    };

    const reasons = [];
    const warnings = [];

    const settings = inputs.settings || {};
    const tariffType = settings.tariff_type || 'fixed';

    // Ensure explanation uses the same price as the planning view
    const providerPrice = inputs.priceProvider?.getPriceForTimestamp(inputs.time)?.price;
    inputs.effectivePrice = providerPrice ?? inputs.tariff?.currentPrice ?? null;

    // Mirror policy-engine: cap at configured & 0.95 to prevent drift, but use learned if lower
    const configuredEff = settings.battery_efficiency || 0.75;
    const learnedEff    = inputs.batteryEfficiency ?? configuredEff;
    inputs.batteryEfficiency = Math.min(configuredEff, learnedEff, 0.95);

    // CORE REASONS
    this._addBatteryReasons(reasons, warnings, inputs.battery, settings, tariffType, inputs);
    this._addLoadAwarenessReasons(reasons, inputs);
    this._addTariffReasons(reasons, inputs.tariff, settings, tariffType, inputs);
    this._addPVReasons(reasons, inputs);
    this._addArbitrageReasons(reasons, inputs);
    this._addDelayChargeReasons(reasons, inputs, normalized);

    if (tariffType === 'dynamic') {
      this._addWeatherReasons(reasons, inputs.weather);
      this._addSunForecastReasons(reasons, inputs);
      this._addEfficiencyReasons(reasons, inputs);
    }

    this._addPeakShavingReasons(reasons, inputs);
    this._addTimeReasons(reasons, inputs.time);
    this._addConfidenceReason(reasons, recommendation, inputs);

    // Sort reasons by impact
    reasons.sort((a, b) => this._impactWeight(b.impact) - this._impactWeight(a.impact));

    const summary = this._generateSummary(recommendation, reasons, inputs);
    const shortSummary = this._generateShortSummary(recommendation, inputs);

    return {
      recommendation: hwMode || policyMode,
      confidence: recommendation.confidence,
      reasons: reasons.slice(0, 8),
      warnings,
      scores,
      summary,
      shortSummary,
      timestamp: new Date().toISOString(),
      // ✅ Add battery cost and efficiency to output for UI display
      batteryCost: inputs.batteryCost,
      batteryEfficiency: inputs.batteryEfficiency,
      effectivePrice: inputs.effectivePrice
    };
  }

  // ... (rest of the methods stay the same until _generateShortSummary)

  _generateShortSummary(recommendation, inputs) {
    const hw = recommendation.hwMode;
    const price = inputs?.effectivePrice;
    const soc = inputs?.battery?.stateOfCharge;
    const sun = inputs?.weather?.sunshineNext4Hours;
    const rte = inputs?.batteryEfficiency; // ✅ Now uses configured 0.75, not learned 0.99

    const avg = inputs?.batteryCost?.avgCost ?? null;
    const breakEven = inputs?.batteryCost?.breakEven ?? null;

    const MODE_SHORT_NL = {
      zero_charge_only: 'Zon‑laden',
      zero_discharge_only: 'Ontladen',
      to_full: 'Vol‑laden',
      standby: 'Stand‑by',
      zero: 'Net‑0',

      charge: 'Laden',
      discharge: 'Ontladen',
      preserve: 'Bewaren'
    };

    const label = MODE_SHORT_NL[hw] || hw?.toUpperCase() || '?';
    const parts = [label];

    // SoC
    if (typeof soc === 'number') {
      parts.push(`${soc}%`);
    }

    // Huidige prijs
    if (typeof price === 'number') {
      parts.push(`€${price.toFixed(3)}`);
    }

    // ⭐ Arbitrage-indicator
    if (avg !== null && breakEven !== null && typeof price === 'number') {
      if (price > breakEven + 0.01) {
        parts.push(`↑€${(price - breakEven).toFixed(3)}`); // winst per kWh
      } else if (price < breakEven - 0.01) {
        parts.push(`↓€${(breakEven - price).toFixed(3)}`); // besparing bij laden
      } else {
        parts.push('≈BE'); // rond break-even
      }
    }

    // Zon
    if (typeof sun === 'number' && sun >= 1) {
      parts.push(`☀${sun.toFixed(1)}h`);
    }

    // ✅ FIX: RTE should now show 75% instead of 99%
    if (typeof rte === 'number') {
      parts.push(`RTE ${(rte * 100).toFixed(0)}%`);
    }

    return parts.join(' ');
  }

  // ... (rest of methods unchanged - copy from original file)

  _addBatteryReasons(reasons, warnings, battery, settings, tariffType, inputs) {
    const soc = battery?.stateOfCharge ?? 50;
    const minSoc = settings.min_soc ?? null;
    const maxSoc = settings.max_soc ?? 95;

    // NOTE: HomeWizard firmware handles 0-100% protection
    // Explainability reflects strategy, not safety limits.
    // ZERO MODE threshold mirrors policy-engine: Math.max(minSoc, 1)
    const zeroModeThreshold = Math.max(minSoc ?? 0, 1);

    if (soc === 0) {
      // Mirror policy-engine: at soc=0 export may be more profitable than storing
      const _price = inputs.effectivePrice ?? null;
      const _eff   = settings.battery_efficiency ?? 0.75;
      const _pricesArr = inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
      const _now = new Date();
      const _futurePrices = _pricesArr
        .filter(h => h.timestamp ? new Date(h.timestamp) > _now : (h.index ?? 0) >= 1)
        .map(h => h.price).filter(p => typeof p === 'number' && p > 0);
      const _maxFuture = _futurePrices.length ? Math.max(..._futurePrices) : null;
      const _storeValue = _maxFuture !== null ? _maxFuture * _eff : null;
      const _exportWins = _price !== null && _storeValue !== null && _price > _storeValue;

      if (_exportWins) {
        reasons.push({
          icon: '⚡',
          category: 'battery',
          text: `Batterij op 0% — export naar net winstgevender (€${_price.toFixed(3)} > max €${_maxFuture.toFixed(3)} × ${_eff} = €${_storeValue.toFixed(3)}). Stand-by aanbevolen.`,
          impact: 'critical',
          sentiment: 'positive',
          supportedMode: 'preserve'
        });
      } else {
        reasons.push({
          icon: '🔧',
          category: 'battery',
          text: `Batterij op 0% — HomeWizard firmware calibratie mogelijk actief, laden prioriteit.`,
          impact: 'critical',
          sentiment: 'negative',
          supportedMode: 'charge'
        });
      }
      warnings.push(`Batterij op 0% (mogelijk firmware calibratie)`);
      return;
    }

    if (soc <= zeroModeThreshold) {
      reasons.push({
        icon: '🛑',
        category: 'battery',
        text: `Batterij zeer laag (${soc}%) — ontladen niet toegestaan.`,
        impact: 'high',
        sentiment: 'negative',
        supportedMode: 'charge'
      });
      warnings.push(`Batterij zeer laag (${soc}%)`);
      return;
    }

    if (typeof minSoc === 'number' && soc < minSoc) {
      reasons.push({
        icon: '🔋',
        category: 'battery',
        text: `Batterij onder ingestelde minimumwaarde (${soc}% < ${minSoc}%).`,
        impact: 'high',
        sentiment: 'negative',
        supportedMode: 'charge'
      });
      warnings.push(`Batterij onder ingestelde minimumwaarde (${minSoc}%)`);
      return;
    }

    if (soc >= maxSoc) {
      reasons.push({
        icon: '🔋',
        category: 'battery',
        text: `Batterij boven ingestelde maximumwaarde (${soc}% ≥ ${maxSoc}%).`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
      warnings.push(`Batterij boven ingestelde maximumwaarde (${maxSoc}%)`);
      return;
    }

    if (soc > 10 && soc <= 30) {
      reasons.push({
        icon: '⚠️',
        category: 'battery',
        text: `Batterij laag (${soc}%) — behouden voor dure uren.`,
        impact: 'high',
        sentiment: 'neutral',
        supportedMode: 'preserve'
      });
      return;
    }

    reasons.push({
      icon: '🔋',
      category: 'battery',
      text: `Batterij in normaal bereik (${soc}%).`,
      impact: 'low',
      sentiment: 'neutral',
      supportedMode: null
    });
  }

  _addLoadAwarenessReasons(reasons, inputs) {
    const battery = inputs.battery;
    const p1 = inputs.p1;

    if (!battery || !p1) return;

    const maxDischarge = battery.maxDischargePowerW ||
                        battery.battery_group_max_discharge_power_w ||
                        (battery.totalCapacityKwh
                          ? Math.max(1, Math.round(battery.totalCapacityKwh / 2.7)) * 800
                          : 800);
    
    const gridPower = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;
    const dischargeNow = batteryPower < 0 ? Math.abs(batteryPower) : 0;
    const currentLoad = gridPower > 0 ? gridPower + dischargeNow : 0;

    if (currentLoad === 0) return;

    const canCover = currentLoad <= maxDischarge;
    const coverageRatio = currentLoad > 0 ? Math.min(currentLoad / maxDischarge, 1.0) : 0;

    const actualDischargeText = dischargeNow > 0 ? ` [nu: ${Math.round(dischargeNow)}W]` : '';

    if (canCover) {
      reasons.push({
        icon: '✅',
        category: 'load',
        text: `Batterij kan huidige belasting volledig dekken (load: ${currentLoad}W, capaciteit: ${maxDischarge}W${actualDischargeText}).`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    } else {
      const uncovered = currentLoad - maxDischarge;
      reasons.push({
        icon: '⚠️',
        category: 'load',
        text: `Batterij kan slechts ${Math.round(coverageRatio * 100)}% dekken (capaciteit: ${maxDischarge}W, load: ${currentLoad}W${actualDischargeText} — ${uncovered}W blijft van net).`,
        impact: 'high',
        sentiment: 'negative',
        supportedMode: 'discharge'
      });
    }
  }

  _addTariffReasons(reasons, tariff, settings, tariffType, inputs) {
    if (!tariff) return;

    if (tariffType === 'fixed') {
      reasons.push({
        icon: '💰',
        category: 'tariff',
        text: 'Vast tarief actief — focus op peak‑shaving.',
        impact: 'low',
        sentiment: 'neutral',
        supportedMode: 'discharge'
      });
      return;
    }

    const price = inputs.effectivePrice;
    const maxChargePrice = settings.max_charge_price || 0;
    const minDischargePrice = settings.min_discharge_price || 0;
    const fmt = (v) => typeof v === 'number' ? `€${v.toFixed(3)}` : 'onbekend';

    if (inputs.batteryCost?.avgCost > 0) {
      const breakEven = inputs.batteryCost.breakEven;

      if (price > breakEven + 0.01) {
        reasons.push({
          icon: '💰',
          category: 'tariff',
          impact: 'high',
          sentiment: 'positive',
          text: `Huidige prijs (${fmt(price)}) ligt boven break‑even (${fmt(breakEven)}) — ontladen is winstgevend.`,
          supportedMode: 'discharge'
        });
      } else if (price < breakEven - 0.01) {
        reasons.push({
          icon: '📉',
          category: 'tariff',
          impact: 'high',
          sentiment: 'positive',
          text: `Huidige prijs (${fmt(price)}) ligt onder jouw break-even (${fmt(breakEven)}) — laden is goedkoop.`,
          supportedMode: 'charge'
        });
      } else {
        reasons.push({
          icon: '⚖️',
          category: 'tariff',
          impact: 'medium',
          sentiment: 'neutral',
          text: `Prijs ligt rond break‑even (${fmt(price)} ≈ ${fmt(breakEven)}) — batterij behouden.`,
          supportedMode: 'preserve'
        });
      }
    }

    const isTop3Cheap = Array.isArray(tariff.top3Lowest) &&
      tariff.top3Lowest.some(p => Math.abs((p.price ?? p) - price) < 0.00001);

    const isTop3Expensive = Array.isArray(tariff.top3Highest) &&
      tariff.top3Highest.some(p => Math.abs((p.price ?? p) - price) < 0.00001);

    if (isTop3Expensive) {
      const battery = inputs.battery;
      const p1 = inputs.p1;
      const maxDischarge = battery?.maxDischargePowerW || 800;
      const currentLoad = p1?.resolved_gridPower > 0 ? p1.resolved_gridPower : 0;

      if (currentLoad > 0) {
        const savingsPerHour = (Math.min(currentLoad, maxDischarge) / 1000) * price;
        reasons.push({
          icon: '🔥',
          category: 'tariff',
          text: `TOP-3 DUURSTE UUR (${fmt(price)}) — besparing €${savingsPerHour.toFixed(2)}/uur door batterij te gebruiken.`,
          impact: 'critical',
          sentiment: 'positive',
          supportedMode: 'discharge'
        });
      } else {
        reasons.push({
          icon: '🔥',
          category: 'tariff',
          text: `TOP-3 DUURSTE UUR (${fmt(price)}) — batterij beschermen voor wanneer belasting komt.`,
          impact: 'critical',
          sentiment: 'positive',
          supportedMode: 'preserve'
        });
      }
      return;
    }

    if (isTop3Cheap) {
      const EFFICIENCY = inputs.batteryEfficiency ?? 0.75;
      const futurePrice = Array.isArray(tariff.top3Highest) && tariff.top3Highest[0]
        ? (tariff.top3Highest[0].price ?? tariff.top3Highest[0])
        : minDischargePrice;

      const profit = (futurePrice * EFFICIENCY) - price;

      if (profit > 0.05) {
        reasons.push({
          icon: '⚡',
          category: 'tariff',
          text: `TOP-3 GOEDKOOPSTE UUR (${fmt(price)}) — winst €${profit.toFixed(3)}/kWh bij RTE ${(EFFICIENCY * 100).toFixed(0)}%.`,
          impact: 'critical',
          sentiment: 'positive',
          supportedMode: 'charge'
        });
      } else {
        reasons.push({
          icon: '⚠️',
          category: 'tariff',
          text: `TOP-3 GOEDKOOPSTE UUR (${fmt(price)}) maar marginale winst (€${profit.toFixed(3)}/kWh na verlies).`,
          impact: 'medium',
          sentiment: 'neutral',
          supportedMode: 'preserve'
        });
      }
      return;
    }

    if (typeof price === 'number' && price <= maxChargePrice) {
      const minProfitable = price * 1.25;
      if (minDischargePrice >= minProfitable) {
        reasons.push({
          icon: '💰',
          category: 'tariff',
          text: `Stroom goedkoop (${fmt(price)}) — winstgevend bij ontladen op €${minDischargePrice.toFixed(3)}.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'charge'
        });
      } else {
        reasons.push({
          icon: '⚠️',
          category: 'tariff',
          text: `Stroom goedkoop (${fmt(price)}) maar spread te klein — moet €${minProfitable.toFixed(3)}+ worden voor winst.`,
          impact: 'medium',
          sentiment: 'neutral',
          supportedMode: 'preserve'
        });
      }
    }

    if (typeof price === 'number' && price >= minDischargePrice) {
      reasons.push({
        icon: '💰',
        category: 'tariff',
        text: `Stroomprijs hoog (${fmt(price)}) — ontladen voorkomt dure netstroom.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    }

    if (typeof price === 'number' && price <= 0.05) {
      reasons.push({
        icon: '⚡',
        category: 'tariff',
        text: `Extreem lage prijs (${fmt(price)}) — zelfs na 25% verlies winstgevend.`,
        impact: 'critical',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    }

    if (typeof price === 'number' && price >= 0.40) {
      reasons.push({
        icon: '🔥',
        category: 'tariff',
        text: `Extreem hoge prijs (${fmt(price)}) — maximale besparing door batterij.`,
        impact: 'critical',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    }
  }

  _addArbitrageReasons(reasons, inputs) {
    const cost = inputs.batteryCost;
    const price = inputs.effectivePrice;

    if (!cost || typeof price !== 'number') return;

    const avg = cost.avgCost;
    const breakEven = cost.breakEven;

    if (avg <= 0) return;

    const fmt = (v) => `€${v.toFixed(3)}`;

    const minDischargePrice = inputs.settings?.min_discharge_price ?? 0;
    if (price > breakEven + 0.01) {
      if (minDischargePrice > 0 && price < minDischargePrice) {
        reasons.push({
          icon: '⚖️',
          category: 'arbitrage',
          impact: 'medium',
          sentiment: 'neutral',
          text: `Prijs (${fmt(price)}) boven break‑even (${fmt(breakEven)}) maar onder min. ontlaadprijs (€${minDischargePrice.toFixed(3)}) — ontladen geblokkeerd.`,
          supportedMode: 'preserve'
        });
      } else {
        reasons.push({
          icon: '💰',
          category: 'arbitrage',
          impact: 'high',
          sentiment: 'positive',
          text: `Ontladen is winstgevend: huidige prijs (${fmt(price)}) ligt boven break‑even (${fmt(breakEven)}).`,
          supportedMode: 'discharge'
        });
      }
      return;
    }

    if (price < breakEven - 0.01) {
      reasons.push({
        icon: '📉',
        category: 'arbitrage',
        impact: 'high',
        sentiment: 'positive',
        text: `Laden is goedkoop: huidige prijs (${fmt(price)}) ligt onder jouw break-even prijs (${fmt(breakEven)}).`,
        supportedMode: 'charge'
      });
      return;
    }

    reasons.push({
      icon: '⚖️',
      category: 'arbitrage',
      impact: 'medium',
      sentiment: 'neutral',
      text: `Prijs ligt rond break‑even (${fmt(price)} ≈ ${fmt(breakEven)}) — batterij behouden.`,
      supportedMode: 'preserve'
    });
  }

  _addPVReasons(reasons, inputs) {
    const p1 = inputs?.p1;
    if (!p1) {
      reasons.push({
        icon: '🌥️',
        category: 'pv',
        text: `Geen PV‑gegevens beschikbaar.`,
        impact: 'low',
        sentiment: 'neutral',
        supportedMode: null
      });
      return;
    }

    const gridPower = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;

    if (gridPower < -150) {
      const exportPower = Math.abs(gridPower);
      // Mirror policy-engine PV OVERSCHOT: compare export-now vs store-for-later
      const _price = inputs.effectivePrice ?? null;
      const _eff   = (inputs.settings?.battery_efficiency) ?? 0.75;
      const _pricesArr = inputs.tariff?.allPrices || inputs.tariff?.next24Hours || [];
      const _now = new Date();
      const _futurePrices = _pricesArr
        .filter(h => h.timestamp ? new Date(h.timestamp) > _now : (h.index ?? 0) >= 1)
        .map(h => h.price).filter(p => typeof p === 'number' && p > 0);
      const _maxFuture = _futurePrices.length ? Math.max(..._futurePrices) : null;
      const _storeValue = _maxFuture !== null ? _maxFuture * _eff : null;
      const _exportWins = _price !== null && _storeValue !== null && _price > _storeValue;

      if (_exportWins) {
        reasons.push({
          icon: '⚡',
          category: 'pv',
          text: `PV-overschot (${exportPower}W export) — export naar net winstgevender (€${_price.toFixed(3)} > €${_maxFuture.toFixed(3)} × ${_eff} = €${_storeValue.toFixed(3)}). Stand-by aanbevolen.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'preserve'
        });
      } else {
        reasons.push({
          icon: '☀️',
          category: 'pv',
          text: `PV-overschot gedetecteerd (${exportPower}W export) — opslaan winstgevender dan exporteren nu.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'charge'
        });
      }
      return;
    }

    if (batteryPower > 150 && gridPower <= 0) {
      reasons.push({
        icon: '🔋',
        category: 'pv',
        text: `Batterij wordt geladen door PV (${Math.round(batteryPower)}W) — geen conversieverlies.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
      return;
    }

    const weather = inputs.weather || {};
    const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
    const soc = inputs.battery?.stateOfCharge ?? 50;

    if (sunTomorrow >= 4.0 && soc > 50) {
      reasons.push({
        icon: '🌅',
        category: 'pv',
        text: `Geen PV nu, maar ${sunTomorrow.toFixed(1)}h zon morgen — batterij heeft vrije zonenergie (${soc}%), gebruik deze nu.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    } else {
      reasons.push({
        icon: '🌥️',
        category: 'pv',
        text: `Geen PV-opwek — grid laden kost 25% conversieverlies.`,
        impact: 'medium',
        sentiment: 'neutral',
        supportedMode: 'preserve'
      });
    }
  }

  _addWeatherReasons(reasons, weather) {
    if (!weather) return;

    const sun4h = weather.sunshineNext4Hours || 0;
    const sun8h = weather.sunshineNext8Hours || 0;
    const sunTomorrow = weather.sunshineTomorrow || 0;

    if (sun4h >= 2) {
      reasons.push({
        icon: '☀️',
        category: 'weather',
        text: `Sterke zon binnen 4 uur (${sun4h.toFixed(1)}h) — batterij kan gratis geladen worden.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    } else if (sun4h >= 1) {
      reasons.push({
        icon: '🌤️',
        category: 'weather',
        text: `Matige zon binnen 4 uur (${sun4h.toFixed(1)}h).`,
        impact: 'medium',
        sentiment: 'neutral',
        supportedMode: 'charge'
      });
    }

    if (sun8h >= 3 && sun4h < 2) {
      reasons.push({
        icon: '🌤️',
        category: 'weather',
        text: `Zon later vandaag verwacht (${sun8h.toFixed(1)}h over 4-8 uur).`,
        impact: 'medium',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    }

    if (sunTomorrow >= 4) {
      reasons.push({
        icon: '🌅',
        category: 'weather',
        text: `Goede zon morgen verwacht (${sunTomorrow.toFixed(1)}h) — batterij kan dan gratis laden.`,
        impact: 'low',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    }
  }

  _addSunForecastReasons(reasons, inputs) {
    const weather = inputs.weather;
    const sun = inputs.sun;
    const tariff = inputs.tariff;

    if (!weather || !tariff) return;

    const price = tariff.currentPrice;
    const maxChargePrice = inputs.settings?.max_charge_price || 0;
    
    const isCheap = price <= maxChargePrice;
    if (!isCheap) return;

    const sun4h = weather.sunshineNext4Hours || 0;
    const sunToday = weather.sunshineTodayRemaining || 0;

    const gfsScore = sun?.gfs || 0;
    const harmonieScore = sun?.harmonie || 0;
    const avgModelScore = (gfsScore + harmonieScore) / 2;

    const totalSun = Math.max(sun4h, sunToday, avgModelScore / 10);

    if (totalSun >= 3) {
      reasons.push({
        icon: '🌞',
        category: 'sun_forecast',
        text: `Goede zon verwacht (${totalSun.toFixed(1)}h) — grid laden overslaan, wacht op gratis PV.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    } else if (totalSun < 2) {
      reasons.push({
        icon: '☁️',
        category: 'sun_forecast',
        text: `Weinig zon verwacht (${totalSun.toFixed(1)}h) — grid laden nodig voor dure uren.`,
        impact: 'medium',
        sentiment: 'neutral',
        supportedMode: 'charge'
      });
    }
  }

  _addEfficiencyReasons(reasons, inputs) {
    const tariff = inputs.tariff;
    const settings = inputs.settings;
    const policyMode = inputs.policyMode;

    if (!tariff || !settings) return;

    const price = tariff.currentPrice;
    const maxChargePrice = settings.max_charge_price || 0;
    const minDischargePrice = settings.min_discharge_price || 0;

    if (policyMode === 'charge' || (price && price <= maxChargePrice)) {
      const EFFICIENCY = inputs.batteryEfficiency ?? 0.75;
      const minProfitable = price / EFFICIENCY;

      if (minDischargePrice < minProfitable) {
        const loss = price * (1 - EFFICIENCY);
        reasons.push({
          icon: '⚠️',
          category: 'RTE',
          text: `RTE-verlies ${((1 - EFFICIENCY) * 100).toFixed(0)}% (€${loss.toFixed(3)}/kWh) — spread te klein voor winst.`,
          impact: 'medium',
          sentiment: 'negative',
          supportedMode: 'preserve'
        });
      }
    }
  }

  _addDelayChargeReasons(reasons, inputs, recommendation) {
    if (!inputs._delayCharge) return;

    const price = inputs.effectivePrice;
    const fmt = (v) => typeof v === 'number' ? `€${v.toFixed(3)}` : 'onbekend';
    const hwMode = recommendation?.hwMode;

    if (hwMode === 'zero_discharge_only') {
      reasons.push({
        icon: '☀️',
        category: 'strategy',
        text: `PV-export + ontladen: zonne-energie gaat naar net (${fmt(price)}/kWh) terwijl batterij huishoudelijk verbruik dekt. Batterij laadt later bij goedkopere uren.`,
        impact: 'critical',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    } else {
      reasons.push({
        icon: '☀️',
        category: 'strategy',
        text: `PV-export strategie: zonne-energie gaat naar net (${fmt(price)}/kWh), batterij laadt later bij goedkopere prijzen.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    }
  }

  _addPeakShavingReasons(reasons, inputs) {
    if (inputs.settings.tariff_type !== 'fixed') return;

    const time = inputs.time;
    const settings = inputs.settings;
    
    if (!time || !settings.peak_hours) return;

    const hour = time.getHours();
    const [startHour, endHour] = settings.peak_hours.split('-').map(h => parseInt(h, 10));

    if (hour >= startHour && hour < endHour) {
      reasons.push({
        icon: '📊',
        category: 'peak',
        text: `Piekuren (${startHour}:00-${endHour}:00) — batterij gebruiken om netpieken te scheren.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    }
  }

  _addTimeReasons(reasons, time) {
    if (!time) return;

    const hour = time.getHours();

    if (hour >= 17 && hour < 22) {
      reasons.push({
        icon: '⏰',
        category: 'time',
        text: `Avonduren (${hour}:00) — hogere huishoudelijke consumptie verwacht.`,
        impact: 'medium',
        sentiment: 'neutral',
        supportedMode: 'discharge'
      });
    }

    if (hour >= 2 && hour < 6) {
      reasons.push({
        icon: '🌙',
        category: 'time',
        text: `Nachturen (${hour}:00) — vaak goedkope tarieven voor laden.`,
        impact: 'low',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    }
  }

  _addConfidenceReason(reasons, recommendation, inputs) {
    const c = Math.round(recommendation.confidence);
    const MODE_LABELS_NL = {
      zero_charge_only: 'Zon-laden',
      zero_discharge_only: 'Ontladen (zon-export)',
      to_full: 'Vol-laden',
      standby: 'Stand-by',
      zero: 'Net-0',
      charge: 'Laden',
      discharge: 'Ontladen',
      preserve: 'Bewaren'
    };
    const mode = recommendation.hwMode || recommendation.policyMode;
    const modeLabel = MODE_LABELS_NL[mode] || mode || '?';

    const MODE_SUPPORTED = {
      zero_charge_only: 'charge', to_full: 'charge',
      zero_discharge_only: 'discharge',
      standby: 'preserve', zero: 'preserve', preserve: 'preserve'
    };
    const supportedMode = MODE_SUPPORTED[mode] ?? null;

    const prev = inputs?.previousHwMode ?? null;
    const prevLabel = prev ? (MODE_LABELS_NL[prev] || prev) : null;
    const transition = prevLabel && prev !== mode ? ` (was: ${prevLabel})` : '';

    if (c >= 90) {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Zeer hoge zekerheid (${c}%) voor keuze: ${modeLabel}${transition}.`,
        impact: 'low',
        sentiment: 'positive',
        supportedMode
      });
    } else if (c >= 70) {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Hoge zekerheid (${c}%) voor keuze: ${modeLabel}${transition}.`,
        impact: 'low',
        sentiment: 'positive',
        supportedMode
      });
    } else if (c >= 50) {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Redelijke zekerheid (${c}%) voor keuze: ${modeLabel}${transition} — meerdere factoren in balans.`,
        impact: 'low',
        sentiment: 'neutral',
        supportedMode
      });
    } else {
      reasons.push({
        icon: '⚠️',
        category: 'confidence',
        text: `Lage zekerheid (${c}%) voor keuze: ${modeLabel}${transition} — scores lagen dicht bij elkaar.`,
        impact: 'low',
        sentiment: 'neutral',
        supportedMode
      });
    }
  }

  _generateSummary(recommendation, reasons, inputs) {
    const hw = recommendation.hwMode;
    const policy = recommendation.policyMode;

    const MODE_LABELS_NL = {
      zero_charge_only: 'batterij PV-only te laten laden',
      zero_discharge_only: 'batterij te gebruiken voor huishoudelijk verbruik',
      to_full: 'batterij van het net te laden',
      standby: 'batterij stand-by te zetten',
      zero: 'net-0 te handhaven',

      charge: 'batterij te laden',
      discharge: 'batterij te ontladen',
      preserve: 'batterij te beschermen'
    };

    const action = MODE_LABELS_NL[hw] || MODE_LABELS_NL[policy] || 'batterij te beheren';

    const topReasons = reasons
      .filter(r => ['critical', 'high', 'medium'].includes(r.impact))
      .slice(0, 3)
      .map(r => r.text.toLowerCase().replace(/\.$/, ''))
      .join(', ');

    if (topReasons) {
      return `Advies: ${action}. Reden: ${topReasons}.`;
    }

    return `Advies: ${action}.`;
  }

  _impactWeight(impact) {
    return { critical: 4, high: 3, medium: 2, low: 1 }[impact] || 0;
  }
}

module.exports = ExplainabilityEngine;