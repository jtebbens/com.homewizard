'use strict';

// ======================================================
// GLOBAL DEBUG SWITCH
// ======================================================
const debug = false;

class PolicyEngine {
  constructor(homey, settings) {
    this.homey = homey;
    this.settings = settings;
    this.log = (...args) => debug && homey.log('[PolicyEngine]', ...args);
  }

  calculatePolicy(inputs) {
    const scores = { charge: 0, discharge: 0, preserve: 0 };

    this.log('--- POLICY RUN START ---');
    this.log('Inputs:', JSON.stringify(inputs, null, 2));

    // ======================================================
    // PV PRODUCTION → CHARGE (PV IS FREE)
    // ======================================================
    const grid = inputs.p1?.resolved_gridPower ?? 0;
    const soc = inputs.battery?.stateOfCharge ?? 50;
    const maxSoc = this.settings.max_soc ?? 95;

    if (grid < -100 && soc < maxSoc) {
      scores.charge += 500;   // overwint ALLES
      this.log('PV OVERSCHOT: forcing charge (PV is gratis)');
    }


    // 1. Smart Low‑SoC Rule
    this._applySmartLowSocRule(scores, inputs);

    // 2. Dynamic pricing
    if (this.settings.tariff_type === 'dynamic') {
      this._applyTariffScore(scores, inputs.tariff, inputs.battery);
      this._applyWeatherForecast(scores, inputs.weather);
    }

    // 3. Fixed peak‑shaving
    if (this.settings.tariff_type === 'fixed') {
      this._applyPeakShavingRules(scores, inputs);
    }

    // 4. PV Reality (may block charge)
    const pvDetected = this._applyPVReality(
      scores,
      inputs.p1,
      inputs.battery?.mode
    );


    // 5. BatteryScore ALWAYS LAST (force‑charge at 0%)
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
  // DYNAMIC PRICING
  // ======================================================
  _applyTariffScore(scores, tariff, battery) {
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
  // DAYCURVE LOGIC (TOP 3 CHEAP / TOP 3 EXPENSIVE HOURS)
  // ======================================================
  if (Array.isArray(tariff.top3Highest) &&
      tariff.top3Highest.some(p => isFloatEqual(p, price))) {
    scores.discharge += 40;
    scores.preserve -= 10;
    this.log('Tariff: top 3 expensive hour → discharge +40');
  }

  if (Array.isArray(tariff.top3Lowest) &&
      tariff.top3Lowest.some(p => isFloatEqual(p, price))) {
    scores.charge += 40;
    scores.preserve -= 10;
    this.log('Tariff: top 3 cheap hour → charge +40');
  }

  // ======================================================
  // EXISTING PRICE THRESHOLDS
  // ======================================================
  if (price <= maxChargePrice && maxChargePrice > 0) {
    scores.charge += 35;
    this.log('Tariff: cheap → charge +35');
  } else if (price > maxChargePrice && soc > 0) {
    scores.charge = 0;
    scores.preserve += 15;
    this.log('Tariff: expensive → preserve +15');
  }

  if (price >= minDischargePrice && minDischargePrice > 0) {
    scores.discharge += 30;
    this.log('Tariff: high price → discharge +30');
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
    scores.charge += 50;
    scores.preserve -= 10;
    this.log('Tariff: ultra cheap → charge +50');
  }

  if (price >= 0.40) {
    scores.discharge += 50;
    scores.preserve -= 10;
    this.log('Tariff: ultra expensive → discharge +50');
  }

  // ======================================================
  // HARD RULE: expensive hour → FORCE DISCHARGE
  // ======================================================
  if (
    Array.isArray(tariff.top3Highest) &&
    tariff.top3Highest.some(p => isFloatEqual(p, price))
  ) {
    scores.discharge += 300;   // overwint ALLES
    scores.preserve = 0;       // preserve uitschakelen
    this.log('Tariff: EXPENSIVE HOUR → FORCE DISCHARGE (+300)');
  }
}



  // ======================================================
  // PV REALITY
  // ======================================================
  _applyPVReality(scores, p1, batteryMode) {
  if (!p1) return false;

  const gridPower = p1.resolved_gridPower ?? 0;
  const batteryPower = p1.battery_power ?? 0;

  if (debug) this.log('PV Reality debug:', { gridPower, batteryPower, batteryMode });

  let pvDetected = false;

  // ------------------------------------------------------
  // 1. ZERO_CHARGE_ONLY → batteryPower > 0 = PV-opwek
  //    (want batterij mag NIET laden van het net)
  // ------------------------------------------------------
  if (batteryMode === 'zero_charge_only') {
    pvDetected = batteryPower > 0;
  }

  // ------------------------------------------------------
  // 2. ALLE ANDERE MODI → alleen gridPower bepaalt PV-overschot
  // ------------------------------------------------------
  else {
    pvDetected = gridPower < -100; // export = PV-overschot
  }

  // ------------------------------------------------------
  // 3. Geen PV → charge blokkeren
  // ------------------------------------------------------
  if (!pvDetected) {
    scores.charge = 0;
    this.log('PV Reality: no PV → blocking charge');
    return false;
  }

  this.log('PV Reality: PV detected → charge allowed');
  return true;
}


  // ======================================================
  // WEATHER
  // ======================================================
  _applyWeatherForecast(scores, weather) {
    if (!weather) return;

    const sun4h = Number(weather.sunshineNext4Hours ?? 0);
    const sun8h = Number(weather.sunshineNext8Hours ?? 0);
    const sunToday = Number(weather.sunshineTodayRemaining ?? 0);
    const sunTomorrow = Number(weather.sunshineTomorrow ?? 0);

    if (sun4h >= 2.0) {
      scores.charge -= 25;
      scores.preserve += 15;
      this.log('Weather: sun4h >= 2 → preserve');
    }

    if (sun4h >= 1.0) {
      scores.discharge -= 15;
      scores.preserve += 10;
      this.log('Weather: sun4h >= 1 → preserve');
    }

    if (sun8h >= 3.0) {
      scores.charge -= 20;
      scores.preserve += 10;
      this.log('Weather: sun8h >= 3 → preserve');
    }

    if (sunToday >= 4.0) {
      scores.charge -= 15;
      scores.preserve += 10;
      this.log('Weather: sunToday >= 4 → preserve');
    }

    if (sunTomorrow >= 2.0) {
      scores.charge -= 5;
      scores.preserve += 5;
      this.log('Weather: sunTomorrow >= 2 → preserve');
    }

    if (sunTomorrow >= 4.0) {
      scores.charge -= 10;
      scores.preserve += 10;
      this.log('Weather: sunTomorrow >= 4 → preserve');
    }

    if (sunTomorrow >= 6.0) {
      scores.charge -= 15;
      scores.preserve += 15;
      this.log('Weather: sunTomorrow >= 6 → preserve');
    }
  }

  // ======================================================
  // PEAK SHAVING (FIXED TARIFF)
  // ======================================================
  _applyPeakShavingRules(scores, inputs) {
    const { p1, time, battery } = inputs;
    if (!p1 || !time) return;

    const grid = p1.resolved_gridPower ?? 0;
    const batt = p1.battery_power ?? 0;
    const dischargeNow = batt < 0 ? Math.abs(batt) : 0;
    const trueLoad = grid + dischargeNow;

    const maxDischarge =
      battery.maxDischargePowerW ??
      battery.battery_group_max_discharge_power_w ??
      (battery.totalCapacityKwh ? battery.totalCapacityKwh * 1000 / 2 : 800);

    const hour = time.getHours();

    const peak = this._parseTimeRange(this.settings.peak_hours);
    const inPeak = peak && hour >= peak.startHour && hour < peak.endHour;

    if (inPeak) {
      scores.charge = 0;
      scores.discharge += 10;
      scores.preserve += 5;
      this.log('Peak: in peak hours → discharge');
    }

    if (trueLoad > maxDischarge * 0.8) {
      scores.discharge += 30;
      scores.preserve -= 5;
      this.log('Peak: high load → discharge');
    }

    if (trueLoad < maxDischarge * 0.3) {
      scores.preserve += 15;
      scores.discharge -= 5;
      this.log('Peak: low load → preserve');
    }
  }

  // Dummy parser (kept as in your original file)
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
      this.log('PolicyMode: ECO');
    }

