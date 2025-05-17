# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR DEVICE FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP BEFORE ADDING DEVICES

v3.6.20
* Update code for custom polling for P1 and sockets (Default is back to 10s).
* Setting can be adjusted in advanced settings of the device
* Bug fixes polling timers that suddenly stopped
* P1(apiv2) gas meter bugfixes
* P1(apiv2) aggregated total usage added (support for PowerByTheHour app)
* Custom polling for Watermeter, SDM230, SDM630 and SDM630-p1 mode, Default 10s, adjust as you wish.
* (untested) action cards plugin battery - P1apiv2 device is required
* Bug fix for P1(apiv2) make sure P1apiv2 is firmware version 6.0200 or higher.
* Additional loggin Plugin Battery mode get/set. 
* Wifi metric (dBm) added for P1(apiv2) and Plugin Battery
* Custom Polling interval added for Plugin Battery
* Removed version check for battery mode, using API query to verify if data is there, only then condition and action cards should show.
* Bugfix P1(apiv2) showing as unresponsive due to battery getMode query error. 
* Attempt to register the condition and action flow cards (error)
* Daily usage imported power and gas (P1apiv1) - User request

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
