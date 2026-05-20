# Weather & PV Forecasting

Multi-source weather/PV forecasting feeds the optimizer's DP schedule, the PV-OVERSCHOT detection, and the per-day yield charts.

## Data sources

### Open-Meteo ensemble (`WeatherForecaster.fetchForecast` → `_mergeApiResponses`)

Four models fetched via `models=meteofrance_arpege_europe,gfs_seamless,icon_seamless,knmi_harmonie_arome_netherlands` on `api.open-meteo.com/v1/forecast`:

| Model | Source | Region focus |
|---|---|---|
| `meteofrance_arpege_europe` | Météo-France ARPEGE | Europe |
| `gfs_seamless` | NOAA GFS | Global |
| `icon_seamless` | DWD ICON | Europe / Global |
| `knmi_harmonie_arome_netherlands` | KNMI HARMONIE-AROME | Netherlands (high-res, ~2.5km) |

Each model exposes `shortwave_radiation_<model>` in the hourly response. Standard endpoint also returns `cloud_cover`, `sunshine_duration`, `global_tilted_irradiance` (when tilt/azimuth set in settings).

### Solcast (`lib/solcast-provider.js`)

Optional rooftop-specific PV power forecast. Requires API key + resource ID. Returns `pv_estimate` (p50 W) and `pv_estimate10` (p10, conservative). 30-min resolution; converted to W (kW × 1000) and aggregated hourly for the chart.

Cached in settings (`solcast_forecast_cache`); stale cache used as fallback on fetch failure.

### KNMI ground-truth (`lib/knmi-stations.js` + `_recordKnmiActual`)

`knmi-stations.js` lists Dutch KNMI stations (Cabauw, De Bilt, Schiphol, etc.) with lat/lon. `_pickNearestStation(lat, lon)` returns the closest. Hourly `qg` (global solar radiation, W/m²) is fetched from `https://www.daggegevens.knmi.nl/klimatologie/uurgegevens` and stored in `learningEngine.knmi_hourly` (last 2 calendar days).

Rate-limited to 1×/hour via `_maybeRecordKnmiActual` — safe to call on every fetchForecast (incl. cache hits).

Settings flag: `knmi_api_key` field (set on device); without it, KNMI fetch is skipped (Open-Meteo's own historical radiation falls back as actual).

## Ensemble blending

`_mergeApiResponses` produces a single `shortwave_radiation` array (used everywhere downstream) via weighted blend of the 4 model arrays:

```
const w = learningEngine.getModelWeights() ?? { equal weights };
wMean = Σ (w[m] × radiation[m]) / Σ w[m]
```

**Spread discount:** when models disagree (stdev across 4 values for a given hour), the blended value is reduced to avoid overshoot:

- `std > 80 W/m²` → `wMean − 0.5 × std`
- `std > 30 W/m²` → `wMean − 0.3 × std`
- else → `wMean`

Spread-adjusted slot count is logged: `Ensemble radiation blended from 4 models [mf=24% gfs=24% icon=26% knmi=27%] (sample avg: 155 W/m², spread-adjusted 29 slots)`.

Per-model arrays also kept as `perModelWm2` on each `hourlyForecast` slot, aligned to `standardData.hourly.time`. Used by device.js to build per-model `pvForecast` for accuracy tracking without re-aligning.

## Per-model accuracy

`learningEngine.recordModelAccuracy(perModelForecast, actualAvgWm2, dateStr)` runs once per day in `_learnFromYesterday`:

- Forecast snapshot saved at day-end via `saveForecastSnapshot(date, forecastAvgWm2, perModel)`
- Yesterday's snapshot compared against actual:
  - `actualAvg = knmiDailyAvg ?? (openMeteoHistoricalAvg)` — KNMI preferred
  - Per-model error `err = |actual − fc| / max(actual, fc)`; accuracy `1 − min(err, 1)`
- EMA update: `acc_m[t+1] = 0.15 × acc + 0.85 × acc_m[t]` (α=0.15, ~7-day half-life)
- Guard: each `dateStr` processed at most once (`pv_model_accuracy_date` flag)
- Prior used for cold-start: `_modelPrior(m)` (currently 0.7 for all)

Storage:

```
data.pv_model_accuracy = {
  meteofrance_arpege_europe: 0.801,
  gfs_seamless:              0.791,
  icon_seamless:             0.865,
  knmi_harmonie_arome_netherlands: 0.904,
}
data.pv_model_accuracy_date = '2026-05-19'
```

`getModelWeights()` returns proportional weights `acc[m] / Σacc[m]`, used by `_mergeApiResponses` for the next blend.

## Per-day per-model accuracy (UI)

Settings page (`settings/index.html`) shows MF/GFS/ICON/KNMI pills **per day** alongside Blended/OM/SC pills. Computed entirely frontend from `pvPredictions[*].{mf, gfs, icon, knmi, actual}` (already in learning-engine pvPredictions storage), grouped by Amsterdam-day in `_renderPvAccuracyDay`. No new backend storage — derived from existing per-slot per-model W values.

Updates when user navigates with day prev/next buttons.

## OM + Solcast blend (optimizer)

Optimizer slot-level PV uses weighted blend of OM and Solcast (when both available):

- `wOM` / `wSC` from `learningEngine.getPvBlendWeights()` (EMA per-source accuracy)
- `pvForecastSCEffective` chooses p50 or p10 per slot (conservative blend when accuracy uncertain)
- Past hours: OM + SC blended where both present, OM alone otherwise
- Future hours: stored blended `pvForecast[0]` (set by optimizer after rerun)

Chart shows both lines separately (Open-Meteo dashed blue, Solcast dashed green) plus the blended "PV Verwachting" (dashed orange) and actual (solid yellow).

## Bias factors

- `radiation_bias_factor` — EMA daily ratio actual/forecast (α=0.15, clamped 0.3–2.0). Skipped when ≥10 yield slots learned (yield factors already absorb bias).
- `pv_daily_bias` / `pv_daily_bias_clear` — per-cloud-cover-band ratios from `recordDailyPvBiasFromPredictions`. Applied as cloud-aware discount in optimizer DP when overcast forecast risks early stop-charging.
- `pvCloudFactor` — applied in DP under heavy cloud cover; prevents grid-charge stopping too early on overcast morning.

## Logging cheatsheet

```
[KNMI] Cabauw (14km): qg=200 W/m² n=6 okta ss=0 min ta=13.9°C
[KNMI] Using station qg=200 W/m² as actual for 2026-05-19
Ensemble radiation blended from 4 models [mf=24% gfs=24% icon=26% knmi=27%] (sample avg: 155 W/m², spread-adjusted 29 slots)
[Snapshot] 2026-05-20 rad=269 perModel=mf=332 gfs=415 icon=271 knmi=224 ensLen=96 hourlyLen=96
[ModelAccuracy check] 2026-05-19: perModel=meteofrance_arpege_europe,gfs_seamless,icon_seamless,knmi_harmonie_arome_netherlands actualCount=14
[ModelAccuracy] mf=0.80 gfs=0.79 icon=0.86 knmi=0.90 (actual=200W/m²)
```

## Settings keys

- `weather_latitude` / `weather_longitude` — location (number fields)
- `weather_update_interval` — fetch period (hours, default 3)
- `solcast_enabled` / `solcast_api_key` / `solcast_resource_id` — Solcast config
- `knmi_api_key` — KNMI daggegevens API token (device setting)
- `pv_tilt` / `pv_azimuth` — used for `global_tilted_irradiance` request (when both set)
