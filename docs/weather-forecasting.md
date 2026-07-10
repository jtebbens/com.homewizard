# Weather & PV Forecasting

Multi-source weather/PV forecasting feeds the optimizer's DP schedule, the PV-OVERSCHOT detection, and the per-day yield charts.

## Data sources

### Open-Meteo ensemble (`WeatherForecaster.fetchForecast` → `_mergeApiResponses`)

Five models fetched via `models=meteofrance_arpege_europe,gfs_seamless,icon_seamless,knmi_harmonie_arome_netherlands,ecmwf_ifs` on `api.open-meteo.com/v1/forecast` (single call — `models=` is a comma-list, not per-model requests):

| Model | Source | Region focus |
|---|---|---|
| `meteofrance_arpege_europe` | Météo-France ARPEGE | Europe |
| `gfs_seamless` | NOAA GFS | Global |
| `icon_seamless` | DWD ICON | Europe / Global |
| `knmi_harmonie_arome_netherlands` | KNMI HARMONIE-AROME | Netherlands (high-res, ~2.5km) |
| `ecmwf_ifs` | ECMWF IFS HRES | Global (9km) |

**Not `ecmwf_ifs04`**: that identifier is retired — Open-Meteo silently returns null `shortwave_radiation` for it (no HTTP error), so it looked valid but contributed nothing. Confirmed dead both in the 2026-05-17 fix (commit `ff747e5`) and re-verified live 2026-07-09. Current correct ECMWF id is `ecmwf_ifs` (IFS HRES, 9km — free since Oct 2025); `ecmwf_ifs025` (25km) also works but is lower-res.

Each model exposes `shortwave_radiation_<model>` in the hourly response. Standard endpoint also returns `cloud_cover`, `sunshine_duration`, `global_tilted_irradiance` (when tilt/azimuth set in settings).

### Solcast (`lib/solcast-provider.js`)

Optional rooftop-specific PV power forecast. Requires API key + resource ID. Returns `pv_estimate` (p50 W) and `pv_estimate10` (p10, conservative). 30-min resolution; converted to W (kW × 1000) and aggregated hourly for the chart.

Cached in settings (`solcast_forecast_cache`); stale cache used as fallback on fetch failure.

### KNMI ground-truth (`lib/knmi-stations.js` + `_recordKnmiActual`)

`knmi-stations.js` lists Dutch KNMI stations (Cabauw, De Bilt, Schiphol, etc.) with lat/lon. `_pickNearestStation(lat, lon)` returns the closest. Hourly `qg` (global solar radiation, W/m²) is fetched from `https://www.daggegevens.knmi.nl/klimatologie/uurgegevens` and stored in `learningEngine.knmi_hourly` (last 2 calendar days).

Rate-limited to 1×/hour via `_maybeRecordKnmiActual` — safe to call on every fetchForecast (incl. cache hits).

