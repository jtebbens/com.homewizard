# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR ENERGY SOCKET FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP

v3.2.0
* Improved Heatlink (Water pressure, Boiler temperature)

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
