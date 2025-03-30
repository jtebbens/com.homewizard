'use strict';

const Homey = require('homey');
// const { ManagerDrivers } = require('homey');
// const drivers = ManagerDrivers.getDriver('homewizard');
// const { ManagerI18n } = require('homey');

const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;
const homeWizard_devices = {};

const preset_text = '';
const preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie'];
const preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday'];

const debug = false;

class HomeWizardDevice extends Homey.Device {

  onInit() {

    if (debug) { console.log('HomeWizard Appliance has been inited'); }

    const devices = this.homey.drivers.getDriver('homewizard').getDevices();

    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

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
    this._flowTriggerPresetChanged = this.homey.flow.getDeviceTriggerCard('preset_changed');

  }

  flowTriggerPresetChanged(device, tokens) {
    this._flowTriggerPresetChanged.trigger(device, tokens).catch(this.error);
  }

  startPolling(devices) {

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
    this.refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start HomeWizard Polling-- '); }
      if (debug) { console.log('--Start HomeWizard Polling-- '); }

      this.getStatus(devices);

    }, 1000 * 20);

  }

  getStatus(devices) {
    Promise.resolve()
      .then(async () => {

        // const me = this;
        const homey_lang = this.homey.i18n.getLanguage();

        // new
        for (const device of devices) {
          try {
					  const callback = await homewizard.getDeviceData(device.getData().id, 'preset');

					  if (device.getStoreValue('preset') === null) {
              if (debug) {
						  this.log(`Preset was set to ${callback}`);
              }
              await device.setStoreValue('preset', callback);
					  }

					  if (device.getStoreValue('preset') !== callback) {
              await device.setStoreValue('preset', callback);

              if (debug) {
						  this.log(`Flow call! -> ${callback}`);
              }

              const preset_text = (homey_lang === 'nl') ? preset_text_nl[callback] : preset_text_en[callback];

              this.flowTriggerPresetChanged(device, { preset: callback, preset_text });

              if (debug) {
						  this.log(`Preset was changed! ->${preset_text}`);
              }
					  }
          } catch (err) {
					  console.log('HomeWizard data corrupt');
					  console.log(err);
          }
				  }
      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
	  } // end of getstatus

  /*
	getStatus(devices) {

		var me = this;

		var homey_lang = this.homey.i18n.getLanguage();

		for (var index in devices) {
			homewizard.getDeviceData(devices[index].getData().id, 'preset', async function(callback) { // async added

				try {
					if (devices[index].getStoreValue('preset') === null) {
						if (debug) {me.log('Preset was set to ' + callback);}

						devices[index].getStoreValue('preset', callback);
					}

					if (devices[index].getStoreValue('preset') != callback) {

						await devices[index].setStoreValue('preset', callback).catch(me.error);

						if (debug) {me.log('Flow call! -> ' + callback);}

						if (homey_lang == "nl") {
							preset_text = preset_text_nl[callback];
						} else {
							preset_text = preset_text_en[callback];
						}
						me.flowTriggerPresetChanged(devices[index], {preset: callback, preset_text: preset_text});

						if (debug) {me.log('Preset was changed! ->'+ preset_text);}
					}
				} catch(err) {
					console.log ("HomeWizard data corrupt");
					console.log(err);
				};
			});

		}
	};
*/

}

module.exports = HomeWizardDevice;
