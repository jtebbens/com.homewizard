'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const debug = false;

class HomeWizardKakusensors extends Homey.Device {

  async onInit() {

    if (debug) this.log(`Init Kakusensor ${this.getName()}`);

    this.startPolling();
  }

  startPolling() {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId);

    this.refreshIntervalId = setInterval(() => {
      this.poll();
    }, 20000);
  }

  async poll() {
    const hwId = this.getSetting('homewizard_id');
    const sensorId = this.getSetting('kakusensors_id');
    const sensorType = this.getSetting('kakusensor_type');

    if (!hwId || !sensorId) return;

    try {
      const sensors = await homewizard.getDeviceData(hwId, 'kakusensors');
      if (!Array.isArray(sensors)) return;

      const entry = sensors.find(s => s.id == sensorId);
      if (!entry) return;

      const status = entry.status === 'yes';

      // Motion
      if (sensorType === 'motion') {
        if (!this.hasCapability('alarm_motion')) {
          try {
            await this.addCapability('alarm_motion');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_motion — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_motion') !== status) {
          await this.setCapabilityValue('alarm_motion', status);
        }
      }

      // Smoke
      if (sensorType === 'smoke' || sensorType === 'smoke868') {
        if (!this.hasCapability('alarm_smoke')) {
          try {
            await this.addCapability('alarm_smoke');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_smoke — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_smoke') !== status) {
          await this.setCapabilityValue('alarm_smoke', status);
        }
      }

      // Water leakage
      if (sensorType === 'leakage') {
        if (!this.hasCapability('alarm_water')) {
          try {
            await this.addCapability('alarm_water');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_water — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_water') !== status) {
          await this.setCapabilityValue('alarm_water', status);
        }
      }

      // Contact
      if (sensorType === 'contact' || sensorType === 'contact868') {
        if (!this.hasCapability('alarm_contact')) {
          try {
            await this.addCapability('alarm_contact');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_contact — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_contact') !== status) {
          await this.setCapabilityValue('alarm_contact', status);
        }
      }

      // Doorbell
      if (sensorType === 'doorbell') {
        if (!this.hasCapability('alarm_generic')) {
          try {
            await this.addCapability('alarm_generic');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_generic — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_generic') !== status) {
          await this.setCapabilityValue('alarm_generic', status);
        }
      }

      // Battery (optioneel)
      if (entry.lowBattery !== undefined) {
        const low = entry.lowBattery === 'yes';
        if (!this.hasCapability('alarm_battery')) {
          try {
            await this.addCapability('alarm_battery');
          } catch (err) {
            if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
              this.log('Capability already exists: alarm_battery — ignoring');
            } else {
              throw err;
            }
          }
        }
        if (this.getCapabilityValue('alarm_battery') !== low) {
          await this.setCapabilityValue('alarm_battery', low);
        }
      }

      this.setAvailable().catch(() => {});

    } catch (err) {
      this.log('Kakusensor poll error:', err);
    }
  }

  onDeleted() {
    const deviceId = this.getData().id;
    homewizard.removeDevice(deviceId);
    
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId);
  }
}

module.exports = HomeWizardKakusensors;
