'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('thermometer');

var refreshIntervalId;
var devices = {};
const thermometers = {};

class HomeWizardThermometer extends Homey.Device {

	onInit() {

		this.log('HomeWizard Thermometer '+this.getName() +' has been inited');

		const devices = driver.getDevices();

		devices.forEach(function initdevice(device) {
			console.log('add device: ' + JSON.stringify(device.getName()));

			devices[device.getData().id] = device;
			devices[device.getData().id].settings = device.getSettings();
		});

		if (Object.keys(devices).length > 0) {
		  this.startPolling(devices);
		}
	}

	startPolling(devices) {

		var me = this;

		// Clear interval
		if (refreshIntervalId) {
			clearInterval(refreshIntervalId);
		}

		// Start polling for thermometer
		refreshIntervalId = setInterval(function () {
			console.log("--Start Thermometer Polling-- ");

			me.getStatus(devices);

		}, 1000 *10 );

	}

	getStatus(devices) {
		console.log('Start Polling');
		var me = this;

		for (var index in devices) {

			if(devices[index].settings.homewizard_id !== undefined ) {
				var homewizard_id = devices[index].settings.homewizard_id;
				var thermometer_id = devices[index].settings.thermometer_id;
				homewizard.getDeviceData(homewizard_id, 'thermometers', function(callback) {
					if (Object.keys(callback).length > 0) {
						try {
							//Rename index to index2 to avoid overwrite
							for (var index2 in callback) {
								if (callback[index2].id == thermometer_id) {
									var te = (callback[index2].te.toFixed(1) * 2) / 2;
									var hu = (callback[index2].hu.toFixed(1) * 2) / 2;

									// console.log("Thermometer ID and Data - " + thermometer_id + " Temp: " + te + " Hum: " + hu);

									//Check current temperature
									if (devices[index].getCapabilityValue('measure_temperature') != te) {
										console.log("New TE - "+ te);
										devices[index].setCapabilityValue('measure_temperature', te);
									}

									//Check current temperature
									if (devices[index].getCapabilityValue('measure_humidity') != hu) {
										console.log("New HU - "+ hu);
										devices[index].setCapabilityValue('measure_humidity', hu);
									}
								}
							}
						} catch (err) {
							console.log(err);
							console.log("Thermometer data corrupt");
						}
					}
				});
			}
		}
	}

	onDeleted() {

		if (Object.keys(devices).length === 0) {
			clearInterval(refreshIntervalId);
			console.log("--Stopped Polling--");
		}

		this.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardThermometer;