    if (mode === 'aggressive') {
      scores.charge *= 1.2;
      scores.discharge *= 1.2;
      scores.preserve *= 0.7;
      this.log('PolicyMode: AGGRESSIVE');
    }
  }

  // ======================================================
  // MAP INTERNAL POLICY MODE → HOMEWIZARD MODE
  // ======================================================
  /**
   * Maps the internal policy mode ("charge", "discharge", "preserve")
   * to the correct HomeWizard battery mode.
   *
   * Depends on:
   * - tariff_type: "dynamic" (balanced) or "fixed"
   * - zero-mode flag (separate mode)
   * - SoC limits
   * - zero-mode permissions
   */
  _mapPolicyToHwMode(policyMode, ctx) {
  const tariffType = this.settings.tariff_type; // "dynamic" or "fixed"
  const soc = ctx.battery?.stateOfCharge ?? 50;

  const zeroModeActive = ctx.policyMode === 'zero'; // expliciete net‑0 modus

  // -----------------------------
  // ZERO‑MODE (separate net‑0 mode)
  // -----------------------------
  if (zeroModeActive) {
    const grid = ctx.p1?.resolved_gridPower ?? 0;
    const deadband = 50;

    const chargeAllowed = this.settings.zero_charge_allowed;
    const dischargeAllowed = this.settings.zero_discharge_allowed;

    const minSoc = this.settings.min_soc ?? 0;
    const maxSoc = this.settings.max_soc ?? 95;

    // Battery protection
    if (soc <= minSoc) {
      // bij te lage SoC: alleen laden als dat mag, anders niets
      return chargeAllowed ? 'to_full' : 'standby';
    }
    if (soc >= maxSoc) {
      // bij te hoge SoC: alleen ontladen blokkeren (zero_discharge_only)
      return dischargeAllowed ? 'zero_discharge_only' : 'standby';
    }

    // Net‑0 logic
    if (grid < -deadband && chargeAllowed) return 'zero_charge_only';      // overschot → PV‑only laden
    if (grid >  deadband && dischargeAllowed) return 'zero_discharge_only'; // tekort → niet ontladen blokkeren

    return 'standby';
  }

  // -----------------------------
  // BALANCED MODE (dynamic pricing)
  // -----------------------------
  if (tariffType === 'dynamic') {
    const price = ctx.tariff?.currentPrice ?? null;
    const maxCharge = this.settings.max_charge_price || 0;
    const minDischarge = this.settings.min_discharge_price || 0;
    const grid = ctx.p1?.resolved_gridPower ?? 0;

    const isCheap = price !== null && price <= maxCharge && maxCharge > 0;
    const isExpensive = price !== null && price >= minDischarge && minDischarge > 0;

    // 1. Expliciet ontladen → beste benadering: zero_discharge_only
    if (policyMode === 'discharge') {
      return 'zero_discharge_only';
    }

    // 2. Goedkope uren → laden
    if (policyMode === 'charge' || isCheap) {
      if (grid < -100) {
        return 'zero_charge_only';   // PV‑only laden
      }
      return 'to_full';              // netladen
    }

    // 3. Dure uren → beschermen
    if (isExpensive) {
      return 'zero_discharge_only';
    }

    // 4. Preserve → PV‑only laden (klaarstaan voor zon, geen netimport)
    if (policyMode === 'preserve') {
      return 'zero_charge_only';
    }

    // 5. Fallback (veilig, zon‑vriendelijk)
    return 'zero_charge_only';
  }

  // -----------------------------
  // FIXED MODE (peak/off‑peak, PV‑driven)
  // -----------------------------
  if (tariffType === 'fixed') {
    const p1 = ctx.p1 || {};
    const pvPower = p1.pv_power ?? 0;

    // Expliciet ontladen → beste benadering: zero_discharge_only
    if (policyMode === 'discharge') {
      return 'zero_discharge_only';
    }

    if (policyMode === 'charge') {
      // In fixed mode, charging = PV‑only
      return pvPower > 0 ? 'zero_charge_only' : 'standby';
    }

    // preserve → PV‑only charging if available
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
      hwMode,              // external: "to_full" | "standby" | "charge_only" | "discharge_only"
      confidence: Math.min(confidence, 100)
    };
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }
}

module.exports = PolicyEngine;
