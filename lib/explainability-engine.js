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

    // CORE REASONS
    this._addBatteryReasons(reasons, warnings, inputs.battery, settings, tariffType);
    this._addTariffReasons(reasons, inputs.tariff, settings, tariffType);
    this._addPVReasons(reasons, inputs.p1);

    if (tariffType === 'dynamic') {
      this._addWeatherReasons(reasons, inputs.weather);
    }

    this._addPeakShavingReasons(reasons, inputs);
    this._addTimeReasons(reasons, inputs.time);
    this._addConfidenceReason(reasons, recommendation);

    // Sort reasons by impact
    reasons.sort((a, b) => this._impactWeight(b.impact) - this._impactWeight(a.impact));

    const summary = this._generateSummary(recommendation, reasons);
    const shortSummary = this._generateShortSummary(recommendation, inputs);

    return {
      recommendation: hwMode || policyMode,
      confidence: recommendation.confidence,
      reasons: reasons.slice(0, 6),
      warnings,
      scores,
      summary,
      shortSummary,
      timestamp: new Date().toISOString()
    };
  }

  // -------------------------------------------------------
  // BATTERY
  // -------------------------------------------------------
  _addBatteryReasons(reasons, warnings, battery, settings, tariffType) {
  const soc = battery?.stateOfCharge ?? 50;

  const minSoc = settings.min_soc ?? null;
  const maxSoc = settings.max_soc ?? 95;

  // 1. Kritiek laag (hardware / realistisch minimum)
  if (soc <= 10) {
    reasons.push({
      icon: '🛑',
      category: 'battery',
      text: `Batterij zeer laag (${soc}%) — ontladen niet toegestaan.`,
      impact: 'high',
      sentiment: 'negative'
    });
    warnings.push(`Batterij zeer laag (${soc}%)`);
    return;
  }

  // 2. Onder ingestelde minimum SOC
  if (typeof minSoc === 'number' && soc < minSoc) {
    reasons.push({
      icon: '🔋',
      category: 'battery',
      text: `Batterij onder ingestelde minimumwaarde (${soc}% < ${minSoc}%).`,
      impact: 'high',
      sentiment: 'negative'
    });
    warnings.push(`Batterij onder ingestelde minimumwaarde (${minSoc}%)`);
    return;
  }

  // 3. Boven ingestelde maximum SOC
  if (soc > maxSoc) {
    reasons.push({
      icon: '🔋',
      category: 'battery',
      text: `Batterij boven ingestelde maximumwaarde (${soc}% > ${maxSoc}%).`,
      impact: 'high',
      sentiment: 'positive'
    });
    warnings.push(`Batterij boven ingestelde maximumwaarde (${maxSoc}%)`);
    return;
  }

  // 4. Normaal bereik
  reasons.push({
    icon: '🔋',
    category: 'battery',
    text: `Batterij in normaal bereik (${soc}%).`,
    impact: 'low',
    sentiment: 'neutral'
  });
}


  // -------------------------------------------------------
  // TARIFF
  // -------------------------------------------------------
  _addTariffReasons(reasons, tariff, settings, tariffType) {
  if (!tariff) return;

  if (tariffType === 'fixed') {
    reasons.push({
      icon: '💰',
      category: 'tariff',
      text: 'Vast tarief actief — focus op peak‑shaving.',
      impact: 'low',
      sentiment: 'neutral'
    });
    return;
  }

  const price = tariff.currentPrice;
  const maxChargePrice = settings.max_charge_price || 0;
  const minDischargePrice = settings.min_discharge_price || 0;

  const fmt = (v) => typeof v === 'number' ? `€${v.toFixed(2)}/kWh` : 'onbekend';

  if (typeof price === 'number' && price <= maxChargePrice) {
    reasons.push({
      icon: '💰',
      category: 'tariff',
      text: `Stroom goedkoop (${fmt(price)}) — laden aantrekkelijk.`,
      impact: 'high',
      sentiment: 'positive'
    });
  }

  if (typeof price === 'number' && price >= minDischargePrice) {
    reasons.push({
      icon: '💰',
      category: 'tariff',
      text: `Stroomprijs hoog (${fmt(price)}) — ontladen aantrekkelijk.`,
      impact: 'medium',
      sentiment: 'positive'
    });
  }

  if (typeof price === 'number' && price <= 0.05) {
    reasons.push({
      icon: '⚡',
      category: 'tariff',
      text: `Extreem lage prijs (${fmt(price)}) — laden sterk aanbevolen.`,
      impact: 'critical',
      sentiment: 'positive'
    });
  }

  if (typeof price === 'number' && price >= 0.40) {
    reasons.push({
      icon: '🔥',
      category: 'tariff',
      text: `Extreem hoge prijs (${fmt(price)}) — ontladen zeer aantrekkelijk.`,
      impact: 'critical',
      sentiment: 'positive'
    });
  }
}


  // -------------------------------------------------------
  // PV REALITY
  // -------------------------------------------------------
  _addPVReasons(reasons, p1) {
    if (!p1) {
      reasons.push({
        icon: '🌥️',
        category: 'pv',
        text: `Geen PV‑gegevens beschikbaar.`,
        impact: 'low',
        sentiment: 'neutral'
      });
      return;
    }

    const gridPower = p1.resolved_gridPower ?? 0;
    const batteryPower = p1.battery_power ?? 0;

    if (gridPower < -150) {
      reasons.push({
        icon: '🔆',
        category: 'pv',
        text: `Export gedetecteerd — zonne‑opwek actief.`,
        impact: 'medium',
        sentiment: 'positive'
      });
      return;
    }

    if (batteryPower > 150 && gridPower <= 0) {
      reasons.push({
        icon: '🔋',
        category: 'pv',
        text: `Batterij wordt geladen door PV.`,
        impact: 'medium',
        sentiment: 'positive'
      });
      return;
    }

    reasons.push({
      icon: '🌥️',
      category: 'pv',
      text: `Geen export en geen batterij‑opwek — waarschijnlijk geen zon.`,
      impact: 'high',
      sentiment: 'negative'
    });
  }

  // -------------------------------------------------------
  // WEATHER
  // -------------------------------------------------------
  _addWeatherReasons(reasons, weather) {
    if (!weather) return;

    const sun4h = weather.sunshineNext4Hours || 0;
    const sunTomorrow = weather.sunshineTomorrow || 0;

    if (sun4h >= 2) {
      reasons.push({
        icon: '☀️',
        category: 'weather',
        text: `Sterke zon binnen 4 uur (${sun4h.toFixed(1)} uur).`,
        impact: 'high',
        sentiment: 'positive'
      });
    } else if (sun4h >= 1) {
      reasons.push({
        icon: '🌤️',
        category: 'weather',
        text: `Matige zon binnen 4 uur (${sun4h.toFixed(1)} uur).`,
        impact: 'medium',
        sentiment: 'neutral'
      });
    }

    if (sunTomorrow >= 2) {
      reasons.push({
        icon: '🌅',
        category: 'weather',
        text: `Zon verwacht morgen (${sunTomorrow.toFixed(1)} uur).`,
        impact: 'low',
        sentiment: 'positive'
      });
    }
  }

  // -------------------------------------------------------
  // PEAK SHAVING
  // -------------------------------------------------------
  _addPeakShavingReasons(reasons, inputs) {
    if (inputs.settings.tariff_type !== 'fixed') return;
  }

  // -------------------------------------------------------
  // TIME
  // -------------------------------------------------------
  _addTimeReasons(reasons, time) {
    if (!time) return;

    const hour = time.getHours();

    if (hour >= 17 && hour < 22) {
      reasons.push({
        icon: '⏰',
        category: 'time',
        text: `Avonduren — hogere huishoudelijke consumptie verwacht.`,
        impact: 'medium',
        sentiment: 'negative'
      });
    }
  }

  // -------------------------------------------------------
  // CONFIDENCE
  // -------------------------------------------------------
  _addConfidenceReason(reasons, recommendation) {
    const c = recommendation.confidence;

    if (c >= 90) {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Hoge zekerheid — één optie had duidelijk de hoogste score.`,
        impact: 'low',
        sentiment: 'positive'
      });
    } else if (c >= 60) {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Redelijke zekerheid — scores lagen niet ver uit elkaar.`,
        impact: 'low',
        sentiment: 'neutral'
      });
    } else {
      reasons.push({
        icon: '🎯',
        category: 'confidence',
        text: `Lage zekerheid — scores lagen dicht bij elkaar.`,
        impact: 'low',
        sentiment: 'neutral'
      });
    }
  }

  // -------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------
  _generateSummary(recommendation, reasons) {
    const hw = recommendation.hwMode;
    const policy = recommendation.policyMode;

    const MODE_LABELS_NL = {
      zero_charge_only: 'de batterij PV‑only te laten laden',
      zero_discharge_only: 'de batterij te beschermen (niet laden, niet ontladen)',
      to_full: 'de batterij van het net te laden',
      standby: 'de batterij niets te laten doen',
      zero: 'net‑0 te handhaven',

      charge: 'de batterij te laden',
      discharge: 'de batterij te ontladen',
      preserve: 'de batterij PV‑only te laten laden'
    };

    const action = MODE_LABELS_NL[hw] || MODE_LABELS_NL[policy] || 'de batterij te beheren';

    const top = reasons
      .slice(0, 2)
      .map(r => r.text.toLowerCase())
      .join(', ');

    return top
      ? `Advies: ${action} vanwege ${top}.`
      : `Advies: ${action}.`;
  }

  // -------------------------------------------------------
  // SHORT SUMMARY
  // -------------------------------------------------------
  _generateShortSummary(recommendation, inputs) {
    const hw = recommendation.hwMode;
    const price = inputs?.tariff?.currentPrice;
    const sun = inputs?.weather?.sunshineNext4Hours;

    const MODE_SHORT_NL = {
      zero_charge_only: 'PV‑LADEN',
      zero_discharge_only: 'BESCHERMEN',
      to_full: 'NET‑LADEN',
      standby: 'STAND‑BY',
      zero: 'NET‑0',

      charge: 'LADEN',
      discharge: 'ONTLADEN',
      preserve: 'PV‑LADEN'
    };

    const label = MODE_SHORT_NL[hw] || hw?.toUpperCase() || 'ONBEKEND';

    if (typeof price === 'number' && typeof sun === 'number') {
      return `${label} (€${price.toFixed(2)}, ☀️${sun.toFixed(1)}h)`;
    }

    if (typeof price === 'number') {
      return `${label} (€${price.toFixed(2)})`;
    }

    return label;
  }

  _impactWeight(impact) {
    return { critical: 4, high: 3, medium: 2, low: 1 }[impact] || 0;
  }
}

module.exports = ExplainabilityEngine;
