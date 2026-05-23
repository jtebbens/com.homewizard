# HomeWizard for Homey

Control and monitor your HomeWizard Energy devices directly from your Homey smart home hub.

## 🚀 Quick Start

1. **Enable Local API** - Open the official HomeWizard Energy app and enable "Local API" for your devices you like to add

## 🚀 Quick Start LEGACY (OLD MODEL)

1. **Add Homewizard Unit** - First add your main Homewizard unit in Homey
2. **Add Devices** - Then add related/connected components from Homewizard to your Homey (Heatlink, Energylink, Thermometers etc)

⚠️ **IMPORTANT**: You must enable "Local API" for your device in the official HomeWizard Energy app before adding devices to Homey.

## ✨ Features

### Smart Energy Management

* **P1 Meter Support** - Monitor energy consumption in real-time (API v1 & v2)
* **Smart Sockets** - Control and monitor individual devices
* **Battery Management** - Track and control home battery systems
* **Solar Integration** - Monitor solar production and consumption

### Advanced Features

* **Battery Policy Driver** - Automated battery management based on dynamic tariffs or peak shaving
* **Power Quality Monitoring** - Trigger cards for voltage sags, swells, power failures, and restoration events
* **Baseload Detection** - Identify standby power consumption (sluipverbruik)
* **Learning Engine** - AI-powered pattern recognition for optimized battery charging
* **Cloud API Support** - Connect P1 meters and water meters via HomeWizard cloud

### Supported Devices

* P1 Energy Meters (API v1 & v2, including cloud-connected)
* Energy Sockets
* Plugin Battery
* SDM230 & SDM630 kWh Meters (3-phase, industrial grade)
* Water Meters (local & cloud)
* Legacy Devices (thermometer, heatlink, rainmeter, windmeter, sensors)

## 📊 Battery Policy Manager

NEW in v3.13.14: Intelligent battery management system that:

* Responds to dynamic electricity tariffs
* Implements peak shaving strategies
* Learns consumption patterns over time
* Adjusts PV production estimates based on historical accuracy
* Provides confidence scoring for policy decisions

**Note**: Cloud-based features depend on internet connectivity and HomeWizard Energy platform availability. During maintenance or outages, you may experience errors or incorrect data.

## 📝 Latest Updates (v3.15.63–v3.15.86)

### PV Forecast, Optimizer & Battery Policy Fixes (v3.15.83–v3.15.86)

* **Per-model GTI via solar transposition + KNMI kt bias classification (v3.15.83)** — PV forecast accuracy per Open-Meteo model now uses Global Tilted Irradiance (GTI) computed via the Perez transposition model rather than GHI. This ensures the per-model radiation error is evaluated on the same tilted plane as the actual panel yield. Simultaneously, the daily radiation bias factor is now selected based on the KNMI clearness index (kt) rather than Open-Meteo cloud cover fraction — OM systematically over-estimates cloud cover (42% vs 15% measured), causing the wrong bias tier to be selected on partially-cloudy days

* **PV chart data key separated + kt-based bias apply + memory reduction (v3.15.84)** — The PV chart now uses a dedicated data key independent of the forecast pipeline, preventing stale forecast values from persisting across recomputes. kt-based bias is applied earlier in the forecast chain so downstream models see the corrected irradiance. Internal forecast buffers reduced to lower heap usage during ensemble fetches

* **Chart midnight rollover fix + ensemble fetch timeout 10→15s (v3.15.85)** — The planning chart camera image swapped tomorrow's chart for today's after midnight due to a day-boundary comparison error; fixed. The Open-Meteo ensemble fetch timeout was extended from 10s to 15s to reduce spurious timeout failures on slow upstream responses. Battery policy capabilities now expose projected profit, PV forecast, bias factor, and current DP plan summary as Homey capability values

* **Optimizer: smooth isolated preserve islands in discharge sequences (v3.15.86)** — A single `preserve` slot flanked by `discharge` on both sides with a price delta below 1 ct is a DP numerical edge case (floating-point score tie at a local price minimum). Such slots are now overridden to `discharge` in a post-DP smoothing pass; projected SoC is propagated forward accordingly. Observed impact: one 15-min standby at €0.273 between €0.281 and €0.274 discharge slots

### PV Forecast — KNMI Ground-Truth & Fixes (v3.15.81–v3.15.82)

