'use strict';

/**
 * OptimizationEngine — 24h DP-based battery scheduling bias layer.
 *
 * Runs backward induction over the available price horizon to find the
 * globally optimal charge / preserve / discharge sequence. The result is
 * exposed as a per-slot hint that PolicyEngine adds as a ~60-point bias,
 * strong enough to guide but NOT strong enough to override real-time safety
 * rules (PV surplus, SoC limits, delay-charge, etc.).
 *
 * Architecture:
 *   PolicyEngine keeps all edge-case handling.
 *   OptimizationEngine provides a 24-h lookahead that the heuristic rules lack.
 *
 * SoC grid:
 *   Internal representation uses a 10x finer grid (GRID=10, 0–1000 steps =
 *   0.0–100.0% in 0.1% increments). This prevents the old integer-rounding
 *   clamp (Math.max(1, round(delta))) from inflating the apparent SoC cost of
 *   each discharge slot on large multi-battery setups with modest consumption.
 *   Example: 4 batteries (10.752 kWh) + 291W load + 15-min slot → true delta
 *   = 0.68% → old code rounded to 1% (47% overestimate) → DP wrongly preferred
 *   preserve. With GRID=10 the delta becomes grid-unit 7 (=0.7%), accurate to
 *   0.02% and the DP makes correct economic decisions.
 */

const GRID = 10; // 10 grid units per SoC percent → 0.1% resolution

class OptimizationEngine {
  constructor(settings) {
    this.RTE              = settings.battery_efficiency  || 0.75;
    this.minSoc           = settings.min_soc             ?? 0;
    this.maxSoc           = settings.max_soc             ?? 95;
    this.cycleCostPerKwh  = settings.cycle_cost_per_kwh  ?? 0.075;
    // NL saldering (net metering) is active until 2027: export earns full retail price.
    // Set to actual export/import ratio when saldering ends.
    this.exportPriceRatio = settings.export_price_ratio  ?? 1.0;
    this._schedule = null; // { computedAt: number, projectedProfit: number, slots: [{timestamp, action}] }
  }

