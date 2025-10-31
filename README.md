# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR DEVICE FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP BEFORE ADDING DEVICES

v3.7.5
* Extra check upon websocket creation to avoid crashes
* Plugin battery catch all error (unhandled exception)
* Additional checking and error handling on bad wifi connections (websocket based)

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

v3.4.4
* Voltage addition sockets
* Serial number addition to socket names (DCSBL)

v3.4.3
WARNING: Initial testing as this is the new APIv2 from Homewizard and not tested fully
* Support for P1 with (Homewizard APIv2)
* Support for Plugin Battery (Still pairing problem)
  TEMPORARY WORKAROUND 
    - Add Battery (this will fail, not found)
    - Press button on battery
    - Add Battery again (now it can be added)

v3.3.26
* Watermeter via P1 (Belgium)

v3.3.25
* BUG FIX SDM230 device, some users have solar panels but class was not changed to socket and show negative solar (BUGFIX request Athom)

v3.3.24
* Added pairing prompt (Enable LOCAL API confirmation, warning watermeter need USB power)
* Update images and manifest to match HomeWizard branding

v3.3.21
* Watermeter cumulative energy support
* Enabled Wifi RSSI strength (Insights)

v3.3.18
* Added support to the Energy usage for Homey (Homey SDK)

v3.3.17
* Added a 60s timeout for P1 and Energy sockets for users with bad wifi connection to related devices

v3.3.16
* Rollback gasmeter (old firmware P1 fails check and removes)
* User bug fix Energylink where solar production values from unit ended negative
* Added T3 import and export meter (user request)

v3.3.10
* Support for gasmeter details when replaced and old unit not correctly set in P1 (external data)
* Support for Norway Voltage and Amp readings
* Energylink Insight support (user request)
* Energylink name tags update S2 (solar)

v3.3.5
* Finetuning
* Lowered CPU footprint (polling Energy sockets set to 10s and not 2s)

v3.3.2
* kWh Meters SDM230 & SDM630 added support for Voltage & Amp
* Bug fix SDM630
* Updated product brandnames and internal mDNS discovery matching

v3.2.25
* P1 Phase3 circuit adjustment code (some values are not updated in rare setups)
* Watermeter offset taken from Homewizard Energy app when set, else it takes the offset in Homey Homewizard setting

v3.2.22
* Contact sensors 868Mhz HomeWizard Legacy fix
* Windmeter bug fix, battery can be empty but there is still ws (windspeed) available
* Rainmeter battery alarm added (HomeWizard Legacy)

v3.2.18
* HomeWizard Wattcher (legacy) bug fix
* Windmeter battery support

v3.2.17
* Optional Energy socket watt compensation (User request)

v3.2.14
* P1 Meter added Power failures, voltage sags & swell counts

v3.2.13
* Energylink bug fix for s2 for “other” or “car” type sources.
* Windmeter fix (device not found message on Homey version 8.1.6)

v3.2.11
* Additional mDNS LastSeen check added
* Changed mDNS host regex to product_type, workaround for HomeyPro2023
* Changed driver names for Phase 1 and 3 SDM230 * SDM630
* Unhandled rejection Heatlink catch
* Bugfix mDNS regex match

v3.2.9
* Removed retry code for legacy Homewizard (HW wifi chip cant handle extra connections)
* Added cache mechanism to avoid double pulls for Homewizard Legacy devices
* Heatlink updated icons
* Heatlink added tapwater (warm)

v3.2.5
* Attempt to cleanup callback calls and replace them with Promise/Resolve
* P1 fixing voltage for those that have that info
* Additional Homewizard windmeter error handling
* Energylink meters 3 decimals
* Energylink code fix reading T1 & T2
* SDK3 - Kakusensors fix (driver problem)

v3.2.1
* Improved Heatlink (Water pressure, Boiler temperature)
* Fallback to node-fetch as Axios 1.4.0 giving problems (Added retry & abortcontroller code)
* P1 - monthly peak watt (Belgium specific P1 meter value)

v3.1.7
* New icon thermometer
* Gasmeter with 3 decimals
* Combined meters added import/export energy (T1&T2)

v3.1.6
* Voltage support for P1 Dongle with 3 phase connection (1 phase does not have voltage datapoint in firmware sadly)
* Rollback Homewizard preset code as getting undefined errors
* 3 Decimal for Kwh (User request)

v3.1.2
* New features P1 firmware (Peak/OffPeak & Dag/Nacht)
* Bugfixes (Total usage KWH )
* Trigger card Peak/Offpeak
* T1 & T2 Export bugfix for pre FW 4.x P1 dongles

v3.0.6
* Roleback to Axios for polling Homewizard legacy (better timeout handling)
* Code clean up

v3.0.3
* Offset watermeter and thermometer fixed (callback not a function)

v3.0.2
* SDKv3 support (Big thanks to Bram Chlon for alpha testing the code with his HW equipment)
* Bugfixes
* Adjusted threshold to remove return meter (Less than 1kWh)




**You can sponsor my work by donating via paypal.**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
