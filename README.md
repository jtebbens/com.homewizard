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

## 📝 Latest Updates (v3.15.63–v3.19.1)

### Battery Now Charges Ahead of a Profitable Peak on Sunny Days (v3.19.1)

* **Fixed the planner refusing to buy cheap power before an expensive evening, on any day solar was expected to refill the battery.** When enough sun is forecast, the planner treats every battery level as equally good, reasoning that solar will top the pack up regardless of where it starts. That shortcut is what lets the battery discharge freely overnight instead of hoarding for a single best hour — but it also erased the value of being fuller, so buying cheap power before a pricey evening scored no better than doing nothing, and the battery simply sat there. Seen live on 31 August: the battery held at 67% while power cost €0.13 and that evening's peak paid €0.38, well clear of the wear cost of a charge/discharge cycle. The planner now keeps the value of a fuller battery intact whenever the price gap ahead beats that wear cost, and falls back on the shortcut the rest of the time. Replaying 53 recorded planning runs both ways, the change was better on 14 of the 15 where it made any difference (one was worse by €0.0006). Nothing to set — it is on by default; whether a real difference between battery levels may be ignored is a matter of the planner being right, not a preference.

### PV Curtailment Trigger No Longer Fires With the Setting Off (v3.19.1)

* **Fixed the "PV curtailment target changed" flow trigger firing even when the "Enable PV curtailment" setting was left off.** That setting exists so the app only asks your inverter to throttle solar production if you actually have a flow set up to act on it — leave it off and the app is supposed to never send that request. But the trigger card only checked whether exporting had gone negative-value (worth less than nothing), not whether you had turned the setting on. Under standard net metering this never showed up, because export can't go negative there. It became visible once export pricing that can turn negative was in use: the trigger fired, and any flow already listening on it acted on a request the setting said was off. The capability that shows the calculated target still updates regardless of the setting — that part is just for checking the number — but the trigger itself now only fires when the setting is switched on.

### New Setting: Weigh a Weak Solar Surplus Against Exporting (v3.19.1, off by default)

* **Added a setting that lets the planner decide what to do with a small solar surplus, instead of always exporting it.** When solar produces only a little more than the house uses — roughly under 400 W — the planner treats staying idle and holding the battery as the same thing and never asks whether storing that surplus would be worth more than sending it to the grid. The new "Weigh weak solar surplus against export" setting makes it ask. It ships **off**: while net metering applies, exported energy is credited at the full slot price, so exporting a weak surplus is worth more than storing it (storing loses round-trip efficiency and battery wear). The setting exists for when net metering ends and export is paid less than consumption, and for anyone who prefers to bank every kilowatt-hour. Turning it on does not change what the battery earns on a normal sunny day: strong-sun behaviour is untouched.

### Battery No Longer Stops Discharging While Prices Are Still High (v3.19.1)

* **Fixed a near-empty battery going idle at a profitable price whenever a little solar was forecast.** When the planner compared "stay idle and let solar export" against "keep discharging", it credited the export revenue to the idle option only. In reality the battery does not give that revenue up by discharging: it covers the house load while solar exports the surplus at the same time, so the revenue is earned either way. Counting it on one side made idling look better than it was. The error was small in absolute terms, so it only tipped the decision when there was little left to discharge — which is exactly why it showed up on a nearly empty battery, leaving it parked at 1–3% while prices were still well above the discharge threshold. Both options are now valued on what actually distinguishes them. Behaviour at negative prices is unchanged.

### Dynamic Prices Now Come From Power by the Hour (v3.19.1)

* **Replaced the built-in price scrapers with the Power by the Hour app as the price source.** Dynamic prices used to be fetched by two scrapers maintained inside this app, which broke whenever a supplier changed their website. Instead, the app now reads the day-ahead prices from a device in the Power by the Hour app (`com.gruijter.powerhour`) — select which device to use in the battery policy settings. That app already supports a long list of suppliers and keeps them working, including quarter-hourly prices where the supplier publishes them. If those prices are unavailable for any reason, the app falls back to ENTSO-E day-ahead data as before, so planning keeps running. One thing worth checking after updating: the import markup is configured in both apps, and the price the planner uses comes from Power by the Hour. If the two don't match, the prices shown in the charts won't line up with the ones the battery plans on. Power by the Hour shows the markup including VAT; this app's "Import Markup" setting expects it excluding VAT (divide by 1.21).

### Elapsed Hours and the Current Hour Now Priced Correctly (v3.19.1)

* **Fixed today's earlier hours disappearing from the price chart, and the current hour's price being slightly off.** The new price source only serves slots from now onwards, which caused two problems. First, the hours that had already passed today vanished from the price table after a refresh and stayed gone until midnight, leaving the chart starting halfway through the day. Those hours are now filled in from the ENTSO-E data, which covers whole days. Second, the hour currently in progress was averaged over only the quarter-hours still remaining in it rather than all four, so its price could read a few cents too high or too low depending on how the hour was shaped. The complete average is now used. Neither issue affected the battery's decisions — those are made on quarter-hourly prices and on hours still ahead — but both were visible in the chart.

### Evening Safety Check No Longer Blocks Waiting for Cheaper Solar (v3.19.1)

* **Fixed the planner buying from the grid instead of waiting for solar that was still coming, on batteries smaller than an evening's consumption.** When the plan sees cheaper solar ahead it can defer a grid charge, and a safety check is supposed to override that whenever waiting would leave too little in the battery for the evening. That check compared what the battery can hold against the full learned evening consumption — so on any battery too small to cover a whole evening on its own, it was true no matter what, and the deferral was cancelled every single time. Measured over 24 real planning runs: 198 deferrals attempted, 182 overruled. The check now asks whether the remaining solar still fills the battery, which is the question it was meant to ask.

### Correct Total Current on Three-Phase P1 Meters (v3.19.1)

