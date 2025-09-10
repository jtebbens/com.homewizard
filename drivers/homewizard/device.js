'use strict';

const Homey = require('homey');
// const { ManagerDrivers } = require('homey');
// const drivers = ManagerDrivers.getDriver('homewizard');
// const { ManagerI18n } = require('homey');

const homewizard = require('../../includes/legacy/homewizard.js');

var refreshIntervalId;
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
    homewizard.stoppoll();
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

    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start HomeWizard Polling-- '); }
      if (debug) { console.log('--Start HomeWizard Polling-- '); }

      this.getStatus(devices);

    }, 1000 * 20);

  }

async getStatus(devices) {
  try {
    const homey_lang = this.homey.i18n.getLanguage();

    for (const device of devices) {
      const callback = await homewizard.getDeviceData(device.getData().id, 'preset');
      const currentPreset = await device.getStoreValue('preset');

      if (currentPreset === null || currentPreset !== callback) {
        await device.setStoreValue('preset', callback);

        const preset_text = (homey_lang === 'nl') ? preset_text_nl[callback] : preset_text_en[callback];
        this.flowTriggerPresetChanged(device, { preset: callback, preset_text });

        if (debug) this.log(`Preset updated: ${preset_text}`);
      }
    }

    await this.setAvailable();
  } catch (err) {
    console.error('Error in getStatus:', err);
    await this.setUnavailable(err);
  }
}

  

}

module.exports = HomeWizardDevice;
