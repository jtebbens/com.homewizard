# HomeWizard

This app let's you connect your HomeWizard to Homey. You can add your HomeWizard in the device section. Once done it will show up in the flow-editor, ready to be used!

v0.2.2:
* Rainmeter flow trigger added (Rainfall total based)

v0.2.1:
* Windmeter fix and heatlink action card added

v0.2.0:
* Added windmeter
* Changed device class to make it work on Homey V2

v0.1.7:
* Save readings from your smart meter
* Fixed EnergyLink not correctly saving solar from S2 port.

v0.1.6:
* Added rainmeter
* SIDENOTE just as the Energylink, heatlink etc you need to add Rain and windmeter separately.
  Verify homewizard has its windmeter units set to km/h else you get funny measures

v0.1.5: Bugfix for making scenes work again (big thanks to Jeroen Tebbens!)

v0.1.3:
Energylink updates:
* s1 and s2 are now giving information on either solar or water (whatever is connected to it)
* "Netto verbruik" feature added, it will now show the aggregated power usage which can be negative if your solarpanels do their job. ;)
* SIDENOTE: You need to redo/add Energylink device to make the "Netto verbruik" visible
Other updates:
* Made fixes for app to work on 1.2.0 Firmware (Thermometer & Scenes)


v0.1.2:
Updated Polling method to avoid traffic overhead and timing issues

V0.1.1:

* Added temp sensors
* Added trigger on preset change

V0.1.0:

* Improved polling (far less requests to HomeWizard)
* Various bugfixes and improvements

V0.0.9:

* Energylink + Wattcher support added (credits: Jeroen Tebbens)
* SIDENOTE: All devices paired before 0.0.9 (expect HomeWizard) should be re-paired!
* Make sure your solar meter is connected to s1 on energylink.

V0.0.8:

* Heatlink support added (credits: Nick Bockmeulen)

V0.0.7:

* Made fixes for app to work on 0.10.x

V0.0.5 & V0.0.6:

* Made fixes for app to work on 0.9.x

V0.0.4:

* Added switching on/off scenes

V0.0.3:

* Added a time-out of 10 sec
* Added extra logging

V0.0.2:

* Save HomeWizard’s as a device

V0.0.1:

* Use HomeWizard’s preset as a condition in flows
* Set HomeWizard’s preset as action in flows


**If you like this app, then consider to buy me a beer :)**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=4653ZKTPTPSLW)
