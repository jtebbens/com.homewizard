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
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0) {
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

    // Pre-compute per-slot PV coverage (0–1): fraction of charge power covered by PV
    const pvCoverage = prices.map(p => {
      const pvW = this._getPvForSlot(pvForecast, p.timestamp);
      return Math.min(pvW / maxChargePowerW, 1);
    });

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, pvStrongCoverage } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG);

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
  computeExpectedProfit(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return 0;

    const N = prices.length;
    const slotH = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
      : 1;

    const effectiveRte    = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;
    const cycleCostPerKwh = this.cycleCostPerKwh ?? 0;

    const GRID_TOTAL = GRID * 100;
    const minSocG    = Math.round(this.minSoc * GRID);
    const maxSocG    = Math.round(this.maxSoc * GRID);

    const pvCoverage = prices.map(p => {
      const pvW = this._getPvForSlot(pvForecast, p.timestamp);
      return Math.min(pvW / maxChargePowerW, 1);
    });

    const { dp } = this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
      capacityKwh, maxChargePowerW, maxDischargePowerW,
      effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
      minDischargePrice, maxSocG, minSocG);

    const initialSocG = Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID)));
    return dp[initialSocG] ?? 0;
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
                 minDischargePrice, maxSocG, minSocG) {
    const GRID_TOTAL = GRID * 100;

    // SoC delta per full charge slot in grid units.
    const chargeSocDeltaG = Math.max(1, Math.round(
      (maxChargePowerW / 1000) * slotH * effectiveRte * 100 / capacityKwh * GRID
    ));
    const chargeKwhFull = (maxChargePowerW / 1000) * slotH;

    // Per-slot effective discharge power: limited by house consumption so the
    // battery doesn't discharge faster than the load can absorb it.
    const effectiveDischargePowerW = prices.map((_, t) => {
      const consumptionW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t]
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

    // dp[socG] = max future profit achievable with this SoC from the current slot onward
    let dp = new Float64Array(GRID_TOTAL + 1).fill(0);

    // policy[t][socG] = best action code: 0 = preserve, 1 = charge, 2 = discharge
    const policy = Array.from({ length: N }, () => new Uint8Array(GRID_TOTAL + 1));

    // ── Backward induction ────────────────────────────────────────────────────
    for (let t = N - 1; t >= 0; t--) {
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
        let vDischarge = -1e9;
        if (socG > minSocG && price >= minDischargePrice) {
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
          // Half the cycle cost applies on discharge (other half was on charge).
          vDischarge = dischargeValue - cycleCostPerKwh * 0.5 * kwh + dp[newSocG];
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
    let best = 0, bestDist = Infinity;
    for (const s of pvForecast) {
      const dist = Math.abs(new Date(s.timestamp).getTime() - slotMs);
      if (dist < bestDist) { bestDist = dist; best = s.pvPowerW; }
    }
    return bestDist <= 35 * 60 * 1000 ? best : 0;
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

    return (best && bestDist <= 35 * 60 * 1000) ? best.action : null;
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
