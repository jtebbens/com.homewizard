# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR DEVICE FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP BEFORE ADDING DEVICES

v3.13.0

* Watermeter - battery based (via cloud hwenergy only 4x updates a day)
NOTE: This is best effort as this is cloud based and depends on your own internet and what Homewizard Energy platform allows.
If Homewizard Energy is down or is under maintenance you get errors or incorrect data.

v3.12.9

* Plugin battery charge mode now selectable from UI
* Energy(apiv2) guard for add / remove "battery_group_charge_mode"

v3.12.7

* P1 tuning TIMEOUT & Unreachable
* Removed pollingActive, unwanted side effect

v3.12.4

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

v3.5.1

* Coversion to homey-compose (DCSBL)
* Socket identification (push button led blink) (DCSBL)

**You can sponsor my work by donating via paypal.**

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
