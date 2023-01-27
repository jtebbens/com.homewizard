# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR ENERGY SOCKET FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP

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

v2.1.37
* Changed energy_socket to class socket (was sensor)
* Minor fixes on energy_socket

v2.1.35
* Energylink S1 & S2 electric car support
* Wifi strength value added to Energy Sockets, P1, SDM230/SDM630, watermeter (user request)


v2.1.32
* Homewizard Energy Watermeter offset support (align meter with your current value of the physical watermeter)
* Updated kwh1 and kwh3 icon (credits to basvanderploeg)

v2.1.30
* Homewizard context/preset fix

v2.1.29
* Heatlink fix - function error

v2.1.27
* Homewizard Energy - Watermeter support
* Dropped AbortController implementation (prone to memory problems)
* Temporary disabled precheck tcp
* Replaced node-fetch library with axios as its has easier timeout handling for Homewizard Legacy devices

v2.1.23
* Added precheck Homewizard Legacy if device is available before attempting JSON pull

v2.1.17
* Changed mdns discovery string to host kwhmeter (this will match both sdm230 and sdm630)

v2.1.16
* Adjusted mdns condition check as it was matching the wrong devices


**If you like this app, then consider to buy me a beer :)**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
