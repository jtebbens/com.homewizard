'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const debug = false; // leave true for now while validating

class HomeWizardThermometer extends Homey.Device {

  async onInit() {
    this.sensorIndex = -1;
    this.homewizard_id = this.getSetting('homewizard_id');

    const rawId = this.getData().id;
    this.log('Thermometer init → raw id:', rawId, 'device name:', this.getName());

    // Deterministic offset based on device name (stable enough)
    const hash = this._hashString(this.getName());
    const offsetMs = (hash % 20) * 1000;
    this.log(`Thermometer update offset: ${offsetMs}ms`);

    setTimeout(() => {
      this.pollOnce();
      this.refreshIntervalId = setInterval(() => this.pollOnce(), 20_000);
    }, offsetMs);
  }

  async pollOnce() {
    try {
      if (!this.homewizard_id) return;

      const result = await homewizard.getDeviceData(this.homewizard_id, 'thermometers');
      if (!result || !Array.isArray(result) || result.length === 0) {
        if (debug) this.log('No thermometer data yet');
        return;
      }

      if (debug) this.log('Thermometer array from HomeWizard:', JSON.stringify(result));

      // Resolve index lazily by matching name
      if (this.sensorIndex === -1) {
        const name = this.getName();
        this.sensorIndex = result.findIndex(t => t.name === name);
        this.log('Resolved index at runtime (by name):', this.sensorIndex, 'for name:', name);

        if (this.sensorIndex === -1) {
          if (debug) this.log('Sensor name not found in array yet');
          return;
        }
      }

      const sensor = result[this.sensorIndex];
      if (!sensor) return;

      if (sensor.te == null || sensor.hu == null) return;

      let te = (sensor.te.toFixed(1) * 2) / 2;
      let hu = (sensor.hu.toFixed(1) * 2) / 2;

      te += this.getSetting('offset_temperature') || 0;
      hu += this.getSetting('offset_humidity') || 0;

      const tasks = [];

      if (this.getCapabilityValue('measure_temperature') !== te) {
        if (debug) this.log(`New TE → ${te}`);
        tasks.push(this.setCapabilityValue('measure_temperature', te));
      }

      if (this.getCapabilityValue('measure_humidity') !== hu) {
        if (debug) this.log(`New HU → ${hu}`);
        tasks.push(this.setCapabilityValue('measure_humidity', hu));
      }

      if (sensor.lowBattery != null) {
        const low = sensor.lowBattery === 'yes';

        if (!this.hasCapability('alarm_battery')) {
          tasks.push(this.addCapability('alarm_battery'));
        }

        if (this.getCapabilityValue('alarm_battery') !== low) {
          if (debug) this.log(`New battery status → ${low}`);
          tasks.push(this.setCapabilityValue('alarm_battery', low));
        }
      }

      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }

      await this.setAvailable();

    } catch (err) {
      this.error(err);
      await this.setUnavailable(err);
    }
  }

  onDeleted() {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
    this.log(`Thermometer deleted: ${this.getName()}`);
  }

  onSettings(oldSettings, newSettings, changedKeys) {
    this.log('Settings updated');

    for (const key of changedKeys) {
      if (key.startsWith('offset_')) {
        const cap = `measure_${key.slice(7)}`;
        const oldVal = this.getCapabilityValue(cap);
        const delta = newSettings[key] - oldSettings[key];
        const newVal = oldVal + delta;

        this.log(`Updating ${cap} from ${oldVal} → ${newVal}`);
        this.setCapabilityValue(cap, newVal).catch(this.error);
      }
    }
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

module.exports = HomeWizardThermometer;