* **Fixed the total current reading showing the L1 phase value instead of the actual total on three-phase installations.** The `measure_current` capability simply mirrored phase 1, so on a three-phase meter it under-reported whenever the load wasn't evenly spread. It now uses the meter's own total-current reading, falling back to adding up the three phases when the meter doesn't publish a total. Single-phase installations were never affected.

### Water Meter Daily Total Now Resets at Local Midnight (v3.19.1)

* **Fixed the daily water total rolling over at 2:00 in the morning instead of midnight during summer time.** The reset compared dates in UTC rather than local time, so the "today" total kept counting for the first two hours of each new day (one hour in winter). It now uses the Amsterdam local date.

### Tomorrow's Plan No Longer Falls Back to Flat Hourly Prices (v3.19.1)

* **Fixed the battery planning tomorrow on averaged hourly prices instead of the real quarter-hourly ones.** Once the hourly price table ran through the end of tomorrow, the app treated its price data as complete and stopped fetching for the rest of the day. But a complete hourly table says nothing about the quarter-hourly one: on days where hourly prices for tomorrow arrived first and quarter-hourly prices were only published later in the afternoon, the app never went back for them. Tomorrow then stayed on four identical prices per hour until midnight, hiding exactly the within-the-hour price differences the planner uses to pick charge and discharge moments. Price refreshes now check the quarter-hourly horizon as well, and re-open a fetch when it stops short — at most once an hour, so this adds no meaningful load. Setups running on hourly prices are unaffected. Separately, quarter-hourly prices from the ENTSO-E fallback source are now kept across an app restart instead of being dropped and re-fetched.

### Simplified PV Forecast Source Setting (v3.19.0)

* **Replaced three overlapping checkboxes with a single, clearer choice.** The settings page used to have separate toggles for "Use satellite in DP optimizer" and "Satellite replaces Solcast", plus a Solcast enable checkbox — with unwritten precedence rules deciding what happened when more than one was switched on. These are now one setting: blend Open-Meteo's forecast with nothing extra, with a satellite-based nowcast, or with Solcast. Only one secondary source can be active at a time, so there's no longer a hidden "which one wins" question. The satellite option no longer requires a Solcast account to use — previously the satellite blend only worked at all when Solcast was also configured, which wasn't intentional and just wasn't caught until now. Existing configurations are migrated automatically on the first restart after updating; nothing needs to be re-entered. Satellite nowcast images captured in the few minutes just before sunrise carry no usable signal but were previously blended in anyway, dragging the near-term PV forecast down to near-zero for the following, already-sunlit hour — those images are now ignored.

### Peak Shaving No Longer Silently Downgrades to Standby (v3.19.0)

* **Fixed peak shaving occasionally doing nothing when it should have discharged.** Peak shaving is meant to be a hard, price-blind safety cap that discharges the battery whenever grid import threatens to exceed your configured limit — but a shared internal profitability check could veto that discharge and drop it back to standby whenever the electricity price sat below your minimum discharge price, with nothing logged to explain why. Peak-shaving discharges now bypass that price check entirely, as intended; normal price-driven discharging is unaffected.

### Corrected Battery Discharge Floor Calculation (v3.19.0)

* **Fixed the minimum state of charge the planner protects near the end of a discharge window sometimes being computed from the wrong time slot.** The per-slot floor that keeps a reserve in the battery could end up flat, or based on the first slot of the forecast instead of the slot actually being planned, occasionally letting the plan aim closer to empty than intended.

### Corrected Battery Wear Cost in Store-vs-Export Decisions (v3.19.0)

* **Fixed the cost of battery wear (charge/discharge cycling) not being weighed in some cases when deciding whether to store surplus solar or export it.** The same decision made through the low-PV "trickle" path used a separate piece of code that had been missed the first time this was fixed. Both now consistently account for cycle cost, so the plan no longer stores PV in the battery when exporting it would actually have been more profitable.

### Fixed an Underestimate in Learned Standby Consumption (v3.19.0)

* **Fixed nights that were only partially measured (for example due to a restart) being able to win selection as one of the "lowest consumption" reference nights used to learn your household's standby power.** A partial night's total looks artificially low, so it could pull the learned baseline down and understate your real overnight consumption. Incomplete nights are now excluded from that selection.

### Corrected a Timezone Bug in a Dynamic Price Window (v3.19.0)

* **Fixed a price-release time window that was reading the clock in local time on a server that actually runs in UTC, shifting the window two hours later than intended in winter (one hour in summer).** Also stopped the price fetcher from unnecessarily re-downloading and re-parsing the full day-ahead price page on every policy run when the cached prices already covered the full stretch through tomorrow.

### CDP Debug Inspector Off by Default (v3.19.0)

* **Closed a debug-only network listener that could be left open unintentionally.** A Chrome DevTools inspector port used for live performance profiling during development now stays off unless explicitly enabled by a developer-only flag.

### Reduced Background Memory Usage (v3.19.0)

* **Moved several large internal buffers (PV accuracy samples, debug logs, price-provider caches) out of the app's settings storage and into local files.** Every settings write ships the app's entire settings data over an internal channel, so unrelated data sitting in that storage was being re-sent on every single write regardless of what actually changed. This measurably reduced background memory and CPU use, and lowers the chance of hitting Homey's memory-warning limit on setups with many HomeWizard devices.

### Battery Plan No Longer Collapses After a Charge-Rate Calibration (v3.17.11)

* **Fixed a case where the planner could get stuck aiming for a much lower state of charge than it should, after the battery briefly recalibrated its maximum charge rate.** Batteries occasionally report a temporary, very low charge-rate ceiling while calibrating internally. Normally this self-corrects within moments, but on some systems the reported value could stay stuck at that low figure for the rest of the day. Because the planner trusted that reported ceiling, it believed far less solar could be stored than actually could, and planned around a much emptier battery than necessary. The planner now always works from the battery's nominal charge capability instead of the moment-to-moment reported ceiling. That reported figure is only ever a planning input — the actual charge rate is enforced by the battery hardware itself — so a temporary calibration figure (or the natural tapering as the battery nears full) should never shape a forecast that spans a full day of charging and discharging. This closes the gap left by the earlier version of this fix, which could only recover once the battery was already charging hard enough to visibly contradict its own reported ceiling, and so did nothing while the battery sat idle.

