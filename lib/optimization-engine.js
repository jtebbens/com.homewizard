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
 */
class OptimizationEngine {
  constructor(settings) {
    this.RTE              = settings.battery_efficiency  || 0.75;
    this.minSoc           = settings.min_soc             ?? 0;
    this.maxSoc           = settings.max_soc             ?? 95;
    this.cycleCostPerKwh  = settings.cycle_cost_per_kwh  ?? 0.075;
    // NL saldering (net metering) is active until 2027: export earns full retail price.
    // Set to actual export/import ratio when saldering ends.
    this.exportPriceRatio = settings.export_price_ratio  ?? 1.0;
    this._schedule = null; // { computedAt: number, slots: [{timestamp, action}] }
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
   */
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return;

    const N = prices.length;
    // Auto-detect slot duration from timestamps (supports both 1h and 15-min data)
    const slotH = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
      : 1;

    const effectiveRte       = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;
    const cycleCostPerKwh    = this.cycleCostPerKwh ?? 0;

    // SoC delta per full slot (integer %, clamped to at least 1)
    const chargeSocDelta    = Math.max(1, Math.round(
      (maxChargePowerW   / 1000) * slotH * effectiveRte * 100 / capacityKwh
    ));
    const dischargeSocDelta = Math.max(1, Math.round(
      (maxDischargePowerW / 1000) * slotH * 100 / capacityKwh
    ));

    // kWh exchanged per full slot — used only for proportional edge scaling
    const chargeKwhFull    = (maxChargePowerW   / 1000) * slotH;
    const dischargeKwhFull = (maxDischargePowerW / 1000) * slotH;

    const minSoc = this.minSoc;
    const maxSoc = this.maxSoc;

    // Pre-compute per-slot PV coverage (0–1): fraction of charge power covered by PV
    const pvCoverage = prices.map(p => {
      const pvW = this._getPvForSlot(pvForecast, p.timestamp);
      return Math.min(pvW / maxChargePowerW, 1);
    });

    // dp[soc] = max future profit achievable with this SoC from the current slot onward
    let dp = new Float64Array(101).fill(0);

    // policy[t][soc] = best action code: 0 = preserve, 1 = charge, 2 = discharge
    const policy = Array.from({ length: N }, () => new Uint8Array(101));

    // pvStrong threshold: matches policy-engine's pvStrong (≥400 W) used in
    // _mapActionToHwModeForPlanning.  Only above this coverage does the firmware
    // run zero_charge_only during preserve — below it the battery stays in standby
    // and gains no free SoC from PV.
    const pvStrongCoverage = maxChargePowerW > 0 ? 400 / maxChargePowerW : 0.15;

    // ── Backward induction ────────────────────────────────────────────────────
    for (let t = N - 1; t >= 0; t--) {
      const price = prices[t].price;
      // Grid charge cost reduced by PV coverage (fully free when PV >= charge power)
      const effectiveChargeCost = price * (1 - pvCoverage[t]);
      const newDp = new Float64Array(101).fill(-1e9);


      for (let soc = 0; soc <= 100; soc++) {

        // Preserve: firmware runs zero_charge_only only when PV is strong (≥400 W),
        // so only apply free SoC gain above that threshold.  Weak PV results in
        // standby — no free charging.
        const pvSocGain  = pvCoverage[t] >= pvStrongCoverage
          ? Math.round(pvCoverage[t] * chargeSocDelta)
          : 0;
        const preserveSoc = Math.min(maxSoc, soc + pvSocGain);
        const vPreserve  = dp[preserveSoc];

        // Charge: SoC rises; cost is reduced when PV covers part of the charge power.
        // Half the cycle cost applies here (wear from charging), regardless of PV coverage.
        let vCharge = -1e9;
        if (soc < maxSoc) {
          const newSoc    = Math.min(maxSoc, soc + chargeSocDelta);
          const socDelta  = newSoc - soc; // may be less than chargeSocDelta at the top
          const kwh       = chargeKwhFull * socDelta / chargeSocDelta;
          vCharge = -(effectiveChargeCost + cycleCostPerKwh * 0.5) * kwh + dp[newSoc];
        }

        // Discharge: SoC falls, avoided grid cost.
        // If consumption data is available, discharge beyond local demand is export
        // (worth exportPriceRatio of retail price vs. 100% for local consumption offset).
        // Block discharge when PV is strong: the HW battery can't discharge AND capture PV
        // in the same slot. Also prevents the irrational "discharge at maxSoc, recharge from
        // PV for free" pattern — the PV energy used for recharging has an opportunity cost
        // (it could export at market price), so such cycles are net-negative after cycle costs.
        let vDischarge = -1e9;
        if (soc > minSoc && pvCoverage[t] <= 0.5) {
          const newSoc      = Math.max(minSoc, soc - dischargeSocDelta);
          const socDelta    = soc - newSoc;
          const kwh         = dischargeKwhFull * socDelta / dischargeSocDelta;
          // null = no data (assume full local offset); 0 = learned zero consumption (all export)
          const consumptionKwh = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
            ? (consumptionWPerSlot[t] / 1000) * slotH
            : null;
          // With NL saldering (net metering, active until 2027), export earns the full
          // retail price — so the consumption split does not reduce discharge value.
          // exportPriceRatio defaults to 1.0 and can be lowered post-saldering.
          const exportPriceRatio = this.exportPriceRatio ?? 1.0;
          let dischargeValue;
          if (consumptionKwh != null && exportPriceRatio < 1.0) {
            const coveredKwh = Math.min(kwh, consumptionKwh);
            const exportKwh  = kwh - coveredKwh;
            dischargeValue = price * coveredKwh + price * exportPriceRatio * exportKwh;
          } else {
            dischargeValue = price * kwh;
          }
          // Half the cycle cost applies on discharge (other half was on charge).
          vDischarge = dischargeValue - cycleCostPerKwh * 0.5 * kwh + dp[newSoc];
        }

        // Pick best action
        let best = vPreserve, bestAction = 0;
        if (vCharge    > best) { best = vCharge;    bestAction = 1; }
        if (vDischarge > best) { best = vDischarge; bestAction = 2; }

        newDp[soc]      = best > -1e9 ? best : 0;
        policy[t][soc]  = bestAction;
      }

      dp = newDp;
    }

    // ── Forward pass: trace the optimal path from currentSoc ──────────────────
    const slots = [];
    const ACTIONS = ['preserve', 'charge', 'discharge'];
    let soc = Math.max(0, Math.min(100, Math.round(currentSoc)));

    for (let t = 0; t < N; t++) {
      const code   = policy[t][soc];
      const action = ACTIONS[code];
      slots.push({ timestamp: prices[t].timestamp, action, price: prices[t].price, socProjected: soc });

      if (code === 1) soc = Math.min(maxSoc, soc + chargeSocDelta);
      else if (code === 2) soc = Math.max(minSoc, soc - dischargeSocDelta);
      else if (pvCoverage[t] >= pvStrongCoverage) {
        // Preserve + PV strong enough for zero_charge_only: battery charges for free.
        // Below pvStrongCoverage the firmware stays in standby — no free SoC gain.
        soc = Math.min(maxSoc, soc + Math.round(pvCoverage[t] * chargeSocDelta));
      }
    }

    this._schedule = { computedAt: Date.now(), slots };
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
