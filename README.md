# HomeWizard

Upon first deployment you need add the Homewizard unit first, then you can add the related/connected components from Homewizard to your Homey.

v2.0.0
* One brand one app the application "Homewizard Energy" has been merged with this Homewizard application big thanks to Athom develop team.

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