### Corrected Payback and Profit Figures on the Expansion Tab (v3.17.11)

* **Fixed the payback figures on the expansion tab, which were several times too short for anyone running more than one battery.** The purchase price you enter is per battery, but the measured payback time and the "earned back so far" percentage were comparing that single price against the earnings of your entire set — so with three batteries, payback looked three times shorter than it really is. Both now account for how many batteries you actually have, and the investment total is spelled out so you can check it. The progress bar underneath showed an annual return rate while being labelled as payback time, which meant it never moved as you earned the investment back; it now tracks actual progress towards break-even. Finally, each comparison card used to lead with a euro amount presented as a profit per day, which it never was — it was an internal planning value covering a window longer than a day, including energy still sitting in the battery. The cards now lead with the share of your household consumption covered without drawing from the grid, which is what the underlying calculation genuinely measures, alongside the capacity, power and any shortfall during discharge. The estimated yearly gain and payback time for adding a battery are still shown, now marked as a rough model indication. Those estimates are also ranked correctly again: the underlying figure used to credit whatever charge happened to be in the battery at the moment of calculation, which grows with pack size, so a larger battery could be scored below a smaller one and the comparison shifted as the state of charge moved through the day. Scenarios are now compared on what each pack can earn starting from empty, which depends only on prices, solar and consumption. Your measured earnings, based on completed charge/discharge cycles, remain the figure to trust for real returns.

### Battery No Longer Makes Tiny Pointless Charges Around Sunset (v3.17.11)

* **Fixed a case where the battery would briefly charge a little when solar production was roughly equal to house consumption (typically as the sun faded).** With no real surplus to store, that small charge had to be given back later at a round-trip efficiency loss — a guaranteed waste with no benefit. The battery now simply stays idle in that situation and lets any solar go to the grid, matching what the planning chart already showed. This mainly affects days with variable cloud and the hour around sunset.

### Energy Socket Polling Interval and Thermometer Offset Now Apply Immediately (v3.17.10)

* **Fixed a bug where changing the polling interval on Energy Socket devices, or the temperature/humidity offset on Thermometer devices, silently had no effect until the app was restarted.** The settings screen saved the new value, but the running device kept using the old one — so, for example, lowering the polling interval from 10 to 5 seconds appeared to save successfully while the device kept polling every 10 seconds until the next app restart. Changes to these settings now take effect immediately.

### More Reliable Device Updates During App Restarts (v3.17.8)

* **Fixed a rare connection error during app shutdown or restart.** Energy meters, smart plugs, batteries and the water meter could briefly try to update their values while the app was already shutting down, which showed up as a connection error in diagnostic reports. Those updates are now cleanly skipped while the app is stopping. The water meter additionally received the same protection against overlapping reads piling up that the smart plugs already had, keeping it responsive even when a meter is temporarily unreachable.

### Battery Efficiency Now Broken Down by Charge/Discharge Workload (v3.17.7)

* **New insight into how the battery's round-trip efficiency depends on how hard it is charged or discharged.** Each completed charge/discharge cycle now records how much of its energy moved at low, medium and high power, so the app can compare efficiency between gentle and high-power usage instead of relying on a single session average. This reveals whether short high-power bursts — for example covering a large household spike — cost efficiency, helping you tune when to charge and discharge for the least loss. The comparison fills in over the coming days as new cycles complete.

### Cheap Solar Now Stored at the Best Moment Instead of Exported (v3.17.6)

* **Fixed a case where the battery could export cheap solar surplus now and top up later at a less favorable moment.** On systems that use time-varying discharge thresholds, an internal check that reserves enough energy for the evening was being skipped, so the planner sometimes preferred exporting over storing during strong, low-priced solar. Solar surplus is now stored at the cheapest available moment as intended.

### Battery Wear Cost Now Applied Consistently Across All Charging Paths (v3.17.5)

* **Fixed an inconsistency where storing energy via one internal path was valued as slightly cheaper than an economically identical path, with no physical basis for the difference** — the battery's wear cost now applies uniformly no matter how the energy enters the battery, removing a small bias in charging-timing decisions.

### Battery Startup Reliability for Multi-Battery Setups (v3.17.5)

* **Fixed a startup crash that could occur on setups with several batteries** — connections to each battery now start with a brief stagger instead of all at once, avoiding a CPU-limit trip during initialization.

### Satellite Solar Forecast Improvements (v3.17.5)

* **Extended the near-term cloud-dip detection look-ahead** for earlier warning of an approaching solar dip.
* **Fixed a regression in the satellite-based solar yield calculation** that had crept back in from an earlier change.
* **Fixed a day-boundary issue where yesterday's cloud data could leak into today's calculation** right after midnight.

### Camera Chart & PV Accuracy Display Fixes (v3.17.5)

* **The camera solar chart now shows the same corrected forecast used for accuracy tracking**, instead of an older, less accurate calculation.
* **PV accuracy indicators now only appear once satellite data is actually available**, instead of showing before there's anything to compare against.
* **The camera chart now plots the same forecast curve used elsewhere in the app**, instead of a separate, unblended one.

### Cloud-Cover Forecast Accuracy (v3.17.5)

* **The solar-output discount applied during heavy cloud cover now cross-checks against ground-based measurements before applying** — reduces cases where a temporary cloud-model disagreement caused an unnecessarily large forecast cut.
* **Cloud-cover data now blends multiple weather models instead of relying on a single one**, for a steadier forecast input.