Settings flag: `knmi_api_key` field (set on device); without it, KNMI fetch is skipped (Open-Meteo's own historical radiation falls back as actual).

## Ensemble blending

`_mergeApiResponses` produces a single `shortwave_radiation` array (used everywhere downstream) via weighted blend of the 5 model arrays:

```
const w = learningEngine.getModelWeights() ?? { equal weights };
wMean = Σ (w[m] × radiation[m]) / Σ w[m]
```

**Spread (model disagreement):** stdev across the 5 model values for a given hour is tracked for observability only — it does **not** discount the point forecast. Disagreement is two-sided uncertainty, not a downward bias, so `wMean` is used as-is regardless of spread (a `std>30` discount existed at one point but was removed; see `test/ensemble-spread.test.js`). Slots where `std>30 W/m²` are counted and logged as "spread-detected", not "spread-adjusted".

Logged as: `Ensemble radiation blended from 5 models [mf=13% gfs=27% icon=20% knmi=7% ecmwf_ifs=33%] (sample avg: 269 W/m², spread-detected 18 slots (p50 not discounted))`.

Per-model arrays also kept as `perModelWm2` on each `hourlyForecast` slot, aligned to `standardData.hourly.time`. Used by device.js to build per-model `pvForecast` for accuracy tracking without re-aligning.

## Per-model accuracy

`learningEngine.recordPvAccuracy(predictedW, actualW, omW, scW, perModelW, satW, chartW)` runs every policy cycle (`device.js` `_recordPvAccuracySample()`, called from the main policy loop — every `policy_interval` minutes, not once/day):

- `perModelW` = current live PV interpolated from each model's own `_pvForecastPerModel[m]` curve (raw, uncorrected — ranking must judge closeness-to-truth, not closeness-to-ensemble-mean)
- Per-model error `err = |actualW − mW| / max(actualW, mW, 1)`, only when `mW > 50`
- EMA update: `acc_m[t+1] = 0.1 × (1 − err) + 0.9 × acc_m[t]` (α=0.1)
- Cold-start seed: `_modelPrior(m)` — e.g. knmi=0.90, icon=0.87, mf=0.82, ecmwf_ifs=0.80, gfs=0.77, default 0.84 for any unlisted model
- No per-date guard — updates continuously, every cycle a fresh sample lands

Storage:

```
data.pv_model_accuracy = {
  meteofrance_arpege_europe: 0.801,
  gfs_seamless:              0.791,
  icon_seamless:             0.865,
  knmi_harmonie_arome_netherlands: 0.904,
  ecmwf_ifs:                 0.80,
}
```

`getModelWeights()` does **not** return proportional weights (`acc/Σacc`) — it rank-sorts models by current `pv_model_accuracy` (falling back to prior when absent) and assigns fixed `[5,4,3,2,1]/15` shares by rank position (softened tilt, chosen 2026-06-20 after proportional/harsh weighting chased daily noise). Recomputed fresh on every ensemble fetch (`weather_update_interval`, default 3h, or on-demand cache-miss) using whatever `pv_model_accuracy` currently holds — so accuracy drifts every policy cycle, but the blend weight only refreshes at the next fetch.

## Per-day per-model accuracy (UI)

Settings page (`settings/index.html`) shows MF/GFS/ICON/KNMI/ECMWF pills **per day** alongside Blended/OM/SC pills. Computed entirely frontend from `pvPredictions[*].{mf, gfs, icon, knmi, ecmwf, actual}` (already in learning-engine pvPredictions storage), grouped by Amsterdam-day in `_renderPvAccuracyDay`. No new backend storage — derived from existing per-slot per-model W values.

Updates when user navigates with day prev/next buttons.

## OM + Solcast blend (optimizer)

Optimizer slot-level PV uses weighted blend of OM and Solcast (when both available):

- `wOM` / `wSC` from `learningEngine.getPvBlendWeights()` (EMA per-source accuracy)
- `pvForecastSCEffective` chooses p50 or p10 per slot (conservative blend when accuracy uncertain)
- Past hours: OM + SC blended where both present, OM alone otherwise
- Future hours: stored blended `pvForecast[0]` (set by optimizer after rerun)

Chart shows both lines separately (Open-Meteo dashed blue, Solcast dashed green) plus the blended "PV Verwachting" (dashed orange) and actual (solid yellow).

## PV forecast pipeline (post-collapse, single source)

After the 2026-06 pipeline-collapse (removed Cabauw decorrelation scaffold + clear-sky ceiling), `pvForecast` is built once per `_recomputeOptimizer` and reused everywhere — no per-consumer re-derivation:

1. **Radiation** — Open-Meteo 5-model ensemble blend (`_mergeApiResponses`, spread tracked not discounted — see Ensemble blending above) → `shortwave_radiation` per slot.
2. **Base pvForecast** (device.js ~2174–2200) — `radiation × yieldFactorSmoothed` when `learnedSlots ≥ 10`, else `pvCapacity × PR × (radiation/1000) × tempFactor`. Capped at `pvCapacityW` (installed-system ceiling only; the separate clear-sky ceiling was removed — yield factors already encode real-world ceiling).
3. **Daily bias** — `getDailyPvBiasFactor(cloud, kt)` (cloud/kt-aware EMA, capped toward 1.0 above 75% cloud). Returns `1.0` once `learnedSlots ≥ 10` (yield factors already absorb the correction — see [[learning-engine.md]]).
4. **PV-accuracy conservatism** — discount when `pv_accuracy_score < 0.80`.
5. **Intraday corrector + cloudGate** (device.js ~2531–2593) — rain/precip-aware per-slot trim.
6. → single `pvForecast` array feeds:
   - **DP optimizer**: `_getPvForSlot(pvForecast, t)` → `optimizationEngine.compute()` (device.js ~2766/2876)
   - **Planning chart**: `buildPlanningSchedule(slots, pvForecast, ...)` — same array, no separate chart snapshot
   - **Explainability**: `_planSlot.pvForecastW` ← read from the DP schedule produced in step 6

All three consumers see the same post-correction values by construction (Property-suite invariant 19 checks PV-lift never lowers projected profit).

## Bias factors

- `radiation_bias_factor` — EMA daily ratio actual/forecast (α=0.15, clamped 0.3–2.0). Skipped when ≥10 yield slots learned (yield factors already absorb bias).
- `pv_daily_bias` / `pv_daily_bias_clear` — per-cloud-cover-band ratios from `recordDailyPvBiasFromPredictions`. Applied as cloud-aware discount in optimizer DP when overcast forecast risks early stop-charging. Skipped (returns 1.0) once ≥10 yield slots learned — same yield-absorbs-bias guard as `radiation_bias_factor`.
- `pvCloudFactor` — applied in DP under heavy cloud cover; prevents grid-charge stopping too early on overcast morning.

## Logging cheatsheet

```
[KNMI] Cabauw (14km): qg=200 W/m² n=6 okta ss=0 min ta=13.9°C
[KNMI] Using station qg=200 W/m² as actual for 2026-05-19
Ensemble radiation blended from 5 models [mf=13% gfs=27% icon=20% knmi=7% ecmwf_ifs=33%] (sample avg: 269 W/m², spread-detected 18 slots (p50 not discounted))
[Snapshot] 2026-07-09 rad=269 hourlyLen=96
[PV perModel] slots: mf=27 gfs=27 icon=27 knmi=27 ecmwf=27
```

(Verified against live log 2026-07-09 — the older `[ModelAccuracy check]`/`[ModelAccuracy]` lines documented here previously no longer exist in the code; per-model accuracy has no dedicated log line now, only the stored `pv_model_accuracy` value and the `[PV perModel]` slot-count line above.)

## Settings keys

- `weather_latitude` / `weather_longitude` — location (number fields)
- `weather_update_interval` — fetch period (hours, default 3)
- `solcast_enabled` / `solcast_api_key` / `solcast_resource_id` — Solcast config
- `knmi_api_key` — KNMI daggegevens API token (device setting)
- `pv_tilt` / `pv_azimuth` — used for `global_tilted_irradiance` request (when both set)
