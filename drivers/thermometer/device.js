'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('thermometer');

var refreshIntervalId;
var devices = {};
const thermometers = {};
var debug = false;

class HomeWizardThermometer extends Homey.Device {

	onInit() {

		if (debug) {console.log('HomeWizard Thermometer '+this.getName() +' has been inited');}

		const devices = driver.getDevices();

		devices.forEach(function initdevice(device) {
			if (debug) {console.log('add device: ' + JSON.stringify(device.getName()));}

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
			if (debug) {console.log("--Start Thermometer Polling-- ");}

			me.getStatus(devices);

		}, 1000 *10 );

	}

	getStatus(devices) {
		if (debug) {console.log('Start Polling');}
		var me = this;
		var lowBattery_status = null;

		for (var index in devices) {

			if(devices[index].settings.homewizard_id !== undefined ) {
				var homewizard_id = devices[index].settings.homewizard_id;
				var thermometer_id = devices[index].settings.thermometer_id;
				homewizard.getDeviceData(homewizard_id, 'thermometers', function(result) {
					if (Object.keys(result).length > 0) {
						try {
							for (var index2 in result) {

								if (result[index2].id == thermometer_id && result[index2].te != undefined && result[index2].hu != undefined) {
									var te = (result[index2].te.toFixed(1) * 2) / 2;
									var hu = (result[index2].hu.toFixed(1) * 2) / 2;

									//Check current temperature
									if (devices[index].getCapabilityValue('measure_temperature') != te) {
										if (debug) {console.log("New TE - "+ te);}
										devices[index].setCapabilityValue('measure_temperature', te);
									}

									//Check current temperature
									if (devices[index].getCapabilityValue('measure_humidity') != hu) {
										if (debug) {console.log("New HU - "+ hu);}
										devices[index].setCapabilityValue('measure_humidity', hu);
									}
									// console.log(result[index2].lowBattery);
									try {
										if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
												//console.log(result[index2].lowBattery);
												if (!devices[index].hasCapability('alarm_battery')) {
													devices[index].addCapability('alarm_battery');
												}
												var lowBattery_temp = result[index2].lowBattery;
												if (lowBattery_temp == 'yes') {
														lowBattery_status = true }
												else {
														lowBattery_status = false;
											 }
											 if (devices[index].getCapabilityValue('alarm_battery') != lowBattery_status) {
													if (debug) {console.log("New status - "+ lowBattery_status);}
													devices[index].setCapabilityValue('alarm_battery', lowBattery_status);
											}
										}
										else {
											if (devices[index].hasCapability('alarm_battery')) {
												devices[index].removeCapability('alarm_battery');
											}
										}
									} catch (e) {
										console.log(e)
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
			if (debug) {console.log("--Stopped Polling--");}
		}

		console.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardThermometer;
