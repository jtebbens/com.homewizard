'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('rainmeter');

var refreshIntervalId;
var devices = {};
var temperature;

class HomeWizardRainmeter extends Homey.Device {

	onInit() {

		this.log('HomeWizard Rainmeter '+this.getName() +' has been inited');

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

	}

	onDeleted() {

		if (Object.keys(devices).length === 0) {
			clearInterval(refreshIntervalId);
			console.log("--Stopped Polling--");
		}

		this.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardRainmeter;