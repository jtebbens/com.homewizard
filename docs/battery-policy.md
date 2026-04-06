# Battery Policy Device

- Loads 6 engines at startup: LearningEngine, WeatherForecaster, PolicyEngine, TariffManager, EfficiencyEstimator, OptimizationEngine — all eagerly required
- ExplainabilityEngine and BatteryChartGenerator are **lazy-loaded** (first `_runPolicyCheck` call, ~15 min after startup)
- `batteryPower` sign convention: positive = charging, negative = discharging
- `_runPolicyCheck` runs every 15 min + at hour boundaries
- Weather fetched at startup (restored from settings cache if within `weather_update_interval`); refreshed every `weather_update_interval` hours (setting, default 3h, min 1h) during `_runPolicyCheck`
- Weather location stored as `weather_latitude` + `weather_longitude` (number fields). Old `weather_location` text field (city name or `lat,lon`) is migrated on first `onInit` via `_migrateWeatherLocation()`
- `WeatherForecaster._blendForecast(oldCache, newForecast)` blends new API data with previous cache (α=0.6) to smooth sudden Open-Meteo model-run changes. Past `dailyProfiles` slots are never blended (actual data).
- `_schedulePriceRefresh`: every 15 min between 14:00–16:00, every 30 min otherwise

## WeatherForecaster — Open-Meteo Data

- API uses hourly resolution (`temporal_resolution` is NOT set — do NOT add `minutely_15`)
- `_processForecast` builds `hourlyForecast` (36 future slots) and `dailyProfiles` (all 24h today + tomorrow, including past hours from `past_days=1`)
- `daily.sunrise/sunset` returned as `"YYYY-MM-DDTHH:MM"` (no timezone suffix when `timezone=UTC`) — must append `Z`: `new Date(\`${v}Z\`)`
- **`past_days=1` daily index offset:** with `past_days=1` the `daily` array is `[yesterday, today, tomorrow]`. `todaySunrise/Sunset` must use index `[1]` and `tomorrowSunrise/Sunset` index `[2]`. Using `[0]` gives yesterday's sunset → `afterSunset` triggers all day → pvEstimate ignored → PV state oscillates. Do NOT revert to `[0]`.
- **Sunrise boundary correction:** Open-Meteo averages radiation over the full 60-min slot, diluting the first slot where sunrise falls mid-hour. `_processForecast` corrects this by scaling `radiationWm2 × 60 / minutesOfSunInSlot` for both `hourlyForecast` and `dailyProfiles`. Applied to all sunrises in the daily array (today + tomorrow). Slots with `sunMinutes < 2` or `> 58` are left untouched (no meaningful boundary or near-full-hour).
- `dailyProfiles` hourly entries power the past-hours PV chart via learned yield factors in device.js `pvForecastByDay`; `hourlyForecast` powers the future-hours PV forecast and optimizer

## Policy Scores & PV OVERSCHOT

**Policy scores:** normal range ~20–300. PV OVERSCHOT (`_pvStoreWins`) adds charge +250 — intentionally high to dominate most preserve combinations, but capped to stay readable. Do NOT raise back to 1000.

**PV OVERSCHOT low-SoC margin:**

- When SoC < 50%, the export margin must exceed €0.02/kWh (`_lowSocMarginRequired`) for export to win over storing. Below that threshold, `_pvStoreWins = true` — the marginal export revenue is not worth keeping the battery half-empty when a higher-priced discharge slot is coming later.
- At SoC ≥ 50% the threshold is €0.00 (no bias — pure price comparison).

## OptimizationEngine (DP) Discharge Constraints

- `minDischargePrice` is a hard constraint in the DP backward induction — discharge is blocked when `price < minDischargePrice`. This keeps the DP schedule consistent with `_mapActionToHwModeForPlanning` (which shows `standby` for those slots). Without this guard the DP discharges internally but the chart shows standby with an unexplained SoC drop.
- **PV discharge block removed:** the old `pvCoverage[t] <= 0.5` guard has been removed. The `minDischargePrice` floor already prevents irrational low-price PV-hour discharge. Do NOT re-add the pvCoverage discharge block.
- In strict mode (`respect_minmax=true`): DP uses `min_discharge_price` as the floor.
- In dynamic mode (`respect_minmax=false` or `policy_mode='balanced-dynamic'`): DP uses `opportunistic_discharge_floor` (default €0.20).
- `buildPlanningSchedule` uses the same effective floor so the planning display matches the DP schedule.
- **`opportunistic_discharge_floor` tuning:** the default €0.20 allows marginal overnight slots (e.g. €0.22) that add ~€0.002/slot while consuming battery cycles before a better morning peak. Raise to €0.25–0.27 to suppress these.

