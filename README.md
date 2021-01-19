# HomeWizard

This app let's you connect your HomeWizard to Homey. You can add your HomeWizard in the device section.
Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE: As of verion 1.0.0 you must (re)pair your homewizard and other subcomponents (Energylink, Heatlink etc.) as they will fail due
to the big code change from SDKv1 to SDKv2.

v1.1.16
* Installed AbortController npm library
* Added AbortController handling for Node-Fetch with a 5 seconds timeout to avoid socket hang up issues and potential JSON errors (i.e. JSON isnt properly formatted)

v1.1.14
* Fix: Memory hog when homewizard has unstable wifi connection and has incomplete JSON payload, added catch error handling

v1.1.12
* Core request module replaced with node-fetch for performance boost and lower memory usage
* Some svg icons added else you will see multiple Homewizard icons (request from Homey reviewer)
* lowBattery fix for non compatibile thermometers

v1.1.10
* Water&leakage sensor added

v1.1.9
* Promisify request core

v1.1.8
* Extended support for door/window contact
* Added lowBattery for smoke868 type sensor
* Added lowBattery for thermometers
* Added smoke 434Mhz types

v1.1.0
* By popular demand, smoke sensor support (upon adding it show all kakusensors, you need to pick the smoke detectors yourself)
* Also made motion sensor possible since its the same code section in Homewizard (but there is a delay of 10 seconds so not useful for direct action cards)

v1.0.7:
* Added trigger cards for S1 & S2 power usage

v1.0.6:
* Bug fix: S1 & S2 no energy updates

v1.0.5:
* Crash log fix, replaced function with method in 'autocomplete' scene - unexpected token

v1.0.4:
* Bug fix: Heatlink callback error and action card Heatlink off

v1.0.3:
* User request: Water meter has now 3 decimals

v1.0.2:
* Bug fix: remove S1 & S2 power tracking from UI if there is already solar and water meters active

v1.0.1:
* Added power usage meter support for Energylink port S1 and S2

v1.0.0:
* Complete rewrite to SDK2 so it will on Homey Firmware V3 - V5 (Thanks & Credits to Freddie Welvering)

**If you like this app, then consider to buy me a beer :)**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
