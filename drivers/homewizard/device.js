'use strict';

const Homey = require('homey');
const { ManagerDrivers } = require('homey');
const drivers = ManagerDrivers.getDriver('homewizard');
const { ManagerI18n } = require('homey');

var homewizard = require('./../../includes/homewizard.js');
var refreshIntervalId;
var homeWizard_devices = {};

var preset_text = '';
var preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie'];
var preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday'];
var homey_lang = ManagerI18n.getLanguage();
var debug = false;

class HomeWizardDevice extends Homey.Device {

	onInit() {

		if (debug) {console.log('HomeWizard Appliance has been inited');}

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
		  this.startPolling(devices);
		}

		// Init flow triggers
		this._flowTriggerPresetChanged = new Homey.FlowCardTriggerDevice('preset_changed').register();

	}

	flowTriggerPresetChanged( device, tokens ) {
		this._flowTriggerPresetChanged.trigger( device, tokens ).catch( this.error )
	}

	startPolling(devices) {

		var me = this;

		if (refreshIntervalId) {
			clearInterval(refreshIntervalId);
		}
		refreshIntervalId = setInterval(function () {
			if (debug) {me.log("--Start HomeWizard Polling-- ");}
			if (debug) {console.log("--Start HomeWizard Polling-- ");}

				me.getStatus(devices);

		}, 1000 * 10);

	}

	getStatus(devices) {

		var me = this;

		for (var index in devices) {
			homewizard.getDeviceData(devices[index].getData().id, 'preset', function(callback) {

				try {
					if (devices[index].getStoreValue('preset') === null) {
						if (debug) {me.log('Preset was set to ' + callback);}

						devices[index].getStoreValue('preset', callback);
					}

					if (devices[index].getStoreValue('preset') != callback) {

						devices[index].setStoreValue('preset', callback);

						if (debug) {me.log('Flow call! -> ' + callback);}

						if (homey_lang == "nl") {
							preset_text = preset_text_nl[callback];
						} else {
							preset_text = preset_text_en[callback];
						}
						me.flowTriggerPresetChanged(devices[index], {preset: callback, preset_text: preset_text})

						if (debug) {me.log('Preset was changed! ->'+ preset_text);}
					}
				} catch(err) {
					console.log ("HomeWizard data corrupt");
					console.log(err);
				}
			});

		}
	}
}



module.exports = HomeWizardDevice;
