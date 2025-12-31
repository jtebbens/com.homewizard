'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('heatlink');

let refreshIntervalId;
const devices = {};
// var temperature;

const debug = false;

function callnewAsync(device_id, uri_part, {
  timeout = 3000,
  retries = 2,
  retryDelay = 250
} = {}) {

  return new Promise((resolve, reject) => {

    let attempts = 0;

    const attempt = () => {
      attempts++;

      let timeoutId;
      let finished = false;

      // Timeout mechanisme
      timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          return setTimeout(attempt, retryDelay);
        }

        return reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);

      // De echte call
      homewizard.callnew(device_id, uri_part, (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);

        if (err) {
          if (attempts <= retries) {
            return setTimeout(attempt, retryDelay);
          }
          return reject(err);
        }

        return resolve(result);
      });
    };

    attempt();
  });
}



class HomeWizardHeatlink extends Homey.Device {

  async onInit() {

    // const devices = this.homey.drivers.getDriver('heatlink').getDevices(); // or heatlink
    const driverDevices = this.homey.drivers.getDriver('heatlink').getDevices();


    driverDevices.forEach((device) => {
      this.log(`add device: ${device.getName()}`);
      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });


    this.startPolling();

    this.registerCapabilityListener('target_temperature', async (temperature) => {
      if (!temperature) return false;

      if (temperature < 5) temperature = 5;
      else if (temperature > 35) temperature = 35;

      temperature = Math.round(temperature.toFixed(1) * 2) / 2;

      const homewizard_id = this.getSetting('homewizard_id');
      const path = `/hl/0/settarget/${temperature}`;
      this.log(path);

      try {
        await callnewAsync(homewizard_id, path);
        this.log('settarget target_temperature - returned true');
        return true;

      } catch (err) {
        this.log('ERR settarget target_temperature -> returned false');
        this.error(
          `Heatlink ${this.getName()} (${this.getData().id}) settarget failed: ${err.message || err}`
        );
        return false;
      }
    });
  }

  startPolling() {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) { this.log('--Start Heatlink Polling-- '); }

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
            if (debug) { this.log(`New RTE - ${rte}`); }
            promises.push(this.setCapabilityValue('measure_temperature', rte).catch(this.error));
            this.setStoreValue('temperature', rte).catch(this.error);
			  } else if (debug) { this.log('RTE: no change'); }

			  if (this.getStoreValue('thermTemperature') != rsp) {
            if (debug) { this.log(`New RSP - ${rsp}`); }
            if (this.getStoreValue('setTemperature') === 0) {
              promises.push(this.setCapabilityValue('target_temperature', rsp).catch(this.error));
            }
            this.setStoreValue('thermTemperature', rsp).catch(this.error);
			  } else if (debug) { this.log('RSP: no change'); }

			  if (this.getStoreValue('setTemperature') != tte) {
            if (debug) { this.log(`New TTE - ${tte}`); }
            if (tte > 0) {
              promises.push(this.setCapabilityValue('target_temperature', tte).catch(this.error));
            } else {
              promises.push(this.setCapabilityValue('target_temperature', this.getStoreValue('thermTemperature')).catch(this.error));
            }
            this.setStoreValue('setTemperature', tte).catch(this.error);
			  } else if (debug) { this.log('TTE: no change'); }

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
        this.log('Heatlink data error', error);
        this.setUnavailable(error).catch(this.error);
		  }
    } else {
		  this.log('HW ID not found');
		  if (Object.keys(devices).length === 1) {
        clearInterval(this.refreshIntervalId);
		  }
    }
	  }

  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(this.refreshIntervalId);
     this.log('--Stopped Polling--');
    }

    this.log(`deleted: ${JSON.stringify(this)}`);
  }

}

module.exports = HomeWizardHeatlink;
