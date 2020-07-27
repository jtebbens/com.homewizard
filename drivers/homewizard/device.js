'use strict';

const Homey = require('homey');
const { ManagerDrivers } = require('homey');
const drivers = ManagerDrivers.getDriver('homewizard');

var homewizard = require('./../../includes/homewizard.js');
var refreshIntervalId;
var homeWizard_devices = {};

class HomeWizardDevice extends Homey.Device {

	onInit() {

		this.log('HomeWizard Appliance has been inited');

		const devices = drivers.getDevices();

		devices.forEach(function initdevice(device) {
			console.log('add device: ' + JSON.stringify(device.getName()));

			homeWizard_devices[device.getData().id] = {};
			homeWizard_devices[device.getData().id].name = device.getName();
			homeWizard_devices[device.getData().id].settings = device.getSettings();
		});

		homewizard.setDevices(homeWizard_devices);
		homewizard.startpoll();

		if (Object.keys(homeWizard_devices).length > 0) {
		  this.startPolling();
		}

	}

	startPolling = function() {

	}
}



module.exports = HomeWizardDevice;