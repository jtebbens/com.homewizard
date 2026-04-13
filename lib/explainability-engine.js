'use strict';

class ExplainabilityEngine {
  constructor(homey) {
    this.homey = homey;
    this.log = homey.log.bind(homey);
  }

  generateExplanation(recommendation, inputs, scores) {
    const policyMode = recommendation.policyMode || recommendation.mode;
    const hwMode = recommendation.hwMode || null;

    // DP-primary path: use DP decision context directly
    if (inputs?.dpDecision) {
      const summary      = this._generateDpSummary(recommendation, inputs);
      const shortSummary = this._generateDpShortSummary(recommendation, inputs);
      return {
        recommendation: hwMode || policyMode,
        policyMode,
        hwMode,
        confidence:        recommendation.confidence,
        reasons:           this._buildDpReasons(recommendation, inputs),
        warnings:          [],
        scores:            scores || { charge: 0, discharge: 0, preserve: 0 },
        summary,
        shortSummary,
        timestamp:         new Date().toISOString(),
        batteryCost:       inputs.batteryCost,
        batteryEfficiency: inputs.batteryEfficiency,
        effectivePrice:    inputs.effectivePrice ?? inputs.tariff?.currentPrice ?? null,
      };
    }

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
    this._addModeSpecificReasons(reasons, inputs, normalized);
    this._addConfidenceReason(reasons, recommendation, inputs);

    // Score-reasons explain WHY policyMode won (charge/discharge/preserve).
    // hwMode may differ due to mapping constraints (e.g. charge → standby when price too high).
    // Filter on policyMode so score-reasons stay visible, then prepend mapping explanation.
    const MODE_SUPPORTED = {
      zero_charge_only: 'charge', to_full: 'charge',
      zero_discharge_only: 'discharge',
      standby: 'preserve', zero: 'preserve', preserve: 'preserve'
    };
    const policyCategory = normalized.policyMode; // 'charge' | 'discharge' | 'preserve'
    const hwCategory     = MODE_SUPPORTED[normalized.hwMode] ?? null;

    const mappingReason = this._buildMappingReason(normalized, inputs, scores);
    if (mappingReason) reasons.unshift(mappingReason);

    const filteredReasons = policyCategory
      ? reasons.filter(r => r.supportedMode === policyCategory || r.supportedMode === null)
      : reasons;

    // Sort by impact (mapping reason stays first via 'critical' impact)
    filteredReasons.sort((a, b) => this._impactWeight(b.impact) - this._impactWeight(a.impact));

    const summary = this._generateSummary(recommendation, filteredReasons, inputs);
    const shortSummary = this._generateShortSummary(recommendation, inputs);

    return {
      recommendation: hwMode || policyMode,
      policyMode,
      hwMode,
      confidence: recommendation.confidence,
      reasons: filteredReasons.slice(0, 8),
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

  // ── DP-primary summary (full) ─────────────────────────────────────────────
  _generateDpSummary(recommendation, inputs) {
    const dp        = inputs.dpDecision;
    const action    = dp.finalAction;
    const exception = dp.exception;
    const price     = inputs.effectivePrice ?? inputs.tariff?.currentPrice ?? null;
    const breakEven = dp.breakEven;
    const soc       = inputs.battery?.stateOfCharge ?? 50;
    const minSoc    = inputs.settings?.min_soc ?? 0;
    const maxSoc    = inputs.settings?.max_soc ?? 95;

    const priceStr    = price     != null ? `€${price.toFixed(3)}`     : null;
    const beStr       = breakEven != null ? `€${breakEven.toFixed(3)}` : null;
    const futStr      = dp.maxFuturePrice != null ? `€${dp.maxFuturePrice.toFixed(3)}` : null;

    if (exception === 'no_optimizer') {
      return 'Advies: bewaren. Reden: geen planningsdata — wacht op eerste optimalisatierun.';
    }
    if (exception === 'soc_too_low') {
      return `Advies: bewaren. Reden: SoC ${soc}% is gelijk aan of lager dan minimum (${minSoc}%) — ontladen geblokkeerd.`;
    }
    if (exception === 'soc_full') {
      return `Advies: bewaren. Reden: SoC ${soc}% is vol (max ${maxSoc}%) — opladen niet nodig.`;
    }
    if (exception === 'pv_store_wins') {
      const fut = inputs._pvStoreValue != null ? `€${inputs._pvStoreValue.toFixed(3)}` : futStr;
      const now = inputs._pvCurrentPrice != null ? `€${inputs._pvCurrentPrice.toFixed(3)}` : priceStr;
      return `Advies: opladen. Reden: PV surplus — opslaan (${fut ?? '?'}/kWh) is waardevoller dan nu exporteren (${now ?? '?'}).`;
    }
    if (exception === 'delay_charge') {
      return `Advies: stand-by. Reden: PV exporteert nu naar net${priceStr ? ` (${priceStr})` : ''} — laden uitgesteld naar goedkoper moment.`;
    }
    if (exception === 'peak_shaving') {
      const load = inputs.batteryLimits?.currentLoad;
      const loadStr = load != null ? `${Math.round(load)}W` : null;
      return `Advies: ontladen. Reden: piekverbruik${loadStr ? ` (${loadStr})` : ''} overschrijdt drempelwaarde — batterij dekt huislast.`;
    }

    // DP followed, no exception
    if (action === 'discharge') {
      let parts = [`DP gepland: ontladen`];
      if (priceStr) parts.push(`prijs ${priceStr}`);
      if (beStr)    parts.push(`boven break-even ${beStr}`);
      return `Advies: ontladen. Reden: ${parts.join(', ')}.`;
    }
    if (action === 'charge') {
      let parts = [`DP gepland: opladen`];
      if (priceStr) parts.push(`goedkope stroom ${priceStr}`);
      return `Advies: opladen. Reden: ${parts.join(', ')}.`;
    }
    // preserve
    let reason = 'DP gepland: bewaren';
    if (futStr && priceStr && dp.maxFuturePrice > (price ?? 0) * 1.05) {
      reason += ` — hogere prijs verwacht ${futStr} vs nu ${priceStr}`;
    }
    return `Advies: bewaren. Reden: ${reason}.`;
  }

  // ── DP-primary short summary (capability display) ─────────────────────────
  _generateDpShortSummary(recommendation, inputs) {
    const hw        = recommendation.hwMode;
    const dp        = inputs.dpDecision;
    const price     = inputs.effectivePrice ?? inputs.tariff?.currentPrice ?? null;
    const soc       = inputs.battery?.stateOfCharge;
    const breakEven = dp.breakEven;

    const HW_NL = {
      zero_charge_only:    'Zon‑laden',
      zero_discharge_only: 'Ontladen',
      to_full:             'Vol‑laden',
      standby:             'Stand‑by',
      zero:                'Net‑0',
    };
    const label = HW_NL[hw] || hw?.toUpperCase() || '?';
    const parts = [label];
    if (typeof soc   === 'number') parts.push(`${soc}%`);
    if (typeof price === 'number') parts.push(`€${price.toFixed(3)}`);

    const exc = dp.exception;
    if (exc === 'no_optimizer')  { parts.push('geen planning'); }
    else if (exc === 'soc_too_low') { parts.push('SoC te laag'); }
    else if (exc === 'soc_full')    { parts.push('vol'); }
    else if (exc === 'pv_store_wins') { parts.push('PV opslaan'); }
    else if (exc === 'delay_charge')  { parts.push('PV→net'); }
    else if (exc === 'peak_shaving')  { parts.push('piek'); }
    else {
      // DP followed
      if (dp.finalAction === 'preserve' && dp.maxFuturePrice && price) {
        parts.push(`→${dp.maxFuturePrice.toFixed(3)}`);
      } else if (dp.finalAction === 'discharge' && breakEven != null && price != null) {
        const margin = price - breakEven;
        parts.push(`${margin >= 0 ? '+' : ''}€${margin.toFixed(3)}/kWh`);
      }
    }
    return parts.join(' ');
  }

  _buildDpReasons(recommendation, inputs) {
    const dp        = inputs.dpDecision;
    const exception = dp.exception;
    const action    = dp.finalAction;
    const price     = inputs.effectivePrice ?? inputs.tariff?.currentPrice ?? null;
    const breakEven = dp.breakEven;
    const soc       = inputs.battery?.stateOfCharge ?? 50;
    const minSoc    = inputs.settings?.min_soc ?? 0;
    const maxSoc    = inputs.settings?.max_soc ?? 95;
    const priceStr  = price     != null ? `€${price.toFixed(3)}`     : null;
    const beStr     = breakEven != null ? `€${breakEven.toFixed(3)}` : null;
    const futStr    = dp.maxFuturePrice != null ? `€${dp.maxFuturePrice.toFixed(3)}` : null;

    const reasons = [];

    if (exception === 'no_optimizer') {
      reasons.push({ impact: 'medium', category: 'strategy', supportedMode: 'preserve', icon: '⏳', text: 'Geen planningsdata — wacht op eerste optimalisatierun.' });
    } else if (exception === 'soc_too_low') {
      reasons.push({ impact: 'critical', category: 'battery', supportedMode: 'preserve', icon: '🔋', text: `SoC ${soc}% is gelijk aan of lager dan minimum (${minSoc}%) — ontladen geblokkeerd.` });
    } else if (exception === 'soc_full') {
      reasons.push({ impact: 'high', category: 'battery', supportedMode: 'preserve', icon: '🔋', text: `SoC ${soc}% is vol (max ${maxSoc}%) — opladen niet nodig.` });
    } else if (exception === 'pv_store_wins') {
      const fut = inputs._pvStoreValue != null ? `€${inputs._pvStoreValue.toFixed(3)}` : futStr;
      const now = inputs._pvCurrentPrice != null ? `€${inputs._pvCurrentPrice.toFixed(3)}` : priceStr;
      reasons.push({ impact: 'high', category: 'pv', supportedMode: 'charge', icon: '☀️', text: `PV surplus — opslaan (${fut ?? '?'}/kWh) is waardevoller dan nu exporteren (${now ?? '?'}).` });
    } else if (exception === 'delay_charge') {
      reasons.push({ impact: 'high', category: 'pv', supportedMode: 'preserve', icon: '⏸️', text: `PV exporteert nu naar net${priceStr ? ` (${priceStr})` : ''} — laden uitgesteld.` });
    } else if (exception === 'peak_shaving') {
      const load = inputs.batteryLimits?.currentLoad;
      const loadStr = load != null ? `${Math.round(load)}W` : null;
      reasons.push({ impact: 'high', category: 'load', supportedMode: 'discharge', icon: '⚡', text: `Piekverbruik${loadStr ? ` ${loadStr}` : ''} — batterij dekt huislast.` });
    } else if (action === 'discharge') {
      let text = `DP gepland: ontladen`;
      if (priceStr) text += `, prijs ${priceStr}`;
      if (beStr)    text += `, break-even ${beStr}`;
      reasons.push({ impact: 'critical', category: 'strategy', supportedMode: 'discharge', icon: '🧠', text });
    } else if (action === 'charge') {
      let text = `DP gepland: opladen`;
      if (priceStr) text += `, goedkope stroom ${priceStr}`;
      reasons.push({ impact: 'critical', category: 'strategy', supportedMode: 'charge', icon: '🧠', text });
    } else {
      let text = `DP gepland: bewaren`;
      if (futStr && priceStr && dp.maxFuturePrice > (price ?? 0) * 1.05) {
        text += ` — hogere prijs verwacht ${futStr} vs nu ${priceStr}`;
      }
      reasons.push({ impact: 'critical', category: 'strategy', supportedMode: 'preserve', icon: '🧠', text });
    }

    return reasons;
  }

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
      predictive: 'Slim laden',

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
        parts.push(`+€${(price - breakEven).toFixed(3)}/kWh`); // prijs boven break-even
      } else if (price < breakEven - 0.01) {
        parts.push(`-€${(breakEven - price).toFixed(3)}/kWh`); // prijs onder break-even
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
    // Mirror policy-engine: no hardcoded floor — respect user's min_soc setting
    const zeroModeThreshold = minSoc ?? 0;

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
          text: `Batterij op 0% — laden nu niet rendabel (laadprijs €${_price.toFixed(3)} > verwachte ontlaadwaarde €${_maxFuture.toFixed(3)} × ${_eff.toFixed(2)} = €${_storeValue.toFixed(3)}). Stand-by aanbevolen.`,
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
      const fullText = maxSoc >= 100
        ? `Batterij volledig geladen (${soc}%).`
        : `Batterij boven ingestelde maximumwaarde (${soc}% ≥ ${maxSoc}%).`;
      const fullWarning = maxSoc >= 100
        ? `Batterij volledig geladen (${soc}%)`
        : `Batterij boven ingestelde maximumwaarde (${maxSoc}%)`;
      reasons.push({
        icon: '🔋',
        category: 'battery',
        text: fullText,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
      warnings.push(fullWarning);
      return;
    }

    if (soc > zeroModeThreshold && soc <= 10) {
      reasons.push({
        icon: '⚠️',
        category: 'battery',
        text: `Batterij erg laag (${soc}%) — laden aanbevolen.`,
        impact: 'high',
        sentiment: 'negative',
        supportedMode: 'charge'
      });
      return;
    }

    if (soc > 10 && soc <= 30) {
      if (inputs._pvStoreWins) {
        // PV surplus is being stored — low SoC is being addressed by free PV charging
        reasons.push({
          icon: '☀️',
          category: 'battery',
          text: `Batterij laag (${soc}%) — wordt geladen uit gratis PV-overschot.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'charge'
        });
      } else {
        reasons.push({
          icon: '⚠️',
          category: 'battery',
          text: `Batterij laag (${soc}%) — behouden voor dure uren.`,
          impact: 'high',
          sentiment: 'neutral',
          supportedMode: 'preserve'
        });
      }
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

    // ✅ FIX: HW firmware caps discharge at 800 W regardless of battery count
    const maxDischarge = battery.maxDischargePowerW || 800;
    
    const gridPower = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;
    const dischargeNow = batteryPower < 0 ? Math.abs(batteryPower) : 0;
    const currentLoad = gridPower > 0 ? gridPower + dischargeNow : 0;

    if (currentLoad === 0) return;

    const canCover = currentLoad <= maxDischarge;
    const coverageRatio = currentLoad > 0 ? Math.min(maxDischarge / currentLoad, 1.0) : 0;

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
    const respectMinMax = (inputs.settings?.policy_mode === 'balanced-dynamic')
      ? false
      : inputs.settings?.respect_minmax !== false;
    const _settingsFloor = (inputs.settings?.cycle_cost_per_kwh ?? 0.075) / (inputs.settings?.battery_efficiency || 0.75);
    const effectiveDischargeFloor = respectMinMax ? minDischargePrice : _settingsFloor;

    if (price > breakEven + 0.01) {
      if (effectiveDischargeFloor > 0 && price < effectiveDischargeFloor) {
        const blockReason = respectMinMax
          ? `onder min. ontlaadprijs (${fmt(minDischargePrice)})`
          : `onder opportunistische drempel (${fmt(oppDischargeFloor)})`;
        reasons.push({
          icon: '⚖️',
          category: 'arbitrage',
          impact: 'medium',
          sentiment: 'neutral',
          text: `Prijs (${fmt(price)}) boven break‑even (${fmt(breakEven)}) maar ${blockReason} — ontladen geblokkeerd.`,
          supportedMode: 'preserve'
        });
      } else {
        const consumptionW = inputs.consumptionW;
        const maxDischW = inputs.battery?.maxDischargePowerW || 800;
        const effKwh = consumptionW != null ? Math.min(maxDischW, consumptionW) / 1000 : null;
        const consumptionNote = effKwh != null
          ? ` Geschat verbruik: ${(consumptionW / 1000).toFixed(1)} kW → ~€${(price * effKwh).toFixed(3)}/u.`
          : '';
        reasons.push({
          icon: '💰',
          category: 'arbitrage',
          impact: 'high',
          sentiment: 'positive',
          text: `Ontladen is winstgevend: huidige prijs (${fmt(price)}) ligt boven break‑even (${fmt(breakEven)}).${consumptionNote}`,
          supportedMode: 'discharge'
        });
      }
      return;
    }

    if (price < breakEven - 0.01) {
      let dischargeNote = '';
      const slots = inputs.optimizerSlots;
      if (Array.isArray(slots)) {
        const now = new Date();
        const best = slots
          .filter(s => new Date(s.timestamp) > now && s.action === 'discharge' && s.price != null)
          .sort((a, b) => b.price - a.price)[0];
        if (best) {
          const t = new Date(best.timestamp);
          const timeLabel = t.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }).padStart(2, '0') + ':00';
          const margin = best.price - price;
          dischargeNote = ` Beste ontlaadslot: ${timeLabel} bij ${fmt(best.price)} → nettomarge ~${fmt(margin)}/kWh.`;
        }
      }
      reasons.push({
        icon: '📉',
        category: 'arbitrage',
        impact: 'high',
        sentiment: 'positive',
        text: `Laden is goedkoop: huidige prijs (${fmt(price)}) ligt onder jouw break-even prijs (${fmt(breakEven)}).${dischargeNote}`,
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
      const _exportMargin = (_price !== null && _storeValue !== null) ? _price - _storeValue : null;
      const _soc = inputs.battery?.stateOfCharge ?? 50;
      const _lowSocMarginRequired = _soc < 50 ? 0.02 : 0;
      // Mirror policy-engine: export only wins if margin exceeds low-SoC threshold
      const _exportWins = _exportMargin !== null && _exportMargin > 0 && _exportMargin >= _lowSocMarginRequired;

      if (_exportWins) {
        const delayNote = inputs._delayCharge ? `, batterij laadt later bij goedkopere prijzen` : '';
        reasons.push({
          icon: '⚡',
          category: 'pv',
          text: `PV-overschot (${exportPower}W export) — export naar net winstgevender (€${_price.toFixed(3)} > €${_maxFuture.toFixed(3)} × ${_eff.toFixed(2)} = €${_storeValue.toFixed(3)})${delayNote}.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'preserve'
        });
      } else if (_exportMargin !== null && _exportMargin > 0 && _exportMargin < _lowSocMarginRequired) {
        // Export margin exists but too thin at low SoC — store to avoid empty battery
        reasons.push({
          icon: '🔋',
          category: 'pv',
          text: `PV-overschot (${exportPower}W) — exportmarge €${_exportMargin.toFixed(3)}/kWh te klein bij SoC ${_soc}% → opslaan voor piekontlading later.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'charge'
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

    // Mirror policy-engine PV detection: virtual export = gridPower - batteryPower
    const virtualExport = gridPower - batteryPower;
    if (batteryPower > 150 && (gridPower <= 0 || virtualExport < -200)) {
      const exportPart = virtualExport < -200 ? `, ${Math.round(Math.abs(virtualExport))}W virtueel export` : '';
      reasons.push({
        icon: '🔋',
        category: 'pv',
        text: `Batterij wordt geladen door PV (${Math.round(batteryPower)}W${exportPart}) — geen conversieverlies.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
      return;
    }

    const weather = inputs.weather || {};
    const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);
    const soc = inputs.battery?.stateOfCharge ?? 50;
    const pvNowW = Math.round(inputs.p1?.pv_power_estimated ?? 0);
    const pvNowLabel = pvNowW > 50 ? `PV beperkt (${pvNowW}W)` : 'Geen PV nu';

    if (sunTomorrow >= 4.0 && soc > 50) {
      reasons.push({
        icon: '🌅',
        category: 'pv',
        text: `${pvNowLabel}, maar ${sunTomorrow.toFixed(1)}h zon morgen — batterij heeft vrije zonenergie (${soc}%), gebruik deze nu.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    } else if (pvNowW > 50) {
      reasons.push({
        icon: '☀️',
        category: 'pv',
        text: `PV actief (${pvNowW}W) — batterij laadt via zon.`,
        impact: 'medium',
        sentiment: 'positive',
        supportedMode: 'charge'
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
    const sunToday = weather.sunshineTodayRemaining || 0;
    const sunTomorrow = weather.sunshineTomorrow || 0;

    // Use remaining PV when available (more useful than full-day total mid-day)
    const pvKwhRemaining = weather.pvKwhRemaining ?? null;
    const pvKwhToday     = weather.pvKwhToday     ?? null;
    const pvKwhLabel = pvKwhRemaining != null
      ? `~${pvKwhRemaining} kWh resterend`
      : pvKwhToday != null
        ? `~${pvKwhToday} kWh vandaag`
        : null;
    const pvKwhSuffix = pvKwhLabel ? `, ${pvKwhLabel}` : '';

    if (sun4h >= 2) {
      reasons.push({
        icon: '☀️',
        category: 'weather',
        text: `Sterke zon komende 4 uur (${sun4h.toFixed(1)}h zonuren${pvKwhSuffix}) — batterij kan gratis geladen worden.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    } else if (sun4h >= 1) {
      reasons.push({
        icon: '🌤️',
        category: 'weather',
        text: `Matige zon komende 4 uur (${sun4h.toFixed(1)}h zonuren${pvKwhSuffix}).`,
        impact: 'medium',
        sentiment: 'neutral',
        supportedMode: 'charge'
      });
    }

    if (sun8h >= 3 && sun4h < 2) {
      reasons.push({
        icon: '🌤️',
        category: 'weather',
        text: `Zon later vandaag verwacht (${sun8h.toFixed(1)}h over 4-8 uur${pvKwhSuffix}).`,
        impact: 'medium',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    } else if (sunToday >= 2 && sun4h < 1) {
      reasons.push({
        icon: '⛅',
        category: 'weather',
        text: `Zon verwacht later vandaag (${sunToday.toFixed(1)}h zonuren resterend${pvKwhSuffix}).`,
        impact: 'medium',
        sentiment: 'positive',
        supportedMode: 'preserve'
      });
    } else if (sun4h < 1) {
      // Bewolkt/regen — geen noemenswaardige zon verwacht
      const pvLabel = pvKwhLabel ?? 'weinig PV';
      const sunLabel = sunToday > 0 ? `${sunToday.toFixed(1)}h zon resterend` : 'geen zonuren verwacht';
      reasons.push({
        icon: '🌧️',
        category: 'weather',
        text: `Bewolkt/regen vandaag — ${pvLabel} PV (${sunLabel}).`,
        impact: 'low',
        sentiment: 'neutral',
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
      // Skip "wait for PV" when PV surplus is already being stored
      if (!inputs._pvStoreWins) {
        reasons.push({
          icon: '🌞',
          category: 'sun_forecast',
          text: `Goede zon verwacht (${totalSun.toFixed(1)}h) — grid laden overslaan, wacht op gratis PV.`,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'preserve'
        });
      }
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
      // Skip RTE loss reason when charging from free PV — no charge cost means no RTE loss
      if (inputs._pvStoreWins) return;

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

    // If PV-overschot reason already covers the export story, skip the redundant strategy line
    const pvAlreadyExplained = reasons.some(r => r.category === 'pv' && r.supportedMode === 'preserve');

    if (hwMode === 'zero_discharge_only') {
      reasons.push({
        icon: '☀️',
        category: 'strategy',
        text: `PV-export + ontladen: zonne-energie gaat naar net (${fmt(price)}/kWh) terwijl batterij huishoudelijk verbruik dekt. Batterij laadt later bij goedkopere uren.`,
        impact: 'critical',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    } else if (!pvAlreadyExplained) {
      reasons.push({
        icon: '☀️',
        category: 'strategy',
        text: `Batterij laadt later bij goedkopere prijzen (nu ${fmt(price)}/kWh).`,
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

    const hour = parseInt(time.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);

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

  _addModeSpecificReasons(reasons, inputs, recommendation) {
    const hwMode = recommendation.hwMode;
    const price = inputs.effectivePrice;
    const fmt = (v) => typeof v === 'number' ? `€${v.toFixed(3)}` : '?';

    if (hwMode === 'zero' && inputs._pvStoreWins) {
      // _pvStoreWins → zero: bidirectional grid balancing from PV surplus
      const pvW = Math.round(inputs.p1?.pv_power_estimated ?? 0);
      const soc = inputs.battery?.stateOfCharge ?? 0;
      const battPower = Math.round(inputs.p1?.battery_power ?? 0);
      const gridPower = Math.round(inputs.p1?.resolved_gridPower ?? 0);
      const parts = [];
      if (pvW > 0) parts.push(`PV ${pvW}W`);
      if (battPower > 0) parts.push(`laden ${battPower}W`);
      else if (battPower < 0) parts.push(`ontladen ${Math.abs(battPower)}W`);
      if (gridPower !== 0) parts.push(`grid ${gridPower > 0 ? '+' : ''}${gridPower}W`);
      const statusLine = parts.length ? ` (${parts.join(', ')})` : '';
      reasons.push({
        icon: '⚡',
        category: 'mode',
        text: `Net-0 actief${statusLine} — batterij laadt uit PV-overschot én ontlaadt bij verbruikspieken. SoC ${soc}%.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    } else if (hwMode === 'zero' && recommendation.policyMode === 'discharge') {
      // discharge + PV → zero: peak shaving with PV recharging
      const pvW = Math.round(inputs.p1?.pv_power_estimated ?? 0);
      const soc = inputs.battery?.stateOfCharge ?? 0;
      const battPower = Math.round(inputs.p1?.battery_power ?? 0);
      const gridPower = Math.round(inputs.p1?.resolved_gridPower ?? 0);
      const parts = [];
      if (pvW > 0) parts.push(`PV ${pvW}W`);
      if (battPower > 0) parts.push(`laden ${battPower}W`);
      else if (battPower < 0) parts.push(`ontladen ${Math.abs(battPower)}W`);
      if (gridPower !== 0) parts.push(`grid ${gridPower > 0 ? '+' : ''}${gridPower}W`);
      const statusLine = parts.length ? ` (${parts.join(', ')})` : '';
      reasons.push({
        icon: '⚡',
        category: 'mode',
        text: `Net-0 peak shaving${statusLine} — PV-overschot vult batterij aan, ontlading dekt pieken. SoC ${soc}%.`,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'discharge'
      });
    }

    if (hwMode === 'standby' && recommendation.policyMode === 'preserve') {
      const slots = inputs.optimizerSlots;
      const currentPrice = inputs.effectivePrice;

      if (slots) {
        const now = new Date();
        const upcoming = slots
          .filter(s => {
            if (new Date(s.timestamp) <= now || s.action !== 'discharge') return false;
            // Only show slots that are actually more expensive than now —
            // showing cheaper future slots contradicts "current price too low"
            return typeof currentPrice !== 'number' || s.price > currentPrice;
          })
          .slice(0, 3);

        if (upcoming.length > 0) {
          const slotLabels = upcoming.map(s => {
            const t = new Date(s.timestamp);
            const timeLabel = t.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            return `${timeLabel} (${fmt(s.price)})`;
          });
          const priceNote = typeof currentPrice === 'number' ? ` Huidige prijs ${fmt(currentPrice)} te laag om nu te ontladen.` : '';
          reasons.push({
            icon: '🔋',
            category: 'arbitrage',
            text: `Batterij bewaard voor geplande ontlaadbeurten: ${slotLabels.join(', ')}.${priceNote}`,
            impact: 'high',
            sentiment: 'positive',
            supportedMode: 'preserve'
          });
        }
      }
    }

    if (hwMode === 'to_full') {
      const slots = inputs.optimizerSlots;
      const currentPrice = inputs.effectivePrice;
      const cycleCost = inputs.settings?.cycle_cost ?? 0.075;

      let text;
      if (slots && typeof currentPrice === 'number') {
        const now = new Date();
        const bestDischarge = slots
          .filter(s => new Date(s.timestamp) > now && s.action === 'discharge')
          .sort((a, b) => b.price - a.price)[0];

        if (bestDischarge) {
          const margin = bestDischarge.price - currentPrice - cycleCost;
          const t = new Date(bestDischarge.timestamp);
          const timeLabel = t.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
          text = `Laden van net: ${fmt(currentPrice)}/kWh → verwacht ontladen om ${timeLabel} bij ${fmt(bestDischarge.price)}. Nettomarge: ${fmt(margin)}/kWh na cycluskosten.`;
        } else {
          text = `Laden van net: ${fmt(currentPrice)}/kWh — geen duurder ontlaadmoment in planningsvenster.`;
        }
      } else {
        text = 'Laden van net actief.';
      }

      reasons.push({
        icon: '⚡',
        category: 'tariff',
        text,
        impact: 'high',
        sentiment: 'positive',
        supportedMode: 'charge'
      });
    }

    if (hwMode === 'zero_charge_only') {
      // Only add if no meaningful charge-supporting reason exists yet
      const hasChargeReason = reasons.some(r => r.supportedMode === 'charge' && r.impact !== 'low');
      if (!hasChargeReason) {
        const minDischargePrice = inputs.settings?.min_discharge_price ?? 0;
        const maxChargePrice = inputs.settings?.max_charge_price ?? 0;
        const respectMinMax = (inputs.settings?.policy_mode === 'balanced-dynamic')
          ? false
          : inputs.settings?.respect_minmax !== false;
        const _settingsFloor = (inputs.settings?.cycle_cost_per_kwh ?? 0.075) / (inputs.settings?.battery_efficiency || 0.75);
        const effectiveDischargeFloor = respectMinMax ? minDischargePrice : _settingsFloor;

        const parts = [];
        if (effectiveDischargeFloor > 0 && typeof price === 'number' && price < effectiveDischargeFloor) {
          const blockLabel = respectMinMax
            ? `min. ontlaadprijs ${fmt(minDischargePrice)}`
            : `break-even ${fmt(effectiveDischargeFloor)}`;
          parts.push(`ontladen geblokkeerd (prijs ${fmt(price)} < ${blockLabel})`);
        }
        if (maxChargePrice > 0 && typeof price === 'number' && price > maxChargePrice) {
          parts.push(`grid laden te duur (${fmt(price)} > max. laadprijs ${fmt(maxChargePrice)})`);
        }

        const text = parts.length > 0
          ? `Modus Zon-laden actief — ${parts.join(', ')}. Batterij wacht op gratis PV-opwek.`
          : `Modus Zon-laden actief — batterij accepteert alleen gratis PV-opwek.`;

        reasons.push({
          icon: '🌤️',
          category: 'mode',
          text,
          impact: 'high',
          sentiment: 'positive',
          supportedMode: 'charge'
        });
      }
    }
  }

  /**
   * When policyMode and hwMode diverge (e.g. charge wins score but becomes standby
   * because price > max_charge_price and no PV), generate an explanation for the gap.
   */
  _buildMappingReason(normalized, inputs, scores) {
    const policyMode = normalized.policyMode;
    const hwMode     = normalized.hwMode;

    // No divergence
    if (policyMode === 'preserve' && (hwMode === 'standby' || hwMode === 'zero')) return null;
    if (policyMode === 'charge'   && (hwMode === 'to_full' || hwMode === 'zero_charge_only' || hwMode === 'zero')) return null;
    if (policyMode === 'discharge' && hwMode === 'zero_discharge_only') return null;

    // Discharge + PV → zero: not a divergence but worth explaining
    if (policyMode === 'discharge' && hwMode === 'zero') {
      const pvW = Math.round(inputs.p1?.pv_power_estimated ?? 0);
      const gridPower = inputs.p1?.resolved_gridPower ?? 0;
      const surplus = gridPower < 0 ? Math.abs(Math.round(gridPower)) : 0;
      const pvLabel = surplus > 0 ? `${surplus}W overschot van ${pvW}W` : (pvW > 0 ? `${pvW}W productie` : '');
      return {
        icon: '☀️',
        category: 'mapping',
        text: `Ontladen via Net-0 (i.p.v. alleen-ontladen) — PV${pvLabel ? ` (${pvLabel})` : ''} laadt batterij bij, ontlading dekt verbruikspieken. Grid blijft ~0W.`,
        impact: 'critical',
        sentiment: 'positive',
        supportedMode: 'discharge'
      };
    }

    const price          = inputs.effectivePrice;
    const maxChargePrice = inputs.settings?.max_charge_price ?? 0;
    const minDischarge   = inputs.settings?.min_discharge_price ?? 0;
    const fmt            = v => typeof v === 'number' ? `€${v.toFixed(3)}` : '?';
    const scoreCharge    = scores?.charge ?? 0;
    const scoreDischarge = scores?.discharge ?? 0;

    const HW_LABELS = {
      standby: 'Standby', zero_charge_only: 'Zon-laden', to_full: 'Vol-laden',
      zero_discharge_only: 'Ontladen', zero: 'Net-0'
    };
    const hwLabel = HW_LABELS[hwMode] || hwMode;

    if (policyMode === 'charge' && (hwMode === 'standby' || hwMode === 'zero_charge_only')) {
      const parts = [];
      if (typeof price === 'number' && price > maxChargePrice) {
        parts.push(`stroomprijs ${fmt(price)} > max laadprijs ${fmt(maxChargePrice)}`);
      }
      if (hwMode === 'standby') parts.push('geen PV beschikbaar');
      return {
        icon: '⏳',
        category: 'mapping',
        text: `Laden wint (score ${scoreCharge}) maar ${parts.join(' en ')} → ${hwLabel}: wacht op betere conditie.`,
        impact: 'critical',
        sentiment: 'neutral',
        supportedMode: 'charge'
      };
    }

    if (policyMode === 'discharge' && hwMode === 'standby') {
      const respectMinMax = (inputs.settings?.policy_mode === 'balanced-dynamic')
        ? false
        : inputs.settings?.respect_minmax !== false;
      const _settingsFloor = (inputs.settings?.cycle_cost_per_kwh ?? 0.075) / (inputs.settings?.battery_efficiency || 0.75);
      const effectiveFloor = respectMinMax ? minDischarge : _settingsFloor;

      const parts = [];
      if (typeof price === 'number' && effectiveFloor > 0 && price < effectiveFloor) {
        const floorLabel = respectMinMax
          ? `min ontlaadprijs ${fmt(minDischarge)}`
          : `break-even ${fmt(effectiveFloor)}`;
        parts.push(`prijs ${fmt(price)} < ${floorLabel}`);
      } else {
        parts.push('ontladen niet winstgevend genoeg');
      }
      return {
        icon: '⏳',
        category: 'mapping',
        text: `Ontladen wint (score ${scoreDischarge}) maar ${parts.join(' en ')} → ${hwLabel}.`,
        impact: 'critical',
        sentiment: 'neutral',
        supportedMode: 'discharge'
      };
    }

    return null;
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