* **KNMI station ground-truth for model accuracy (v3.15.81)** — PV forecast accuracy tracking now uses independent in-situ radiation measurements from the nearest KNMI automatic weather station (e.g. Cabauw) as the daily actual, instead of Open-Meteo's own historical data. Open-Meteo used its own archived data as the "actual" reference, creating circular validation that could not detect systematic model bias. KNMI station data is fetched hourly via the EDR API and accumulated into a daily average used as ground-truth in the nightly learning step. Falls back to Open-Meteo if fewer than 4 daylight readings were collected or if no API key is configured. Requires a KNMI EDR API key configured in device settings (register at dataplatform.knmi.nl)

* **NOCT temperature derating for fallback PV forecast (v3.15.81)** — The pre-learning fallback PV forecast (used before sufficient yield data has accumulated) now applies a thermal derating factor for high ambient temperatures. Silicon PV panels lose approximately 0.4%/°C above 25°C cell temperature; on hot summer days the flat-PR fallback overpredicted by up to 10%. The correction uses ambient temperature from the Open-Meteo forecast and the standard NOCT model. Panels with a learned yield factor already embed temperature effects empirically — correction applies only to the fallback path

* **P1 meter identify accepts empty response body (v3.15.82)** — The P1 meter returns an empty HTTP body on `/api/system/identify`; the strict JSON object-type check caused a false "Invalid response format" error. HTTP status code alone is now used to detect failure

### PV Forecast — Cloud Uncertainty, Solcast p10 & Per-Model Accuracy (v3.15.80)

* **Solcast p10 cloud-aware selection (v3.15.80)** — When Solcast's `pv_estimate` (p50) exceeds the Open-Meteo NWP forecast by ≥10% for a given slot, the optimizer switches to `pv_estimate10` (pessimistic 10th-percentile) for that slot. On clear days both models agree and p50 is used; on overcast days where Solcast's satellite/ML lags a weather front, OM sees the cloud cover first and the p10 switch prevents over-reliance on PV that won't arrive. Logged as `p10=Xslots` per day in `[PV blend]`

* **Cloud uncertainty discount in DP (v3.15.80)** — When cloud cover exceeds 70%, `pvCoverage` in the DP forward and backward passes is discounted by up to 40% (factor 0.6–1.0). Prevents the optimizer from discharging at break-even prices early in the day by relying on uncertain PV recharge that may not materialise on overcast days. Shown in the PV bias line as `×0.87 (pv-onzekerheid)` and logged as `[PV cloud uncertainty]`
* **Per-model OM radiation curves in PV accuracy chart (v3.15.80)** — The PV forecast accuracy section now shows a second chart with individual Open-Meteo model curves (Météo-France ARPEGE, GFS, ICON, KNMI) alongside actual measured production. Per-model Watt estimates are recorded per 15-min accuracy sample and stored in `pv_predictions`. Per-model EMA accuracy scores are shown as pills once a full day of data has accumulated
* **Météo-France ARPEGE Europe replaces ECMWF IFS04 in ensemble blend (v3.15.80)** — ECMWF IFS04 returned null `shortwave_radiation` for all hourly slots via the Open-Meteo ensemble endpoint and contributed nothing to the blend or accuracy tracking. Replaced with Météo-France ARPEGE Europe (10 km, West-European coverage), which provides full hourly radiation data. Accuracy prior set to 0.82

### Battery Policy — Grid Top-Up Timing (v3.15.79)

* **Low-SoC top-up deferred to cheapest upcoming slot (v3.15.79)** — `lowSocGridTopUp` now only fires when the current price is the minimum price in the next 8 hours. Previously, the top-up could trigger at any price below `dynamicMaxChargePrice`, causing premature grid charging when a cheaper DP-planned slot existed shortly ahead. With two batteries (1600 W charge rate), charging at a sub-optimal price erases the efficiency margin entirely

### Diagnostics & PV Accuracy (v3.15.78)

* **Policy run debug: dynamicMaxChargePrice + lowSocGridTopUp (v3.15.78)** — The `policy_last_run_debug` snapshot now stores `dynamicMaxChargePrice` (the effective charge price ceiling at the time of the run) and `lowSocGridTopUp` (whether the low-SoC grid top-up path was triggered). Both are shown in the diagnostic output. Previously, post-hoc diagnosis of unexpected `to_full` decisions was impossible because only the current dynamic max was available, not the value from the actual run
* **PV net surplus accuracy tracking (v3.15.78)** — Learning engine now tracks predicted vs actual net PV surplus (PV minus consumption during solar hours). An EMA correction factor `pv_net_surplus_factor` [0.4–1.1] adjusts the terminal value calculation in the DP optimizer so next-day battery dispatch is planned on realistic rather than idealised surplus
* **Optimizer terminal value uses adjusted PV tomorrow (v3.15.78)** — `terminalPvKwhTomorrow` passes the surplus-accuracy-corrected PV estimate to the DP forward pass, preventing the optimizer from over-discharging today when tomorrow's PV was historically over-predicted

