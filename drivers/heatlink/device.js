'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('heatlink');

var refreshIntervalId;
var devices = {};

class HomeWizardHeatlink extends Homey.Device {

	onInit() {

		this.log('HomeWizard Heatlink '+this.getName() +' has been inited');

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
				console.log(callback);
				if (Object.keys(callback).length > 0) {

					try {

						var rte = (callback[0].rte.toFixed(1) * 2) / 2;
                		var rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
                		var tte = (callback[0].tte.toFixed(1) * 2) / 2;

						//Check current temperature
						if (device.getCapabilityValue('temperature') != rte) {
						  console.log("New RTE - "+ rte);
							device.setCapabilityValue('measure_temperature', rte );
							device.setCapabilityValue('temperature',rte);
						} else {
						  console.log("RTE: no change");
						}
					} catch (err) {
						console.log ("Heatlink data corrupt", err);
					}
				} else {
					me.log('No data');
				}
			});
		} else {
			console.log('HW ID not found');
		}
		// if(devices[device_id].settings.homewizard_id !== undefined ) {
//         var homewizard_id = devices[device_id].settings.homewizard_id;
//         homewizard.getDeviceData(homewizard_id, 'heatlinks', function(callback) {
//             if (Object.keys(callback).length > 0) {
//            	try {
//                 var rte = (callback[0].rte.toFixed(1) * 2) / 2;
//                 var rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
//                 var tte = (callback[0].tte.toFixed(1) * 2) / 2;
//
//                 //Check current temperature
//                 if (devices[device_id].temperature != rte) {
//                   console.log("New RTE - "+ rte);
//                   module.exports.realtime( { id: device_id }, "measure_temperature", rte );
//                   devices[device_id].temperature = rte;
//                 } else {
//                   console.log("RTE: no change");
//                 }
//
//                 //Check thermostat temperature
//                 if (devices[device_id].thermTemperature != rsp) {
//                   console.log("New RSP - "+ rsp);
//                   if (devices[device_id].setTemperature === 0) {
//                     module.exports.realtime( { id: device_id }, "target_temperature", rsp );
//                   }
//                   devices[device_id].thermTemperature = rsp;
//                 } else {
//                   console.log("RSP: no change");
//                 }
//
//                 //Check heatlink set temperature
//                 if (devices[device_id].setTemperature != tte) {
//                   console.log("New TTE - "+ tte);
//                   if (tte > 0) {
//                     module.exports.realtime( { id: device_id }, "target_temperature", tte );
//                   } else {
//                     module.exports.realtime( { id: device_id }, "target_temperature", devices[device_id].thermTemperature );
//                   }
//                   devices[device_id].setTemperature = tte;
//                 } else {
//                   console.log("TTE: no change");
//                 }

	}

	onDeleted() {

		if (Object.keys(devices).length === 0) {
			clearInterval(refreshIntervalId);
			Homey.log("--Stopped Polling--");
		}

		this.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardHeatlink;