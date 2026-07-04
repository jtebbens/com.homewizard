# PV forecast correction stack — one mental model

Consolidates the ~19 correction layers that sit between raw Open-Meteo radiation and the
`pvForecast[]` array the DP consumes. Read this before touching any PV scaler — the layers
stack multiplicatively, interleave with hard caps, and two of them feed back into the DP's
night plan via the reserve floor. Companion to `optimizer-dp-pipeline.md`.

Two files: `lib/weather-forecaster.js` (`_processForecast`, radiation level) and
`drivers/battery-policy/device.js` (`_gatherInputs`/policy build, power level). Applied strictly
in the order below.

## The layers, in order

| # | Layer | Location | Type | Scope |
|---|-------|----------|------|-------|
| **A. Radiation (W/m²)** | | `weather-forecaster.js` | | |
| 1 | GTI transposition (tilt/azimuth) | `_computeGTI` ~350–365 | replace | when tilt+azimuth set, else GHI |
| 2 | Ensemble blend (per-model weights) | ~524–538 | weighted avg | ECMWF/GFS/ICON/KNMI × `getModelWeights()` |
| 3 | `biasFactor` (learned radiation bias) | 467, 537/568 | ×uniform | all slots |
| 4 | `wxFactor` (fog/snow/rain/thunder) | `_weatherAttenuation` 505 | ×reduce | per weather_code + precipProb |
| 5 | `radiationSpreadFrac` (ensemble std/mean) | 544–553 | *tag only* | feeds layer 19 + `pvSpreadTomorrow` |
| **B. Radiation → Power (W)** | | `device.js` ~2320 | | |
| 6 | Learned yield factors (W per W/m²) | 2326–2347 | replace pvCapW×PR | per 15-min UTC slot; fallback pvCapW×PR×temp if <10 learned |
| 7 | Cap at `pvCapacityW` | 2351 | clamp | all |
| **C. Day / accuracy corrections** | | `device.js` ~2600 | | |
| 8 | `dailyBias` (weather-type) + high-cloud cap | 2614–2622 | ×both/tomorrow | `cappedDailyBias`, capped when cloud >75% |
| 9 | `accFactor` (conservatism if acc<0.80) | 2650–2662 | ×reduce | skipped if under-forecasting or simplified |
| 10 | `_pvCloudFactor` (DP coverage discount) | 2666–2670 | *DP-only, separate arg* | cloud >70% → down to 0.6; NOT applied to pvForecast |
| **D. Intraday self-correction** | | `device.js` ~2684 | | |
| 11 | `intradayRatio` (actual/forecast today) | 2687–2754 | ×both dir | today-future only; winsorised, CV-gated, cloud-gated, un-biased |
| **E. Near-term overrides** | | `device.js` ~2775 | | |
| 12 | Re-clamp to `pvCapacityW` | 2775–2779 | clamp | after upward corrections |
| 13 | Buienradar rain cap | 2785–2815 | reduce-only | ≤2h radar window |
| 14 | OM precip cap (`_omPrecipFactor`) | 2818–2828 | reduce-only | beyond Buienradar window |
| 15 | Final cap at `pvCapacityW` | 2835–2837 | clamp | before DP consumes |
| 16 | Satellite nowcast override | 2839–2864 | **replace** | 0–2h, gated `satellite_dp_active`; sets spreadFrac=0 |
| 17 | Upwind cloud modulation | 2866–2885 | reduce-only | lead-time slot ×`upwindKt`, always when upwind data present |
| **F. DP-internal (not on pvForecast)** | | `optimization-engine.js` | | |
| 18 | Spread-band (`_applyPvSpreadBand`) | 663–666 | **RETIRED 2026-07-04** | no live caller (device.js passes `pvTimingRobust=false` always); helper kept as dead-but-tested code |

## Three things that make this fragile

1. **Multipliers stack; overrides replace.** Layers 3,4,8,9,11 are multiplicative — they compound.
   Layers 16 (satellite) and 17 (upwind) **replace/reduce the already-corrected value**, running
   last. So a slot's final PV can be `raw × biasFactor × wxFactor × dailyBias × accFactor ×
   intradayRatio`, then *overwritten* by satPanelW (16) or pulled down by upwindKt (17). Adding a
   new multiplier upstream silently shifts what the caps (7,12,15) clamp and what the overrides
   compare against.

2. **Two consumers diverge — by design, but watch it.** The chart, stored forecast, and
   accuracy line consume the fully-corrected **p50** `pvForecast[].pvPowerW`. The DP additionally
   applies `_pvCloudFactor` (layer 10, a *separate* `pvCloudFactor` arg to `compute()`, discounts
   `pvCoverage` only) (the spread-band, layer 18, is retired — no longer a divergence). This is the deliberate
   "decision is more conservative than the display" split — but it means "why does the DP see less
   PV than the chart shows?" is expected, not a bug. Per CLAUDE.md's single-correction-impl rule:
   never add a chart-side mirror of a DP-side discount or vice-versa.

3. **Two layers feed back into the DP night plan (the loop to `optimizer-dp-pipeline.md`).**
   The intraday corrector (layer 11) sets `_lastPvForecastCv` and `_lastPvForecastRatio` (2715–2716);
   the scalar `pvSpreadTomorrow` (device.js ~2567, from layer 5) is the third input. All three feed
   `refillConfidenceFromForecast` → `reserveFloorG[]` → the whole overnight discharge plan. So a
   PV-*forecast* correction reshapes *battery discharge* timing. This is the single most surprising
   coupling in the app: a change to a morning intraday ratio can move tonight's discharge slots.

## Known double-count guards (already in place — don't remove)

- `accFactor` (9) is **skipped in simplified mode** — it overlaps with `dailyBias` + `intradayRatio`
  which already absorb the error for today. Re-enabling it there double-discounts.
- `intradayRatio` (11) divides out `biasCorrFactor` (`_pvDailyBiasFactor × _pvAccFactor`, 2708)
  before applying — otherwise it re-corrects an already-biased forecast.
- `cloudGate` on the intraday upward push (2726–2728) prevents a clear-morning sample from
  re-inflating PV the model correctly lowered for a cloudy afternoon; `_knmiAwareCloudGate` lets a
  real clearness reading override a false-overcast. Downward correction is left intact.
- `dailyBias` high-cloud cap (2618–2620) stops an upward weather-type bias from firing on an
  already-overcast day.

## Historical hazard (the reason for the single-impl rule)

2026-06-22: the webcam-OM correction and the accuracy-OM correction diverged because the same
formula was implemented twice — fixed via the shared `_correctOverlayW` (device.js ~3710). Any
correction that must feed chart **and** diagnostics **and** DP goes through one implementation.
Grep for an existing formula before adding one. See CLAUDE.md "One implementation per
correction/formula".

## Consolidation verdict (chunk 5, 2026-07-04)

This is the "overview first" half of `project_stability_focus_chunkplan` chunk 5. Each layer is
individually justified by a documented past miss; the risk is the stacking order + the two
feedback couplings, which this doc now makes explicit. **No simplification attempted here** —
merging/removing layers is higher-risk and needs its own per-layer A/B with the property suite.
The `pv_forecast_simplified` shadow-run (layers 8/9 tomorrow-only vs legacy all-slots, 2756–2771)
is the existing scaffold for retiring the legacy dailyBias/accFactor path once the simplified
delta is proven — that's the natural first consolidation candidate if this is picked up.