### Battery Policy — Night Behaviour Fixes (v3.15.77)

* **Sunset guard broken after midnight weather refresh (v3.15.77)** — After midnight, a weather cache refresh set `todaySunset` to the current day's future sunset timestamp. Because the current time (e.g. 00:48 UTC) was before that sunset (19:30 UTC), `_afterSunset` evaluated to `false`, letting stale PV estimates (EMA still decaying) pass the guard and map `preserve` to `zero_charge_only` instead of `standby`. Fix: `_afterSunset` is now also `true` when the current time is before `todaySunrise`, covering the entire pre-dawn window regardless of which day's sunset is cached
* **SoC staleness at policy run (v3.15.77)** — `battery_group_average_soc` is updated by a 60-second interval; when the policy engine ran between updates it used a stale SoC, causing the DP to plan from the wrong starting point. Fix: `_updateBatteryGroup()` is now called immediately before `_getBatteryState()` on every policy run, refreshing the capability from live WS data
* **Event history battery power from WS (v3.15.77)** — `battW` in event history entries now reads `_lastPower` directly from the plugin_battery WebSocket (seconds-fresh) instead of the 30s-stale `battery_group_power_w` capability. Falls back to the capability when no plugin_battery device is found
* **BMS calibration detection (v3.15.77)** — Battery management systems occasionally run a calibration cycle: battery charges at full power but reports SoC=0% and power=0W. This caused event history entries to look like unexplained grid spikes. Policy engine now detects this signature (`soc=0%`, `battW≈0`, `gridW>700W`, nighttime, no charge/discharge mode commanded) and marks the entry `exception: bms_calibration`

### Battery Policy — PV Forecast Accuracy (v3.15.69–v3.15.76)

* **Multi-source rain correction + ensemble averaging (v3.15.74)** — Buienradar now samples 5 geographic points (center + N/S/E/W at ±0.05°) for more representative local precipitation. PV forecast now averages 4 Open-Meteo radiation models (ECMWF, GFS, ICON, KNMI Harmonie), with spread-adjusted weighting to reduce outlier influence
* **3-class daily PV bias stratification by cloud cover (v3.15.73)** — Daily PV bias factor is now derived from three cloud-cover classes (clear/partial/overcast) rather than a single global correction, improving accuracy for mixed-sky days
* **Intraday PV scaling with winsorised ratios + CV dampening (v3.15.72)** — Intraday reoptimisation scales the PV forecast to match morning actuals. Ratio samples are now winsorised (outlier-clipped) and dampened by their coefficient of variation, preventing a single cloudy-then-clear hour from over-correcting the full-day forecast
* **Clear-sky forecast floor (v3.15.63)** — Intraday reopt now enforces a clear-sky model as a ceiling on per-slot PV corrections; slots cannot be scaled above theoretical maximum irradiance

### Battery Policy — PV Chart & Display (v3.15.69–v3.15.73)

* **OM and Solcast forecast lines shown separately (v3.15.70)** — PV chart now renders Open-Meteo (blue dashed) and Solcast (purple dashed) forecast lines independently alongside the blended orange line, making model agreement visible
* **Day-start Solcast snapshot for past-hour chart line (v3.15.77)** — The blended orange line now extends into past hours using the day-start Solcast snapshot (saved once per Amsterdam calendar day), preventing the line from dropping to zero for past slots when live data is no longer available
* **Planning schedule uses unbiased PV forecast (v3.15.73)** — The planning chart's orange forecast line now uses the raw unbiased PV values; the daily bias factor is applied only to optimizer inputs, not to the chart display
* **PV bias info + pvChart column in diagnose (v3.15.69)** — The `/diagnose` command now shows `PV bias: ×X.XX (dag) ×X.XX (acc) netto ×X.XX bewolking=X%` and a `PVchart` column with the chart-scaled PV value per slot

### Settings & Diagnostics (v3.15.69)

* **Bilingual settings page NL + EN (v3.15.69)** — All settings labels and descriptions are now available in Dutch and English; language follows the Homey locale setting

### Battery Policy — Optimizer (v3.15.63–v3.15.68)

