'use strict';

const { exportValue } = require('./price-formulas');

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
// SoC threshold (grid units) below which policy-engine's lowSocGridTopUp heuristic
// forces a grid charge on a cheap slot. Shared by the backward-induction override,
// the forward-pass top-up simulation, and the reorder re-sim.
const TOPUP_THRESH_G = 40 * GRID;

class OptimizationEngine {
  constructor(settings) {
    this.RTE              = settings.battery_efficiency  || 0.75;
    this.minSoc           = settings.min_soc             ?? 0;
    this.maxSoc           = settings.max_soc             ?? 95;
    this.cycleCostPerKwh  = settings.cycle_cost_per_kwh  ?? 0.075;
    // NL saldering (net metering) is active until 2027: export earns full retail price.
    // Set to actual export/import ratio when saldering ends.
    this.exportPriceRatio = settings.export_price_ratio  ?? 1.0;
    // Tariff model: 'saldering' (net metering, export == retail import) or
    // 'asymmetric_2027' (post-saldering: export valued per-slot at prices[t].exportPrice).
    this.tariffModel      = settings.tariff_model        ?? 'saldering';
    // Flatten-gate arb guard (default off → shadow-log only). When on, the per-SoC
    // flatten (backward loop) is skipped at slots where a future discharge slot beats
    // the charge-now→discharge-later round-trip cost, so the charge gradient survives.
    this.flattenArbGate   = settings.dp_flatten_arb_gate ?? false;
    this._schedule = null; // { computedAt: number, projectedProfit: number, slots: [{timestamp, action}] }
  }

  /**
   * €/kWh credited for exporting PV in a given slot — the single source of truth
   * for export value across both DP passes (backward + forward).
   * Saldering: export offsets import 1:1, so it equals the retail import price.
   * asymmetric_2027: post-saldering per-slot export price from chunk-1 plumbing
   * (falls back to the legacy scalar exportPriceRatio when the field is absent).
   */
  _exportValue(priceSlot) {
    return exportValue(priceSlot, this.tariffModel, this.exportPriceRatio ?? 1.0);
  }

  /**
   * Derive overnight refill-reserve confidence (0–1) from same-day PV forecast error.
   * Consumed as the `refillConfidence` param of compute(): low confidence raises the
   * overnight reserveFloor so the battery is not drained to empty when tomorrow's PV
   * is likely to under-deliver.
   *
   * Two signals, both from today's actual-vs-forecast samples:
   *   cv    — coefficient of variation of the per-sample error (forecast volatility).
   *           High cv → models disagree / conditions noisy → lower confidence.
   *   ratio — mean actual / bias-corrected forecast. ratio < 1 means PV under-delivered
   *           vs the forecast the DP actually uses. This is the asymmetric downside term:
   *           a consistently over-optimistic forecast (low cv, ratio≈0.5) must still lower
   *           confidence, otherwise the battery drains overnight and the morning refill fails.
   *           Over-delivery (ratio > 1) is upside and is ignored.
   *
   * A third, independent signal lifts confidence regardless of the same-day terms:
   *   pvRefill — tomorrow's forecast net surplus (haircut by `ratio`) as a fraction of
   *              the usable SoC span. cv/ratio only measure TODAY's forecast accuracy,
   *              which spikes on low-light sample noise every sunset and says nothing
   *              about tomorrow's actual forecast. When the forecast itself covers the
   *              span, the battery recovers and the reserve guards a risk that is gone,
   *              so we take the stronger of (same-day confidence, pvRefill).
   *
   * @param {number} [cv]    same-day forecast-error CV; undefined on cold start → no cv penalty
   * @param {number} [ratio] mean actual / post-bias forecast; undefined → no downside penalty
   * @param {number} [pvKwhTomorrow] within-horizon forecast net PV surplus (kWh); 0 → no lift
   * @param {number} [usableSpanKwh] usable SoC span (kWh); 0 → no lift
   * @param {number} [spreadRel] forward model-spread: radiation-weighted relative std of the
   *                 per-model ensemble over the same window as pvKwhTomorrow. cv/ratio look
   *                 backward (today) and the pvRefill lift trusts tomorrow's point forecast;
   *                 spread is the only forward uncertainty signal, so it caps the final
   *                 confidence — including the lift, which is exactly the claim the models
   *                 disagree about. undefined (no ensemble / cold start) → no cap.
   * @returns {number} confidence in [0, 1]
   */
  static refillConfidenceFromForecast(cv, ratio, pvKwhTomorrow = 0, usableSpanKwh = 0, spreadRel = undefined) {
    // cv ≤ 0.25 → 1.0, cv ≥ 0.60 → 0.0, linear between (matches the PV bias cvWeight).
    let conf = (typeof cv === 'number')
      ? Math.max(0, Math.min(1, (0.60 - cv) / 0.35))
      : 1.0;
    if (typeof ratio === 'number' && ratio < 1) conf *= ratio;
    if (usableSpanKwh > 0 && pvKwhTomorrow > 0) {
      const haircut = (typeof ratio === 'number' && ratio < 1) ? ratio : 1;
      const pvRefill = Math.min(1, (pvKwhTomorrow * haircut) / usableSpanKwh);
      conf = Math.max(conf, pvRefill);
    }
    if (typeof spreadRel === 'number') {
      // spread ≤ 0.25 → 1.0 (agreement, no-op), ≥ 0.75 → 0.0, linear between.
      const spreadConf = Math.max(0, Math.min(1, (0.75 - spreadRel) / 0.50));
      conf = Math.min(conf, spreadConf);
    }
    return conf;
  }

  /**
   * Sum net PV surplus over a time window, in kWh (rounded to 0.1).
   *
   * For each forecast slot whose timestamp is in (startMs, endMs], the net
   * surplus = clamp(pvPowerW − consumptionW, 0, maxChargePowerW) is accumulated
   * (slots are treated as hourly, so W ≈ Wh per slot — matches the existing
   * pvKwhTomorrow math). consumptionFn(Date) returns predicted house load (W),
   * or is omitted for 0.
   *
   * Two windows use this:
   *   - now → now+24h: PV that refills WITHIN the planning horizon (drives the
   *     flattening / pvAbundant / night-floor guards).
   *   - horizonEnd → horizonEnd+24h: PV that refills AFTER the horizon ends
   *     (drives terminal value). Starting at the horizon end avoids double-counting
   *     today's PV, which the DP forward pass already credits via pvWPerSlot.
   *
   * @returns {number} net surplus in kWh.
   */
  static sumPvNetWindow(pvForecast, startMs, endMs, maxChargePowerW, consumptionFn = null) {
    if (!Array.isArray(pvForecast)) return 0;
    let netWh = 0;
    for (const { timestamp, pvPowerW } of pvForecast) {
      const slotMs = new Date(timestamp).getTime();
      if (slotMs <= startMs || slotMs > endMs) continue;
      const consW = consumptionFn ? (consumptionFn(new Date(timestamp)) ?? 0) : 0;
      netWh += Math.min(maxChargePowerW, Math.max(0, pvPowerW - consW));
    }
    return Math.round(netWh / 100) / 10;
  }

  /**
   * PV spread-band: discount each slot's PV by its cross-model disagreement
   * (spreadFrac = ensemble std/mean) for conservative discharge-cap sizing.
   * spreadFrac 0 (models agree, incl. the predictable dawn/dusk ramp) → identity.
   * Never raises PV; clamped ≥0. z = conservatism in σ.
   * @param {Array<number>} pvW per-slot PV watts
   * @param {Array<number>} spreadFrac per-slot relative spread (0..1)
   * @param {number} z conservatism in σ
   * @returns {Array<number>} discounted per-slot PV watts (same length)
   */
  static _applyPvSpreadBand(pvW, spreadFrac, z = 1.0) {
    if (!Array.isArray(pvW) || !Array.isArray(spreadFrac)) return pvW;
    return pvW.map((w, t) => Math.max(0, w * (1 - z * (spreadFrac[t] ?? 0))));
  }

