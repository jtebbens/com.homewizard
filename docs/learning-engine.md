# Learning Engine

- Records consumption from `gridPower` only when `gridPower > 0` — intentional; battery discharge is not recorded separately
- `pv_predictions` capped at 300 entries (only last 100 used for accuracy calc via `slice(-100)`)
- `getPredictedConsumption()` falls back: specific day → day-group (weekday/weekend) → all days → 0
- Consumption forecast in optimizer: `learned > 0 ? learned : baseloadW` — baseload only used when slot has no learned data at all
- `getConsumptionSampleCount(targetTime)` — returns raw sample count (0–100) for a specific day-of-week + hour. Count < 4 means below direct-use threshold (learning engine falls back to group average). Used for confidence badges in planning UI.

## Solar Yield Factors

- 96 slots (15-min), stored as `yieldFactor = W_actual / radiationWm2`
- EMA α=0.10 (symmetric — asymmetric EMA was tried and caused upward drift to 4.6kW on 3500Wp, do NOT reintroduce)
- `getSolarYieldFactorsSmoothed()` does linear gap-fill + 3-pass triangular smoothing (0.25/0.5/0.25) — raw factors are never modified
- Used in pvForecast when `learnedSlots >= 10`; below 10 falls back to `pvCapacity × pv_performance_ratio × (radiation/1000)`
- `pv_performance_ratio` is **irrelevant** once ≥ 10 slots are learned — the yield factors absorb capacity, orientation, PR and shading
- `getRadiationBiasFactor()` returns 1.0 until ≥ 3 daily samples are recorded (prevents bad single-day ratios from taking effect)
- **`getRadiationBiasFactor()` returns 1.0 when `learnedSlots >= 10`** — yield factors already absorb the Open-Meteo vs actual relationship; applying bias on top double-counts the correction. Do NOT remove this guard.

## Radiation Bias

- Compares yesterday's forecasted vs actual GTI/GHI daily average; updates via EMA α=0.15, clamped 0.3–2.0
- Ratio capped at 3.0 per sample to limit single-day outliers
- Skips samples where `forecastAvgWm2 < 30` — protects against corrupt snapshots (Open-Meteo returning near-zero values)
- `radiation_bias_reset_v1` flag: one-time reset if stored factor > 1.5 at startup (corrupted data guard)
- Factor clamps at 2.0 (max). If still at 2.0 after several weeks of operation, Open-Meteo structurally underestimates GTI for this location — monitor in spring as yield data accumulates
- **Cache caveat:** `getRadiationBiasFactor()` is only called inside `_processForecast()`. When weather is restored from settings cache, `_processForecast()` is skipped — bias baked into cache is from the original fetch moment
- Startup log: `[LearningEngine] radiation_bias_factor=X.XXX (N samples, M yield slots — ACTIVE / inactive: yield factors in use)`

## Solar Yield Slots & DST

- Slots are indexed on UTC (`getUTCHours()`) — consistent across DST transitions
- At spring/autumn DST, the slot corresponding to peak-sun shifts by 1 in local time; self-corrects within days via EMA
- Yield factor index in device.js pvForecast mapping: `d.getUTCHours() * 4` (hourly data always on the hour, minutes = 0)
