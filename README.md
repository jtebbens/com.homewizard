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

## 📝 Latest Updates (v3.15.5)

### Battery Policy — PV Forecast & Planning

* **Solcast integration** - Satellite-based PV forecast (30-min resolution) blended with Open-Meteo weather model. Optional, requires Solcast API key and resource ID in settings. Lazy-loaded; cached across restarts
* **Blend log split by day** - `[PV blend]` log now shows today and tomorrow separately, making it easy to verify forecast accuracy per day
* **Self-sufficiency tracking** - Daily grid import vs. house consumption accumulated in real time (15 s poll). Persisted to settings across restarts; visible in battery expansion analysis
* **SoC plan snapshot** - Planned SoC per slot stored on first computation, never overwritten. Enables frontend to show "planned vs. actual" SoC for past slots
* **currentPrice fix** - Widget/settings were showing the first slot (which could be in the past); now correctly uses the first future slot
* **Consumption margin** - Optimizer assumes 20% higher consumption than learned average while evening patterns are still building up
* **`_recomputeOptimizer` made async** - Required for Solcast API calls inside the optimizer path

### Polling & Connectivity

* **Plugin battery polling floor** - Polling interval now enforced to minimum 5 seconds (`Math.max(..., 5)`) in all three code paths (startup, settings change, interval restart); settings UI also enforces `min: 5`
* **SDM230 backoff on failure** - After 3 consecutive poll failures the SDM230 slows to a 60 s backoff interval. Automatically restores normal interval on next successful poll
* **Cloud WebSocket race condition fix** - `mainWs` was assigned before the socket was ready; a concurrent reconnect could replace it mid-handshake, leaving stale event listeners firing on the wrong socket. Fixed by using a local `ws` variable for all event listeners, with a guard (`if (this.mainWs !== ws) return`) that silently drops events from superseded sockets. Also removed the redundant double-open guard that was papering over the root cause

### Battery Policy — Previous (v3.15.3)

### Battery Policy — Multi-Battery Discharge Fix

* **Discharge power capped at 800 W** - HW firmware limits discharge (`max_production_w`) to 800 W regardless of battery count (charge scales linearly, discharge does not). The fallback calculation incorrectly assumed `unitCount × 800 W`, causing 3-battery setups to report "capaciteit: 2400W" in explainability text while actual discharge was locked at 800 W. Fixed in policy-engine, explainability-engine, and device `_getBatteryState()` fallback
* **WebSocket capability guard** - `max_consumption_w` and `max_production_w` are now only updated when actually present in the WS payload (`typeof === 'number'`). Previously, missing fields were written as `0`, which caused the `??` fallback to pass through `0` instead of triggering the corrected 800 W fallback
* **Confidence rounding** - Learning-adjusted confidence now uses `Math.round()` after adjustment, preventing 14-decimal-place values (e.g. `99.33326922747905`) in timeline entries and flow tokens

### Battery Policy — Learning Engine

* **15-minute consumption resolution** - Consumption patterns upgraded from hourly (7 × 24 = 168 slots) to 15-minute (7 × 24 × 4 = 672 slots). Includes automatic migration from old hourly format, spreading existing averages evenly across quarter slots
* **Amsterdam timezone fix** - All consumption recording now uses `_getAmsterdamTime()` (via `toLocaleString` with `Europe/Amsterdam` timezone) instead of `getHours()` which returns UTC on Homey. One-time reset migration clears old UTC-indexed data; re-learning takes ~24–48h
* **Daily profile export** - New `getDailyProfile(dayOfWeek)` method returns 96 slots with predicted wattage, enabling per-day consumption charts in the settings UI

### Battery Policy — Expansion Analysis (new)

* **What-if battery comparison** - New `computeExpectedProfit()` method on OptimizationEngine runs the DP for 1–4 battery scenarios without modifying the live schedule. Shows marginal daily/yearly profit per additional battery, power bottleneck slots where house consumption exceeds discharge capacity, and payback period based on configurable investment cost
* **Settings tab "Uitbreiding"** - New tab visualises expansion scenarios with per-unit profit cards, shortfall indicators, and user-adjustable battery price input

### Battery Policy — Consumption Profile Chart (new)

* **Learned consumption chart** - New chart in the planning tab renders the learned 15-min consumption profile per day-of-week. Features day selector (Ma–Zo), peak detection with top-3 labels, colour-coded bars (green → yellow → red), and current-slot highlight. Updates hourly via `policy_consumption_profile` setting

### Optimizer Engine — Refactoring

