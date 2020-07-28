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

	startPolling = function(devices) {
		if (refreshIntervalId) {
		  clearInterval(refreshIntervalId);
		}
		refreshIntervalId = setInterval(function () {
			console.log("--Start Thermometer Polling-- ");

			for (var index in devices) {

				if(devices[index].settings.homewizard_id !== undefined ) {
					var homewizard_id = devices[index].settings.homewizard_id;
					var thermometer_id = devices[index].settings.thermometer_id;
					homewizard.getDeviceData(homewizard_id, 'thermometers', function(callback) {
						if (Object.keys(callback).length > 0) {
							try {
								for (var index in callback) {

									if (callback[index].id == thermometer_id) {
										var te = (callback[index].te.toFixed(1) * 2) / 2;
										var hu = (callback[index].hu.toFixed(1) * 2) / 2;

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

		}, 1000 * 10);
 	}



}

module.exports = HomeWizardThermometer;