  /**
   * Compute the optimal 24-h schedule via backward-induction DP.
   *
   * @param {Array<{timestamp: string|Date, price: number}>} prices
   *   Hourly price slots sorted ascending (allPrices / next24Hours).
   * @param {number} currentSoc  — current state of charge (0-100 %)
   * @param {number} capacityKwh — usable battery capacity in kWh
   * @param {number} maxChargePowerW   — max charge power in W
   * @param {number} maxDischargePowerW — max discharge power in W
   * @param {Array<{timestamp: string|Date, pvPowerW: number}>} [pvForecast]
   *   Optional per-slot PV power estimate (W). Slots with PV reduce effective
   *   grid-charge cost proportionally — the DP prefers charging during PV hours.
   * @param {number|null} [rte]
   *   Round-trip efficiency override (0–1). Falls back to this.RTE when null.
   * @param {Array<number>|null} [consumptionWPerSlot]
   *   Expected house consumption per slot in W. When provided and exportPriceRatio < 1,
   *   discharge value is split: local consumption offset at 100% price, export at exportPriceRatio.
   * @param {number} [minDischargePrice]
   *   Minimum price (€/kWh) at which discharge is allowed. Slots below this threshold
   *   are treated as discharge-blocked so the DP never schedules discharge there.
   *   Defaults to 0 (no constraint). Must match the policy-engine's min_discharge_price setting.
   */
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0, consumptionMargin = 1.0, pvKwhTomorrow = 0) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return;

    const N = prices.length;
    // Auto-detect slot duration from timestamps (supports both 1h and 15-min data)
    const slotH = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
      : 1;

    const effectiveRte    = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;
    const cycleCostPerKwh = this.cycleCostPerKwh ?? 0;

    // ── SoC grid setup ─────────────────────────────────────────────────────────
    const GRID_TOTAL = GRID * 100;
    const minSocG    = Math.round(this.minSoc * GRID);
    const maxSocG    = Math.round(this.maxSoc * GRID);

    // Pre-compute per-slot PV coverage (0–1): fraction of charge power covered by PV SURPLUS.
    // Net surplus = max(0, pvW − consW): PV first serves house load; only the remainder
    // enters the battery (zero_charge_only). Using raw pvW would overstate free charge.
    const pvCoverage = prices.map((p, t) => {
      const pvW   = this._getPvForSlot(pvForecast, p.timestamp);
      const consW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] : 0;
      return Math.min(1, Math.max(0, pvW - consW) / maxChargePowerW);
    });

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, pvStrongCoverage } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG, consumptionMargin, pvKwhTomorrow);

    const initialSocG     = Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID)));
    const projectedProfit = dp[initialSocG] ?? 0;

    // ── Forward pass: trace the optimal path from currentSoc ──────────────────
    const slots = [];
    const ACTIONS = ['preserve', 'charge', 'discharge'];
    let socG = initialSocG;

    for (let t = 0; t < N; t++) {
      const code   = policy[t][socG];
      const action = ACTIONS[code];
      slots.push({ timestamp: prices[t].timestamp, action, price: prices[t].price, socProjected: socG / GRID,
        consumptionW: Array.isArray(consumptionWPerSlot) ? (consumptionWPerSlot[t] ?? null) : null });

      if (code === 1) socG = Math.min(maxSocG, socG + chargeSocDeltaG);
      else if (code === 2) socG = Math.max(minSocG, socG - perSlotDischargeSocDeltaG[t]);
      else if (pvCoverage[t] >= pvStrongCoverage) {
        // Preserve + PV strong enough for zero_charge_only: battery charges for free.
        // Below pvStrongCoverage the firmware stays in standby — no free SoC gain.
        socG = Math.min(maxSocG, socG + Math.round(pvCoverage[t] * chargeSocDeltaG));
      }
    }

    this._schedule = { computedAt: Date.now(), projectedProfit, slots };
  }

  /**
   * Compute expected 24h profit for a given battery config WITHOUT modifying _schedule.
   * Safe to call after compute() — live policy decisions are not affected.
   *
   * Used for "what if" analysis (e.g. a second battery with higher capacity/power).
   *
   * @returns {number} Expected gross profit in € for the next 24h horizon, or 0 on error.
   */
  computeExpectedProfit(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0, consumptionMargin = 1.0, pvKwhTomorrow = 0) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return { profit: 0, selfSufficiencyPct: 0 };

    const N = prices.length;
    const slotH = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
      : 1;

    const effectiveRte    = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;
    const cycleCostPerKwh = this.cycleCostPerKwh ?? 0;

    const GRID_TOTAL = GRID * 100;
    const minSocG    = Math.round(this.minSoc * GRID);
    const maxSocG    = Math.round(this.maxSoc * GRID);

    // Keep raw pvW per slot for the self-sufficiency forward pass (house supply).
    // pvCoverage uses NET surplus (pvW − consW) so we can't derive raw pvW from it.
    const pvWPerSlot = prices.map(p => this._getPvForSlot(pvForecast, p.timestamp));
    const pvCoverage = pvWPerSlot.map((pvW, t) => {
      const consW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] : 0;
      return Math.min(1, Math.max(0, pvW - consW) / maxChargePowerW);
    });

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, pvStrongCoverage } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG, consumptionMargin, pvKwhTomorrow);

    const initialSocG = Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID)));
    const profit = dp[initialSocG] ?? 0;

    // ── Forward pass: compute self-sufficiency % ────────────────────────────
    // Track how much house consumption is covered by PV + battery discharge
    // vs. imported from grid. Battery charge demand is excluded from house load.
    let totalConsKwh     = 0;
    let totalGridImportKwh = 0;
    let socG = initialSocG;

    for (let t = 0; t < N; t++) {
      const consW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] : 0;
      const pvW   = pvWPerSlot[t]; // raw PV watts (from inverter; house load served first)
      const code  = policy[t][socG];

      let batterySupplyW = 0;
      if (code === 2) {
        // Discharge: battery supplies up to effectiveDischargePower (already capped by consumption in DP)
        const effectiveDischW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
          ? Math.min(maxDischargePowerW, consumptionWPerSlot[t])
          : maxDischargePowerW;
        batterySupplyW = effectiveDischW;
      }

      // PV available for house: during charge, part of PV goes to battery
      let pvForHouseW = pvW;
      if (code === 1) {
        // Charge: PV first covers battery demand, rest goes to house
        pvForHouseW = Math.max(0, pvW - maxChargePowerW);
      } else if (code === 0 && pvCoverage[t] >= pvStrongCoverage) {
        // Preserve with strong PV: zero_charge_only — only surplus (pvW − consW) to battery
        const pvToBatteryW = Math.min(maxChargePowerW, Math.max(0, pvW - consW));
        pvForHouseW = Math.max(0, pvW - pvToBatteryW);
      }

      const suppliedW    = pvForHouseW + batterySupplyW;
      const gridImportW  = Math.max(0, consW - suppliedW);

      totalConsKwh       += consW * slotH / 1000;
      totalGridImportKwh += gridImportW * slotH / 1000;

      // Advance SoC (same as compute() forward pass)
      if (code === 1) socG = Math.min(maxSocG, socG + chargeSocDeltaG);
      else if (code === 2) socG = Math.max(minSocG, socG - perSlotDischargeSocDeltaG[t]);
      else if (pvCoverage[t] >= pvStrongCoverage) {
        socG = Math.min(maxSocG, socG + Math.round(pvCoverage[t] * chargeSocDeltaG));
      }
    }

    const selfSufficiencyPct = totalConsKwh > 0
      ? Math.round((1 - totalGridImportKwh / totalConsKwh) * 100)
      : 100;

    return { profit, selfSufficiencyPct };
  }

  /**
   * Backward-induction DP kernel. Returns the dp value array and the policy table.
   * Also returns derived constants needed by the forward pass in compute().
   * Does NOT touch any instance state — fully side-effect-free.
   * @private
   */
  _runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
                 capacityKwh, maxChargePowerW, maxDischargePowerW,
                 effectiveRte, cycleCostPerKwh, exportPriceRatio,
                 minDischargePrice, maxSocG, minSocG, consumptionMargin = 1.0, pvKwhTomorrow = 0) {
    const GRID_TOTAL = GRID * 100;

    // SoC delta per full charge slot in grid units.
    const chargeSocDeltaG = Math.max(1, Math.round(
      (maxChargePowerW / 1000) * slotH * effectiveRte * 100 / capacityKwh * GRID
    ));
    const chargeKwhFull = (maxChargePowerW / 1000) * slotH;

    // Per-slot effective discharge power: limited by house consumption so the
    // battery doesn't discharge faster than the load can absorb it.
    // consumptionMargin inflates the predicted load for a conservative SoC projection
    // (actual consumption is often higher than the learned average, e.g. dishwasher, cooking).
    // consumptionMargin can be a single number (uniform) or an array (per-slot).
    const effectiveDischargePowerW = prices.map((_, t) => {
      const margin = Array.isArray(consumptionMargin) ? (consumptionMargin[t] ?? 1.20) : consumptionMargin;
      const consumptionW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] * margin
        : maxDischargePowerW;
      return Math.min(maxDischargePowerW, consumptionW);
    });

    const perSlotDischargeSocDeltaG = effectiveDischargePowerW.map(w =>
      Math.max(1, Math.round((w / 1000) * slotH * 100 / capacityKwh * GRID))
    );
    const perSlotDischargeKwhFull = effectiveDischargePowerW.map(w =>
      (w / 1000) * slotH
    );

    // pvStrong threshold: matches policy-engine's pvStrong (≥400 W) used in
    // _mapActionToHwModeForPlanning. Only above this coverage does the firmware
    // run zero_charge_only during preserve.
    const pvStrongCoverage = maxChargePowerW > 0 ? 400 / maxChargePowerW : 0.15;

    // Pre-compute cumulative PV kWh that can enter the battery from each slot onwards.
    // pvCoverage[t] is clamped to [0,1], so pvCoverage[t] * chargeKwhFull = kWh absorbed.
    // When pvKwhFromT[t+1] >= capacityKwh, any starting SoC at t+1 will be fully replenished
    // by PV before horizon end — the SoC arriving at t+1 becomes irrelevant for future value.
    const pvKwhFromT = new Float64Array(N + 1); // pvKwhFromT[N] = 0 by default
    for (let t = N - 1; t >= 0; t--) {
      pvKwhFromT[t] = pvKwhFromT[t + 1] + pvCoverage[t] * chargeKwhFull;
    }

    // ── Terminal value: residual worth of stored energy at horizon end ────────
    // top-quartile price × 0.8 × RTE × kWh, discounted by PV refill forecast.
    // pvRefill ≥ 80% → terminal = 0 (PV fills battery for free, no hoarding).
    let dp = new Float64Array(GRID_TOTAL + 1).fill(0);
    if (N >= 4) {
      const pvRefill = capacityKwh > 0 ? Math.min(1, pvKwhTomorrow / capacityKwh) : 0;
      // Full PV day (≥80% refill) → terminal = 0, no residual value
      if (pvRefill < 0.8) {
        const sortedPrices = prices.map(p => p.price).filter(p => p > 0).sort((a, b) => b - a);
        const topQuartile = sortedPrices.slice(0, Math.max(1, Math.floor(sortedPrices.length / 4)));
        const terminalPricePerKwh = topQuartile.length > 0
          ? (topQuartile.reduce((a, b) => a + b, 0) / topQuartile.length) * 0.8 * effectiveRte
          : 0;
        if (terminalPricePerKwh > 0) {
          // Scale down linearly: pvRefill 0→0% discount, pvRefill 0.8→100% discount
          const terminalFactor = Math.max(0, 1 - pvRefill / 0.8);
          for (let socG = 0; socG <= GRID_TOTAL; socG++) {
            const kwhStored = (socG / GRID / 100) * capacityKwh;
            dp[socG] = terminalPricePerKwh * kwhStored * terminalFactor;
          }
        }
      }
      // else: pvRefill >= 0.8 → dp stays all zeros (battery worthless at end of horizon)
    }

    // policy[t][socG] = best action code: 0 = preserve, 1 = charge, 2 = discharge
    const policy = Array.from({ length: N }, () => new Uint8Array(GRID_TOTAL + 1));

    // ── Backward induction ────────────────────────────────────────────────────
    for (let t = N - 1; t >= 0; t--) {
      // Neutralize backward pressure from post-PV high prices: when PV from slot t+1
      // onwards can fully recharge the battery (pvKwhFromT[t+1] >= capacityKwh), any
      // starting SoC at t+1 yields the same future outcome. Flatten dp to its maximum
      // so discharging in slot t incurs no SoC opportunity cost.
      // Guard: only when overall pvKwhTomorrow >= capacityKwh * 0.8 (aligned with terminal
      // value threshold — both use the same 80% refill criterion so flattening and terminal
      // value zero out at the same point). Only flatten during low/no-PV slots
      // (pvCoverage < pvStrongCoverage). During strong PV hours the vPreserve free-SoC-gain
      // already naturally flattens dp via backward induction, so explicit flattening is
      // redundant. More importantly, if we flatten during strong PV hours the DP loses sight
      // of the evening peak value and may incorrectly recommend discharge at any price.
      if (pvKwhTomorrow >= capacityKwh * 0.8 && pvKwhFromT[t + 1] >= capacityKwh
          && pvCoverage[t] < pvStrongCoverage) {
        let dpMax = dp[0];
        for (let i = 1; i <= GRID_TOTAL; i++) { if (dp[i] > dpMax) dpMax = dp[i]; }
        dp.fill(dpMax);
      }

      const price = prices[t].price;
      // Grid charge cost reduced by PV coverage (fully free when PV >= charge power)
      const effectiveChargeCost = price * (1 - pvCoverage[t]);
      const newDp = new Float64Array(GRID_TOTAL + 1).fill(-1e9);

      for (let socG = 0; socG <= GRID_TOTAL; socG++) {

        // Preserve: firmware runs zero_charge_only only when PV is strong (≥400 W),
        // so only apply free SoC gain above that threshold. Weak PV results in
        // standby — no free charging.
        const pvSocGainG  = pvCoverage[t] >= pvStrongCoverage
          ? Math.round(pvCoverage[t] * chargeSocDeltaG)
          : 0;
        const preserveSocG = Math.min(maxSocG, socG + pvSocGainG);
        const vPreserve    = dp[preserveSocG];

        // Charge: SoC rises; cost is reduced when PV covers part of the charge power.
        // Half the cycle cost applies here (wear from charging), regardless of PV coverage.
        let vCharge = -1e9;
        if (socG < maxSocG) {
          const newSocG   = Math.min(maxSocG, socG + chargeSocDeltaG);
          const socDeltaG = newSocG - socG; // may be less than chargeSocDeltaG near the top
          const kwh       = chargeKwhFull * socDeltaG / chargeSocDeltaG;
          vCharge = -(effectiveChargeCost + cycleCostPerKwh * 0.5) * kwh + dp[newSocG];
        }

        // Discharge: SoC falls, avoided grid cost.
        // If consumption data is available, discharge beyond local demand is export
        // (worth exportPriceRatio of retail price vs. 100% for local consumption offset).
        // Discharge is allowed whenever price >= minDischargePrice — the pvCoverage block
        // was removed because it incorrectly suppressed discharge during delay-charge hours.
        // Also block discharge when price is below the user's minimum discharge threshold —
        // this keeps the DP schedule consistent with _mapActionToHwModeForPlanning which
        // shows 'standby' for those slots.
        const effectiveMinDischarge = Array.isArray(minDischargePrice)
          ? (minDischargePrice[t] ?? 0) : minDischargePrice;
        let vDischarge = -1e9;
        if (socG > minSocG && price >= effectiveMinDischarge) {
          const slotDischargeSocDeltaG = perSlotDischargeSocDeltaG[t];
          const slotDischargeKwhFull   = perSlotDischargeKwhFull[t];
          const newSocG    = Math.max(minSocG, socG - slotDischargeSocDeltaG);
          const socDeltaG  = socG - newSocG;
          const kwh        = slotDischargeKwhFull * socDeltaG / slotDischargeSocDeltaG;
          // null = no data (assume full local offset); 0 = learned zero consumption (all export)
          const consumptionKwh = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
            ? (consumptionWPerSlot[t] / 1000) * slotH
            : null;
          // With NL saldering (net metering, active until 2027), export earns the full
          // retail price — so the consumption split does not reduce discharge value.
          let dischargeValue;
          if (consumptionKwh != null && exportPriceRatio < 1.0) {
            const coveredKwh = Math.min(kwh, consumptionKwh);
            const exportKwh  = kwh - coveredKwh;
            dischargeValue = price * coveredKwh + price * exportPriceRatio * exportKwh;
          } else {
            dischargeValue = price * kwh;
          }
          // Half-cycle cost on discharge. Waived at night when PV tomorrow ≥ 150%
          // capacity — free PV refill means holding energy just clips tomorrow's PV.
          const pvAbundant = pvKwhTomorrow >= capacityKwh * 1.5 && pvCoverage[t] < 0.1;
          const slotCycleCost = pvAbundant ? 0 : cycleCostPerKwh * 0.5;
          vDischarge = dischargeValue - slotCycleCost * kwh + dp[newSocG];
        }

        // Pick best action
        let best = vPreserve, bestAction = 0;
        if (vCharge    > best) { best = vCharge;    bestAction = 1; }
        if (vDischarge > best) { best = vDischarge; bestAction = 2; }

        newDp[socG]      = best > -1e9 ? best : 0;
        policy[t][socG]  = bestAction;
      }

      dp = newDp;
    }

    return { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, chargeKwhFull, pvStrongCoverage };
  }

  /**
   * Find the PV power (W) forecast for a given price-slot timestamp.
   * Returns 0 when no PV data is available or no matching slot found.
   * @private
   */
  _getPvForSlot(pvForecast, timestamp) {
    if (!Array.isArray(pvForecast) || pvForecast.length === 0) return 0;
    const slotMs = new Date(timestamp).getTime();
    // Find surrounding hourly entries for linear interpolation
    let left = null, right = null;
    for (const s of pvForecast) {
      const t = new Date(s.timestamp).getTime();
      if (t <= slotMs && (left === null || t > new Date(left.timestamp).getTime())) left = s;
      if (t >= slotMs && (right === null || t < new Date(right.timestamp).getTime())) right = s;
    }
    if (!left && !right) return 0;
    if (!left) return right.pvPowerW;
    if (!right) return left.pvPowerW;
    const leftMs  = new Date(left.timestamp).getTime();
    const rightMs = new Date(right.timestamp).getTime();
    if (leftMs === rightMs) return left.pvPowerW;
    const frac = (slotMs - leftMs) / (rightMs - leftMs);
    return Math.round(left.pvPowerW + (right.pvPowerW - left.pvPowerW) * frac);
  }

  /**
   * Return the optimal action for the current time slot, or null if unknown.
   * Matches the slot whose timestamp is closest to `now`, within ±35 minutes.
   *
   * @param {Date} now
   * @returns {'charge'|'discharge'|'preserve'|null}
   */
  getSlot(now) {
    if (!this._schedule) return null;

    const nowMs = now.getTime();
    let best = null, bestDist = Infinity;

    for (const slot of this._schedule.slots) {
      const dist = Math.abs(new Date(slot.timestamp).getTime() - nowMs);
      if (dist < bestDist) { bestDist = dist; best = slot; }
    }

    // Threshold: one full slot duration (derived from schedule spacing), minimum 35 min.
    // Hardcoded 35 min was too small for 1h-slot schedules that start at the next hour boundary
    // (e.g. at 21:24 the nearest slot at 22:00 is 36 min away — just over the old limit).
    const slots = this._schedule.slots;
    const slotMs = slots.length >= 2
      ? Math.abs(new Date(slots[1].timestamp) - new Date(slots[0].timestamp))
      : 60 * 60 * 1000;
    const maxDist = Math.max(slotMs, 35 * 60 * 1000);

    return (best && bestDist <= maxDist) ? best.action : null;
  }

  /**
   * True when the schedule is missing or older than maxAgeMs (default 90 min).
   * PolicyEngine triggers recomputation when this returns true.
   */
  isStale(maxAgeMs = 90 * 60 * 1000) {
    return !this._schedule || (Date.now() - this._schedule.computedAt > maxAgeMs);
  }

  /** Propagate settings changes and invalidate the cached schedule. */
  updateSettings(newSettings) {
    if (newSettings.battery_efficiency  != null) this.RTE              = newSettings.battery_efficiency;
    if (newSettings.min_soc             != null) this.minSoc           = newSettings.min_soc;
    if (newSettings.max_soc             != null) this.maxSoc           = newSettings.max_soc;
    if (newSettings.cycle_cost_per_kwh  != null) this.cycleCostPerKwh  = newSettings.cycle_cost_per_kwh;
    if (newSettings.export_price_ratio  != null) this.exportPriceRatio = newSettings.export_price_ratio;
    this._schedule = null; // invalidate — will recompute on next policy run
  }
}

module.exports = OptimizationEngine;