### Performance Improvements (v3.17.4)

* **Reduced CPU overhead in price-fetching and policy evaluation**, and staggered related network calls to avoid short bursts.

### Solar Ensemble Accuracy (v3.17.4)

* **Aligned additional weather signals across forecast models** for a more consistent blended solar forecast.

### Diagnostics: DP Decision-Layer Tracing (v3.17.3)

* **Added a log line that shows whether the optimizer's overnight PV-abundance logic actually reached the current battery level, and what the underlying algorithm would choose there before later adjustment steps run** — helps confirm whether an unexpected hold-vs-discharge decision came from the core planning logic or a later adjustment, without needing a separate reproduction script. `lib/optimization-engine.js`, `lib/policy-engine.js`

* **Re-enabled a shadow measurement for the discharge-timing safety margin that was disabled earlier for lack of a working before/after comparison** — the safety margin (which makes overnight discharge more cautious when weather models disagree with each other) now logs its estimated profit and battery-level effect for comparison, without changing what the battery actually does. Counts persist across app restarts. `drivers/battery-policy/device.js`

### PV-Surplus Charging: Fixed a Battery-Stays-Empty Edge Case on Some Price Curves (v3.17.3)

* **The battery could stay near-empty through a whole morning of PV surplus on certain price-curve shapes** — planning logic that decides when to wait for a better charging moment could keep deferring longer than intended, missing the practical charging window. Tightened so deferral only happens when genuinely worthwhile.

* **Added a safeguard so waiting for a better price can no longer leave the evening's own energy need uncovered** — planning now checks that enough charging opportunity remains before deferring further.

* **Fixed a case where a favorable price later in the schedule could block charging today even when it wouldn't actually be reachable in time.**

