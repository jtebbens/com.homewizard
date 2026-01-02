'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const debug = false;

function callnewAsync(device_id, uri_part, {
  timeout = 3000,
  retries = 2,
  retryDelay = 2000
} = {}) {

  return new Promise((resolve, reject) => {
    let attempts = 0;

    const attempt = () => {
      attempts++;

      let finished = false;
      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          return setTimeout(attempt, retryDelay);
        }

        return reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);

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

    this.log(`Heatlink init: ${this.getName()}`);

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
        this.log('settarget target_temperature -> true');
        return true;

      } catch (err) {
        this.log('ERR settarget target_temperature -> false');
        this.error(
          `Heatlink ${this.getName()} (${this.getData().id}) settarget failed: ${err.message || err}`
        );
        return false;
      }
    });
  }

  startPolling() {

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    this.refreshIntervalId = setInterval(() => {
      if (debug) this.log('--Heatlink Poll--');
      this.getStatus();
    }, 20000); // 20 sec
  }

  async getStatus() {

    const homewizard_id = this.getSetting('homewizard_id');
    if (!homewizard_id) {
      this.log('HW ID not found');
      return;
    }

    try {
      // ❗ getDeviceData is async (in-memory)
      const callback = await homewizard.getDeviceData(homewizard_id, 'heatlinks');

      if (!callback || Object.keys(callback).length === 0) {
        if (debug) this.log('No heatlink data yet');
        return;
      }

      this.setAvailable().catch(this.error);

      const promises = [];

      const rte = (callback[0].rte.toFixed(1) * 2) / 2;
      const rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
      const tte = (callback[0].tte.toFixed(1) * 2) / 2;
      const wte = (callback[0].wte.toFixed(1) * 2) / 2;

      if (this.getStoreValue('temperature') != rte) {
        promises.push(this.setCapabilityValue('measure_temperature', rte).catch(this.error));
        this.setStoreValue('temperature', rte).catch(this.error);
      }

      if (this.getStoreValue('thermTemperature') != rsp) {
        if (this.getStoreValue('setTemperature') === 0) {
          promises.push(this.setCapabilityValue('target_temperature', rsp).catch(this.error));
        }
        this.setStoreValue('thermTemperature', rsp).catch(this.error);
      }

      if (this.getStoreValue('setTemperature') != tte) {
        if (tte > 0) {
          promises.push(this.setCapabilityValue('target_temperature', tte).catch(this.error));
        } else {
          promises.push(this.setCapabilityValue('target_temperature', this.getStoreValue('thermTemperature')).catch(this.error));
        }
        this.setStoreValue('setTemperature', tte).catch(this.error);
      }

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
      } else {
        promises.push(this.setCapabilityValue('central_heating_flame', callback[0].heating === 'on').catch(this.error));
      }

      if (!this.hasCapability('central_heating_pump')) {
        promises.push(this.addCapability('central_heating_pump').catch(this.error));
      } else {
        promises.push(this.setCapabilityValue('central_heating_pump', callback[0].pump === 'on').catch(this.error));
      }

      if (!this.hasCapability('warm_water')) {
        promises.push(this.addCapability('warm_water').catch(this.error));
      } else {
        promises.push(this.setCapabilityValue('warm_water', callback[0].dhw === 'on').catch(this.error));
      }

      if (!this.hasCapability('measure_pressure')) {
        promises.push(this.addCapability('measure_pressure').catch(this.error));
      } else {
        promises.push(this.setCapabilityValue('measure_pressure', callback[0].wp).catch(this.error));
      }

      await Promise.allSettled(promises);

    } catch (error) {
      this.log('Heatlink data error', error);
      this.setUnavailable(error).catch(this.error);
    }
  }

  onDeleted() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
    this.log(`Heatlink deleted: ${this.getName()}`);
  }
}

module.exports = HomeWizardHeatlink;
