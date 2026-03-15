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
    this.RTE    = settings.battery_efficiency || 0.75;
    this.minSoc = settings.min_soc  ?? 0;
    this.maxSoc = settings.max_soc  ?? 95;
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
   * @param {number|null} rte — round-trip efficiency (0-1); overrides this.RTE when provided
   * @param {Array<number>|null} consumptionWPerSlot — expected house consumption per slot in W;
   *   used to discount discharge value when output exceeds local demand (export penalty).
   */
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, rte = null, consumptionWPerSlot = null) {
   * @param {Array<{timestamp: string|Date, pvPowerW: number}>} [pvForecast]
   *   Optional per-slot PV power estimate (W). Slots with PV reduce effective
   *   grid-charge cost proportionally — the DP prefers charging during PV hours.
   */
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return;

    const N      = prices.length;
    const slotH  = 1; // 1 hour per slot (policy runs on hourly price data)

    const effectiveRte = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;

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

    // ── Backward induction ────────────────────────────────────────────────────
    for (let t = N - 1; t >= 0; t--) {
      const price = prices[t].price;
      // Grid charge cost reduced by PV coverage (fully free when PV >= charge power)
      const effectiveChargeCost = price * (1 - pvCoverage[t]);
      const newDp = new Float64Array(101).fill(-1e9);

      // Expected local consumption this slot in kWh (0 if unknown)
      const consumptionKwhSlot = (consumptionWPerSlot && consumptionWPerSlot[t] > 0)
        ? (consumptionWPerSlot[t] / 1000) * slotH
        : null;

      for (let soc = 0; soc <= 100; soc++) {

        // Preserve: SoC unchanged
        const vPreserve = dp[soc];

        // Charge: SoC rises; cost is reduced when PV covers part of the charge power
        let vCharge = -1e9;
        if (soc < maxSoc) {
          const newSoc    = Math.min(maxSoc, soc + chargeSocDelta);
          const socDelta  = newSoc - soc; // may be less than chargeSocDelta at the top
          const kwh       = chargeKwhFull * socDelta / chargeSocDelta;
          vCharge = -effectiveChargeCost * kwh + dp[newSoc];
        }

        // Discharge: SoC falls, avoided grid cost.
        // If consumption data is available, discharge beyond local demand is export
        // (worth ~30% of retail price vs. 100% for local consumption offset).
        let vDischarge = -1e9;
        if (soc > minSoc) {
          const newSoc    = Math.max(minSoc, soc - dischargeSocDelta);
          const socDelta  = soc - newSoc;
          const kwh       = dischargeKwhFull * socDelta / dischargeSocDelta;
          let dischargeValue;
          if (consumptionKwhSlot != null) {
            const coveredKwh = Math.min(kwh, consumptionKwhSlot);
            const exportKwh  = kwh - coveredKwh;
            dischargeValue = price * coveredKwh + price * 0.3 * exportKwh;
          } else {
            dischargeValue = price * kwh;
          }
          vDischarge = dischargeValue + dp[newSoc];
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
      slots.push({ timestamp: prices[t].timestamp, action });

      if      (code === 1) soc = Math.min(maxSoc, soc + chargeSocDelta);
      else if (code === 2) soc = Math.max(minSoc, soc - dischargeSocDelta);
    }

    this._schedule = { computedAt: Date.now(), slots };
  }

  /**
   * Find the PV power (W) forecast for a given price-slot timestamp.
   * Returns 0 when no PV data is available or no matching slot found.
   * @private
   */
  _getPvForSlot(pvForecast, timestamp) {
    if (!pvForecast || pvForecast.length === 0) return 0;
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
    if (newSettings.battery_efficiency != null) this.RTE    = newSettings.battery_efficiency;
    if (newSettings.min_soc            != null) this.minSoc = newSettings.min_soc;
    if (newSettings.max_soc            != null) this.maxSoc = newSettings.max_soc;
    this._schedule = null; // invalidate — will recompute on next policy run
  }
}

module.exports = OptimizationEngine;