* **Stopped the battery from rapidly switching between charging and idle when solar output was present but below household demand** — the surplus-vs-grid decision now only runs when there is genuine surplus (solar actually exceeding the home's own use), avoiding needless mode changes.

### Night Discharge Reorder — Priciest Slots First; wEnd-Budget Fix (v3.17.0)

* **Overnight discharge slots are now evaluated priciest-first instead of chronologically** — The optimizer built its list of candidate night-window discharge slots and filled them earliest-to-latest. When total available SoC fell short of covering every candidate, the cheapest slot got filled while the most valuable one sat idle. The reorder block now sorts by slot price descending and fills from the top, so the highest-price export opportunity captures capacity first. `optimization-engine.js`

* **Reorder budget now correctly uses the DP terminal-SoC target when `wEnd = N`** — When the optimizer targets a non-zero end SoC (e.g. a morning reserve), the reorder block was drawing from the full battery capacity instead of only the headroom above the target floor. On a night requiring 20% reserve at 06:00 it could schedule discharges totalling more SoC than was actually available, leaving later plan slots without energy to deliver. The budget is now `soc − wEnd_target`. Property tests in `test/optimizer-properties.test.js` cover both the sort invariant and the budget constraint.

### Open-Meteo Preceding-Hour Convention: 1-Hour Forecast Shift Fixed (v3.17.0)

* **The solar forecast was systematically shifted 1 hour late — now corrected** — Open-Meteo's hourly irradiance values use the *preceding-hour* convention: the value timestamped 14:00 represents the average from 13:00–14:00. The app was treating them as current-hour values, causing the OM-derived PV forecast to lead one hour. On a rising morning or a falling evening the optimizer was planning charge/discharge decisions 1 slot too early. The ingestion code now indexes each irradiance value to the hour it covers (13:00 for a 14:00 stamp). Existing learned solar yield factors were migrated −1 h UTC to stay consistent with the corrected timestamps. `lib/weather-forecaster.js`, `lib/learning-engine.js`

### Upwind Cloud Signal via KNMI Wind (v3.17.0)

* **The app now reads live KNMI wind speed and direction from the nearest home station** — A keep-alive KNMI wind poller (10-min cadence) pulls the closest measured wind. Wind speed, direction, and WMO weather icon are shown in settings; the widget carries a compass bearing. `lib/knmi-wind.js`, `drivers/battery-policy/device.js`

* **Upwind COT modulates the DP PV forecast and is surfaced in explainability** — The cloud optical thickness at a point ~50 km upwind (derived from live KNMI wind direction and speed) is compared to the local COT. A higher upwind value signals incoming cloud cover with a 20–40 min lead; the DP reduces pvForecast for the next 1–2 slots proportionally. The explainability engine surfaces this as a named reason when it fires. `drivers/battery-policy/device.js`, `lib/explainability-engine.js`

### Satellite Nowcast: EMA-Learned Yield Factors (F2) (v3.17.0)

* **Satellite GHI→panel-W yield factors are now learned per UTC hour from live measurements** — Each 15-min PV production bucket is recorded against the simultaneous satellite GHI reading; an exponential moving average (α = 1.0 first sample, α = 0.10 thereafter) converges the per-hour conversion factor from live data. The hardcoded `SAT_YIELD_FACTORS` table in `weather-forecaster.js` remains as a cold-start fallback for hours that have no EMA data yet. The table was calibrated from a 6-day SDM230 measurement run (Jun 23–29, n = 79 hourly samples, clear-day MAE ≈ 78–118 W); h = 06/07 and h = 15/16/17 were corrected by 5–12%. `lib/learning-engine.js`, `lib/weather-forecaster.js`

* **Satellite DP override defaults to off (`satellite_dp_active = false`)** — The nowcast feature is experimental and the yield-factor bootstrap is per-installation. The toggle must be explicitly enabled in settings; other users are unaffected.

* **`getSat15minCurve` + `getNextSatDip` + `[SAT DIP]` policy log** — The 15-min satellite GHI curve is held in memory; the app can locate the next expected cloud dip and log it at policy time. `lib/weather-forecaster.js`

### Battery Stall: `battery_error_resolved` Flow Trigger (v3.17.0)

* **A new `battery_error_resolved` flow trigger fires when the battery SoC starts moving again after a detected stall** — The companion to the existing `battery_error_detected` card. Enables automations that notify on recovery or reset external state. Works per unit for multi-battery setups. `drivers/energy_v2/device.js`

### Consumption EMA: Appliance Spike Resistance (v3.17.0)

* **Hourly consumption learning is now winsorized to resist appliance spikes** — High P1 readings from short-duration loads (oven, washing machine) entered the EMA directly and inflated the learned baseline for that hour, persisting for weeks. Samples above a 95th-percentile fence are clipped before the EMA update so transient spikes no longer corrupt the consumption profile used for DP planning. `lib/learning-engine.js`

### Daily Planned vs Actual Profit Tracking (v3.17.0)

* **At midnight the app records yesterday's DP-planned profit against the actual metered outcome** — The delta is logged and exposed via the diagnostics API, providing a day-by-day economic accuracy signal. `drivers/battery-policy/device.js`

### ENTSOE Price Cross-Validation (v3.17.0)

* **ENTSOE prices are now cross-checked against the primary price source on the overlapping window** — A divergence above 5 ct/kWh on three or more slots logs a warning, catching provider feed issues early without automatic source switching. `lib/entsoe-prices.js`

### Minor Fixes and Performance (v3.17.0)

* **`trickle` policy maps to `standby` when no PV surplus exists** — Without surplus, the battery was held in a light-charge state on evening and night slots, consuming home-load budget unnecessarily. Standby is now commanded when PV surplus is absent. `drivers/battery-policy/device.js`

* **PV surplus forecast no longer overcounts when the battery is nearly full** — A near-full battery cannot absorb the full projected surplus; the overcounted portion was inflating discharge decisions. A capacity cap is applied at planning time. `drivers/battery-policy/device.js`

* **Panel geometry change auto-resets yield factors** — When tilt, azimuth, or panel count changes in settings the learned solar yield factors are cleared so the new geometry converges from scratch rather than inheriting calibration from the old orientation. `drivers/battery-policy/device.js`

* **P1 poll loop: settings and date-format calls cached across the 15-second cycle** — Eliminates repeated property lookups and `toLocaleString` allocations on every tick. `drivers/battery-policy/device.js`

* **Dynamic OM/Solcast blend weights via brute-force optimisation on the last 50 measured slots** — The blend weights are re-optimised each policy run against recent forecast-vs-actual pairs, replacing the fixed 50/50 default for installations with enough history. `lib/learning-engine.js`

* **HTTP agents hardened and app lifecycle cleanup** — Keep-alive agents reused across weather and satellite fetches; teardown hooks cancel pollers on app uninit. `lib/weather-forecaster.js`

### PV Forecast Comparison Curves Now Show Corrected Forecasts (v3.17.0)

* **The raw weather-model comparison curves no longer sit structurally below the "Werkelijk" (actual) line** — Several diagnostic curves plotted raw NWP output, while the operational forecast that actually drives planning receives the daily-bias factor, the accuracy-conservatism factor and the live intraday actual-vs-forecast ratio. NWP models systematically over-forecast cloud over the Netherlands and so under-forecast irradiance; without those corrections the comparison curves were consistently low, making the charts misleading (most visible on a clear day, where *all* models showed the same gap). The same correction (daily-bias × accuracy-conservatism, plus the intraday ratio for today's slots, capped at the panel's rated capacity) is now applied to: the per-model accuracy chart (Météo-France / GFS / ICON / KNMI, `_recordPvAccuracySample`), and the PV Opwek camera's Open-Meteo, satellite and day-start overlay lines (`policy_pv_forecast_om` / `_sat`, `_correctedDayStartForChart`). Live-verified: a 1.43× intraday correction lifted MF/GFS/ICON/KNMI to ~2120–2268 W against an actual of 2206 W. Display-only — these are comparison curves, not the operational line that feeds the DP optimizer. The day-start reference array stays raw internally (it is the `predictedW` baseline the intraday ratio is computed against); only a scaled copy is plotted, avoiding a self-feeding correction. Solcast keeps its own provider calibration. `drivers/battery-policy/device.js`.

### Unbiased Open-Meteo + Solcast Blend (50/50) (v3.16.1)

* **The solar forecast now averages Open-Meteo and Solcast with a fixed 50/50 weight instead of accuracy-derived weights** — On a 300-sample forecast-vs-actual buffer (2026-06-15) the two models carry opposite, anti-correlated errors: Open-Meteo runs low (bias −144 W) and Solcast runs high (+90 W). A plain average cancels them (blended bias −27 W) and measured **~10% lower error (MAE 369 vs 412 W)** than the previous accuracy-weighted blend — which, despite the learned weights, never beat even the raw Open-Meteo forecast. The fixed average also drops the per-slot Solcast-p10 "cloud-miss" pessimism and the per-day OM/SC divergence penalty, so the blend is exactly the raw 50/50 the measurement validated. A new **"Unbiased OM+Solcast blend (50/50)"** setting (under Solcast, on by default) reverts to the learned accuracy weights when disabled. The same blended forecast feeds the DP optimizer, the planning chart and the explainability text — no divergence. `lib/learning-engine.js` (`getPvBlendWeights`), `drivers/battery-policy/device.js` (`_blendOmScSlot`). New property suite `test/pv-blend-unbiased.test.js` pins that the unbiased output is the exact raw average and weight-invariant (a drifting learned weight can't reintroduce bias).

### Solar Forecast Pipeline Simplified — Removed Stale Correction Layers (v3.16.0)

* **Solar (PV) forecast accuracy improved by removing several correction layers that had drifted out of sync with the underlying yield-learning** — Three changes: (1) the daily PV bias factor (a correction learned from past forecast-vs-actual ratios) no longer applies once the per-slot solar yield factors have converged (≥10 learned slots) — previously it kept multiplying an already-corrected forecast by up to 1.54×, double-counting the correction (`learning-engine.js`, `getDailyPvBiasFactor`); (2) the "clear-sky ceiling" — a separate hard radiation-based cap on the PV forecast — has been removed entirely; the forecast is now radiation × learned yield factor, capped only by the panel's rated capacity; (3) an abandoned experimental "Cabauw decorrelation" scaffold (unused nowcast correction, never enabled) has been stripped from `weather-forecaster.js` and `learning-engine.js`. Together these collapse a stack of stacking correction layers into a single traceable pipeline (radiation → yield-learning → daily-bias gate → DP forecast), with the *same* forecast feeding the DP optimizer, the planning chart, and the explainability text — verified by code-trace, no separate snapshots.

* **Overnight battery reserve now also reacts to forecast model disagreement, not just historical accuracy** — The refill-reserve floor (which holds back charge overnight when next-day PV is uncertain) previously based its confidence only on past forecast accuracy and bias-corrected delivery ratio. It now also folds in the *forward* spread between weather-model ensembles (MF/GFS/ICON/KNMI) for the upcoming day — wide model disagreement raises the reserve floor even when historical accuracy looks fine, since past accuracy can't see that tomorrow's forecast is unusually uncertain. `optimization-engine.js`, `refillConfidenceFromForecast`.

* New economic-dominance regression test: lifting the PV forecast for any slot can never *decrease* the optimizer's projected profit under net-metering (more free PV input is always neutral-or-better). `test/optimizer-properties.test.js`

### False Battery-Error Alarm in `zero_charge_only` (v3.15.98)

* **The "battery error" notification no longer fires when the battery is held in a no-discharge mode** — The stall detector judged the battery healthy by SoC movement against the commanded `target_power_w`. It armed discharge-stall detection in any mode except `predictive`/`standby`, but `zero_charge_only` (and `pv_trickle`, which maps to it) never discharges for home use — it only charges from PV surplus. With PV surplus and the P1 zero-on-meter firmware, the battery legitimately sits idle while the WebSocket payload carries a ghost negative `target_power_w`. The detector read that as a commanded discharge with a stuck SoC and raised a false `battery_error_detected` card (seen at 16:10 CEST on a `trickle`/`preserve` slot). Stall detection is now gated by modes that actually command each direction: discharge in `zero`/`zero_discharge_only`, charge in `zero`/`to_full`/`zero_charge_only`. Real charge- and discharge-stalls remain detected; the ghost-target case no longer alarms. `drivers/energy_v2/device.js`

### Planning Chart No Longer Projects a Grid Charge the Runtime Won't Make (v3.15.97)

* **The planning table no longer shows `to_full` (grid charge) on a low-SoC slot when the PV forecast is strong** — On a cheap, low-SoC slot where the forecast PV roughly cancels forecast consumption (net surplus ≈ 0), the planning mapper's low-SoC grid top-up fired and projected `to_full`, while the live runtime peak-shaved from PV and never pulled from the grid. The chart over-promised a grid charge that reality skips. The planning top-up is now suppressed whenever PV is strong (≥ 400 W), mirroring the runtime — which suppresses top-up via its real `estimatedNetPvSurplusW` signal whenever PV is producing. Strong PV now projects PV-only charging (`pv_trickle` / `zero_charge_only`); the top-up still fires when PV is genuinely weak or absent and no peak-shave is possible. Economically sound too: when PV refills the battery for free, a grid top-up is pure cycle-cost loss. Regression tests in `test/policy-planning.test.js`

### SoC-Drift False Positive on Planned Charge from Empty (v3.15.97)

* **A planned `to_full` charge from an empty battery is no longer flagged as a BMS-calibration drift** — When the battery legitimately starts the day at 0% (drained overnight by the planned evening discharge) and the plan commands a normal `to_full` grid charge, the SoC-drift detector fired a false `⚠️ SoC drift detected` the instant charging began. Cause: the drift timer was anchored to when SoC *last changed*, which for an empty+idle battery was hours earlier overnight — so the "20 minutes stuck while charging" threshold was already satisfied before a single minute of real charging had elapsed. The detector now anchors to when *charging-while-stuck began* (new `computeChargeStuckAnchor` helper, reset whenever the battery is idle or SoC leaves 0%), so the delta measures sustained charging duration. A fresh `to_full` stays silent; a battery that genuinely won't take charge for 20+ min still fires correctly, and the real BMS-calibration two-phase signature (75 W → 800 W) is unchanged. Regression tests in `test/battery-soc-drift.test.js`

### Overnight Reserve Now Reacts to PV-Forecast Bias (v3.15.97)

* **The battery holds an overnight reserve when the PV forecast has been over-optimistic, not just when it is volatile** — The refill-reserve floor (which keeps the battery from draining to empty before an uncertain next-day PV refill) was driven only by forecast *volatility* (CV). A *consistently* over-optimistic forecast — low CV but PV delivering only ~half of what was predicted — produced full confidence and no reserve, so the battery drained to 0% overnight and was forced into a thin-margin morning grid top-up. The reserve confidence now also folds in the bias-corrected delivery ratio (`refillConfidenceFromForecast` in `optimization-engine.js`): when PV under-delivers versus the forecast the DP actually uses, confidence drops proportionally and the floor engages. Over-delivery is upside and is ignored. Scales by SoC-span fraction, so 1–4 battery setups behave consistently. Unit tests in `test/refill-confidence.test.js`

### Explainability Tells You Why the Battery Holds Reserve (v3.15.97)

* **The decision reason now explains an overnight reserve hold** — When the refill-reserve floor holds charge back on a slot where the price would normally allow discharging, the explainability panel previously showed only the generic "DP gepland: bewaren". It now shows a dedicated reason ("🛡️ Reserve aangehouden voor morgenochtend — PV-voorspelling onzeker …") whenever the reserve is the reason discharge is withheld. New branch in `explainability-engine.js`, tests in `test/explainability-refill-reserve.test.js`

### Planning Chart Battery Power No Longer Shows Impossible Values (v3.15.97)

* **The planning table's `Batt(W)` column is clamped to the hardware charge/discharge limit** — On the leading partial-hour row the per-slot SoC is stepwise (held per DP slot, then jumps), so dividing a full-slot SoC delta by a shorter collapsed group implied a charge power above the physical maximum (e.g. 1602 W on an 800 W unit). The optimizer itself always respects `maxChargePowerW`; this is a display-only clamp so the diagnostic never shows a physically impossible power

### Weak-PV Surplus No Longer Exported Before a Reachable Peak (v3.15.97)

* **A cloudy-afternoon slot with a small PV surplus now charges the battery instead of dumping it to the grid** — Observed live (2026-06-01 14:00): a strong ~2 kW PV surplus was exported (−1.7 kWh to grid) while the battery sat at 57% with room to spare and an evening price peak of €0.52 ahead. Cause: the PV-uncertainty/cloud haircut (`pvCloudFactor ≈ 0.60`) pushed the slot's `pvCoverage` just under the `pvStrongCoverage` threshold (0.5), blocking the `pvStoreWins` path; simultaneously the next hour was a strong-PV slot, which resets `trickleSuffixMaxPrice` to 0 (the cap assumes that refill saturates the battery, making a later peak unreachable), blocking the `pvTrickle` path. With both blocked the slot fell through to `pvExportWins` and the surplus was exported — even though the uncapped store value (€0.374) beat the price (€0.25) and the battery never saturated (the plan peaked at 85%). `optimization-engine.js` now stores a weak-slot surplus when the battery still has room and the uncapped store value beats the price, treating the later peak as reachable. The trickle cap is unchanged for strong-PV slots, so genuine export-wins cases (a peak that PV truly refills) still export. Regression test `test/dp-pvstrong-cap-export.test.js`

### Planning Chart PV-Charge SoC Projection No Longer Loses Efficiency Twice (v3.15.97)

* **The planning chart projected PV charging too low** — The chart's SoC projection multiplied the PV-charge step by the round-trip efficiency (`rte ≈ 0.74`), so 1.6 kWh of PV into a 5.376 kWh battery drew as +22% instead of +30% of state-of-charge. Round-trip efficiency belongs in the *value* math (`storeValue = price × rte`), not in the SoC *state*: the battery physically gains the charged kWh. Every other projection path already tracked raw kWh — the grid-charge branch in the same function and the optimizer forward-sim in `optimization-engine.js` — so only the PV-charge branch was inconsistent. Removed the stray `* rte` in `buildPlanningSchedule` (`policy-engine.js`); display-only, no runtime decision effect

### Planning Chart Matches Real Export Decisions (v3.15.97)

* **The planning chart no longer projects the battery filling on slots the optimizer actually exports** — On variable/cloudy days the chart could show the battery charging up to full from PV while the live policy was exporting that surplus to the grid (plan ≠ reality). Cause: the chart's SoC projection valued storing PV with the *uncapped* maximum future price, while the runtime mapper uses the *trickle-capped* store value — a far evening peak that tomorrow's PV will refill anyway should not make storing today worthwhile. When a future peak sits beyond a strong-PV refill, the uncapped value over-stated storing and the chart drew a fill that never happened. Both projections (the optimizer forward-sim in `optimization-engine.js` and the re-mapper `_mapActionToHwModeForPlanning` in `policy-engine.js`, which drives the drawn SoC line) now gate PV charging on the same capped *store-beats-export* test the runtime uses: when exporting wins, the slot is shown as `standby` with a flat SoC. Verified live — `export more profitable → standby, no override`, `drift 0.0pp`

### PV Forecast Cap at Inverter Peak (v3.15.97)

* **PV forecast can no longer exceed the system's physical peak** — On clear days where actual PV ran well above the morning model, the intraday correction ratio (e.g. ×2) multiplied the forecast above `pv_capacity_w`, producing impossible values (e.g. 5.8 kW on a 3.57 kWp system) on the "Batterij Vandaag" and "PV Opwek" charts — and, worse, made the DP over-estimate PV recharge (risking premature discharge stop). The blended/bias/intraday-corrected forecast is now capped at the inverter peak as the final step before the optimizer, the chart forecast line, and the stored hourly forecast consume it. Solcast values are additionally clamped at the source (`solcast-provider.js`), since a misconfigured Solcast resource capacity can report above the physical system limit

### EV Charging Gate (v3.15.94)

* **New flow action `Set EV charging state` (v3.15.94)** — Tell the policy engine when an electric vehicle starts or stops charging. While EV charging is active the battery is forced to `zero_charge_only` (`standby` when SoC ≥ max): the EV draws from grid and PV instead of cycling the home battery, but PV surplus may still top up the battery. The flag auto-clears after 8 hours as a safety net in case the "stop" trigger is missed, and is persisted to settings so it survives app restarts. Implemented as an early-return gate in `_mapPolicyToHwMode` so it overrides discharge for any policy mode (`balanced`, `eco`, `aggressive`, `balanced-dynamic`). Logged as `[MAPPING][EV]` for diagnostics

### Internationalisation (v3.15.94)

* **7 new languages added** — Driver compose, capabilities, flow cards, and locale strings now include German (de), Danish (da), French (fr), Swedish (sv), Norwegian (no), Finnish (fi), and Hungarian (hu)

### UI Text Fix (v3.15.94)

* **"Standby" spelling normalized** — `Stand-by` (with hyphen, including non-breaking hyphen variant) replaced by `Standby` in `driver.settings.compose.json` and `explainability-engine.js`

### Connectivity, Memory & Provider Reliability (v3.15.93)

* **TCP ping socket-destroy on error path (v3.15.93)** — `tcpPing` in both `includes/legacy/homewizard.js` and `drivers/energy_socket/device.js` previously closed the socket only on `connect` and `timeout` events, not on `error`. While Node usually auto-closes sockets on error, edge cases (e.g. EHOSTUNREACH with retained native references) could accumulate file descriptors over days. Error handler now calls `socket.destroy()` explicitly
* **SHARED_SOCKET_AGENT.maxSockets scales with device count (v3.15.93)** — The shared HTTP agent for `energy_socket` devices was hard-capped at `maxSockets: 4`. With 15+ devices the agent became a bottleneck: failing devices held slots up to ~17s on the timeout/retry path, starving healthy devices. `maxSockets` is now set to `max(4, ceil(deviceCount / 3))` on each device init (idempotent — last writer wins). A user with 19 energy sockets now gets 7 slots instead of 4
* **Recovery poller jitter (v3.15.93)** — When multiple energy_socket devices go offline simultaneously (e.g. WiFi access-point hiccup), all their 10-second TCP-ping recovery pollers would fire in lockstep, producing a thundering herd on the AP during recovery. Each recovery poller now starts after a random 0-10s delay before its `setInterval` begins, spreading the load
* **EHOSTUNREACH / ENETUNREACH backoff (v3.15.93)** — On hard network errors (host unreachable / route down), the device now skips polling for 60 seconds instead of retrying every 10s. The backoff is reset on successful poll or any discovery callback (available, address-changed, last-seen). Saves CPU and log noise when a device is genuinely offline
* **Open-Meteo retry on transient failures (v3.15.93)** — `weather-forecaster.js` now uses `fetchWithRetry` for the three Open-Meteo endpoints (ensemble radiation, standard hourly, tilted irradiance). On TIMEOUT or 5xx response the request is retried once after 3s. Open-Meteo overloads at peak times occasionally caused stale weather cache for up to an hour; the retry catches most transient failures
* **Xadi price endpoints fetched in parallel (v3.15.93)** — The Xadi provider previously fetched `/today`, `/next24h`, and `/day/tomorrow` sequentially (each with a 10s timeout, worst case ~30s). Now all three are fetched in parallel via `Promise.allSettled`, reducing worst case to ~10s. Deduplication via `seenTimestamps` Set is preserved
* **kWhPrice page-structure-change detection (v3.15.93)** — When the kwhprice.eu HTML scraper returned 0 slots, the provider silently returned an empty array — even if the HTML was large (indicating the page loaded but the CSS selector no longer matched). The provider now throws an explicit "page structure may have changed" error when `html.length > 2000` and 0 slots are parsed, engaging the stale-cache fallback and surfacing the issue in the logs
* **Drop [MEM][socket] init log spam (v3.15.93)** — Each `energy_socket` device wrote two `[MEM][socket]` heap-stats log lines on init. With 19 devices that's 38 noise lines per app restart with no operational value. Removed

### PV Forecast, Optimizer & Battery Policy Fixes (v3.15.83–v3.15.87)

* **Per-model GTI via solar transposition + KNMI kt bias classification (v3.15.83)** — PV forecast accuracy per Open-Meteo model now uses Global Tilted Irradiance (GTI) computed via the Perez transposition model rather than GHI. This ensures the per-model radiation error is evaluated on the same tilted plane as the actual panel yield. Simultaneously, the daily radiation bias factor is now selected based on the KNMI clearness index (kt) rather than Open-Meteo cloud cover fraction — OM systematically over-estimates cloud cover (42% vs 15% measured), causing the wrong bias tier to be selected on partially-cloudy days

* **PV chart data key separated + kt-based bias apply + memory reduction (v3.15.84)** — The PV chart now uses a dedicated data key independent of the forecast pipeline, preventing stale forecast values from persisting across recomputes. kt-based bias is applied earlier in the forecast chain so downstream models see the corrected irradiance. Internal forecast buffers reduced to lower heap usage during ensemble fetches

* **Chart midnight rollover fix + ensemble fetch timeout 10→15s (v3.15.85)** — The planning chart camera image swapped tomorrow's chart for today's after midnight due to a day-boundary comparison error; fixed. The Open-Meteo ensemble fetch timeout was extended from 10s to 15s to reduce spurious timeout failures on slow upstream responses. Battery policy capabilities now expose projected profit, PV forecast, bias factor, and current DP plan summary as Homey capability values

* **Policy: fix policy_enabled permanently stuck after predictive interaction with restart (v3.15.87)** — Two related bugs that left `policy_enabled = false` after HW Slim laden (predictive) ended: (1) Restart DURING predictive: `_policyEnabledBeforePredictive` was in-memory only and lost on restart; the restore guard (`!== null`) skipped the restore, blocking all policy runs until the next restart. Fixed: persist the value to settings at predictive-start; fall back to persisted value (then `true`) when restoring. (2) Restart AFTER predictive ended before restore ran: `_isPredictiveMode` was `false` on init, so neither the restore branch nor the P1 poll path fired; policy stayed disabled. Fixed: at startup, if `policy_enabled_before_predictive` is present in settings and the hardware is no longer in predictive mode, restore `policy_enabled` immediately. Both paths now trigger an immediate policy check on predictive end instead of waiting up to 15 minutes for the next slot boundary

* **Policy: min-price discharge override for DP preserve at night (v3.15.87)** — The DP optimizer could choose `preserve` at night to protect opportunity value for next-day PV recharge, even when the current price exceeded the user's configured minimum discharge price. This occurred when the SoC was near the PV absorption cliff: one discharge step would drop SoC below the refillable threshold, so the DP correctly valued the future state but violated the user's price floor intent. Added a policy-layer override that forces `discharge` when DP says preserve, price ≥ configured minimum, SoC > min_soc, and no PV is active. Observed: 3-hour discharge gap at SoC 32%, price €0.268–0.281, minimum €0.180

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
