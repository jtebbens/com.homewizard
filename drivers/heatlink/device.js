'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('heatlink');

var refreshIntervalId;
var devices = {};
var temperature;

class HomeWizardHeatlink extends Homey.Device {

	onInit() {

		console.log('HomeWizard Heatlink '+this.getName() +' has been inited');

		const devices = driver.getDevices();
		devices.forEach(function initdevice(device) {
			console.log('add device: ' + JSON.stringify(device.getName()));

			devices[device.getData().id] = device;
			devices[device.getData().id].settings = device.getSettings();
		});

		this.startPolling();

		this.registerCapabilityListener('target_temperature', ( temperature, opts ) => {
			// Catch faulty trigger and max/min temp
			if (!temperature) {
				callback(true, temperature);
				return false;
			}
			else if (temperature < 5) {
				temperature = 5;
			}
			else if (temperature > 35) {
				temperature = 35;
			}
			temperature = Math.round(temperature.toFixed(1) * 2) / 2;

			return new Promise((resolve, reject) => {
					var url = '/hl/0/settarget/'+temperature;
					console.log(url); // Console log url
					var homewizard_id = this.getSetting('homewizard_id');
			    homewizard.call(homewizard_id, '/hl/0/settarget/'+temperature, function(err, response) {
						if (err) {
							console.log('ERR settarget target_temperature -> returned false');
							return resolve(false);
						}
						console.log('settarget target_temperature - returned true');
						return resolve(true);
				});
			});
			return Promise.resolve();
		});
	}

	startPolling() {

		var me = this;

		// Clear interval
		if (refreshIntervalId) {
			clearInterval(refreshIntervalId);
		}

		// Start polling for thermometer
		refreshIntervalId = setInterval(function () {
			console.log("--Start Heatlink Polling-- ");

			me.getStatus();

		}, 1000 * 10 );

	}


	getStatus() {

		var me = this;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			me.log('Gather data');

			homewizard.getDeviceData(homewizard_id, 'heatlinks', function(callback) {

				if (Object.keys(callback).length > 0) {

					try {
						me.setAvailable();
						var rte = (callback[0].rte.toFixed(1) * 2) / 2;
                		var rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
                		var tte = (callback[0].tte.toFixed(1) * 2) / 2;

						//Check current temperature
						if (me.getStoreValue('temperature') != rte) {
						  console.log("New RTE - "+ rte);
							me.setCapabilityValue('measure_temperature', rte );
							me.setStoreValue('temperature',rte);
						} else {
						  console.log("RTE: no change");
						}

						//Check thermostat temperature
						if (me.getStoreValue('thermTemperature') != rsp) {
						  console.log("New RSP - "+ rsp);
						  if (me.getStoreValue('setTemperature') === 0) {
							  me.setCapabilityValue('target_temperature', rsp);
						  }
							me.setStoreValue('thermTemperature',rsp);
						} else {
						  console.log("RSP: no change");
						}

						//Check heatlink set temperature
						if (me.getStoreValue('setTemperature') != tte) {
						  console.log("New TTE - "+ tte);
						  if (tte > 0) {
							  me.setCapabilityValue('target_temperature', tte);
						  } else {
							  me.setCapabilityValue('target_temperature',me.getStoreValue('thermTemperature'));
						  }
							me.setStoreValue('setTemperature',tte);
						} else {
						  console.log("TTE: no change");
						}
					} catch (err) {
						console.log ("Heatlink data corrupt", err);
						me.setUnavailable();
					}
				} else {
					me.log('No data');
				}
			});
		} else {
			console.log('HW ID not found');
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

module.exports = HomeWizardHeatlink;
