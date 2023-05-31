'use strict';

const Homey = require('homey');
const homewizard = require('./../../includes/homewizard.js');

let refreshIntervalId;
const devices = {};
var debug = false;

class HomeWizardHeatlink extends Homey.Device {
  async onInit() {
    console.log('HomeWizard Heatlink ' + this.getName() + ' has been initialized');

    const devices = this.homey.drivers.getDriver('heatlink').getDevices();
    devices.forEach((device) => {
      console.log('add device: ' + JSON.stringify(device.getName()));

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();

    this.registerCapabilityListener('target_temperature', async (value, opts) => {
      try {
        if (!value) {
          return false;
        } else if (value < 5) {
          value = 5;
        } else if (value > 35) {
          value = 35;
        }

        value = Math.round(value.toFixed(1) * 2) / 2;

        const url = '/hl/0/settarget/' + value;
        console.log(url);

        const homewizard_id = this.getSetting('homewizard_id');
        await homewizard.callnew(homewizard_id, url);
        console.log('settarget target_temperature - returned true');
        return true;
      } catch (error) {
        console.log('ERR settarget target_temperature -> returned false');
        return false;
      }
    });
  }

  startPolling() {
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    refreshIntervalId = setInterval(() => {
      if (debug) {console.log('--Start Heatlink Polling--');}
      this.getStatus();
    }, 1000 * 20);
  }

  async getStatus() {
    if (this.getSetting('homewizard_id') !== undefined) {
      const homewizard_id = this.getSetting('homewizard_id');

      try {
        const callback = await homewizard.getDeviceData(homewizard_id, 'heatlinks');

        if (Object.keys(callback).length > 0) {
          this.setAvailable();

          const rte = (callback[0].rte.toFixed(1) * 2) / 2;
          const rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
          const tte = (callback[0].tte.toFixed(1) * 2) / 2;
          const wte = (callback[0].wte.toFixed(1) * 2) / 2;

          if (this.getStoreValue('temperature') != rte) {
            if (debug) {console.log('New RTE - ' + rte);}
            this.setCapabilityValue('measure_temperature', rte);
            this.setStoreValue('temperature', rte);
          } else {
            if (debug) {console.log('RTE: no change');}
          }

          if (this.getStoreValue('thermTemperature') != rsp) {
            if (debug){console.log('New RSP - ' + rsp);}
            if (this.getStoreValue('setTemperature') === 0) {
              this.setCapabilityValue('target_temperature', rsp);
            }
            this.setStoreValue('thermTemperature', rsp);
          } else {
            if (debug){console.log('RSP: no change');}
          }

          if (this.getStoreValue('setTemperature') != tte) {
            if (debug){console.log('New TTE - ' + tte);}
            if (tte > 0) {
              this.setCapabilityValue('target_temperature', tte);
            } else {
              this.setCapabilityValue('target_temperature', this.getStoreValue('thermTemperature'));
            }
            this.setStoreValue('setTemperature', tte);
          } else {
            if (debug){console.log('TTE: no change');}
          }

          if (!this.hasCapability('measure_temperature.boiler')) {
            this.addCapability('measure_temperature.boiler');
          }
          this.setCapabilityValue('measure_temperature.boiler', wte);

          if (!this.hasCapability('measure_temperature.heatlink')) {
            this.addCapability('measure_temperature.heatlink');
          }
          this.setCapabilityValue('measure_temperature.heatlink', tte);

          if (!this.hasCapability('central_heating_flame')) {
            this.addCapability('central_heating_flame');
          }
          this.setCapabilityValue('central_heating_flame', callback[0].heating === 'on');

          if (!this.hasCapability('central_heating_pump')) {
            this.addCapability('central_heating_pump');
          }
          this.setCapabilityValue('central_heating_pump', callback[0].pump === 'on');

          if (!this.hasCapability('measure_pressure')) {
            this.addCapability('measure_pressure');
          }
          this.setCapabilityValue('measure_pressure', callback[0].wp);
        }
      } catch (error) {
        console.log('Heatlink data error', error);
        this.setUnavailable();
      }
    } else {
      console.log('HW ID not found');
      if (Object.keys(devices).length === 1) {
        clearInterval(refreshIntervalId);
      }
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

module.exports = HomeWizardHeatlink;