  /**
   * PV-headroom gate: true when tomorrow's PV is abundant and confidently forecast
   * enough that an anticipated forced low-SoC grid top-up (lowSocGridTopUp) would
   * never actually fire live — PV refills the battery for free instead. Shared by
   * the reorder-block's topup-avoidance guard (optimization-engine.js) and the
   * live/planning lowSocGridTopUp checks (policy-engine.js) so both agree on when
   * the anticipated top-up is real vs. moot.
   */
  static pvHeadroomGateOpen(pvKwhTomorrow, capacityKwh, refillConfidence) {
    return pvKwhTomorrow >= capacityKwh * 0.9 && refillConfidence >= 0.8;
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
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0, consumptionMargin = 1.0, pvKwhTomorrow = 0, terminalPvKwhTomorrow = pvKwhTomorrow, pvCloudFactor = 1.0, refillConfidence = 1.0, pvTimingRobust = false, maxChargePrice = 0) {
    if (!prices || prices.length === 0 || !capacityKwh || capacityKwh <= 0) return;
    // Broken price feed (parse anomaly → null/NaN price) must not reach the DP:
    // a null price compares as 0, so the DP plans grid charging on "free" energy.
    // Refuse the whole horizon; the previous schedule stays active until a clean fetch.
    if (prices.some(p => !Number.isFinite(p?.price))) return;

    const N = prices.length;
    // Auto-detect slot duration from timestamps (supports both 1h and 15-min data)
    const slotH = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
      : 1;

    const effectiveRte    = (rte != null && rte > 0.3 && rte <= 1) ? rte : this.RTE;
    const cycleCostPerKwh = this.cycleCostPerKwh ?? 0;
    // PV-headroom: when true, an anticipated forced grid top-up would never actually
    // fire live (PV refills for free instead) — see pvHeadroomGateOpen doc comment.
    const pvHeadroomOpen  = OptimizationEngine.pvHeadroomGateOpen(pvKwhTomorrow, capacityKwh, refillConfidence);

    // ── SoC grid setup ─────────────────────────────────────────────────────────
    const GRID_TOTAL = GRID * 100;
    const minSocG    = Math.round(this.minSoc * GRID);
    const maxSocG    = Math.round(this.maxSoc * GRID);

    // Pre-compute per-slot PV coverage (0–1): fraction of charge power covered by PV SURPLUS.
    // Net surplus = max(0, pvW − consW): PV first serves house load; only the remainder
    // enters the battery (zero_charge_only). Using raw pvW would overstate free charge.
    const pvIndex = this._buildPvIndex(pvForecast);
    const pvWPerSlot = [];
    const pvCoverage = prices.map((p, t) => {
      const pvW   = this._getPvForSlot(pvIndex, new Date(p.timestamp).getTime());
      const consW = Math.max(50, Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] : 50); // 50W baseload floor (unlearned and zero-learned slots)
      pvWPerSlot.push(pvW);
      const raw = Math.min(1, Math.max(0, pvW - consW) / maxChargePowerW);
      return raw * (pvCloudFactor ?? 1.0);
    });
    // Per-slot ensemble spread (std/mean) for the discharge-cap spread-band. Rides on the
    // pvForecast slots from weather-forecaster; null when forecast carries no spread.
    const pvSpreadPerSlot = pvTimingRobust
      ? prices.map(p => this._getPvSpreadForSlot(pvIndex, new Date(p.timestamp).getTime()))
      : null;

