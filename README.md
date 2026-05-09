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

## 📝 Latest Updates (v3.15.59–v3.15.62)

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
