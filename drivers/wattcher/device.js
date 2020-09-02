'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('wattcher');

var refreshIntervalId;
var devices = {};
var temperature;

class HomeWizardWattcher extends Homey.Device {

	onInit() {

		console.log('HomeWizard Wattcher '+this.getName() +' has been inited');

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
			console.log("--Start Wattcher Polling-- ");

			me.getStatus();

		}, 1000 * 10 );

	}


	getStatus() {

		var me = this;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			homewizard.getDeviceData(homewizard_id, 'energymeters', function(callback) {
				if (Object.keys(callback).length > 0) {
					try {
						me.setAvailable();

						me.log('Start capturing data')

						var energy_current_cons = ( callback[0].po ); // WATTS Energy used JSON $energymeters[0]['po']
						var energy_daytotal_cons = ( callback[0].dayTotal ); // KWH Energy used JSON $energymeters[0]['dayTotal']

						 // Wattcher elec current
						 me.setCapabilityValue("measure_power", energy_current_cons );
						 // Wattcher elec total day
						 me.setCapabilityValue("meter_power", energy_daytotal_cons );

						 me.log('End capturing data');
						 console.log("Wattcher usage- "+ energy_current_cons);
						 console.log("Wattcher Daytotal- "+ energy_daytotal_cons);

					} catch (err) {
						console.log('ERROR Wattcher getStatus ', err);
						me.setUnavailable();
					}
				}
			});
		} else {
			console.log('Wattcher settings not found, stop polling set unavailable');
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

module.exports = HomeWizardWattcher;