    // Remaining fraction of the current slot: when recomputing mid-slot the DP must
    // model only the remaining time, otherwise it overestimates the benefit of preserve
    // (treats a partial slot as a full 0.8 kWh charging opportunity, biasing it to defer
    // charging to the next slot even when that slot is only marginally better).
    const firstSlotMs    = new Date(prices[0].timestamp).getTime();
    const slotDurationMs = slotH * 3_600_000;
    const slot0RemainingFrac = Math.max(0.01, Math.min(1.0,
      (firstSlotMs + slotDurationMs - Date.now()) / slotDurationMs));

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, chargeKwhFull, pvStrongCoverage,
            slot0ChargeSocDeltaG, slot0ChargeKwhFull, reserveFloorG, terminalFactor,
            pvKwhFromT, eveningNeedKwh, lastStrongPv, topupFiringSlots } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG, consumptionMargin, pvKwhTomorrow,
        slot0RemainingFrac, pvWPerSlot, terminalPvKwhTomorrow, refillConfidence, pvTimingRobust, pvSpreadPerSlot, maxChargePrice, currentSoc);

    const initialSocG     = Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID)));
    const projectedProfit = dp[initialSocG] ?? 0;

    // ── Forward pass: trace the optimal path from currentSoc ──────────────────
    const slots = [];
    const ACTIONS = ['preserve', 'charge', 'discharge', 'standby'];
    let socG = initialSocG;

    // Today-only profit: revenue from discharge − cost of grid charge, same day (Amsterdam).
    // Excludes terminal value and tomorrow slots — makes tracking comparable to cycle_history.
    const todayStr = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
    let todayProjectedProfit = 0;

    // Suffix-max of future positive prices — used to approximate _pvStoreWins per slot.
    // When max_future × RTE > current price, the runtime policy will charge from PV surplus
    // even if the DP chose standby (export). We simulate this so the planning display matches
    // actual behaviour (the DP backward pass is unchanged).
    const suffixMaxPrice = new Array(N).fill(0);
    for (let k = N - 2; k >= 0; k--) {
      const p = prices[k + 1]?.price ?? 0;
      suffixMaxPrice[k] = Math.max(p > 0 ? p : 0, suffixMaxPrice[k + 1]);
    }
    // Trickle-capped suffix max: same as suffixMaxPrice but resets to 0 at pvStrong slots.
    // PV-strong hours refill the battery independently — trickle energy stored before them
    // cannot reach high-price slots beyond the saturation point (those kWh come from PV).
    // Without this cap the trickle check picks up tomorrow's peak price even when tomorrow's
    // PV will fill the battery anyway, making today's trickle appear more valuable than it is.
    const trickleSuffixMaxPrice = new Array(N).fill(0);
    for (let k = N - 2; k >= 0; k--) {
      if (pvCoverage[k + 1] >= pvStrongCoverage) {
        trickleSuffixMaxPrice[k] = 0;
      } else {
        const p = prices[k + 1]?.price ?? 0;
        trickleSuffixMaxPrice[k] = Math.max(p > 0 ? p : 0, trickleSuffixMaxPrice[k + 1]);
      }
    }
    // Suffix-min of future pvStrong slot prices. When a cheaper pvStrong slot is ahead,
    // the battery will be refilled for free at that slot — overriding a DP standby decision
    // to preserve/charge at the current (more expensive) pvStrong slot is suboptimal.
    const minFuturePvStrongPrice = new Array(N).fill(Infinity);
    for (let k = N - 2; k >= 0; k--) {
      const nextIsPvStrong = pvCoverage[k + 1] >= pvStrongCoverage;
      const nextPrice = prices[k + 1]?.price ?? 0;
      const nextCandidate = (nextIsPvStrong && nextPrice > 0) ? nextPrice : Infinity;
      minFuturePvStrongPrice[k] = Math.min(nextCandidate, minFuturePvStrongPrice[k + 1]);
    }
    // _pvStoreWins is suppressed at runtime when strongly negative prices are coming.
    // A negative-price slot only helps THIS evening's coverage if it's reachable before
    // the evening tail starts — one scheduled after lastStrongPv can't refill the battery
    // in time for tonight's peak, so it must not suppress the override (live gap
    // 2026-07-01: a negative slot anywhere in the full 48h horizon — even tomorrow —
    // blocked charging regardless of tonight's coverage risk).
    const strongNegWindow = lastStrongPv >= 0 ? lastStrongPv + 1 : N;
    const hasFutureStrongNeg = prices.slice(0, strongNegWindow).some(p => (p.price ?? 0) < -0.10);

    for (let t = 0; t < N; t++) {
      const code  = policy[t][socG];
      const price = prices[t].price;
      let action  = ACTIONS[code];

      // Runtime store value (mirrors policy-engine _pvStoreValue): the trickle-capped suffix max.
      // A far price peak BEYOND a pvStrong refill is served by free PV later, so storing now is
      // not worthwhile — the cap drops it. Fall back to the uncapped suffix max only when the cap
      // zeroes out, matching the runtime fallback. Using the uncapped value here projected SoC
      // rising ("battery fills") on slots the runtime actually exports, so plan diverged from reality.
      const cappedStore = trickleSuffixMaxPrice[t] * effectiveRte;
      const storeValue  = cappedStore > 0 ? cappedStore : suffixMaxPrice[t] * effectiveRte;
      const pvStoreBeatsExport = storeValue > this._exportValue(prices[t]);

      // Standby + strong PV surplus: storing beats exporting → runtime charges from PV.
      // Override action to 'preserve' so buildPlanningSchedule shows zero_charge_only.
      // Exception: when a cheaper pvStrong slot follows, the DP correctly prefers to export
      // now and charge for free later — don't override that decision.
      // Require the future slot to be meaningfully cheaper (mirrors pvDelayMin's 1.30x/€0.03
      // threshold in policy-engine.js) — a bare `<` re-defers on every trivial cent-dip along a
      // falling duck-curve, chaining deferrals from morning to the price trough and squeezing the
      // charge window down to whatever PV is left once it's already fading (live 2026-07-01 bug:
      // battery stayed at 2-3% SoC 09:00-17:00 despite 2-2.5kW PV surplus being exported).
      const cheaperPvAhead = pvCoverage[t] >= pvStrongCoverage
        && minFuturePvStrongPrice[t] < Infinity
        && price > minFuturePvStrongPrice[t] * 1.30
        && price - minFuturePvStrongPrice[t] >= 0.03;
      // Safety net: even a "meaningfully cheaper" future slot isn't worth deferring for if
      // waiting risks not having enough energy left for the evening's actual (learned) need.
      // eveningNeedKwh is the post-PV-window energy demand at eligible prices (same window
      // the reserve floor uses); pvKwhFromT is the remaining free-PV headroom still reachable.
      const currentKwh = (socG / GRID / 100) * capacityKwh;
      const usableSpanKwh = ((maxSocG - minSocG) / GRID_TOTAL) * capacityKwh;
      const futurePvHeadroomKwh = Math.min(usableSpanKwh - currentKwh, pvKwhFromT[t + 1] ?? 0);
      const eveningCoverageAtRisk = eveningNeedKwh > 0 && (currentKwh + futurePvHeadroomKwh) < eveningNeedKwh;
      let pvStoreWins = false;
      if (code === 3 && !hasFutureStrongNeg && pvCoverage[t] >= pvStrongCoverage && price > 0 && pvStoreBeatsExport
          && (!cheaperPvAhead || eveningCoverageAtRisk)) {
        action = 'preserve';
        pvStoreWins = true;
      }
      // Weak PV trickle: standby + net surplus below pvStrong threshold.
      // Use trickleSuffixMaxPrice (not suffixMaxPrice) so prices beyond the first pvStrong
      // saturation slot are excluded — those slots are served by free PV, not today's trickle.
      const pvStoreValue2 = trickleSuffixMaxPrice[t] * effectiveRte;
      const _exportVal = this._exportValue(prices[t]);
      // trickleSuffixMaxPrice resets to 0 at a downstream pvStrong slot, assuming that refill
      // saturates the battery so a later peak is unreachable. For a WEAK slot (cov < pvStrong)
      // the surplus is small and independent of that refill; when the battery still has room
      // (socG < maxSocG) and the uncapped store beats exporting, the peak IS reachable — store
      // the PV-only surplus rather than export it (live 2026-06-01 14:00 bug).
      const weakReachable = pvCoverage[t] > 0 && pvCoverage[t] < pvStrongCoverage
        && socG < maxSocG && storeValue > _exportVal;
      const trickleWins = pvStoreValue2 > _exportVal || weakReachable;
      const pvTrickle = !pvStoreWins && trickleWins && code === 3 && pvCoverage[t] > 0;
      if (pvTrickle) action = 'trickle';

      const pvExportWins = !pvStoreWins && !pvTrickle && code === 3 && pvCoverage[t] > 0;

      // kWh actually moved by the chosen action this slot — surfaces the slot0-partial-hour
      // vs full-hour quantum (only slot 0 is scaled to the remaining time in the current hour;
      // every other slot buys/sells a full slotH), so a "cheap hour skipped" question can be
      // answered from this log alone instead of an offline DP replay.
      const slotDeltaG  = t === 0 ? slot0ChargeSocDeltaG : chargeSocDeltaG;
      const slotKwhFull = t === 0 ? slot0ChargeKwhFull   : chargeKwhFull;

      // Forced low-SoC grid top-up (mirrors policy-engine lowSocGridTopUp → to_full).
      // The backward pass already values preserve/standby at this state as a forced
      // charge (vForcedCharge override), so the forward projection must take the same
      // SoC step — otherwise the traced path diverges from the valued path and from
      // the runtime, which really does charge. Preserve at negative price is excluded:
      // the runtime preserve branch returns standby there before its top-up check.
      // (At a firing sub-40% state the override ties preserve/standby to the same
      // value and preserve wins the tie, so 'standby'/'trickle' can't actually occur;
      // the standby case is kept for symmetry with the runtime's standby branch.)
      const topupForced = !!(topupFiringSlots?.[t] && socG < TOPUP_THRESH_G
        && ((action === 'preserve' && price >= 0) || action === 'standby'));

      let actionKwh = null;
      if (code === 1) {
        actionKwh = slotKwhFull * Math.min(slotDeltaG, maxSocG - socG) / slotDeltaG;
      } else if (code === 2) {
        actionKwh = (Math.min(perSlotDischargeSocDeltaG[t], socG - reserveFloorG[t]) / GRID_TOTAL) * capacityKwh;
      } else if (topupForced) {
        actionKwh = slotKwhFull * Math.min(slotDeltaG, maxSocG - socG) / slotDeltaG;
      }

      slots.push({ timestamp: prices[t].timestamp, action, price, exportPrice: prices[t].exportPrice ?? null, socProjected: socG / GRID, pvExportWins,
        consumptionW: Array.isArray(consumptionWPerSlot) ? (consumptionWPerSlot[t] ?? null) : null,
        pvForecastW: pvWPerSlot[t] ?? null,
        pvStoreValue: storeValue,
        pvTrickleMaxValue: trickleSuffixMaxPrice[t] * effectiveRte,
        pvCoverage: pvCoverage[t],
        cheaperPvAhead: cheaperPvAhead || false,
        pvStoreWins: pvStoreWins || false,
        topupForced,
        actionKwh });

      const isToday = new Date(prices[t].timestamp)
        .toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10) === todayStr;

      if (code === 1) {
        if (isToday) {
          const actualDeltaG  = Math.min(slotDeltaG, maxSocG - socG);
          const gridChargeKwh = (actualDeltaG / slotDeltaG) * slotKwhFull * (1 - pvCoverage[t]);
          todayProjectedProfit -= price * gridChargeKwh;
        }
        socG = Math.min(maxSocG, socG + slotDeltaG);
      } else if (code === 2) {
        if (isToday) {
          const actualDeltaG   = Math.min(perSlotDischargeSocDeltaG[t], socG - reserveFloorG[t]);
          const dischargeKwh   = (actualDeltaG / GRID_TOTAL) * capacityKwh;
          todayProjectedProfit += price * dischargeKwh * effectiveRte;
        }
        socG = Math.max(reserveFloorG[t], socG - perSlotDischargeSocDeltaG[t]);
      } else if (topupForced) {
        // Forced grid top-up: same quantum as a charge slot; cost booked like charge
        // (grid fraction only — weak PV covers part of the power at no grid cost).
        if (isToday) {
          const actualDeltaG  = Math.min(slotDeltaG, maxSocG - socG);
          const gridChargeKwh = (actualDeltaG / slotDeltaG) * slotKwhFull * (1 - pvCoverage[t]);
          todayProjectedProfit -= price * gridChargeKwh;
        }
        socG = Math.min(maxSocG, socG + slotDeltaG);
      } else if (code === 0 && pvCoverage[t] >= pvStrongCoverage && prices[t].price >= 0 && pvStoreBeatsExport) {
        // Preserve + strong PV + storing beats exporting: battery charges for free.
        // Without pvStoreBeatsExport the runtime exports this surplus (standby), so projecting
        // a charge here overstated the SoC versus actual behaviour.
        socG = Math.min(maxSocG, socG + Math.round(pvCoverage[t] * slotDeltaG));
      } else if (pvStoreWins || pvTrickle) {
        // pvStoreWins / pvTrickle: simulate free PV charging for accurate SoC projection.
        socG = Math.min(maxSocG, socG + Math.round(pvCoverage[t] * slotDeltaG));
      }
    }
    const finalSocG = socG; // terminal SoC from DP forward pass

    // ── Post-DP: reorder night-window discharge by price ─────────────────────
    // The backward-DP flatten can mis-order discharge when night prices are
    // non-monotone (e.g. 23:00=€0.272 < midnight=€0.278).  After the forward
    // pass, find the first contiguous non-PV block (evening → overnight, until
    // pvCoverage ≥ pvStrongCoverage) and sort eligible discharge slots by price,
    // assigning discharge to the most expensive slots within the battery budget.
    // Total energy used in the window stays within the same budget.
    const _preReorder = process.env.DP_REORDER_DUMP ? slots.map(s => s.action) : null;
    {
      // Find the overnight non-PV window for discharge reordering. When PV is
      // producing at t=0 (evening run), skip past the remaining PV block to find
      // the night window that starts after PV drops off. The old gate
      // (pvCoverage[0]>0 → wEnd=0) disabled reordering entirely on evening runs,
      // stranding discharge on the cheapest slot instead of the priciest.
      let wStart = 0;
      if ((pvCoverage[0] ?? 0) > 0) {
        // Skip past the current PV block to find where night begins
        while (wStart < N && pvCoverage[wStart] >= pvStrongCoverage) wStart++;
      }
      let wEnd = wStart;
      for (let t = wStart; t < N; t++) {
        if (pvCoverage[t] >= pvStrongCoverage) break;
        if (slots[t].action === 'charge') break;
        wEnd = t + 1;
      }
      const windowLen = wEnd - wStart;
      if (windowLen >= 2) {
        const eligible = [];
        for (let t = wStart; t < wEnd; t++) {
          const effMin = Array.isArray(minDischargePrice) ? (minDischargePrice[t] ?? 0) : minDischargePrice;
          if (slots[t].price >= effMin) eligible.push(t);
        }
        const hasCharge = slots.slice(wStart, wEnd).some(s => s.action === 'charge');
        if (eligible.length >= 2 && !hasCharge) {
          // Peak SoC the forward pass reaches inside the window — the top of any
          // in-window charge or forced top-up (preserve+topupForced) that lifts SoC
          // above initialSocG before the discharge slots. socProjected (line ~401) is
          // set at slot entry, so the peak equals the fully-charged level from which
          // discharge should be budgeted. Budgeting from initialSocG strands that gain,
          // and when the un-flattened DP holds a high end-SoC, dpEndTargetG then starves
          // the discharge budget to a single slot (poging #2 root cause).
          let peakWindowSocG = initialSocG;
          for (let t = wStart; t < wEnd; t++) {
            const sg = Math.round(slots[t].socProjected * GRID);
            if (sg > peakWindowSocG) peakWindowSocG = sg;
          }
          eligible.sort((a, b) => slots[b].price - slots[a].price);
          const rawEndG = wEnd < N ? Math.round(slots[wEnd].socProjected * GRID) : finalSocG;
          const dpEndTargetG = Math.max(rawEndG, wEnd > 0 ? reserveFloorG[wEnd - 1] : minSocG);
          const effFloorG = t => Math.max(reserveFloorG[t], dpEndTargetG);
          const assigned = new Set();
          // SoC at window start: for wStart>0 use the DP's projected SoC entering
          // the night window (not initialSocG which is the horizon-start SoC).
          // For wStart==0 the window can contain pre-discharge top-up/charge slots, so
          // (under the arb gate) use the SoC entering the first discharge slot instead
          // of initialSocG — never below initialSocG.
          const windowStartSocG = wStart > 0
            ? Math.round(slots[wStart].socProjected * GRID)
            : (this.flattenArbGate ? peakWindowSocG : initialSocG);
          let remainSocG = windowStartSocG;
          const _rdTrace = []; // SHADOW-DIAG: topup-guard reorder trace
          let _guardKwh = 0, _guardEur = 0; // energy + Σ kWh×(price−cycle) actually discharged WITH guard
          for (const t of eligible) {
            const stopG = effFloorG(t);
            if (remainSocG <= stopG) break;
            // Skip discharge if it drains SoC below 40% and a subsequent lowSocGridTopUp
            // slot would fire a forced grid refill that makes the cycle net-negative.
            // Skipped entirely under PV-headroom: the anticipated top-up would never
            // actually fire live (PV refills for free instead), so there is no real
            // net-negative cycle to guard against.
            if (maxChargePrice > 0 && !pvHeadroomOpen) {
              const socAfterG = Math.max(stopG, remainSocG - perSlotDischargeSocDeltaG[t]);
              if (socAfterG < TOPUP_THRESH_G) {
                let minTopupPrice = Infinity;
                for (let u = t + 1; u < N; u++) {
                  const fp = prices[u].price;
                  if (fp !== null && fp <= maxChargePrice && pvCoverage[u] < pvStrongCoverage) {
                    minTopupPrice = Math.min(minTopupPrice, fp);
                  }
                }
                if (minTopupPrice < Infinity) {
                  const breakEven = (minTopupPrice + cycleCostPerKwh) / effectiveRte;
                  if (slots[t].price < breakEven) {
                    if (_rdTrace.length < 10) _rdTrace.push({ t, p: +slots[t].price.toFixed(3), skip: 'topup', mt: +minTopupPrice.toFixed(3), be: +breakEven.toFixed(3) });
                    continue;
                  }
                }
              }
            }
            assigned.add(t);
            const spentG = remainSocG - Math.max(stopG, remainSocG - perSlotDischargeSocDeltaG[t]);
            _guardKwh += spentG / GRID_TOTAL * capacityKwh;
            _guardEur += (spentG / GRID_TOTAL * capacityKwh) * (slots[t].price - cycleCostPerKwh);
            remainSocG = Math.max(stopG, remainSocG - perSlotDischargeSocDeltaG[t]);
            if (_rdTrace.length < 10) _rdTrace.push({ t, p: +slots[t].price.toFixed(3), skip: 'assign' });
          }
          // SHADOW-DIAG: counterfactual — same budget, priciest-first, WITHOUT the topup guard.
          // Delta = what a future switch-on would gain: the guard both (a) reorders discharge to
          // cheaper slots and (b) can leave budget unspent (SoC held → imported). deltaEur =
          // unguarded − guarded total discharge value (both minus cycle). Log-only, no behaviour change.
          let _unguKwh = 0, _unguEur = 0, _remU = windowStartSocG;
          for (const t of eligible) {
            const stopG = effFloorG(t);
            if (_remU <= stopG) break;
            const spentG = _remU - Math.max(stopG, _remU - perSlotDischargeSocDeltaG[t]);
            _unguKwh += spentG / GRID_TOTAL * capacityKwh;
            _unguEur += (spentG / GRID_TOTAL * capacityKwh) * (slots[t].price - cycleCostPerKwh);
            _remU = Math.max(stopG, _remU - perSlotDischargeSocDeltaG[t]);
          }
          this._reorderDebug = {
            wStart, wEnd, eligibleN: eligible.length,
            maxChargePrice: +(+maxChargePrice).toFixed(3),
            floor0Pct: +(effFloorG(wStart) / GRID).toFixed(1),
            startSocPct: +(windowStartSocG / GRID).toFixed(1),
            gateOpen: pvHeadroomOpen,
            pvTom: +(+pvKwhTomorrow).toFixed(1),
            conf: +(+refillConfidence).toFixed(2),
            guardKwh: +_guardKwh.toFixed(2),
            unguKwh: +_unguKwh.toFixed(2),
            deltaEur: +(_unguEur - _guardEur).toFixed(3), // gross (foregone-export not yet subtracted)
            trace: _rdTrace,
          };
          let changed = false;
          for (let t = wStart; t < wEnd && !changed; t++) {
            if ((slots[t].action === 'discharge') !== assigned.has(t)) changed = true;
          }
          if (changed) {
            const snapshot = slots.slice(wStart, wEnd).map(s => ({ action: s.action, socProjected: s.socProjected, topupForced: s.topupForced }));
            let socGw = windowStartSocG;
            for (let t = wStart; t < wEnd; t++) {
              if (assigned.has(t) && socGw > effFloorG(t)) {
                slots[t].action = 'discharge';
              } else if (slots[t].action === 'discharge') {
                slots[t].action = 'preserve';
              }
              slots[t].socProjected = socGw / GRID;
              const slotDeltaG = t === 0 ? slot0ChargeSocDeltaG : chargeSocDeltaG;
              // Forced top-up mirror (same condition as the forward pass): the reordered
              // trajectory can hit the sub-40% threshold at a different slot than the
              // original one, and skipping the gain here would understate socGw and
              // false-fire the undershoot rollback below on any window with a topup slot.
              // A slot reassigned to discharge gets no top-up (runtime: discharge hint
              // bypasses the heuristic), so re-derive the flag from the new action.
              const topupF = !!(topupFiringSlots?.[t] && socGw < TOPUP_THRESH_G
                && slots[t].action === 'preserve' && prices[t].price >= 0);
              slots[t].topupForced = topupF;
              if (slots[t].action === 'discharge') {
                socGw = Math.max(effFloorG(t), socGw - perSlotDischargeSocDeltaG[t]);
              } else if (slots[t].action === 'charge') {
                socGw = Math.min(maxSocG, socGw + slotDeltaG);
              } else if (topupF) {
                socGw = Math.min(maxSocG, socGw + slotDeltaG);
              } else if ((slots[t].action === 'trickle' || slots[t].pvStoreWins) && prices[t].price >= 0) {
                // Free-PV gain mirrors the forward pass exactly: only trickle slots
                // (and pvStoreWins preserve, which needs strong coverage and thus can't
                // sit inside this window) bank their surplus. A 'standby' slot exports
                // it — crediting any pvCoverage>0 slot here inflated socGw, let the
                // undershoot rollback below pass plans that really end under
                // dpEndTarget, and projected a SoC rise the runtime never delivers.
                socGw = Math.min(maxSocG, socGw + Math.round(pvCoverage[t] * slotDeltaG));
              }
            }
            const dpEndSocG = wEnd < N ? dpEndTargetG : socGw;
            if (socGw < dpEndSocG - 1) {
              for (let t = wStart; t < wEnd; t++) {
                const si = t - wStart;
                slots[t].action = snapshot[si].action;
                slots[t].socProjected = snapshot[si].socProjected;
                slots[t].topupForced = snapshot[si].topupForced;
              }
            }
          }
        }
      }
    }

    // ── Post-DP: eliminate isolated preserve islands in discharge sequences ──
    // Single preserve slot flanked by discharge on both sides with tiny price
    // delta (<5ct) is a DP numerical edge case — override to discharge.
    {
      for (let t = 1; t < N - 1; t++) {
        if (slots[t].action !== 'preserve') continue;
        if (slots[t - 1].action !== 'discharge') continue;
        if (slots[t + 1].action !== 'discharge') continue;
        const effMin = Array.isArray(minDischargePrice) ? (minDischargePrice[t] ?? 0) : minDischargePrice;
        if (slots[t].price < effMin) continue;
        const priceDelta = Math.max(slots[t - 1].price, slots[t + 1].price) - slots[t].price;
        if (priceDelta > 0.01) continue;
        // Budget guard: re-discharging this island consumes one more slot's worth of
        // reserve-floor budget. In a floor-constrained window the priciest-first reorder
        // deliberately holds the CHEAPEST eligible slot; turning it into a discharge here
        // over-commits the window, so the later feasibility sweep clamps an already-assigned
        // (pricier) discharge slot to the floor and strands it. Skip the override when the
        // extra drain would push any later discharge slot below its reserve floor (the slot
        // sits between discharges because it is the held cheap one, not a DP glitch).
        const socDropG = perSlotDischargeSocDeltaG[t];
        let starvesLater = false;
        for (let u = t + 1; u < N; u++) {
          if (slots[u].action !== 'discharge') continue;
          if (Math.round(slots[u].socProjected * GRID) - socDropG < reserveFloorG[u]) { starvesLater = true; break; }
        }
        if (starvesLater) continue;
        slots[t].action = 'discharge';
        slots[t].topupForced = false; // discharge hint bypasses the top-up heuristic
        const socDrop = perSlotDischargeSocDeltaG[t] / GRID;
        for (let u = t + 1; u < N; u++) {
          slots[u].socProjected = Math.max(reserveFloorG[u] / GRID, slots[u].socProjected - socDrop);
        }
      }
    }

    // ── Post-DP: final feasibility sweep ─────────────────────────────────────
    // A 'discharge' slot whose start SoC sits at the reserve floor has nothing to
    // give — the SoC trajectory already clamps the delta to 0, so the action is a
    // no-op mislabel. This happens when the preserve-island override above extends a
    // discharge run past the available energy, or when the DP assigns more discharge
    // slots than the battery can serve on flat/degenerate prices. Relabel to preserve
    // so the action stays consistent with the projected trajectory.
    for (let t = 0; t < N; t++) {
      if (slots[t].action === 'discharge' && slots[t].socProjected <= reserveFloorG[t] / GRID) {
        slots[t].action = 'preserve';
      }
      // Same principle for the topupForced label: the forward pass (or reorder re-sim)
      // sets it together with a simulated SoC rise, but the island pass can rewrite the
      // downstream trajectory (floor-clamped drain) and erase that rise. A flag whose
      // next slot no longer sits higher describes a charge the final trajectory doesn't
      // show — clear it so the label stays consistent with the projection.
      if (slots[t].topupForced && t + 1 < N && slots[t + 1].socProjected <= slots[t].socProjected) {
        slots[t].topupForced = false;
      }
    }

    if (_preReorder) {
      const diff = slots.map((s, i) => _preReorder[i] === s.action ? null : `t${i}:${_preReorder[i]}->${s.action}`).filter(Boolean);
      console.error(`[REORDER gate=${!!this.flattenArbGate}] pre->post: ${diff.length ? diff.join(' ') : 'NO CHANGE'}`);
    }

    this._schedule = { computedAt: Date.now(), projectedProfit, todayProjectedProfit, slots, terminalFactor, terminalPvKwh: terminalPvKwhTomorrow };
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
    const pvIndex2 = this._buildPvIndex(pvForecast);
    const pvWPerSlot = prices.map(p => this._getPvForSlot(pvIndex2, new Date(p.timestamp).getTime()));
    const pvCoverage = pvWPerSlot.map((pvW, t) => {
      const consW = Math.max(50, Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] : 50); // 50W baseload floor (unlearned and zero-learned slots)
      return Math.min(1, Math.max(0, pvW - consW) / maxChargePowerW);
    });

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, pvStrongCoverage } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG, consumptionMargin, pvKwhTomorrow);

    const initialSocG = Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID)));
    const profit = dp[initialSocG] ?? 0;

    // Earning capacity of this pack, for scenario comparison only.
    //
    // dp[initialSocG] credits the energy already stored at t=0, and that opening stock
    // scales linearly with pack size (same SoC %, more kWh). Comparing scenarios on it
    // therefore rewards bigger packs for charge they were simply handed — on live data
    // roughly €120/year per extra battery against a claimed gain of €175/year, which
    // dominated the "should I add a battery?" answer.
    //
    // dp[minSocG] is the same pack run from empty: the opening stock is excluded by
    // construction, using the DP's own valuation rather than a hand-rolled price. It is
    // monotone in capacity (a bigger pack starting empty can always emulate a smaller one)
    // and independent of the current SoC, so the comparison no longer drifts as SoC moves.
    //
    // `profit` stays untouched — it is the raw DP value and compute() must keep matching
    // it (optimizer-properties Invariant 11).
    const profitFromEmpty = dp[minSocG] ?? 0;

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
      else if (code === 0 && pvCoverage[t] >= pvStrongCoverage) {
        socG = Math.min(maxSocG, socG + Math.round(pvCoverage[t] * chargeSocDeltaG));
      }
      // code === 3 (standby): socG unchanged
    }

    const selfSufficiencyPct = totalConsKwh > 0
      ? Math.round((1 - totalGridImportKwh / totalConsKwh) * 100)
      : 100;

    return { profit, profitFromEmpty, selfSufficiencyPct };
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
                 minDischargePrice, maxSocG, minSocG, consumptionMargin = 1.0, pvKwhTomorrow = 0,
                 slot0RemainingFrac = 1.0, pvWPerSlot = null, terminalPvKwhTomorrow = pvKwhTomorrow, refillConfidence = 1.0, pvTimingRobust = false, pvSpreadPerSlot = null, maxChargePrice = 0, currentSoc = null) {
    const GRID_TOTAL = GRID * 100;
    // Only used for the debug trace below (what would the real SoC's decision be) —
    // null when the caller (computeExpectedProfit) has no live SoC to trace.
    const initialSocG = currentSoc != null ? Math.max(0, Math.min(GRID_TOTAL, Math.round(currentSoc * GRID))) : null;

    // SoC delta per full charge slot in grid units.
    // RTE losses belong on the discharge side (firmware reports physical SoC).
    // Applying RTE here would make each charge step too small, requiring extra
    // slots to fill — e.g. 5×1h instead of the physical 4×1h at 800W / 2.688 kWh.
    const chargeSocDeltaG = Math.max(1, Math.round(
      (maxChargePowerW / 1000) * slotH * 100 / capacityKwh * GRID
    ));
    const chargeKwhFull = (maxChargePowerW / 1000) * slotH;

    // Slot 0 may cover only a fraction of a full slot when recomputing mid-slot.
    const slot0ChargeSocDeltaG = Math.max(1, Math.round(chargeSocDeltaG * slot0RemainingFrac));
    const slot0ChargeKwhFull   = chargeKwhFull * slot0RemainingFrac;

    // Per-slot effective discharge power: limited by house consumption so the
    // battery doesn't discharge faster than the load can absorb it.
    // The firmware enforces "nul op de meter" — the battery never exports to the grid,
    // so the physical discharge rate is capped by actual house consumption.
    // consumptionMargin inflates the predicted load for a conservative SoC projection
    // (actual consumption is often higher than the learned average, e.g. dishwasher, cooking).
    // consumptionMargin can be a single number (uniform) or an array (per-slot).
    // pvTimingRobust spread-band: discount each slot's PV by its cross-model disagreement
    // (pvSpreadPerSlot = ensemble std/mean) so a time-shifted cloud the models can't agree
    // on doesn't leave the discharge-rate cap under-sized for the peak. Where models agree
    // (spread≈0, incl. the predictable sunrise/sunset ramp) it's a no-op. PV_SPREAD_Z = how
    // many σ of conservatism (1.0 = 1σ). Only the decision uses this; the chart stays p50.
    const PV_SPREAD_Z = 1.0;
    const pvWForDischarge = (pvTimingRobust && Array.isArray(pvWPerSlot) && Array.isArray(pvSpreadPerSlot))
      ? OptimizationEngine._applyPvSpreadBand(pvWPerSlot, pvSpreadPerSlot, PV_SPREAD_Z)
      : pvWPerSlot;
    const effectiveDischargePowerW = prices.map((_, t) => {
      const margin = Array.isArray(consumptionMargin) ? (consumptionMargin[t] ?? 1.20) : consumptionMargin;
      const consumptionW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] * margin
        : maxDischargePowerW;
      // Subtract PV from net load: battery only needs to cover consumption not served by PV.
      const pvW  = pvWForDischarge?.[t] ?? 0;
      const netW = Math.max(0, consumptionW - pvW);
      return Math.min(maxDischargePowerW, netW);
    });

    const perSlotDischargeSocDeltaG = effectiveDischargePowerW.map(w =>
      Math.max(0, Math.round((w / 1000) * slotH * 100 / capacityKwh * GRID))
    );
    const perSlotDischargeKwhFull = effectiveDischargePowerW.map(w =>
      (w / 1000) * slotH
    );

    // pvStrong threshold: matches policy-engine's pvStrong (≥400 W) used in
    // _mapActionToHwModeForPlanning. Only above this coverage does the firmware
    // run zero_charge_only during preserve.
    const pvStrongCoverage = maxChargePowerW > 0 ? 400 / maxChargePowerW : 0.15;

    // ── Overnight refill-reserve floor (per-slot) ─────────────────────────────
    // When the PV forecast is uncertain (low refillConfidence), hold a SoC buffer through
    // overnight non-PV slots that PRECEDE a strong-PV refill window, so the evening peak
    // stays served even if the next day's PV under-delivers vs forecast. Slots after the
    // last strong-PV refill (evening peak) keep minSocG so discharge there is unconstrained.
    // At full confidence (stable/sunny forecast) the floor collapses to minSocG → no change.
    const RESERVE_MAX_FRAC = 0.5; // cap: at confidence 0, reserve up to 50% of usable span
    const reserveAddG = Math.round((1 - refillConfidence) * RESERVE_MAX_FRAC * (maxSocG - minSocG));
    const reserveFloorG = new Int32Array(N).fill(minSocG);
    // Last strong-PV slot: boundary between the PV window and the evening/night tail.
    // Shared by the reserve floor below and by eveningNeedKwh (end of function) — one
    // definition of "where the evening tail starts," not two.
    let lastStrongPv = -1;
    for (let t = N - 1; t >= 0; t--) {
      if (pvCoverage[t] >= pvStrongCoverage) { lastStrongPv = t; break; }
    }
    if (reserveAddG > 0) {
      // The reserve is only spendable AFTER the last strong-PV slot (where the floor
      // collapses back to minSocG), so its value = the best discharge price in that
      // trailing window. Never floor a slot whose own price already exceeds that peak:
      // discharging now beats hoarding for a cheaper future peak regardless of how PV
      // resolves — otherwise the reserve sacrifices the horizon's most expensive slot
      // (e.g. tonight's evening peak) to insure a cheaper one.
      let releasedPeak = 0;
      for (let t = lastStrongPv + 1; t < N; t++) {
        if (prices[t].price > releasedPeak) releasedPeak = prices[t].price;
      }
      let strongPvAhead = false;
      for (let t = N - 1; t >= 0; t--) {
        if (pvCoverage[t] >= pvStrongCoverage) { strongPvAhead = true; continue; }
        if (strongPvAhead && prices[t].price <= releasedPeak) {
          reserveFloorG[t] = Math.min(maxSocG, minSocG + reserveAddG);
        }
      }
    }

    // Pre-compute cumulative PV kWh that can enter the battery from each slot onwards.
    // pvCoverage[t] is clamped to [0,1], so pvCoverage[t] * chargeKwhFull = kWh absorbed.
    // When pvKwhFromT[t+1] >= capacityKwh, any starting SoC at t+1 will be fully replenished
    // by PV before horizon end — the SoC arriving at t+1 becomes irrelevant for future value.
    const pvKwhFromT = new Float64Array(N + 1); // pvKwhFromT[N] = 0 by default
    for (let t = N - 1; t >= 0; t--) {
      pvKwhFromT[t] = pvKwhFromT[t + 1] + pvCoverage[t] * (t === 0 ? slot0ChargeKwhFull : chargeKwhFull);
    }

    // Flatten-arb guard inputs. The per-SoC flatten (backward loop) collapses dp to
    // dpMax, killing the charge gradient. That gradient carries real value when a
    // profitable charge-low → discharge-high round trip SPANS slot t — and because the
    // backward pass flattens the peak slot before it reaches the earlier cheap charge
    // slots, the guard must look at the peak inclusive of t (maxPriceFromIncl) against
    // the cheapest slot up to t (minPriceUpTo), not just prices strictly ahead.
    //   maxPriceFromIncl[t] = max positive price over [t..N-1]
    //   minPriceUpTo[t]     = min price over [0..t] (incl. negative — cheapest charge)
    const maxPriceFromIncl = new Float64Array(N); // [N-1] = price[N-1] (or 0)
    for (let k = N - 1; k >= 0; k--) {
      const p = prices[k]?.price > 0 ? prices[k].price : 0;
      maxPriceFromIncl[k] = Math.max(p, k + 1 < N ? maxPriceFromIncl[k + 1] : 0);
    }
    const minPriceUpTo = new Float64Array(N);
    let runMin = Infinity;
    for (let k = 0; k < N; k++) {
      const p = prices[k]?.price ?? 0;
      if (p < runMin) runMin = p;
      minPriceUpTo[k] = runMin;
    }

    // ── Terminal value: residual worth of stored energy at horizon end ────────
    // top-quartile price × 0.8 × RTE × kWh, discounted by PV refill forecast.
    // pvRefill ≥ 80% → terminal = 0 (PV fills battery for free, no hoarding).
    let dp = new Float64Array(GRID_TOTAL + 1).fill(0);
    let terminalFactor = 0; // exposed for diagnose; 0 = PV refills overnight, no residual hoard value
    if (N >= 4) {
      // Normaliser = realistically refillable energy, not full capacity. Discharge is
      // firmware-capped at maxDischargePowerW (800 W) regardless of pack size, so a large
      // pack only empties ~dischargeCap×overnight-hours before next-day PV. Dividing by full
      // capacity over-penalises multi-battery packs (noemer too big → pvRefill too low →
      // terminalFactor too high → over-hoards on a good-PV day). min() picks whichever
      // clamps: usable SoC span (small packs) or the overnight discharge cap (large packs).
      const REFILL_WINDOW_H = 10; // overnight discharge hours (sunset→sunrise)
      const usableSpanKwh = ((maxSocG - minSocG) / GRID_TOTAL) * capacityKwh;
      const refillableKwh = Math.min(usableSpanKwh, (maxDischargePowerW / 1000) * REFILL_WINDOW_H);
      const pvRefill = refillableKwh > 0 ? Math.min(1, terminalPvKwhTomorrow / refillableKwh) : 0;
      // Scale down linearly: pvRefill 0→0% discount, pvRefill ≥0.8→100% discount (factor 0).
      terminalFactor = Math.max(0, 1 - pvRefill / 0.8);
      // Full PV day (≥80% refill) → terminal = 0, no residual value
      if (pvRefill < 0.8) {
        // Forward-only reference: terminal energy is discharged AFTER the horizon, so its
        // residual worth must reference prices still reachable from horizon-end — not the
        // whole horizon. Early-horizon peaks (e.g. today's evening spike) sit in the past
        // relative to the terminal slot and are unreachable; including them over-credits
        // held energy and makes the DP hoard through the final day's peak instead of
        // discharging it. Use only the last 24h of the horizon as the forward proxy for
        // post-horizon prices (the next day is the best available estimate of the day after).
        const tailCount = Math.min(N, Math.max(1, Math.round(24 / slotH)));
        const sortedPrices = prices.slice(N - tailCount).map(p => p.price).filter(p => p > 0).sort((a, b) => b - a);
        const topQuartile = sortedPrices.slice(0, Math.max(1, Math.floor(sortedPrices.length / 4)));
        const terminalPricePerKwh = topQuartile.length > 0
          ? (topQuartile.reduce((a, b) => a + b, 0) / topQuartile.length) * 0.8 * effectiveRte
          : 0;
        if (terminalPricePerKwh > 0) {
          for (let socG = 0; socG <= GRID_TOTAL; socG++) {
            const kwhStored = (socG / GRID / 100) * capacityKwh;
            dp[socG] = terminalPricePerKwh * kwhStored * terminalFactor;
          }
        }
      }
      // else: pvRefill >= 0.8 → dp stays all zeros (battery worthless at end of horizon)
    }

    // Pre-compute which slots would trigger policy-engine lowSocGridTopUp (price ≤ maxChargePrice,
    // no PV, price ≤ min-next-8h+0.001). When such a slot fires with socG < 40%, preserve/standby
    // are not free — they cost a forced grid charge. BI uses this to price that cost correctly.
    const topupFiringSlots = maxChargePrice > 0 ? new Uint8Array(N) : null;
    if (topupFiringSlots) {
      const lookAhead = Math.ceil(8 / slotH);
      for (let t = 0; t < N; t++) {
        const p = prices[t].price;
        if (p !== null && p <= maxChargePrice && pvCoverage[t] < pvStrongCoverage) {
          let minFuture = p;
          for (let j = t + 1; j < Math.min(t + 1 + lookAhead, N); j++) {
            const fp = prices[j].price;
            if (typeof fp === 'number' && fp > 0) minFuture = Math.min(minFuture, fp);
          }
          if (p <= minFuture + 0.001) topupFiringSlots[t] = 1;
        }
      }
    }

    // policy[t][socG] = best action code: 0 = preserve, 1 = charge, 2 = discharge
    const policy = Array.from({ length: N }, () => new Uint8Array(GRID_TOTAL + 1));

    // Pre-allocate second buffer for ping-pong — avoids 96× Float64Array allocation per DP run.
    let dp2 = new Float64Array(GRID_TOTAL + 1);

    // DP_DUMP debug-dump target — read env ONCE here, never inside the socG hot loop
    // (process.env access ×1001×N per compute breaches the property-suite time limit).
    const _dumpT    = process.env.DP_DUMP_T    !== undefined ? +process.env.DP_DUMP_T    : null;
    const _dumpSocG = process.env.DP_DUMP_SOCG !== undefined ? +process.env.DP_DUMP_SOCG : null;

    // Flatten shadow counters over ALL slots. The per-slot debug below only ever described
    // t=0, which on a midday run is a PV slot — pvCoverage[t] < pvStrongCoverage fails there
    // by definition, so flattenGateOpen/gateWouldSuppress read false while the flatten fires
    // on the later non-PV pre-evening slots. These aggregates are the actual live instrument.
    let flatOpenSlots = 0, flatSuppressedSlots = 0, flatFiredSlots = 0, firstSuppressT = -1;
    // Only the pass that got a real currentSoc owns _flattenDebug. _runBackwardDP also runs a
    // second, SoC-less pass (the expansion-scenario profit probe) — resetting there would wipe
    // the live pass's snapshot before policy-engine reads it.
    if (initialSocG != null) this._flattenDebug = null;

    // ── Backward induction ────────────────────────────────────────────────────
    for (let t = N - 1; t >= 0; t--) {
      // Per-SoC flattening: neutralise backward pressure from future high prices when PV
      // can recharge the battery from the current SoC level back to full.
      //
      // Old approach: flatten only when pvKwhFromT >= full capacityKwh AND no better night
      // slot ahead. This caused overnight standby even with 65% SoC and ample PV, because:
      //   (a) rising pre-dawn prices kept _betterSlotAhead=true all night, and
      //   (b) pvKwhFromT (net surplus) is often < capacityKwh even on sunny days.
      //
      // New approach: for each SoC level independently, if remaining PV can cover the gap
      // from that level to maxSoc, discharge from there has zero opportunity cost — the
      // battery will be fully recharged before the next discharge window regardless.
      // This allows the DP to discharge at all profitable overnight slots (price >= floor)
      // and let PV handle the recharge, instead of holding a single "best" slot.
      //
      // Guards kept from the old logic:
      //   - positive price only (negative prices need SoC gradient for deeper-slot selection)
      //   - pvKwhTomorrow >= 80% cap (confidence in PV day)
      //   - non-PV slot (pvCoverage < pvStrongCoverage): during strong PV the natural
      //     vPreserve SoC-gain already equalises dp; flattening there hides evening value
      //   - next slot not PV-strong: the PV-boundary gradient encodes export revenue
      //     (higher SoC → more PV exported at morning price vs stored)
      // Round-trip arb guard (flattenArbGate): a profitable charge-low → discharge-high
      // round trip spans slot t when the best reachable discharge price (peak at or after
      // t) beats the cheapest charge price up to t by more than the full cycle wear
      // (0.5 charge + 0.5 discharge = cycleCostPerKwh). Then the SoC gradient at t carries
      // real value and the flatten must NOT collapse it. Loop-invariant scalar per t —
      // computed outside the socG loop below.
      const arbAhead = maxPriceFromIncl[t] * effectiveRte - minPriceUpTo[t] > cycleCostPerKwh;
      const flattenGateOpen = prices[t].price >= 0 && pvKwhTomorrow >= capacityKwh * 0.6
        && pvCoverage[t] < pvStrongCoverage
        && (t + 1 >= N || pvCoverage[t + 1] < pvStrongCoverage)
        && pvKwhFromT[t + 1] > 0;
      if (flattenGateOpen) {
        flatOpenSlots++;
        if (arbAhead) { flatSuppressedSlots++; firstSuppressT = t; }
      }
      if (flattenGateOpen && !(this.flattenArbGate && arbAhead)) {
        flatFiredSlots++;
        let dpMax = dp[0];
        for (let i = 1; i <= GRID_TOTAL; i++) { if (dp[i] > dpMax) dpMax = dp[i]; }
        for (let sg = 0; sg <= GRID_TOTAL; sg++) {
          const kwhNeeded = (maxSocG - sg) / GRID_TOTAL * capacityKwh;
          if (pvKwhFromT[t + 1] >= kwhNeeded) dp[sg] = dpMax;
        }
      }

      // Debug-only: was the flatten gate open for slot 0 (the live decision), and did it
      // actually reach the caller's real SoC? Answers "PV should refill it, why no discharge"
      // without a repro script — see policy-engine.js's currentSlotDebug log line.
      if (t === 0 && initialSocG != null) {
        const kwhNeededNow = (maxSocG - initialSocG) / GRID_TOTAL * capacityKwh;
        this._flattenDebug = {
          flattenGateOpen,
          flattenedRealSoc: flattenGateOpen && pvKwhFromT[t + 1] >= kwhNeededNow,
          pvKwhFromT1: +pvKwhFromT[t + 1].toFixed(2),
          kwhNeededNow: +kwhNeededNow.toFixed(2),
          reserveFloorPct0: +(reserveFloorG[0] / GRID).toFixed(1),
          // Flatten-arb-gate shadow: arbAhead = tonight spread beats round-trip cost.
          // gateWouldSuppress = the gate changes behaviour at the live slot (flatten
          // would fire but the arb guard skips it). Logged even when the gate is off,
          // to confirm live cadence on appliance-heavy PV days before switch-on.
          arbAhead,
          maxPriceFromIncl0: +maxPriceFromIncl[t].toFixed(3),
          minPriceUpTo0: +minPriceUpTo[t].toFixed(3),
          gateWouldSuppress: flattenGateOpen && arbAhead,
          flattenArbGate: !!this.flattenArbGate,
        };
      }

      const price = prices[t].price;
      // Loop-invariant per t (doesn't depend on socG) — hoisted out of the socG loop below,
      // which iterates up to GRID_TOTAL+1 (1001) times per slot.
      const exportVal = this._exportValue(prices[t]);
      // Negative price: earn money by importing — use full price regardless of PV coverage.
      // Positive price: true cost = grid portion (price × (1−pvCoverage)) + foregone PV export
      //   (_exportValue × pvCoverage).
      // Under saldering _exportValue === price, so this simplifies to `price`, making vCharge
      // symmetric with vPreserve: charging from PV costs the same as charging from grid,
      // because the PV energy was worth exactly `price` if exported instead.
      // Under asymmetric_2027 charging from PV gets a partial discount equal to the spread
      // between retail price and the (lower) per-slot export price.
      const isNegativePrice = price < 0;
      // Charging from PV forgoes exporting it (worth _exportValue this slot); the grid
      // fraction costs the retail price. Under saldering _exportValue === price, so this
      // reduces to `price`; post-2027 it discounts the PV fraction by the export shortfall.
      const effectiveChargeCost = isNegativePrice
        ? price
        : price * (1 - pvCoverage[t]) + exportVal * pvCoverage[t];
      dp2.fill(-1e9);

      // Slot 0 uses scaled charge parameters when recomputing mid-slot.
      const effDeltaG  = t === 0 ? slot0ChargeSocDeltaG : chargeSocDeltaG;
      const effKwhFull = t === 0 ? slot0ChargeKwhFull   : chargeKwhFull;

      for (let socG = 0; socG <= GRID_TOTAL; socG++) {

        // Preserve: firmware runs zero_charge_only only when PV is strong (≥400 W),
        // so only apply free SoC gain above that threshold. Weak PV results in
        // standby — no free charging.
        // At negative prices, suppress the free PV SoC gain: the DP needs an "idle"
        // option so it can save capacity for deeper negative-price charging slots.
        // (Users typically disable their inverter at negative prices; even when on,
        // the economic optimum is to reserve room for the most negative hours.)
        const pvSocGainG  = (!isNegativePrice && pvCoverage[t] >= pvStrongCoverage)
          ? Math.round(pvCoverage[t] * effDeltaG)
          : 0;
        const preserveSocG = Math.min(maxSocG, socG + pvSocGainG);
        // When battery hits maxSoc before absorbing all available PV, the surplus exports
        // to grid. Add that export revenue so preserve correctly beats standby: both fill
        // the battery AND export the remainder at the same price.
        let vPreserve = dp[preserveSocG];
        if (pvSocGainG > 0) {
          const storedKwh = Math.min(pvSocGainG, maxSocG - socG) / effDeltaG * effKwhFull;
          // Same cell, same cycle as a grid charge — wear cost applies regardless of how
          // the kWh got in (matches vCharge's cycleCostPerKwh*0.5 below).
          vPreserve -= cycleCostPerKwh * 0.5 * storedKwh;
          if (price > 0) {
            vPreserve -= storedKwh * exportVal;
            if (preserveSocG < socG + pvSocGainG) {
              const surplusKwh = (socG + pvSocGainG - preserveSocG) / effDeltaG * effKwhFull;
              vPreserve += surplusKwh * exportVal;
            }
          }
        }

        // Charge: SoC rises; cost is reduced when PV covers part of the charge power.
        // Half the cycle cost applies here (wear from charging), regardless of price sign.
        let vCharge = -1e9;
        if (socG < maxSocG) {
          const newSocG   = Math.min(maxSocG, socG + effDeltaG);
          const socDeltaG = newSocG - socG; // may be less than effDeltaG near the top
          const kwh       = effKwhFull * socDeltaG / effDeltaG;
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
        const floorG = reserveFloorG[t];
        if (socG > floorG && price >= effectiveMinDischarge) {
          const slotDischargeSocDeltaG = perSlotDischargeSocDeltaG[t];
          const slotDischargeKwhFull   = perSlotDischargeKwhFull[t];
          if (slotDischargeSocDeltaG > 0) {
            const newSocG    = Math.max(floorG, socG - slotDischargeSocDeltaG);
            const socDeltaG  = socG - newSocG;
            const kwh        = slotDischargeKwhFull * socDeltaG / slotDischargeSocDeltaG;
            // null = no data (assume full local offset); 0 = learned zero consumption (all export)
            // Use net consumption (after PV): battery only offsets load not served by PV.
            const pvWSlot = pvWPerSlot?.[t] ?? 0;
            const consumptionKwh = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
              ? (Math.max(0, consumptionWPerSlot[t] - pvWSlot) / 1000) * slotH
              : null;
            // With NL saldering (net metering, active until 2027), export earns the full
            // retail price — so the consumption split does not reduce discharge value.
            // RTE applied on discharge: physical kWh from battery × RTE = net kWh delivered.
            let dischargeValue;
            if (consumptionKwh != null && this.tariffModel === 'asymmetric_2027') {
              const coveredKwh = Math.min(kwh, consumptionKwh);
              const exportKwh  = kwh - coveredKwh;
              dischargeValue = (price * coveredKwh + exportVal * exportKwh) * effectiveRte;
            } else {
              dischargeValue = price * kwh * effectiveRte;
            }
            // Half-cycle cost on discharge. Waived at night when PV tomorrow ≥ 150%
            // capacity — free PV refill means holding energy just clips tomorrow's PV.
            const pvAbundant = pvKwhTomorrow >= capacityKwh * 1.5 && pvCoverage[t] < 0.1;
            const slotCycleCost = pvAbundant ? 0 : cycleCostPerKwh * 0.5;
            vDischarge = dischargeValue - slotCycleCost * kwh + dp[newSocG];
          }
        }

        // Standby: PV exports to grid at current price; battery SoC unchanged.
        // Competes with preserve/charge when current export price + future flexibility
        // exceeds the marginal value of storing PV now.
        // Only at positive prices — at negative prices, exporting PV costs money.
        // Uses raw pvCoverage (not pvSocGainG) so weak morning PV (< pvStrongCoverage)
        // still contributes an export value and the standby option remains available.
        let vStandby = -1e9;
        if (price > 0 && pvCoverage[t] > 0) {
          const pvGainKwh = pvCoverage[t] * effKwhFull;
          vStandby = pvGainKwh * exportVal + dp[socG];
        }

        // When this slot fires lowSocGridTopUp (cheap price, no PV, price ≤ min-next-8h+0.001)
        // and SoC is below 40%, preserve/standby are not free — the heuristic forces a grid
        // charge. Override both so prior slots correctly see the cost of draining into this state.
        if (topupFiringSlots?.[t] && socG < TOPUP_THRESH_G) {
          const forcedNewSocG  = Math.min(maxSocG, socG + effDeltaG);
          const forcedSocDelta = forcedNewSocG - socG;
          const forcedKwh      = effKwhFull * forcedSocDelta / effDeltaG;
          const vForcedCharge  = -(effectiveChargeCost + cycleCostPerKwh * 0.5) * forcedKwh + dp[forcedNewSocG];
          vPreserve = vForcedCharge;
          vStandby  = vForcedCharge;
        }

        // Pick best action
        let best = vPreserve, bestAction = 0;
        if (vCharge    > best) { best = vCharge;    bestAction = 1; }
        if (vDischarge > best) { best = vDischarge; bestAction = 2; }
        if (vStandby   > best) { best = vStandby;   bestAction = 3; }

        dp2[socG]        = best > -1e9 ? best : 0;
        policy[t][socG]  = bestAction;

        if (_dumpT !== null && t === _dumpT && socG === _dumpSocG) {
          const lowG = Math.max(0, socG - perSlotDischargeSocDeltaG[t]);
          console.error(`[DUMP] t=${t} socG=${socG} price=${price} pvAbundant?next dp[socG]=${dp[socG].toFixed(4)} dp[lowG=${lowG}]=${dp[lowG].toFixed(4)} grad=${(dp[socG]-dp[lowG]).toFixed(4)} | vPreserve=${vPreserve.toFixed(4)} vCharge=${vCharge>-1e9?vCharge.toFixed(4):'-'} vDischarge=${vDischarge>-1e9?vDischarge.toFixed(4):'-'} vStandby=${vStandby>-1e9?vStandby.toFixed(4):'-'} chosen=${['pres','chg','dis','stby'][bestAction]}`);
        }

        if (t === 0 && socG === initialSocG && this._flattenDebug) {
          this._flattenDebug.vPreserve  = +vPreserve.toFixed(4);
          this._flattenDebug.vCharge    = vCharge  > -1e9 ? +vCharge.toFixed(4)  : null;
          this._flattenDebug.vDischarge = vDischarge > -1e9 ? +vDischarge.toFixed(4) : null;
          this._flattenDebug.chosenAction = ['preserve', 'charge', 'discharge', 'standby'][bestAction];
        }
      }

      // Ping-pong: swap dp and dp2 (no allocation)
      const tmp = dp; dp = dp2; dp2 = tmp;
    }

    // Horizon-wide flatten shadow. firstSuppress* names the earliest slot where the arb guard
    // changes behaviour, so the log points at a real slot instead of only reporting t=0.
    if (initialSocG != null) {
      if (!this._flattenDebug) this._flattenDebug = {};
      this._flattenDebug.flatOpenSlots = flatOpenSlots;
      this._flattenDebug.flatFiredSlots = flatFiredSlots;
      this._flattenDebug.flatSuppressedSlots = flatSuppressedSlots;
      this._flattenDebug.firstSuppressT = firstSuppressT;
      this._flattenDebug.firstSuppressAt = firstSuppressT >= 0 ? prices[firstSuppressT].timestamp : null;
      this._flattenDebug.firstSuppressPrice = firstSuppressT >= 0 ? +prices[firstSuppressT].price.toFixed(3) : null;
    }

    // Evening (post-PV) energy need: sum of net consumption at eligible (dischargeable)
    // prices in the tail after the last strong-PV slot. Same window as the reserve floor
    // above — feeds the forward-pass safety net that stops cheaperPvAhead from deferring
    // charging past the point where this need can no longer be covered.
    let eveningNeedKwh = 0;
    for (let t = lastStrongPv + 1; t < N; t++) {
      // minDischargePrice may be a per-slot array (respect_minmax / shiftwork margins) — index it.
      // A bare `price >= array` coerces the array to a string → NaN → always false → eveningNeedKwh
      // stuck at 0, silently disabling the eveningCoverageAtRisk safety net (battery exported cheap
      // PV instead of storing for the evening). Matches the indexing at lines 414/499/941.
      const effMinDischarge = Array.isArray(minDischargePrice) ? (minDischargePrice[t] ?? 0) : minDischargePrice;
      if (prices[t].price >= effMinDischarge) {
        const margin = Array.isArray(consumptionMargin) ? (consumptionMargin[t] ?? 1.20) : consumptionMargin;
        const consumptionW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
          ? consumptionWPerSlot[t] * margin
          : 200; // conservative default, matches the effectiveDischargePowerW fallback above
        const pvW = pvWPerSlot?.[t] ?? 0;
        eveningNeedKwh += (Math.max(0, consumptionW - pvW) / 1000) * slotH;
      }
    }

    return { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, chargeKwhFull, pvStrongCoverage, slot0ChargeSocDeltaG, slot0ChargeKwhFull, reserveFloorG, terminalFactor, pvKwhFromT, eveningNeedKwh, lastStrongPv, topupFiringSlots };
  }

  /**
   * Pre-convert pvForecast timestamps to milliseconds for O(log N) slot lookup.
   * Call once per compute() / computeExpectedProfit() invocation.
   * @private
   */
  _buildPvIndex(pvForecast) {
    if (!Array.isArray(pvForecast) || pvForecast.length === 0) return null;
    const idx = pvForecast
      .map(s => ({ ms: new Date(s.timestamp).getTime(), pvPowerW: s.pvPowerW, spreadFrac: s.spreadFrac ?? 0 }))
      .sort((a, b) => a.ms - b.ms);
    return idx;
  }

  /**
   * Nearest-left ensemble spread fraction (std/mean) for a price-slot timestamp.
   * Step function (no interpolation — spread is a per-slot uncertainty, not a level).
   * Returns 0 when unavailable.
   * @private
   */
  _getPvSpreadForSlot(pvIndex, slotMs) {
    if (!pvIndex || pvIndex.length === 0) return 0;
    let lo = 0, hi = pvIndex.length - 1, leftIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (pvIndex[mid].ms <= slotMs) { leftIdx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return pvIndex[leftIdx === -1 ? 0 : leftIdx].spreadFrac ?? 0;
  }

  /**
   * Interpolate PV power (W) for a given price-slot timestamp using a pre-built index.
   * Returns 0 when no PV data is available.
   * @private
   */
  _getPvForSlot(pvIndex, slotMs) {
    if (!pvIndex || pvIndex.length === 0) return 0;
    // Binary search for the last entry with ms <= slotMs
    let lo = 0, hi = pvIndex.length - 1, leftIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (pvIndex[mid].ms <= slotMs) { leftIdx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (leftIdx === -1) return pvIndex[0].pvPowerW;
    if (leftIdx === pvIndex.length - 1) return pvIndex[leftIdx].pvPowerW;
    const left  = pvIndex[leftIdx];
    const right = pvIndex[leftIdx + 1];
    if (left.ms === right.ms) return left.pvPowerW;
    const frac = (slotMs - left.ms) / (right.ms - left.ms);
    return Math.round(left.pvPowerW + (right.pvPowerW - left.pvPowerW) * frac);
  }

  /**
   * Return the optimal action for the current time slot, or null if unknown.
   * Matches the slot whose timestamp is closest to `now`, within ±35 minutes.
   *
   * @param {Date} now
   * @returns {'charge'|'discharge'|'preserve'|'standby'|null}
   */
  getSlot(now) {
    if (!this._schedule) return null;

    const nowMs = now.getTime();
    const slots = this._schedule.slots;
    const slotMs = slots.length >= 2
      ? Math.abs(new Date(slots[1].timestamp) - new Date(slots[0].timestamp))
      : 60 * 60 * 1000;
    const maxDist = Math.max(slotMs, 35 * 60 * 1000);

    // Prefer the active slot: the most recent past slot within maxDist.
    // This ensures that at e.g. 09:30 we use the 09:00 slot's action (standby),
    // not the 10:00 slot's action (charge) — even though 10:00 is 1 second closer.
    let best = null;
    for (const slot of slots) {
      const ts = new Date(slot.timestamp).getTime();
      if (ts <= nowMs && (!best || ts > new Date(best.timestamp).getTime())) best = slot;
    }
    if (best && nowMs - new Date(best.timestamp).getTime() <= maxDist) return best.action;

    // Fallback: nearest slot (used when schedule starts in the future, e.g. 21:24 → 22:00)
    let bestDist = Infinity;
    best = null;
    for (const slot of slots) {
      const dist = Math.abs(new Date(slot.timestamp).getTime() - nowMs);
      if (dist < bestDist) { bestDist = dist; best = slot; }
    }
    // Skip maxDist when nearest slot IS the first slot: schedule hasn't started yet,
    // not a mid-schedule gap. Return first planned action so policy gets a real signal.
    const isFirstSlot = slots.length > 0 && best &&
      new Date(best.timestamp).getTime() === new Date(slots[0].timestamp).getTime();
    return (best && (bestDist <= maxDist || isFirstSlot)) ? best.action : null;
  }

  /** Returns metadata for the current slot (pvExportWins, etc.), or null. */
  getSlotMeta(now) {
    if (!this._schedule) return null;
    const nowMs = now.getTime();
    const slots = this._schedule.slots;
    const slotMs = slots.length >= 2
      ? Math.abs(new Date(slots[1].timestamp) - new Date(slots[0].timestamp))
      : 60 * 60 * 1000;
    const maxDist = Math.max(slotMs, 35 * 60 * 1000);
    let best = null;
    for (const slot of slots) {
      const ts = new Date(slot.timestamp).getTime();
      if (ts <= nowMs && (!best || ts > new Date(best.timestamp).getTime())) best = slot;
    }
    if (best && nowMs - new Date(best.timestamp).getTime() <= maxDist) return best;
    let bestDist = Infinity;
    best = null;
    for (const slot of slots) {
      const dist = Math.abs(new Date(slot.timestamp).getTime() - nowMs);
      if (dist < bestDist) { bestDist = dist; best = slot; }
    }
    const isFirstSlot = slots.length > 0 && best &&
      new Date(best.timestamp).getTime() === new Date(slots[0].timestamp).getTime();
    return (best && (bestDist <= maxDist || isFirstSlot)) ? best : null;
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
    if (newSettings.tariff_model        != null) this.tariffModel      = newSettings.tariff_model;
    if (newSettings.dp_flatten_arb_gate != null) this.flattenArbGate   = newSettings.dp_flatten_arb_gate;
    this._schedule = null; // invalidate — will recompute on next policy run
  }
}

module.exports = OptimizationEngine;