* **Stop trickle-charging when PV export earns more (v3.15.65)** — `pv_trickle` mode is now blocked when the current export price exceeds the opportunity cost of charging; battery switches to `standby` and lets PV export to grid instead
* **PV trickle cost corrected to zero (v3.15.65)** — The optimizer previously assigned a non-zero charge cost to `pv_trickle` slots, making them compete unfairly with free PV surplus. Trickle-charge cost is now set to zero, consistent with how surplus PV charging is modelled
* **`pv_surplus_forecast` uses mapped hwModes and charge cap (v3.15.69)** — Surplus forecast now accounts for the actual hwMode mapping (not raw DP action) and respects the max charge power cap, preventing overly optimistic PV surplus estimates

---

## Previous Updates (v3.15.59–v3.15.62)

### Battery Policy — PV Detection & Diagnostics

* **P1-derived PV fallback for users without PV flow card (v3.15.62)** — When no live PV flow card is configured, the policy engine now estimates PV production from P1 data using `pvFromP1 = avg_consumption − gridPower`. If this derived value ≥ 300 W during daylight hours, the battery switches to `zero_charge_only` to charge from available solar surplus. Previously, these users would remain in `standby` even when the planning showed `zero_charge_only`, because the live PV signal was always 0 W
* **Correct house consumption in diagnostics (v3.15.62)** — The "huidig verbruik" field in the active-slot diagnostic now shows actual house consumption (`gridPower + pvW − batteryPower`) instead of `currentLoad` (which is 0 when PV covers all loads). Previously, strong PV production caused the field to display 0 W, misleading users into thinking the house had no consumption

### Battery Policy — DP Optimizer Fixes

* **Discharge at highest-price night slots, not cheapest (v3.15.61)** — Two fixes for non-monotone night price ordering: (1) DP flattening is now blocked when a higher-priced non-PV slot exists ahead (e.g. 23:00 at €0.272 is no longer flattened when 00:00 is €0.278); (2) after the forward pass, discharge slots within the first contiguous non-PV window are reordered by price descending and assigned greedily from the battery budget
* **Session RTE tracking, charge cost post-2027, PV-store threshold (v3.15.59)** — Optimizer now tracks per-session round-trip efficiency; charge cost calculation updated for post-2027 net-metering end; PV-store threshold tuned to avoid premature standby during shoulder hours

### Battery Policy — Planning

* **Planning updates PV forecast, trickle mode (v3.15.59)** — Planning view now refreshes PV forecast on each recompute. Added `pv_trickle` mode for weak PV conditions (100–400 W) where zero_charge_only would be too aggressive but standby wastes available solar

---

## Previous Updates (v3.15.49–v3.15.55)

### Battery Policy — DP Optimizer Fixes

* **`getSlot` biased toward active slot (v3.15.55)** — At the exact midpoint between two hourly slots (e.g. 12:30), `getSlot()` previously picked the *next* slot due to a millisecond timing offset, causing that slot's action to be applied up to 30 minutes too early. It now always returns the most recently started slot (the one currently being executed), falling back to nearest-future only when no past slot exists yet (e.g. on first startup)
* **Partial-slot charge modelling (v3.15.55)** — When the optimizer recomputes mid-slot, it previously modelled the current slot as a full 1-hour charging opportunity (0.8 kWh). This caused it to overestimate how much charge could be obtained in the remaining time and incorrectly skip the next slot. The DP now scales `chargeSocDeltaG` and `chargeKwhFull` for slot 0 based on the fraction of the slot still remaining (`slot0RemainingFrac`), so it correctly plans additional charge slots when needed (e.g. `charge=2` instead of `charge=1`)
* **`vPreserve` opportunity cost (v3.15.53)** — The DP previously treated PV charging during `preserve` slots as free: storing surplus PV had zero cost in the value function. It now subtracts the foregone export revenue (`storedKwh × price × exportRatio`) from `vPreserve`. This corrects the bias toward preserve when PV could profitably be exported instead, making `standby` more competitive at low positive prices

### Battery Policy — Planning & Consumption