## `_selectMode` Confidence Calculation

- Formula: `winner / total * 100`. With 3 options this systematically underestimates confidence when a non-executable option inflates the denominator.
- **Charge-blocked fallback:** when charge wins on score but `_mapPolicyToHwMode` returns `standby` (price > maxChargePrice, no PV), re-evaluate using only discharge vs preserve. Confidence = `max(discharge, preserve) / (discharge + preserve)`. Logs `[MAPPING][CHARGE-BLOCKED]`.
- **Unexecutable charge in denominator:** when discharge or preserve wins, if charge is not executable (`_isChargeExecutable()` returns false), exclude charge score from denominator. This prevents a large charge score from diluting confidence in a clear discharge decision (e.g. charge=67, discharge=85, preserve=20 → 49% without fix → 81% with fix).
- `_isChargeExecutable(ctx)`: returns true when `price <= maxChargePrice` OR PV is active (same logic as `_mapPolicyToHwMode` actualPvNow, without logging).

## `_applyPeakTimingGuard` — PV Free-Cycle Bypass

- PeakTiming suppresses discharge when `price < bestFuturePrice × RTE (0.72)`. This assumes recharge costs money (grid). When recharge is free (PV), the RTE penalty is irrelevant.
- **Bypass condition:** `pvKwhRemaining >= storedKwh` where `storedKwh = battCapKwh × (soc - minSoc) / 100`. If remaining PV today can cover what's currently stored, PeakTiming is skipped entirely. The floor gate (`profitableToDischarge`) still applies.
- PeakTiming re-engages in the evening when `pvKwhRemaining` drops below `storedKwh` (sun has set / nearly done).

## `_schedulePolicyCheck` — Slot Boundary Alignment

- `setInterval` starts after a `setTimeout` that aligns to the next UTC 15-min boundary (`:00`, `:15`, `:30`, `:45`). EPEX 15-min price slots are keyed to these UTC boundaries.
- Without alignment, the interval drifts ~11 min into each slot (based on app start time), leaving only ~4 min of discharge per slot.
- A `_slotAlignTimeout` is cleared/reset in `_schedulePolicyCheck` and `onUninit`.
- Hour-boundary run (`:00:05`) remains as fallback for immediate hour-change price updates.

## `_mapPolicyToHwMode` Discharge Gate

- `balanced-dynamic` mode is now handled inside the balanced+dynamic block (same as `balanced`). Previously it fell through to the catch-all (`standby`), causing a plan/reality mismatch.
- `buildPlanningSchedule` has always normalised `balanced-dynamic` → `balanced`; `_mapPolicyToHwMode` now does the same.
- `profitableToDischarge = price >= effectiveFloor && (!costModelActive || price >= breakEven)`
- **Break-even includes cycle cost** (consistent with optimizer): `breakEven = avgCost / effectiveEff + cycleCostPerKwh * 0.5`. Do NOT remove the cycle cost term.
- **Effective floor** — strict mode: `max(min_discharge_price, breakEven)`; opportunistic mode: `max(opportunistic_discharge_floor, breakEven)`.
- `min_discharge_price` default is **€0.22** (was €0.30 — too high for typical NL evening prices). All fallbacks in policy-engine.js use €0.22.
- SoC history in `policy_mode_history` uses `battery_soc_mirror` capability — do NOT use `measure_battery` (does not exist on this device).

**PV store → `zero_charge_only` mode:** When `_pvStoreWins && actualPvNow && !_chargeUrgent`: returns `zero_charge_only`. Placed BEFORE the `pvEstimate >= 400` check so it takes priority when PV storing is optimal.

**Discharge + PV → `zero` mode:** When `policyMode === 'discharge'` and `profitableToDischarge` and `actualPvNow` and `soc > minSoc`: returns `zero` instead of `zero_discharge_only`. The delay-charge discharge path is excluded — it intentionally exports PV at high prices.

## PV Detection

**Sunset guard:**

