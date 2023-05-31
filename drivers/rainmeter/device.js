'use strict';

const Homey = require('homey');
const homewizard = require('./../../includes/homewizard.js');

let refreshIntervalId;
const devices = {};

class HomeWizardRainmeter extends Homey.Device {
  async onInit() {
    console.log('HomeWizard Rainmeter ' + this.getName() + ' has been initialized');

    const devices = this.homey.drivers.getDriver('rainmeter').getDevices();
    devices.forEach(function initdevice(device) {
      console.log('add device: ' + JSON.stringify(device.getName()));

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();

    this._flowTriggerValueChanged = this.homey.flow.getDeviceTriggerCard('rainmeter_value_changed');
  }

  flowTriggerValueChanged(device, tokens) {
    this._flowTriggerValueChanged.trigger(device, tokens).catch(this.error);
  }

  startPolling() {
    const me = this;

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(async function () {
      //console.log("--Start Rainmeter Polling-- ");

      try {
        await me.getStatus();
      } catch (error) {
        console.log('Error while getting Rainmeter status:', error);
      }
    }, 1000 * 20);
  }

  async getStatus() {
    const me = this;

    if (this.getSetting('homewizard_id') !== undefined) {
      const homewizard_id = this.getSetting('homewizard_id');

      try {
        const callback = await homewizard.getDeviceData(homewizard_id, 'rainmeters');
        if (Object.keys(callback).length > 0) {
          me.setAvailable();

          const rain_daytotal = callback[0].mm; // Total Rain in mm used JSON $rainmeters[0]['mm']
          const rain_last3h = callback[0]['3h']; // Last 3 hours rain in mm used JSON $rainmeters[0]['3h']

          // Rain last 3 hours
          me.setCapabilityValue('measure_rain.last3h', rain_last3h).catch(me.error);
          // Rain total day
          me.setCapabilityValue('measure_rain.total', rain_daytotal).catch(me.error);

          // Trigger flows
          if (
            rain_daytotal !== me.getStoreValue('last_raintotal') &&
            rain_daytotal !== 0 &&
            rain_daytotal !== undefined &&
            rain_daytotal !== null
          ) {
            me.flowTriggerValueChanged(me, { rainmeter_changed: rain_daytotal });
            me.setStoreValue('last_raintotal', rain_daytotal); // Update last_raintotal
          }
        }
      } catch (err) {
        console.log('ERROR RainMeter getStatus', err);
        me.setUnavailable();
      }
    } else {
      console.log('Rainmeter settings not found, stop polling set unavailable');
      this.setUnavailable();

      // Only clear interval when the unavailable device is the only device on this driver
      // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
      // In the event that a user has multiple devices with old settings, this function will get called every 10 seconds, but that should not be a problem
    }
  }

  onDeleted() {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      console.log('--Stopped Polling--');
    }

    console.log('deleted: ' + JSON.stringify(this));
  }
}

module.exports = HomeWizardRainmeter;
