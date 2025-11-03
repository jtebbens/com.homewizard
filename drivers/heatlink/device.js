'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('heatlink');

let refreshIntervalId;
const devices = {};
// var temperature;

const debug = false;

class HomeWizardHeatlink extends Homey.Device {

  async onInit() {

    await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    //console.log(`HomeWizard Heatlink ${this.getName()} has been inited`);

    const devices = this.homey.drivers.getDriver('heatlink').getDevices(); // or heatlink
    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();

    this.registerCapabilityListener('target_temperature', (temperature) => {
      // Catch faulty trigger and max/min temp
      if (!temperature) {
        // callback(true, temperature);
        return false;
      }
      if (temperature < 5) {
        temperature = 5;
      }
      else if (temperature > 35) {
        temperature = 35;
      }
      temperature = Math.round(temperature.toFixed(1) * 2) / 2;

      return new Promise(async (resolve) => { // async
        const url = `/hl/0/settarget/${temperature}`;
        console.log(url); // Console log url
        const homewizard_id = this.getSetting('homewizard_id');
			    	await homewizard.callnew(homewizard_id, `/hl/0/settarget/${temperature}`, (err) => { // await, maybe a timestamp for log?
          if (err) {
            // console.log('ERR settarget target_temperature -> returned false');
            console.log('ERR settarget target_temperature -> returned false');
            return resolve(false);
          }
          // console.log('settarget target_temperature - returned true');
          console.log('settarget target_temperature - returned true');
          return resolve(true);
        });
      });
      // return Promise.resolve(); eslint?
    });
  }

  startPolling() {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start Heatlink Polling-- '); }

      this.getStatus();

    }, 1000 * 20);

  }

  async getStatus() {
    if (this.getSetting('homewizard_id') !== undefined) {
		  const homewizard_id = this.getSetting('homewizard_id');

		  try {
        const callback = await homewizard.getDeviceData(homewizard_id, 'heatlinks');

        if (Object.keys(callback).length > 0) {
			  this.setAvailable().catch(this.error);

			  const promises = []; // Capture all await promises

			  const rte = (callback[0].rte.toFixed(1) * 2) / 2;
			  const rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
			  const tte = (callback[0].tte.toFixed(1) * 2) / 2;
			  const wte = (callback[0].wte.toFixed(1) * 2) / 2;

			  if (this.getStoreValue('temperature') != rte) {
            if (debug) { console.log(`New RTE - ${rte}`); }
            promises.push(this.setCapabilityValue('measure_temperature', rte).catch(this.error));
            this.setStoreValue('temperature', rte).catch(this.error);
			  } else if (debug) { console.log('RTE: no change'); }

			  if (this.getStoreValue('thermTemperature') != rsp) {
            if (debug) { console.log(`New RSP - ${rsp}`); }
            if (this.getStoreValue('setTemperature') === 0) {
              promises.push(this.setCapabilityValue('target_temperature', rsp).catch(this.error));
            }
            this.setStoreValue('thermTemperature', rsp).catch(this.error);
			  } else if (debug) { console.log('RSP: no change'); }

			  if (this.getStoreValue('setTemperature') != tte) {
            if (debug) { console.log(`New TTE - ${tte}`); }
            if (tte > 0) {
              promises.push(this.setCapabilityValue('target_temperature', tte).catch(this.error));
            } else {
              promises.push(this.setCapabilityValue('target_temperature', this.getStoreValue('thermTemperature')).catch(this.error));
            }
            this.setStoreValue('setTemperature', tte).catch(this.error);
			  } else if (debug) { console.log('TTE: no change'); }

			  if (!this.hasCapability('measure_temperature.boiler')) {
            promises.push(this.addCapability('measure_temperature.boiler').catch(this.error));
			  } else {
            promises.push(this.setCapabilityValue('measure_temperature.boiler', wte).catch(this.error));
			  }

			  if (!this.hasCapability('measure_temperature.heatlink')) {
            promises.push(this.addCapability('measure_temperature.heatlink').catch(this.error));
			  } else {
            promises.push(this.setCapabilityValue('measure_temperature.heatlink', tte).catch(this.error));
			  }

			  if (!this.hasCapability('central_heating_flame')) {
            promises.push(this.addCapability('central_heating_flame').catch(this.error));
			  } else if (callback[0].heating === 'on') {
            promises.push(this.setCapabilityValue('central_heating_flame', true).catch(this.error));
          }
          else {
            promises.push(this.setCapabilityValue('central_heating_flame', false).catch(this.error));
          }

			  if (!this.hasCapability('central_heating_pump')) {
            promises.push(this.addCapability('central_heating_pump').catch(this.error));
			  } else if (callback[0].pump === 'on') {
            promises.push(this.setCapabilityValue('central_heating_pump', true).catch(this.error));
          }
          else {
            promises.push(this.setCapabilityValue('central_heating_pump', false).catch(this.error));
          }

			  if (!this.hasCapability('warm_water')) {
            promises.push(this.addCapability('warm_water').catch(this.error));
			  } else if (callback[0].dhw === 'on') {
            promises.push(this.setCapabilityValue('warm_water', true).catch(this.error));
          }
          else {
            promises.push(this.setCapabilityValue('warm_water', false).catch(this.error));
          }

			  if (!this.hasCapability('measure_pressure')) {
            promises.push(this.addCapability('measure_pressure').catch(this.error));
			  } else {
            promises.push(this.setCapabilityValue('measure_pressure', callback[0].wp).catch(this.error));
			  }

          // Execute all promises concurrently using Promise.all()
          await Promise.allSettled(promises);

        }
		  } catch (error) {
        console.log('Heatlink data error', error);
        this.setUnavailable().catch(this.error);
		  }
    } else {
		  console.log('HW ID not found');
		  if (Object.keys(devices).length === 1) {
        clearInterval(this.refreshIntervalId);
		  }
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

module.exports = HomeWizardHeatlink;
