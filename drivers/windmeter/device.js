'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('windmeter');

var refreshIntervalId;
var devices = {};
var temperature;

class HomeWizardWindmeter extends Homey.Device {

	onInit() {

		console.log('HomeWizard Windmeter '+this.getName() +' has been inited');

		const devices = driver.getDevices();
		devices.forEach(function initdevice(device) {
			console.log('add device: ' + JSON.stringify(device.getName()));

			devices[device.getData().id] = device;
			devices[device.getData().id].settings = device.getSettings();
		});

		this.startPolling();

	}


	startPolling() {

		var me = this;

		// Clear interval
		if (refreshIntervalId) {
			clearInterval(refreshIntervalId);
		}

		// Start polling for thermometer
		refreshIntervalId = setInterval(function () {
			console.log("--Start Rainmeter Polling-- ");

			me.getStatus();

		}, 1000 * 10 );

	}


	getStatus() {

		var me = this;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			homewizard.getDeviceData(homewizard_id, 'windmeters', function(callback) {
				if (Object.keys(callback).length > 0) {
					try {
						me.setAvailable();

						me.log('Start capturing data')
						var wind_angle_tmp = ( callback[0].dir ); // $windmeters[0]['dir'] SW 225
						var wind_angle_int = wind_angle_tmp.split(" ");
						// var wind_angle = parseInt(wind_angle_tmp); // Capture only the angle portion (number)
						var wind_strength_current = ( callback[0].ws ); // $windmeters[0]['ws'] Windspeed in km/h
						var wind_strength_min = ( callback[0]["ws-"] ); // $windmeters[0]['ws-'] Min Windspeed in km/h
						var wind_strength_max = ( callback[0]["ws+"] ); // $windmeters[0]['ws+'] Max Windspeed in km/h
						var gust_strength = ( callback[0].gu ); // $windmeters[0]['gu'] Gust speed in km/h
						var temp_real = ( callback[0].te ); // $windmeters[0]['te'] Temperature
						var temp_windchill = ( callback[0].wc); // $windmeters[0]['wc'] Windchill temperature

						me.log ("End capturing data");
						// Export the data
						// Console data
						var wind_angle_str = wind_angle_int[1];
						var wind_angle = parseInt(wind_angle_str);

						console.log("Windangle in degrees: "+ wind_angle);
						console.log("Windspeed in km/u: "+ wind_strength_current);
						console.log("Min Windspeed in km/u: "+ wind_strength_min);
						console.log("Min Windspeed in km/u: "+ wind_strength_max);
						console.log("Gust strength in km/u: "+ gust_strength);
						console.log("Temperature current: "+ temp_real);
						console.log("Temperature windchill: "+ temp_windchill);

						// // Wind angle
						me.setCapabilityValue("measure_wind_angle", wind_angle );
						// // Wind speed current
						me.setCapabilityValue("measure_wind_strength.cur", wind_strength_current );
						// // Wind speed min
						me.setCapabilityValue("measure_wind_strength.min", wind_strength_min );
						// // Wind speed max
						me.setCapabilityValue("measure_wind_strength.max", wind_strength_max );
						// // Wind speed
						me.setCapabilityValue("measure_gust_strength", gust_strength );
						// // Temp real
						me.setCapabilityValue("measure_temperature.real", temp_real );
						// // Temp Windchill
						me.setCapabilityValue("measure_temperature.windchill", temp_windchill );

					} catch (err) {
						console.log('ERROR WindMeter getStatus ', err);
						me.setUnavailable();
					}
				}
			});
		} else {
			console.log('Windmeter settings not found, stop polling set unavailable');
			this.setUnavailable();

			// Only clear interval when the unavailable device is the only device on this driver
			// This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
			// In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem

			if(Object.keys(devices).length === 1) {
				clearInterval(refreshIntervalId);
			}
		}
	}

	onDeleted() {

		if (Object.keys(devices).length === 0) {
			clearInterval(refreshIntervalId);
			console.log("--Stopped Polling--");
		}

		console.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardWindmeter;