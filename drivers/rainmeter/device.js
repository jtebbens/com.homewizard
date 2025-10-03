'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('rainmeter');

var refreshIntervalId;
const devices = {};
// var temperature;

class HomeWizardRainmeter extends Homey.Device {

  onInit() {

    console.log(`HomeWizard Rainmeter ${this.getName()} has been inited`);

    const devices = this.homey.drivers.getDriver('rainmeter').getDevices();
    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

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

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(() => {
      // console.log("--Start Rainmeter Polling-- ");

      this.getStatus();

    }, 1000 * 20);

  }

  async getStatus() {
    const me = this;

    try {
      const homewizard_id = this.getSetting('homewizard_id');
      if (typeof homewizard_id === 'undefined') {
        console.log('Rainmeter settings not found, stop polling set unavailable');
        return;
      }

      const callback = await homewizard.getDeviceData(homewizard_id, 'rainmeters');
      if (!callback || Object.keys(callback).length === 0) return;

      const rainmeter = callback[0];

      // Battery check
      if (rainmeter.lowBattery != null) {
        if (!this.hasCapability('alarm_battery')) {
          await this.addCapability('alarm_battery').catch(me.error);
        }

        const lowBattery_status = rainmeter.lowBattery === 'yes';
        if (this.getCapabilityValue('alarm_battery') !== lowBattery_status) {
          await this.setCapabilityValue('alarm_battery', lowBattery_status).catch(me.error);
        }
      } else if (this.hasCapability('alarm_battery')) {
        await this.removeCapability('alarm_battery').catch(me.error);
      }

      // Rain data
      const rain_daytotal = rainmeter.mm;
      const rain_last3h = rainmeter['3h'];

      await me.setCapabilityValue('measure_rain.last3h', rain_last3h).catch(me.error);
      await me.setCapabilityValue('measure_rain.total', rain_daytotal).catch(me.error);

      // Trigger flow if rain total changed
      const lastRainTotal = await me.getStoreValue('last_raintotal');
      if (
        typeof rain_daytotal === 'number' &&
        rain_daytotal !== 0 &&
        rain_daytotal !== lastRainTotal
      ) {
        me.flowTriggerValueChanged(me, { rainmeter_changed: rain_daytotal });
        await me.setStoreValue('last_raintotal', rain_daytotal).catch(me.error);
      }

      await this.setAvailable().catch(this.error);
    } catch (err) {
      console.error('ERROR RainMeter getStatus', err);
      await this.setUnavailable(err).catch(this.error);
    }
}



  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      console.log('--Stopped Polling--');
    }

    console.log(`deleted: ${JSON.stringify(this)}`);
  }

}

module.exports = HomeWizardRainmeter;
