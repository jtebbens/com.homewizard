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
  compute(prices, currentSoc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, rte = null, consumptionWPerSlot = null, minDischargePrice = 0, consumptionMargin = 1.0, pvKwhTomorrow = 0, terminalPvKwhTomorrow = pvKwhTomorrow, pvCloudFactor = 1.0, refillConfidence = 1.0) {
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

    // Remaining fraction of the current slot: when recomputing mid-slot the DP must
    // model only the remaining time, otherwise it overestimates the benefit of preserve
    // (treats a partial slot as a full 0.8 kWh charging opportunity, biasing it to defer
    // charging to the next slot even when that slot is only marginally better).
    const firstSlotMs    = new Date(prices[0].timestamp).getTime();
    const slotDurationMs = slotH * 3_600_000;
    const slot0RemainingFrac = Math.max(0.01, Math.min(1.0,
      (firstSlotMs + slotDurationMs - Date.now()) / slotDurationMs));

    const { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, chargeKwhFull, pvStrongCoverage,
            slot0ChargeSocDeltaG, slot0ChargeKwhFull, reserveFloorG, terminalFactor } =
      this._runBackwardDP(N, prices, pvCoverage, consumptionWPerSlot, slotH,
        capacityKwh, maxChargePowerW, maxDischargePowerW,
        effectiveRte, cycleCostPerKwh, this.exportPriceRatio ?? 1.0,
        minDischargePrice, maxSocG, minSocG, consumptionMargin, pvKwhTomorrow,
        slot0RemainingFrac, pvWPerSlot, terminalPvKwhTomorrow, refillConfidence);

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
    // _pvStoreWins is suppressed at runtime when strongly negative prices are coming.
    const hasFutureStrongNeg = prices.some(p => (p.price ?? 0) < -0.10);

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
      const pvStoreBeatsExport = storeValue > price;

      // Standby + strong PV surplus: storing beats exporting → runtime charges from PV.
      // Override action to 'preserve' so buildPlanningSchedule shows zero_charge_only.
      let pvStoreWins = false;
      if (code === 3 && !hasFutureStrongNeg && pvCoverage[t] >= pvStrongCoverage && price > 0 && pvStoreBeatsExport) {
        action = 'preserve';
        pvStoreWins = true;
      }
      // Weak PV trickle: standby + net surplus below pvStrong threshold.
      // Use trickleSuffixMaxPrice (not suffixMaxPrice) so prices beyond the first pvStrong
      // saturation slot are excluded — those slots are served by free PV, not today's trickle.
      const pvStoreValue2 = trickleSuffixMaxPrice[t] * effectiveRte;
      const _ratio = this.exportPriceRatio ?? 1.0;
      // trickleSuffixMaxPrice resets to 0 at a downstream pvStrong slot, assuming that refill
      // saturates the battery so a later peak is unreachable. For a WEAK slot (cov < pvStrong)
      // the surplus is small and independent of that refill; when the battery still has room
      // (socG < maxSocG) and the uncapped store beats the price, the peak IS reachable — store
      // the PV-only surplus rather than export it (live 2026-06-01 14:00 bug).
      const weakReachable = pvCoverage[t] > 0 && pvCoverage[t] < pvStrongCoverage
        && socG < maxSocG && storeValue > price * _ratio;
      const trickleWins = pvStoreValue2 > price * _ratio || weakReachable;
      const pvTrickle = !pvStoreWins && trickleWins && code === 3 && pvCoverage[t] > 0;
      if (pvTrickle) action = 'trickle';

      const pvExportWins = !pvStoreWins && !pvTrickle && code === 3 && pvCoverage[t] > 0;
      slots.push({ timestamp: prices[t].timestamp, action, price, socProjected: socG / GRID, pvExportWins,
        consumptionW: Array.isArray(consumptionWPerSlot) ? (consumptionWPerSlot[t] ?? null) : null,
        pvForecastW: pvWPerSlot[t] ?? null,
        pvStoreValue: storeValue,
        pvTrickleMaxValue: trickleSuffixMaxPrice[t] * effectiveRte,
        pvCoverage: pvCoverage[t] });

      const isToday = new Date(prices[t].timestamp)
        .toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10) === todayStr;

      const slotDeltaG  = t === 0 ? slot0ChargeSocDeltaG : chargeSocDeltaG;
      const slotKwhFull = t === 0 ? slot0ChargeKwhFull   : chargeKwhFull;
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

    // ── Post-DP: reorder night-window discharge by price ─────────────────────
    // The backward-DP flatten can mis-order discharge when night prices are
    // non-monotone (e.g. 23:00=€0.272 < midnight=€0.278).  After the forward
    // pass, find the first contiguous non-PV block (evening → overnight, until
    // pvCoverage ≥ pvStrongCoverage) and sort eligible discharge slots by price,
    // assigning discharge to the most expensive slots within the battery budget.
    // Total energy used in the window stays within the same budget.
    {
      let wEnd = 0;
      for (let t = 0; t < N; t++) {
        if (pvCoverage[t] >= pvStrongCoverage) break;
        // A charge slot (e.g. next-midday grid refill) ends the overnight-discharge
        // regime. Without this, the window spans night discharge AND the later charge,
        // tripping the !hasCharge guard below and disabling the reorder entirely — which
        // left night discharge stranded on the cheapest slot instead of the priciest.
        if (slots[t].action === 'charge') break;
        wEnd = t + 1;
      }
      // When PV is already producing at t=0 (daytime run), this first non-PV block is the
      // MORNING pre-PV window, not the evening/overnight one this reorder targets. Reordering
      // discharge into it double-cycles before the imminent PV refill AND leaves the post-window
      // socProjected stale (the slot[wEnd] boundary isn't recomputed below), which surfaced as a
      // 'discharge' slot whose projected SoC rises. The intended evening/overnight block starts
      // with no PV (pvCoverage[0] == 0), so gate on that.
      if ((pvCoverage[0] ?? 0) > 0) wEnd = 0;
      if (wEnd >= 2) {
        const eligible = [];
        for (let t = 0; t < wEnd; t++) {
          const effMin = Array.isArray(minDischargePrice) ? (minDischargePrice[t] ?? 0) : minDischargePrice;
          if (slots[t].price >= effMin) eligible.push(t);
        }
        // Only reorder in pure discharge windows — skip if ANY window slot charges
        // (charging between slots increases SoC, invalidating the simple budget model
        // and risking SoC safety violations in the rewritten trajectory).
        const hasCharge = slots.slice(0, wEnd).some(s => s.action === 'charge');
        if (eligible.length >= 2 && !hasCharge) {
          eligible.sort((a, b) => slots[b].price - slots[a].price);
          // Spend exactly the energy the DP drained across this window — reassigned to the PRICIEST
          // eligible slots. Targeting the DP's end-of-window SoC (not the reserve floor) keeps the
          // rewrite budget-neutral by construction, so the neutrality guard below cannot discard a
          // valid price reorder. Draining greedily to the floor instead made the reorder spend MORE
          // than the DP, tripping that guard → the whole correction reverted, stranding a pricier slot
          // while a cheaper one discharged (live miss 2026-06-08: 17:00 €0.284 discharged, 21:00 €0.359 held).
          // End-of-window SoC target. The DP's stored boundary SoC (slots[wEnd]) can dip BELOW
          // the window's reserve floor at the strong-PV release point — a forward-pass
          // reconstruction discontinuity (the floor releases at the PV boundary, so the boundary
          // slot reads a sub-floor SoC). The window itself cannot drain below its floor, so the
          // true budget target is the floored value; reading the raw boundary would set an
          // infeasible (too-low) target the floored rewrite can never reach → spurious revert.
          const rawEndG = wEnd < N ? Math.round(slots[wEnd].socProjected * GRID) : minSocG;
          const dpEndTargetG = Math.max(rawEndG, wEnd > 0 ? reserveFloorG[wEnd - 1] : minSocG);
          // Effective per-slot floor: never drain below the end-of-window target. Without this
          // a single high-load (large net-cap) slot drains past the target in one step, so the
          // rewrite's end SoC undershoots and the budget-neutral guard reverts the whole reorder
          // — stranding discharge on the cheaper slots the DP picked. Clamping every slot to
          // dpEndTargetG lets the priciest slot absorb exactly the budget.
          const effFloorG = t => Math.max(reserveFloorG[t], dpEndTargetG);
          const assigned = new Set();
          let remainSocG = initialSocG;
          for (const t of eligible) {
            const stopG = effFloorG(t);
            if (remainSocG <= stopG) break;
            assigned.add(t);
            remainSocG = Math.max(stopG, remainSocG - perSlotDischargeSocDeltaG[t]);
          }
          // Only rewrite if ordering differs from DP result
          let changed = false;
          for (let t = 0; t < wEnd && !changed; t++) {
            if ((slots[t].action === 'discharge') !== assigned.has(t)) changed = true;
          }
          if (changed) {
            // Snapshot so we can revert if the rewrite is not budget-neutral.
            const snapshot = slots.slice(0, wEnd).map(s => ({ action: s.action, socProjected: s.socProjected }));
            let socGw = initialSocG;
            for (let t = 0; t < wEnd; t++) {
              if (assigned.has(t) && socGw > effFloorG(t)) {
                // Budget assigned discharge here AND time-ordered SoC is available
                slots[t].action = 'discharge';
              } else if (slots[t].action === 'discharge') {
                // Un-assign: budget placed discharge elsewhere, or SoC exhausted
                slots[t].action = 'preserve';
              }
              slots[t].socProjected = socGw / GRID;
              const slotDeltaG = t === 0 ? slot0ChargeSocDeltaG : chargeSocDeltaG;
              if (slots[t].action === 'discharge') {
                socGw = Math.max(effFloorG(t), socGw - perSlotDischargeSocDeltaG[t]);
              } else if (slots[t].action === 'charge') {
                socGw = Math.min(maxSocG, socGw + slotDeltaG);
              } else if (pvCoverage[t] > 0 && prices[t].price >= 0) {
                socGw = Math.min(maxSocG, socGw + Math.round(pvCoverage[t] * slotDeltaG));
              }
            }
            // Discharge SoC deltas are consumption-capped (nul-op-de-meter), so moving discharge
            // to a different-load slot can change total drained energy unless the reserveFloor
            // clamp binds both orderings. When it does not, the rewrite's end-of-window SoC
            // diverges from the DP trajectory that slot[wEnd] onward still assumes, producing an
            // inconsistent SoC trace. Only keep the reorder when it is budget-neutral.
            // Compare against the feasible (floored) end target, not the raw boundary SoC which
            // may sit below the window floor at the PV-release discontinuity (see dpEndTargetG).
            // When wEnd===N there is no downstream slot to stay consistent with, so the rewrite's
            // own end SoC is the reference (matches the pre-clamp behaviour, no revert).
            const dpEndSocG = wEnd < N ? dpEndTargetG : socGw;
            if (Math.abs(socGw - dpEndSocG) > 1) {
              for (let t = 0; t < wEnd; t++) {
                slots[t].action = snapshot[t].action;
                slots[t].socProjected = snapshot[t].socProjected;
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
                 minDischargePrice, maxSocG, minSocG, consumptionMargin = 1.0, pvKwhTomorrow = 0,
                 slot0RemainingFrac = 1.0, pvWPerSlot = null, terminalPvKwhTomorrow = pvKwhTomorrow, refillConfidence = 1.0) {
    const GRID_TOTAL = GRID * 100;

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
    const effectiveDischargePowerW = prices.map((_, t) => {
      const margin = Array.isArray(consumptionMargin) ? (consumptionMargin[t] ?? 1.20) : consumptionMargin;
      const consumptionW = Array.isArray(consumptionWPerSlot) && consumptionWPerSlot[t] != null
        ? consumptionWPerSlot[t] * margin
        : maxDischargePowerW;
      // Subtract PV from net load: battery only needs to cover consumption not served by PV.
      const pvW  = pvWPerSlot?.[t] ?? 0;
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
    if (reserveAddG > 0) {
      // The reserve is only spendable AFTER the last strong-PV slot (where the floor
      // collapses back to minSocG), so its value = the best discharge price in that
      // trailing window. Never floor a slot whose own price already exceeds that peak:
      // discharging now beats hoarding for a cheaper future peak regardless of how PV
      // resolves — otherwise the reserve sacrifices the horizon's most expensive slot
      // (e.g. tonight's evening peak) to insure a cheaper one.
      let lastStrongPv = -1;
      for (let t = N - 1; t >= 0; t--) {
        if (pvCoverage[t] >= pvStrongCoverage) { lastStrongPv = t; break; }
      }
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
        const sortedPrices = prices.map(p => p.price).filter(p => p > 0).sort((a, b) => b - a);
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

    // policy[t][socG] = best action code: 0 = preserve, 1 = charge, 2 = discharge
    const policy = Array.from({ length: N }, () => new Uint8Array(GRID_TOTAL + 1));

    // Pre-allocate second buffer for ping-pong — avoids 96× Float64Array allocation per DP run.
    let dp2 = new Float64Array(GRID_TOTAL + 1);

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
      if (prices[t].price >= 0 && pvKwhTomorrow >= capacityKwh * 0.6
          && pvCoverage[t] < pvStrongCoverage
          && (t + 1 >= N || pvCoverage[t + 1] < pvStrongCoverage)
          && pvKwhFromT[t + 1] > 0) {
        let dpMax = dp[0];
        for (let i = 1; i <= GRID_TOTAL; i++) { if (dp[i] > dpMax) dpMax = dp[i]; }
        for (let sg = 0; sg <= GRID_TOTAL; sg++) {
          const kwhNeeded = (maxSocG - sg) / GRID_TOTAL * capacityKwh;
          if (pvKwhFromT[t + 1] >= kwhNeeded) dp[sg] = dpMax;
        }
      }

      const price = prices[t].price;
      // Negative price: earn money by importing — use full price regardless of PV coverage.
      // Positive price: true cost = grid portion (price × (1−pvCoverage)) + foregone PV export
      //   (price × pvCoverage × exportPriceRatio) = price × (1 − pvCoverage × (1 − exportPriceRatio)).
      // At exportPriceRatio=1.0 (NL saldering) this simplifies to `price`, making vCharge
      // symmetric with vPreserve: charging from PV costs the same as charging from grid,
      // because the PV energy was worth exactly `price` if exported instead.
      // At exportPriceRatio<1.0 (post-2027) charging from PV gets a partial discount equal
      // to the spread between retail and export price.
      const isNegativePrice = price < 0;
      const effectiveChargeCost = isNegativePrice
        ? price
        : price * (1 - pvCoverage[t] * (1 - exportPriceRatio));
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
        if (pvSocGainG > 0 && price > 0) {
          const storedKwh = Math.min(pvSocGainG, maxSocG - socG) / effDeltaG * effKwhFull;
          vPreserve -= storedKwh * price * exportPriceRatio;
          if (preserveSocG < socG + pvSocGainG) {
            const surplusKwh = (socG + pvSocGainG - preserveSocG) / effDeltaG * effKwhFull;
            vPreserve += surplusKwh * price * exportPriceRatio;
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
            if (consumptionKwh != null && exportPriceRatio < 1.0) {
              const coveredKwh = Math.min(kwh, consumptionKwh);
              const exportKwh  = kwh - coveredKwh;
              dischargeValue = (price * coveredKwh + price * exportPriceRatio * exportKwh) * effectiveRte;
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
          vStandby = pvGainKwh * price * exportPriceRatio + dp[socG];
        }

        // Pick best action
        let best = vPreserve, bestAction = 0;
        if (vCharge    > best) { best = vCharge;    bestAction = 1; }
        if (vDischarge > best) { best = vDischarge; bestAction = 2; }
        if (vStandby   > best) { best = vStandby;   bestAction = 3; }

        dp2[socG]        = best > -1e9 ? best : 0;
        policy[t][socG]  = bestAction;
      }

      // Ping-pong: swap dp and dp2 (no allocation)
      const tmp = dp; dp = dp2; dp2 = tmp;
    }

    return { dp, policy, chargeSocDeltaG, perSlotDischargeSocDeltaG, chargeKwhFull, pvStrongCoverage, slot0ChargeSocDeltaG, slot0ChargeKwhFull, reserveFloorG, terminalFactor };
  }

  /**
   * Pre-convert pvForecast timestamps to milliseconds for O(log N) slot lookup.
   * Call once per compute() / computeExpectedProfit() invocation.
   * @private
   */
  _buildPvIndex(pvForecast) {
    if (!Array.isArray(pvForecast) || pvForecast.length === 0) return null;
    const idx = pvForecast
      .map(s => ({ ms: new Date(s.timestamp).getTime(), pvPowerW: s.pvPowerW }))
      .sort((a, b) => a.ms - b.ms);
    return idx;
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
    return (best && bestDist <= maxDist) ? best.action : null;
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
    return (best && bestDist <= maxDist) ? best : null;
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
