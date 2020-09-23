'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('kakusensors');

var refreshIntervalId;
var devices = {};
const thermometers = {};

class HomeWizardKakusensors extends Homey.Device {

	onInit() {

		console.log('HomeWizard Kakusensors '+this.getName() +' has been inited');

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
			console.log("--Start Kakusensors Polling-- ");

			me.getStatus(devices);

		}, 1000 *10 );

	}

	getStatus(devices) {
		console.log('Start Polling');
		var me = this;
		var sensor_status = null;
		var lowBattery_status = null;

		for (var index in devices) {

			if(devices[index].settings.homewizard_id !== undefined ) {
				var homewizard_id = devices[index].settings.homewizard_id;
				var kakusensor_id = devices[index].settings.kakusensor_id;
				homewizard.getDeviceData(homewizard_id, 'kakusensors', function(result) {
					 if (Object.keys(result).length > 0) {
					 try {
							for (var index2 in result) {
								if (result[index2].id == kakusensor_id) {
									//BEGIN
									var sensor_status_temp = result[index2].status; // READ STATUS OF kakusensor_id
									if (sensor_status_temp == 'yes') {
											sensor_status = true }
											else {sensor_status = false}

									if (result[index2].type == "motion" ) {
										// MOTION SENSOR 	alarm_motion
										me.addCapability('alarm_motion');
										me.removeCapability('alarm_smoke');
										if (devices[index].getCapabilityValue('alarm_motion') != sensor_status) {
											console.log("New status - "+ sensor_status);
											devices[index].setCapabilityValue('alarm_motion', sensor_status);
										}
									}

									if (result[index2].type == "smoke868" ) {
										// MOTION SENSOR 	alarm_smoke
										me.addCapability('alarm_smoke');
										me.removeCapability('alarm_motion');
										if (devices[index].getCapabilityValue('alarm_smoke') != sensor_status) {
											console.log("New status - "+ sensor_status);
											devices[index].setCapabilityValue('alarm_smoke', sensor_status);
										}

										try {
											if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
													console.log(result[index2].lowBattery);
													devices[index].addCapability('alarm_battery');
													var lowBattery_temp = result[index2].lowBattery;
													if (lowBattery_temp == 'yes') {
															lowBattery_status = true }
													else {
															lowBattery_status = false
												 }
												 if (devices[index].getCapabilityValue('alarm_battery') != lowBattery_status) {
														console.log("New status - "+ lowBattery_status);
														devices[index].setCapabilityValue('alarm_battery', lowBattery_status);
												}
											}
										} catch (e) {
											console.log(e)
										}
									}

									if (result[index2].type == "smoke" ) {
										// MOTION SENSOR 	alarm_smoke
										me.addCapability('alarm_smoke');
										me.removeCapability('alarm_motion');
										if (devices[index].getCapabilityValue('alarm_smoke') != sensor_status) {
											console.log("New status - "+ sensor_status);
											devices[index].setCapabilityValue('alarm_smoke', sensor_status);
										}
									}

									if (result[index2].type == "contact" ) {
										// MOTION SENSOR 	alarm_smoke
										me.addCapability('alarm_contact');
										me.removeCapability('alarm_smoke');
										me.removeCapability('alarm_motion');
										if (devices[index].getCapabilityValue('alarm_contact') != sensor_status) {
											console.log("New status - "+ sensor_status);
											devices[index].setCapabilityValue('alarm_contact', sensor_status);
										}
									}

								}
							}
						} catch (err) {
							console.log(err);
							console.log("Kakusensors data corrupt");
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

		console.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardKakusensors;