* **Pure DP kernel** - Backward induction extracted into `_runBackwardDP()` — a fully side-effect-free method returning `{dp, policy, ...}`. Forward pass remains in `compute()`. Enables `computeExpectedProfit()` to reuse the same DP logic without touching `_schedule`
* **Projected profit tracking** - `_schedule` now includes `projectedProfit` (€) from the DP value function at current SoC, used by expansion analysis

---

## Previous Updates (v3.14.29+)

### Battery Policy — Optimizer & Scheduling

* **DP discharge allowed during PV hours** - Removed the `pvCoverage > 0.5` discharge block from the optimizer's backward induction. During delay-charge hours the battery correctly discharges to cover house load while PV exports to the grid; the old block suppressed this and left ~1 kWh/day of discharge revenue uncollected (battery entered the solar morning at 30–40% SoC instead of min_soc). The `minDischargePrice` floor already prevents irrational low-price PV-hour discharge
* **Slot-boundary alignment** - Policy check interval now aligns to the next UTC 15-minute boundary (`:00`, `:15`, `:30`, `:45`) on startup instead of running at an arbitrary offset. Without alignment the interval drifted ~11 min into each EPEX slot, leaving only ~4 min of discharge per slot

### Battery Policy — PV Detection

* **Virtual grid power fix** - `virtualGridPower = gridPower − batteryPower` is now always applied (both when charging and discharging). The old code used raw `gridPower` when discharging, causing battery over-discharge (e.g. −337 W) to create apparent grid export (−220 W) and falsely trigger PV-ON at 06:51 before sunrise
* **PeakTiming PV free-cycle bypass** - PeakTiming discharge suppression is now skipped when `pvKwhRemaining ≥ storedKwh`. When remaining PV today can cover what's currently stored, recharging is free and the RTE cost threshold is irrelevant. Re-engages in the evening when PV is nearly exhausted. Prevents the battery from staying half-full all morning because PeakTiming assumed grid recharge cost

---

## Previous Updates (v3.14.24+)

### Battery Policy — Planning & Optimizer

* **Discharge SoC projection now consumption-aware** - `zero_discharge_only` keeps grid at ~0W by matching discharge to actual house consumption (variable 0–800W), not fixed max discharge power. Planning chart SoC curve now reflects real depletion speed based on learned consumption per slot
* **Discharge floor consistent between DP and display** - Optimizer now enforces `min_discharge_price` as a hard constraint in backward induction; eliminates the bug where planning showed "standby" but SoC dropped (DP had internally discharged below the threshold)
* **Opportunistic discharge in dynamic mode** - When `respect_minmax` is disabled, the DP uses `opportunistic_discharge_floor` (default €0.20) instead of `min_discharge_price`, consistent with the policy engine's opportunistic logic. Planning display matches
* **Pre-peak urgent charging** - When an expensive hour is ≤30 min away and SoC is below target, policy switches to `to_full` even when PV is producing (≥400W), ensuring the battery fills in time

### Battery Policy — Weather & PV

* **Lat/lon location fields** - Weather location now uses separate latitude/longitude number fields instead of a city name text field. Existing city names are automatically migrated on first startup
* **Forecast blending** - New weather fetch is blended with the previous cache (α=0.6) to smooth sudden Open-Meteo model-run jumps; prevents PV forecast from jumping between runs
* **Weather refresh interval** - Cache refresh now uses the existing `weather_update_interval` setting (default 3h, min 1h) instead of a hardcoded 3-hour interval

### Battery Policy — Scoring

* **PV overschot score rebalanced** - Score reduced from +1000 to +250 to keep all scores in the readable 20–300 range; still dominates preserve but no longer produces scores like 1170

### Bug Fixes

