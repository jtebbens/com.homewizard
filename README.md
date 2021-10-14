# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

NOTE! - ENABLE "LOCAL API" FOR YOUR ENERGY SOCKET FIRST IN THE OFFICIAL HOMEWIZARD ENERGY APP

v2.1.3
* Energy Socket support - Credits to denniedegroot
* Only update values when changed (P1) - Credits to denniedegroot
* Icon and images updated (Energy Socket)
* Attempt to improve mdns matches (string vs regex)

v2.0.17
* Bug fixes (memory, p1 and SDM230)
* Module node-fetch increased timeout 20s to compensate bad wifi connection with HomeWizard
* Better SVG icons for Heatlink and Energylink (thanks for community sharing)

v2.0.8
* Populating missing meters/metrics
* Flagging the kwh1 as solarpanel if the active_power_w goes negative which means there is a solarpanel unit attached to it
* Bug fixes

v2.0.5
* Extra error handling main driver (Homewizard legacy/old unit connectivity) - memory leak when there are connection issues
* SDM230 support (1-fase kwh meter)

v2.0.3
* SDM630 support added for "HomeWizard WiFi kWh meter 3-fase"
* Updated icon
* Extra error handling connection (timeouts etc)

v2.0.1
* One brand one app the application "Homewizard Energy" has been merged with this Homewizard application big thanks to Athom develop team.
* P1 dongle will also be automatically detected via mdns on your local network so no need to add ip manually
* Added all other meters for HomeWizard Energy P1 dongle

v1.1.18
* fix: await add/remove capability
* Installed AbortController npm library
* Added AbortController handling for Node-Fetch with a 5 seconds timeout to avoid socket hang up issues and potential JSON errors (i.e. JSON isnt properly formatted)
* Fix: Memory hog when homewizard has unstable wifi connection and has incomplete JSON payload, added catch error handling
* Core request module replaced with node-fetch for performance boost and lower memory usage
* Some svg icons added else you will see multiple Homewizard icons (request from Homey reviewer)
* lowBattery fix for non compatibile thermometers
* Water&leakage sensor added

v1.1.8
* Extended support for door/window contact
* Added lowBattery for smoke868 type sensor
* Added lowBattery for thermometers
* Added smoke 434Mhz types

**If you like this app, then consider to buy me a beer :)**

[![](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)
