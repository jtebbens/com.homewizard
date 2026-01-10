'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;
const debug = false;

class HomeWizardWindmeter extends Homey.Device {

  async onInit() {

    this.log(`HomeWizard Windmeter ${this.getName()} initialized`);

    const devices = this.homey.drivers.getDriver('windmeter').getDevices();

    // Start polling if there are devices
    if (Object.keys(devices).length > 0) {
      this.startPolling();
    }
  }

  startPolling() {

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    this.refreshIntervalId = setInterval(() => {
      if (debug) this.log('-- Windmeter Polling --');
      this.getStatus();
    }, 20 * 1000);
  }

  async getStatus() {

    const homewizard_id = this.getSetting('homewizard_id');
    if (!homewizard_id) {
      this.log('Windmeter settings missing, stopping polling');
      this.setUnavailable();
      return;
    }

    try {
      const callback = await homewizard.getDeviceData(homewizard_id, 'windmeters');

      // No data → nothing to update
      if (!Array.isArray(callback) || callback.length === 0) {
        return;
      }

      const entry = callback[0];
      if (!entry) return;

      this.setAvailable().catch(this.error);

      // -------------------------
      // Battery
      // -------------------------
      if (entry.lowBattery !== undefined && entry.lowBattery !== null) {

        if (!this.hasCapability('alarm_battery')) {
          await this.addCapability('alarm_battery').catch(this.error);
        }

        const lowBatteryStatus = entry.lowBattery === 'yes';

        if (this.getCapabilityValue('alarm_battery') !== lowBatteryStatus) {
          await this.setCapabilityValue('alarm_battery', lowBatteryStatus).catch(this.error);
        }

      } else if (this.hasCapability('alarm_battery')) {
        await this.removeCapability('alarm_battery').catch(this.error);
      }

      // -------------------------
      // No windspeed → skip update
      // -------------------------
      if (entry.ws == null) {
        return;
      }

      // -------------------------
      // Wind direction (safe parsing)
      // -------------------------
      let windAngle = null;

      if (entry.dir && typeof entry.dir === 'string') {
        const parts = entry.dir.split(' ');
        if (parts.length > 1) {
          const parsed = parseInt(parts[1]);
          if (!isNaN(parsed)) windAngle = parsed;
        }
      }

      if (windAngle !== null) {
        if (this.getCapabilityValue('measure_wind_angle') !== windAngle) {
          await this.setCapabilityValue('measure_wind_angle', windAngle).catch(this.error);
        }
      }

      // -------------------------
      // Wind speeds
      // -------------------------
      if (entry.ws !== undefined) {
        if (this.getCapabilityValue('measure_wind_strength.cur') !== entry.ws) {
          await this.setCapabilityValue('measure_wind_strength.cur', entry.ws).catch(this.error);
        }
      }

      if (entry['ws-'] !== undefined) {
        if (this.getCapabilityValue('measure_wind_strength.min') !== entry['ws-']) {
          await this.setCapabilityValue('measure_wind_strength.min', entry['ws-']).catch(this.error);
        }
      }

      if (entry['ws+'] !== undefined) {
        if (this.getCapabilityValue('measure_wind_strength.max') !== entry['ws+']) {
          await this.setCapabilityValue('measure_wind_strength.max', entry['ws+']).catch(this.error);
        }
      }

      // -------------------------
      // Gust strength
      // -------------------------
      if (entry.gu !== undefined) {
        if (this.getCapabilityValue('measure_gust_strength') !== entry.gu) {
          await this.setCapabilityValue('measure_gust_strength', entry.gu).catch(this.error);
        }
      }

      // -------------------------
      // Temperature
      // -------------------------
      if (entry.te !== undefined) {
        if (this.getCapabilityValue('measure_temperature.real') !== entry.te) {
          await this.setCapabilityValue('measure_temperature.real', entry.te).catch(this.error);
        }
      }

      // -------------------------
      // Windchill
      // -------------------------
      if (entry.wc !== undefined) {
        if (this.getCapabilityValue('measure_temperature.windchill') !== entry.wc) {
          await this.setCapabilityValue('measure_temperature.windchill', entry.wc).catch(this.error);
        }
      }

    } catch (err) {
      this.log('ERROR Windmeter getStatus', err);
      this.setUnavailable(err);
    }
  }

  onDeleted() {
    clearInterval(refreshIntervalId);
    this.log('-- Windmeter Polling Stopped --');
    this.log(`Deleted: ${JSON.stringify(this)}`);
  }
}

module.exports = HomeWizardWindmeter;