* **Consumption slot timezone fix (v3.15.49)** — Price records now carry explicit Amsterdam `hour`/`minute` fields. When present, consumption lookups use `getPredictedConsumptionForSlot()` instead of deriving the hour from the UTC timestamp. Previously, UTC timestamps without a timezone indicator were shifted by +2h (CEST), causing all consumption forecasts to land on the wrong slot and return the baseload floor (~314 W) everywhere
* **Null consumption when nothing is learned (v3.15.49)** — If the learning engine has not yet accumulated any non-zero consumption data, `consumptionWPerSlot` is passed as `null` to the optimizer instead of an all-zero array. An all-zero array caused the baseload floor to over-constrain discharge planning as if the house never consumed power; `null` correctly instructs the optimizer to use unconstrained max discharge power (800 W)
* **`pvStoreWins` simulation in planning forward pass (v3.15.49)** — The optimizer's forward pass now simulates the `_pvStoreWins` override that the runtime policy engine applies. When a standby slot would have `pvStoreWins` active (PV surplus worth more than current export price), the planning chart shows `zero_charge_only` and updates the projected SoC accordingly — matching what actually happens at runtime
* **Planning slot reasons (v3.15.49)** — `_mapActionToHwModeForPlanning` now returns a `reason` string alongside `hwMode` (e.g. `dp:charge negative_price`, `preserve:pv_strong(3200W)`). Stored in the schedule and visible in the settings UI for easier diagnostics

### Battery Policy — PV Estimation

* **PV estimation fallback to weather forecast (v3.15.54)** — `_estimatePvProduction()` is now used everywhere house consumption is calculated. When no flow card is supplying live PV data (or the data is stale), it falls back to a weather-based estimate using sun score and configured PV capacity. Previously `this._pvProductionW ?? 0` was used directly, causing 0 W PV during stale periods and overcounting house consumption by the full battery charge power in the learning engine
* **P1 firmware `batteryPower = 0` correction (v3.15.55)** — The P1/DSMR firmware incorrectly reports battery power as 0 W when the battery is in `to_full` mode. The battery-policy device now detects this case (mode = `to_full`, reported power = 0) and substitutes the configured max charge power from device state. Without this correction the learning engine recorded house consumption ~800 W too high during every grid-charging session

---

## Earlier Updates (v3.13–v3.15.58)

* **v3.15.40** — Negative price charging (`to_full` when price < 0); `preserve→standby` bij negatieve prijzen; slot0RemainingFrac fix; P1 firmware batteryPower=0 correctie
* **v3.15.37** — Yield-factor normalisation; Solcast moved to `_updateWeather`; cycle recorded on discharge→charge transition; predictive modes in camera
* **v3.15.35–36** — Startup crash fix (serialised settings write queue); SDM polling spread; memory log per device type
* **v3.15.10+** — DP-primary refactor (sole decision-maker); PV accuracy fix; intraday PV scaling; explainability DP-reasons; PV chart fix; weather attenuation; DP terminal value; per-slot confidence margin; profit tracking; SoC forward simulation
* **v3.15.10** — pvCoverage net surplus; pvKwhTomorrow net-absorbable; dp.fill guard non-PV only; three-tier discharge floor; linear PV interpolation; Solcast integration; self-sufficiency tracking; consumption margin; PV camera image
* **v3.14.24–3.14.29** — Discharge SoC projection consumption-aware; discharge floor consistent DP/display; opportunistic discharge; pre-peak urgent charging; lat/lon weather; forecast blending; PV score rebalanced
* **v3.14.19** — Solar yield learning; weekend/weekday consumption patterns; battery cycle cost; pure DP kernel
* **v3.14.0** — 15-min price granularity; optimizer on 96 slots; explainability color coding
* **v3.13.68** — OptimizationEngine (DP scheduler); WebSocket throttle configurable
* **v3.13.58** — Baseload battery correction; RTE learning fixes; WebSocket performance; tiered updates
* **v3.13.49** — Active mode capability; dynamic pricing v2; WebSocket stability; CPU/performance overhaul
* **v3.13.37** — PV detection sticky state; grid charging during PV fix
* **v3.13.28** — Manual IP override; battery-aware baseload; weather-aware discharge; dynamic sunrise/sunset
* **v3.13.14** — Battery Policy driver; ML learning engine; cloud P1/water meter support; trigger cards

---

## 📄 License

This app is licensed under the GNU General Public License v3.0

## 👥 Credits

* **Jeroen Tebbens** - Main developer
* **DCSBL** - Major code contributions (homey-compose, pairing improvements)
* **Sven Serlier (smarthomesvan)** - Cloud API research, Legacy device improvements
* **Community contributors** - Bug reports and feature requests

## 🔗 Links

* [GitHub Repository](https://github.com/jtebbens/com.homewizard)
* [Homey App Store](https://homey.app/a/com.homewizard/)
* [HomeWizard Official Site](https://www.homewizard.com/)