* **`battery_group_charge_mode` capability missing** - Self-healing guard added: if the capability is absent when a battery event arrives, it is re-added before `setCapabilityValue()` is called, preventing repeated "Invalid Capability" errors
* **BaseloadMonitor false oscillation** - `_detectOscillation()` now trims 1 outlier from each end before computing the range; a single bad sample from battery mode-transition measurement lag no longer invalidates an otherwise clean night
* **BaseloadMonitor energy_v2** - Battery power sourced from `plugin_battery` (accurate) instead of the P1 `payload.power_w` field (unreliable when firmware doesn't report battery state)
* **Settings crash on PV/weather change** - `homey.settings.unset()` is synchronous; removed erroneous `.catch()` call that crashed when settings were changed

---

## Previous Updates (v3.14.19)

### Battery Policy — Planning & Intelligence

* **Single source of truth** - Planning view now reads directly from the optimizer schedule; no duplicate policy logic in the frontend
* **Accurate SoC projection** - Forward pass now reflects PV-assisted charging during preserve slots (firmware runs zero_charge_only when PV is available)
* **Solar yield learning** - Per-slot yield factors (W per W/m²) learned from actual PV measurements, absorbing panel capacity, orientation, PR and shading into one number. Approach inspired by de Gruijter's app
* **Weekend/weekday consumption patterns** - Learning engine distinguishes weekday vs weekend consumption; falls back to group average until enough per-day samples accumulate
* **Consumption-aware planning** - Optimizer uses learned consumption forecasts per slot; discharge offsetting local consumption is valued at full retail price vs 30% for export
* **Battery cycle cost** - Configurable degradation cost (€/kWh discharged); optimizer only cycles the battery when the price spread exceeds the cycle cost, preventing unprofitable small arbitrage rounds

---

## Previous Updates (v3.14.0)

### Battery Policy — 15-Minute Pricing

* **15-min price granularity** - Policy decisions now use the actual 15-minute spot price instead of the hourly average, enabling more precise charge/discharge timing during short price dips or peaks
* **Optimizer on 15-min slots** - The 24h dynamic-programming scheduler now plans across 96 slots (15-min) instead of 24 hourly slots, making it possible to exploit short cheap windows (e.g. wind surplus at night)

### Battery Policy — Explainability

* **Reasons match the winning mode** - Decision reasons are now filtered to only show why the actual recommendation was made; conflicting reasons from other modes no longer appear
* **Mapping explanation** - When scoring favours charging but conditions prevent it (price above ceiling, no PV), a prominent notice now explains the gap: *"Laden wint (score 140) maar prijs €0.26 > max laadprijs €0.14 → Standby: wacht op betere conditie"*
* **Battery very low reason** - SoC between 1–10% now correctly shows "Batterij erg laag — laden aanbevolen" instead of "normaal bereik"
* **Zero mode threshold** - Explainability engine now mirrors policy engine exactly: respects `min_soc = 0` without a hardcoded 1% floor

### Bug Fixes

* **Weather forecast timezone** - Fixed 1-hour offset caused by `timezone: auto` + appending Z; now uses `timezone: UTC`
* **Sunshine duration ensemble** - Fixed all-zero sunshine when using multi-model Open-Meteo requests (`models=` parameter causes model-specific key names like `sunshine_duration_ecmwf_ifs04`; plain key absent)
* **Planning SoC projection** - Fixed all hours showing standby due to early return `if (soc < minSoc) return 'standby'` in planning display; radiation-based PV formula corrected (`pvCapW × radiation/1000` instead of `maxChgW × factor`)
* **ZERO MODE threshold** - Policy engine and explainability now both respect user's `min_soc` setting; removed hardcoded 5% / 1% floors

### Technical

* **36-hour forecast horizon** - Weather forecaster extended from 24h to 36h to always cover tonight + full tomorrow even when run in the evening
* **SunMultiSource removed** - Replaced with WeatherForecaster ensemble (3-model average); next-4h radiation used for PV estimation

---

## Previous Updates (v3.13.68)

### Battery Policy

* **OptimizationEngine** - New dynamic-programming scheduler that computes the optimal charge/discharge schedule across the full 24-hour price horizon. The policy engine now has genuine lookahead instead of relying purely on heuristics, improving decisions around when to charge cheap and discharge at peak.
* **Explainability color coding** - Policy decision reasons now show color-coded tags with relative weights, making it easier to understand what drove the recommendation.

### Bug Fixes

* **Planning solar charge** - Fixed planning page incorrectly showing solar charge in the evening/night hours
* **Incorrect PV charge at night** - Fixed battery policy charging from grid during nighttime when PV flag was incorrectly set

### Technical

* **WebSocket throttle configurable** - `energy_v2` WebSocket measurement throttle is now adjustable in device settings (default 2s)
* **WebSocket logging** - Improved WebSocket connection tracking and diagnostics in the settings page

---

## Previous Updates (v3.13.58)

### Bug Fixes

* **Baseload Negative Values** - Fixed `BaseloadMonitor._fallback()` including negative power samples in bottom-10% calculation, which caused the baseload (sluipverbruik) to report negative values; now filters to `p >= 0 && p < 1000 W` (consistent with `_computeSmartBaseload`)
* **Baseload Battery Correction** - Fixed `updatePower()` only correcting for battery discharge (`batteryPower < 0`) but not for charging; now applies `householdPower = gridPower − batteryPower` for both directions; result clamped to 0 to prevent negative household consumption from rounding/timing mismatches
* **RTE Learning — Counter Reset Bug** - Fixed efficiency estimator resetting both charge and discharge counters when measured RTE < 0.50; a low ratio simply means the cycle is not complete yet (not enough discharge accumulated relative to charge); counters now preserved and continue accumulating; only reset on confirmed measurement error (RTE > 0.85) or stale counters (> 10 kWh either side)
* **RTE Learning — SoC Null Guard** - Fixed `soc <= 5` orphan-clear guard in `EfficiencyEstimator` firing on every charge start because `null <= 5` is `true` in JavaScript; guard now requires `typeof soc === 'number'`
* **RTE Learning — Wrong SoC Source** - Fixed `battery-policy/device.js` reading `measure_battery` capability (does not exist on the policy device → always `null`) instead of the `soc` variable already resolved from `battery_group_average_soc` on the P1 device
* **Battery Policy bugs** - Fixed Recommended mode text to active mode, leftover battery SoC in morning to discharge. Fix for `to_full` when PV is not enough to charge battery but the market prices are at their lowest (zero_change_only vs to_full)
* **Ratelimit on flowcards in energy (apiv2)** - Ratelimit to avoid action flowcard to execute every second crippling the application and make it cpu/memory crash
* **Energy socket connectivity** - Improve connectivity when there is poor wifi (10s timeouts, was 5s) and retry logic

### Technical

* **WebSocket slow_handler threshold** raised from 100 ms to 250 ms to better reflect ARM CPU reality on Homey; journal entries throttled to once per handler per 5 minutes to prevent log noise
* **WebSocket preflight_fail** journal events throttled to once per 10 minutes via `_journalThrottled()`; log output still emitted on every failure for debugging
* **Settings page copy button** — `navigator.clipboard.writeText()` silently fails inside Homey's sandboxed iframe; now always uses `textarea + execCommand('copy')` as primary path; if that also fails a selectable textarea is shown as manual fallback

---

## Previous Updates (v3.13.49)

### New Features

* **Active Mode Capability** - New `active_mode` capability shows the battery mode actually active on the hardware, which may differ from `recommended_mode` when confidence is below threshold, auto-apply is off, or a manual override is active
* **New Policy Modes** - Added `Fixed Pricing` and `Dynamic Pricing (V2)` options to the policy mode picker
* **Global Error Handlers** - App now catches unhandled promise rejections, uncaught exceptions, and Node.js process warnings (MaxListenersExceededWarning etc.) for better crash diagnostics

### Bug Fixes

* **Coverage Ratio Calculation** - Fixed inverted battery coverage ratio: a 1751 W load with 800 W max now correctly reports 46% coverage instead of 100%
* **Multi-Unit Battery Power** - Max discharge/charge fallback now scales with battery group size (2.7 kWh/unit × 800 W/unit) instead of hardcoding 800 W regardless of how many units are installed
* **PV Virtual Grid Calculation** - Fixed virtual grid calculation: battery charging power is now subtracted (not added) to correctly show true export potential when evaluating PV decisions
* **WebSocket Null Guards** - Fixed crashes when `ws._events` is accessed after the socket is already cleaned up; `removeAllListeners` and event dispatch now guard against null `ws` reference
* **Cost Model Reset** - Battery cost model now resets at or below `min_soc` even when firmware cuts discharge power to 0 W (no longer waits for `isDischarging` to be true)
* **Sensor/History Overflow** - `LearningEngine` now uses exponential moving average (alpha=0.01) after 100 samples per slot, preventing `sum` and `count` from growing unboundedly over years

### Performance (CPU)

* **WebSocket Throttle** - Measurements now processed immediately on receive with a 2 s throttle, replacing the previous fixed polling interval; system/battery topics reduced to 30 s (was 10 s)
* **energy_v2 Tiered Updates** - Capability updates split into realtime / 10 s / 30 s / 60 s tiers; voltage, current, and frequency no longer updated on every WebSocket message
* **energy_v2 Battery Group** - Battery group interval reduced from 10 s to 60 s
* **energy_v2 Flow Triggers** - `energy_import_kwh` flow trigger rate-limited to 60 s (was 5 s), preventing 12 triggers/min per device
* **energy_socket Polling** - Minimum poll interval raised to 30 s (was 2 s); startup offset staggered 5–35 s; TCP keep-alive extended to 35 s to match interval
* **plugin_battery Startup Stagger** - First poll staggered 0–30 s per device to prevent 3 simultaneous TLS handshakes at startup
* **plugin_battery Battery Group** - Battery group interval reduced from 10 s to 60 s
* **plugin_battery Capability Batching** - All capability updates in `_handleMeasurement` are now batched with `Promise.allSettled` (non-blocking) instead of sequential `await`
* **Baseload Throttle** - `BaseloadMonitor._processNightSample` stores at most 1 sample per 30 s; `_detectNearZeroLong` is now time-based instead of sample-count-based; night history downsampled to 30 s resolution on save
* **Battery Policy P1 Polling** - P1 capability polling interval increased from 5 s to 15 s

### Technical

* WebSocket internals refactored; debug and runtime statistics are now surfaced in the settings page for improved diagnostics
* `onUninit` / `onDeleted` split across all drivers (`energy_v2`, `energy_socket`, `plugin_battery`, `cloud_p1`, `battery-policy`): timers/intervals cleaned up on both app stops and explicit device deletion; baseload deregistration and settings wipe only on deletion
* `__deleted` guard added to `onPoll`, `_fallbackPoll`, `_updateBatteryGroup`, and `_handleMeasurement` to prevent errors after uninit
* PV state detection uses separate hysteresis thresholds for ON (−200 W) vs OFF (−150 W) to prevent bouncing; grid range widened to −150…+250 W when already in PV state
* `active_mode` updated after every policy run to reflect the actual `battery_group_charge_mode` capability value from the P1 device; `battery_policy_state.currentMode` patched to match for accurate SoC projection
* RTE learning bounds enforced (50–85%); values outside this range fall back to the configured setting and trigger an estimator reset; learning threshold lowered to 1.0 kWh per side (was 2.5 kWh) for faster convergence
* `EfficiencyEstimator.reset(eff)` method added
* Explainability engine: soc=0 reason now mirrors policy-engine export-wins analysis; arbitrage reason now shows when price is above break-even but blocked by `min_discharge_price`; PV surplus reason mirrors PV OVERSCHOT opportunity-cost logic
* Coverage ratio formula corrected to `min(maxDischarge / load, 1.0)` in `PolicyEngine`, `_applyPeakShavingRules`, and `ExplainabilityEngine`
* Battery group max power fallback derived from `battery_group_total_capacity_kwh` in device, policy engine, and explainability engine

---

## Previous Updates (v3.13.37)

### Bug Fixes

* **Battery Policy PV Detection** - Fixed incorrect grid charging during active PV production
* **WebSocket Stability** - Improved reconnection logic and error handling for energy_v2 and plugin_battery drivers

### Technical

* Policy engine mapping logic now respects sticky PV detection state set by `_applyPVReality()`
* PV detection includes `pvEstimate` as additional indicator alongside grid export and battery power
* Improved logging shows virtual grid power breakdown for better debugging
* Enhanced WebSocket connection resilience during network fluctuations

---

## Previous Updates (v3.13.28)

### New Features

* **Manual IP Override** - Repair flow for devices when mDNS discovery fails (VLAN/UniFi/mesh Wi-Fi issues)
* **Battery-Aware Baseload** - Excludes battery discharge from grid power for accurate standby consumption
* **Smart Filtering** - Automatically filters EV charging and heat pump cycles from baseload calculation
* **Dynamic Sunrise/Sunset** - Battery discharge windows adapt to seasonal changes (sunset-based timing)
* **Weather-Aware Discharge** - Battery policy uses tomorrow's solar forecast for intelligent discharge decisions
* **Monthly Cost Display** - Settings page shows estimated baseload costs with real-time pricing

### Improvements

* Discovery error messages now guide users with mDNS troubleshooting steps (EN/NL)
* Baseload monitor uses median of lowest 50% samples for robust calculation
* Settings page displays visual ML score progress bars
* Explainability engine shows weather-aware reasoning with dynamic time windows
* General UI and logging refinements for clarity and consistency
* Pre charge only when it's profitable
* Planning update when min max prices are changed by user affecting decisions

### Technical

* Manual IP support for both P1 Meter (v1) and P1 Meter (apiv2) drivers
* Discovery events properly ignored when manual IP is configured
* Fixed €0.25 estimate for baseload costs to prevent API overload from 15k users
* Internal refactoring improves stability, caching behavior, and driver initialization

---

## Previous Updates (v3.13.14)

* Battery Policy driver with ML-based charging optimization
* Trigger cards for energy grid errors, voltage swells, voltage sags, and restoration events
* Learning engine for consumption patterns and PV accuracy tracking
* Plugin Battery state of charge icon for dashboard

### Improvements

* Homewizard Legacy Device updates (CSS, flow and language) - thanks smarthomesvan
* P1 meters can now connect via HomeWizard cloud API (thanks to Sven Serlier's research)
* Watermeter cloud support (4x daily updates via hwenergy)
* P1 (apiv2) tariff trigger improvements

### Bug Fixes

* Fixed capability_already_exists error (cloud_p1)

---

## 📖 Full Changelog

<details>
<summary>Click to expand complete version history</summary>

### v3.12.9

* Plugin battery charge mode selectable from UI
* Energy (apiv2) guard for add/remove "battery_group_charge_mode"

### v3.12.7

* P1 tuning TIMEOUT & Unreachable
* Removed pollingActive (unwanted side effect)

### v3.12.4

* Baseload ignore return power (compensate battery return to grid datapoints)
* Plugin Battery LED brightness adjustment (user request)
* Bug fix: Battery Group (SoC missed when there are fetch errors)
* Bug fix: Polling deadlock fix for (energy, energy_socket, SDM230, SDM630, watermeter)
* Energy socket setAvailable fix
* Bugfix: _cacheSet undefined

(Websocket & caching)

* Optimized external meters hash calculation (eliminates array.map() garbage collection pressure)
* Battery group settings now cached with 60-second refresh

Baseload / sluipverbruik

* Detection algorithms now run every 30 seconds instead of on every power sample
* Eliminates expensive array scans during night hours

v3.11.9

* P1 energy modified to modular
* P1 energy_v2 modified to modular
* Heatlink additional code check on set target_temperature
* P1, changed order of processing, eletric first then gas/water
* P1 missed call in onPoll interval to reset daily calculation
* Bugfix: P1 (apiv2) polling mode - Charge mode fixes
* Bugfix: Group Battery State of Charge (increased timestamp check)
* Realtime pull from all batteries as fallback Battery Group State

v3.10.13

* Updated plugin battery mode names
* Added device name to debug messages
* SDM630 added per phase kwh meter tracking + daily kwh meter (estimate)
* More gas fix reset at night time (apiv1 and apiv2)
* Bugfix: incorrect daily reset during day of gas usage
* Bugfix: Energylink (watermeter) and Thermometer (battery)
NOTE: This is an estimate based on polling interval. If bad wifi or Homey can't reach the SDM630 the measured value will be lower than the actual data.

v3.10.7

* Bugfix: Homewizard Legacy fetch (tab was empty, no entries while there were errors in the log)
* Remove fetchQueue feature in favor of capture debug information in the app settings page
* Watermeter daily usage added
* Bugfix: Device Fetch Debug wasn't updating only showed "Loading..."
* Bugfix: Circular Reference "device"
* Bugfix: SDM230(p1mode) - updateCapability missed
* Finetune debug log (ignore message circuit_open)
* Energy_socket finetune, added a device queue as a replacement for the earlier centralized fetchQueue
* Homewizard adaptive polling + tuning timeouts
* Cleanup device drivers with overcomplicated checks that ended up with polling deadlocks
* SDM230(p1mode) - Extra code handling for TIMEOUT issues
* Daily gas usage reset improvement (nighttime sometimes misses when there is no gas value received)

v3.9.29

* Wsmanager optimize
* Homewizard legacy custom polling
* Driver.js (apiv2) log fix (this.log undefined)
* Thermometer rollback (name index matching doesnt work as expected)
* Homewizard legacy -> node-fetch and not the fetchQueue utility (bad user experience feedback)
* Baseload (sluipverbruik) improvement (fridge/freezer should not be flagged as invalid )
* Homewizard app setting page with log or debug information for discovery, fetch failures, websocket problems and baseload samples
* Bugfix: Homewizard.poll (legacy unit)
* Homewizard Legacy fetch debug added to same section under Application settings
* Heatlink Legacy improvement
* Homewizard Legacy Preset improvement (UI picker in Homey app)
* Using external gas meter (timestamp X) instead of administrative meter
* Thermometer trigger and condition cards for no response for X hours.
* Improvement fetchQueue (protect against high cpu warning for devices on 1s polling)

v3.9.20

* New Plugin Battery mode support (zero_charge_only & zero_discharge_only)
* Optional gas checkbox (default enabled) for P1 (apiv1 and apiv2). (User request)
* Added 15min power datapoint for Belgium (average_power_15m_w) P1(apiv2) (user request)
* Plugin Battery - Bugfix setMode for to_full (PUT)
* Updated SDM230_v2 and SDM630_v2 drivers
* Bugfix - Updated P1apiv2 check-battery-mode condition card
* Backward compatibilty fix for the new battery mode applied to older P1 firmware.
* Bugfix - Websocket payload battery mode adjustment
* Fixed: rare crash when _handleBatteries() ran after a device was deleted, causing Not Found: Device with ID … errors during setStoreValue.
* Phase overload notification setting added and a limiter to avoid notification flooding
* New Feature: Baseload (sluipverbruik) detection (experimental)
* Bugfix: energy_socket connection_error capability fix
* Bugfix: energy_v2 (handleBatteries) - device_not_found crash
* Bugfix: trigger cards for SDM230_v2
* APIv2 change pairing: Modified the username that is used during pair made it unique per homey
* Bugfix: APIv2 pairing -> local/homey_xxxxxx
* Bugfix: SDM630v2 trigger cards removed (obsolete as these are default Homey)
* Finetune: P1(apiv2) websocket + polling, capability updates
* Finetune: energy_sockets (fetch / timeout) centralized
* Refractor code update for P1apiv1, SDM230, SDM630, watermeter
* Customizable phase overload warning + reset
* Phase 1 /3 fix for P1(apiv1) after refractor code update
* Bugfix: Fallback url for SDM230v2 and P1apiv2 (mDNS fail workaround)
* Bugfix: pairing problem "Cannot read properties of undefined (reading 'log')
* Homewizard legacy, clear some old callback methods
* Finetune async/await updates

v3.8.22

* Finetune energy_v2 updates primary values are updated instant, other lesser values once every 10s
* Additional watchdog code to reconnect energy_v2 and plugin_battery upon firmware up/downgrades
* Websocket finetuning (energy_v2 and plugin battery)
* Centralized fetch queue for all fetch calls to spread all queries
* Removed interval check in onPoll loop
* Restore custom polling sockets (got removed by accident rollback)

v3.8.18

* Bugfix: Failed to recreate agent: TypeError: Assignment to constant variable (energy)
* Adjustment to async/await code several drivers

v3.8.16

* Updated APIv2 to add more text upon fetch failed
* Websocket based battery mode settings added (both condition and action)
* Websocket heartbeat (30s) to keep battery mode updated (workaround as battery mode is the only realtime update when it changes)
* P1 & EnergySocket driver (apiv1) http agent tuning (ETIMEOUT and ECONNRESET)

v3.8.13

* Extra error handling (updateCapability) based on received crashreports
* Bugfix: ReferenceError: err is not defined (energy_socket)

v3.8.11

* Rollback energy dongle code from earlier version v3.7.0
* Strange SD630 problem on older Homey's
* Extra verbose logging in urls to expose mDNS problems for older Homeys (url)

v3.8.8

* After attempting conditional fetch, roll back to node-fetch until 12.9.x releases (Homey Pro 2016 - 2019)
* Bugfix: SDM230-p1mode - error during initialization

v3.7.9

* Extra check upon websocket creation to avoid crashes
* Plugin battery catch all error (unhandled exception)
* Additional checking and error handling on bad wifi connections (websocket based)
* (fix) Error: WebSocket is not open: readyState 0 (CONNECTING)
* Fetch was not defined for fetchWithTimeout function
* Missed net_frequency update, also made it 3 decimals
* Capability update fix (avoid removal check)

v3.7.1

* Trigger card for battery SoC Drift (triggers on expected vs actual State-of-charge)
* Trigger card for battery error (based on energy returned to grid while battery group should be charging)
* Trigger card for battery netfrequency out of range
* Icon update for various capabilities
* Battery group details added to P1apiv2. (Charging state)
* Realtime data for P1 (apiv2) via Websocket
* Realtime data for Plugin Battery via Websocket
* Bugfixes/crashes on P1 (apiv2) - no gas data on first poll / ignore
* Websocket reconnect code for covering wifi disconnect & terminate issues
* Plugin Battery group fix (tracking combined set of batteries) - bugfix / Refenece error
* Netfrequency capability added for Plugin Battery
* Homewizard Legacy - code rollback (pairing problems after improvements)
* P1 (apiv2) - Added checkbox setting to fallback to polling if websocket is to heavy for Homey device

v3.6.77

* Custom polling-interval option made for Homewizard Legacy unit (default 20s, when adjusted restart app to active it)
  To adjust setting check the main unit advanced settings
* Energy sockets with poor wifi connection will have 3 attempts now
* Fallback url for P1 mode SDM230 / SDM630

v3.6.75

* Thermometer (Homewizard Legacy) - full code refractoring
* Homewizard Legacy doesnt support keep-alive, changed back to normal fetch / retry
* Finetune code keepAlive for other devices 10s
* Bugfix: number_of_phases setting incorrectly updated
* Added verbose mDNS discovery results for troubleshooting

v3.6.73

* More try/catch code to avoid any crashes on Homewizard Legacy main unit getStatus fail (Device not found)
* Fine tune "estimated kwh" plugin battery calculation based on user feedback
* Code fixes: unhandledRejections CloudOn/Off for sockets and P1

v3.6.71

* Finetuning polling and capability during init phase of various drivers
* Added more logging to support diagnostic reports
* Bugfix SDM230 solar parameter was undefined
* Added an estimate charge available in plugin battery value
* Extra code checking for Homewizard Legacy (getStatus function) when there is a connection failure/device not found

v3.6.67

* Enforcing interval clears on various devices when interval is reset
* try_authorize handler bugfix (interval / timeout) app crash logs

v3.6.66

* Fall back url setting upon initial poll for P1, sockets, kwh's, watermeter. (older Homey Pro;s 2016/2019 seems to struggle with mDNS updates)
* Removed retry code for Homewizard legacy devices (changed to keeping http agent session open / keepAlive)
* Battery Group data removed from P1 after a fetch fail (bugfix)
* Increased timeouts (authorize / pairing APIv2)
* Language adjustment P1 warning (overload EN/NL)
NOTE: First time running this version will fail as the url setting is empty so it should improve onwards.

v3.6.63

* SDM230 (p1 mode added)
* P1apiv2 - added daily usage kwh (resets at nightime) (does not cater for directly consumed solar-used energy as this does not pass the smart meter at all)
* Adjustment for P1 to look at Amp datapoints to detect 3-Phased devices in Norway
* HTTP - keepalive agent added to P1, sockets, APIv2 devices
* KeepAlive timeout increased from default 1000ms
* AbortController code added for APiv2
* Wifi quality capability added (-48dBm is not always clear to users if it is good or bad)
* Bugfix: P1, missed setAvailable(). Code didn’t recover from a failed P1 connection and kept P1 offline

v3.6.58

* Bugfix that was caused by experimental firmware Homey 12.5.2RC3 and slider capability that could not be removed
* Added energy flags for sockets so they can trace imported/exported energy in Homey Energy Dashboard (Home Batteries connected via sockets)
* Code cleanup
* Added some fine tuning to spread the API call's to the P1

v3.6.50

* Added phase monitoring
* Adjust settings to align with your energy grid
* Bugfix for sliders when gridconnection has 3 phases
* Actual gas meter measurement added (5min poll pending on smartmeter)
* P1apiv1 - Code refactored (clean up repetive lines)
* Extra plugin battery trigger cards (state change, time to full, time to empty)
* Removed sliders in GUI to show grid load per phases

v3.6.40

* Cloud connection setting made available for P1, Sockets, Watermeter, SDM230, SDM630
* Bugfix Offset watermeter (Cannot read properties of undefined - reading 'offset_water')

v3.6.38

* P1(apiv2) gas meter bugfixes
* P1(apiv2) aggregated total usage added (support for PowerByTheHour app)
* Custom polling for Watermeter, SDM230, SDM630 and SDM630-p1 mode, Default 10s, adjust in advanced settings
* Action cards plugin battery - P1apiv2 device is required (P1 firmware version 6.0201 or higher)
* Wifi metric (dBm) added for P1(apiv2) and Plugin Battery
* Custom Polling interval added for Plugin Battery
* Daily usage imported power and gas (P1apiv1) - User request
* Plugin Battery: added time_to_empty and time_to_full (minutes)
* Trigger for battery mode change

v3.6.6

* Homey Energy - Polling interval for all Energy devices (P1, kwh etc.) lowered to 1s (was 10s)
* Reverted interval back 10s as this has an increased load on some wifi networks and (older) homeys (Early2019)

v3.6.2

* Massive code rework (credits to DCSBL for time and effort)
* Homey Energy dashhboard: Energylink meter_gas capability added
* Text fix in Plugin Battery driver
* APIv2 timer timeout problem

v3.5.5

* Recode P1 APIv2, improved pairing process (DCSBL)
* Pairing process P1 and Plugin Battery aligned
* Plugin in Battery pairing text fix

v3.5.2

* SDM630 clone added to allow P1 like use of kwh meter as a replacement for P1 dongle (users request)

### v3.5.1

* Conversion to homey-compose (DCSBL)
* Socket identification with LED blink (DCSBL)

</details>

---

## 💝 Support This Project

If you find this app useful, consider supporting development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)

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
