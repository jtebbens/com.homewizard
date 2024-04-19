# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR ENERGY SOCKET FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP

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




**If you like this app, then consider to buy me a beer :)**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