- `_estimatePvProduction` uses EMA smoothing (α=0.4), which causes `pvEstimate` to decay slowly (~2 hours after sunset to drop below 100W threshold).
- **Fix 1 (device.js):** When flow card reports 0W, `_lastPvEstimateW` is reset to 0 immediately.
- **Fix 2 (policy-engine.js):** After `todaySunset + 30min`, `pvEstimate >= 100` is **ignored** — only hard signals can prove PV is active.
- **Do NOT remove the sunset guard** — without it, discharge uses `zero` instead of `zero_discharge_only` for ~2 hours after sunset.

**`virtualGridPower` — battery discharge correction:**

- `virtualGridPower = gridPower - batteryPower` always. Do NOT use `gridPower` directly when discharging.
- Old bug: used `gridPower` unmodified when discharging — if batt=-337W, house=117W, P1 shows -220W (apparent export) even with no PV.
- Correct: `virtual = gridPower - batteryPower`. Discharging -337W with grid -220W → virtual = +117W → no export detected.

## Optimizer & Consumption

**Discharge SoC delta:** per-slot based on learned house consumption, not a fixed max discharge power. `min(maxDischargePowerW, consumptionWPerSlot[t])` — falls back to `maxDischargePowerW` when no consumption data.

**`pvKwhTomorrow`:** Calculated in `_recomputeOptimizer` from learned `pvForecast` array. Used as `strongSunTomorrow`:

- `>= 4h` equivalent: `sunshineTomorrow >= 4 || pvKwhTomorrow >= battCapKwh * 0.8`
- `>= 6h` equivalent: `sunshineTomorrow >= 6 || pvKwhTomorrow >= battCapKwh * 1.5`
- **Post-peak charge bonus:** `_applyDayAhead` suppresses the +40 "cheap hours tonight" bonus when `strongSunTomorrow`.

## Charge-Deferral

- `cheaperHourComing` kijkt **12 uur** vooruit. Vuurt als er een slot is dat ≥€0.005 goedkoper is. Geeft preserve +80.
- **Optimizer-check (12–24u vangnet):** als `inputs.optimizer?.getSlot(new Date()) === 'preserve'`, geeft ook preserve +80. Dit vangt goedkope middag-PV-slots op buiten het 12u-venster.
- Dezelfde optimizer-check staat in het **arbitrage-blok**: als optimizer 'preserve' geeft, wordt charge +80 niet toegevoegd maar preserve +20 in plaats daarvan.
- **Plan-vs-realiteit mismatch:** als `result.policyMode !== _dpAction` logt device.js `⚠️ PLAN AFWIJKING`. `battery_policy_state.dpAction` bevat de DP-geplande actie.

## Settings Keys

**PV:**

- `policy_pv_actual_today` — hourly actual PV from flow card `{date, hourly[], sums[], counts[]}` (Amsterdam tz, resets daily)
- `policy_pv_forecast_hourly` — `[{h: pvW}, {}]` for today + tomorrow, written after every optimizer run
- `battery_policy_state.pvLearnedSlots` — count of non-null solar yield factor slots

**State:**

- `battery_policy_state.dpAction` — DP-geplande actie voor huidig slot (`'charge'`/`'discharge'`/`'preserve'`)
- `battery_policy_state.avgCost` — energy-weighted average purchase cost (€/kWh) of stored energy

**Consumption:**

- `consumptionWPerSlot[t]` built from `learningEngine.getPredictedConsumption(slotTime)`, floored by baseload
- `sampleCount` added per slot using `learningEngine.getConsumptionSampleCount(slotTime)`
- `inputs.consumptionW` — current-hour prediction, available in PolicyEngine and ExplainabilityEngine

**`policy_daily_profit`:** Array of `{date, discharge, charge, net}` (max 30 entries), computed lazily from `policy_mode_history` when settings page opens. Only completed calendar days.

## Planning Settings Page

- Day SVG curve (`renderPvCurve`): gestippelde witte lijn toont geschat huisverbruiksprofiel. Alleen zichtbaar als ≥12 uren consumption data beschikbaar.
- Uurkaart details: `🏠 X.X kW` per uur (uurgemiddelde van consumption slots).
- Confidence badge: 🔴 `geen verbruiksdata` (0 samples) of 🟡 `N samples` (1–3) — alleen zichtbaar bij < 4 samples.
- Dagbalk: `💰 ~€X.XX netto` — discharge opbrengst minus laadkosten (gebruikt `avgCost` als beschikbaar, anders spotprijs).
