'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('thermometer');

let refreshIntervalId;
// const devices = {};
// const thermometers = {};
const debug = false;

class HomeWizardThermometer extends Homey.Device {

  async onInit() {

    this.homey.app.bumpDeviceCount?.('thermometer');

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    // Each device polls only itself. Before, every device started a timer that looped over
    // the whole driver's device list, so N devices produced N² updates per cycle.
    this.startPolling();
  }

  startPolling() {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) { this.log('--Start Thermometer Polling-- '); }

      this.getStatus();

    }, 1000 * 20);

  }

  async getStatus() {
    try {
      const settings = this.getSettings();
      if (settings.homewizard_id !== undefined) {
        const { homewizard_id } = settings;
        const { thermometer_id } = settings;

        const result = await homewizard.getDeviceData(homewizard_id, 'thermometers');

        if (Object.keys(result).length > 0) {
          for (const index2 in result) {
            if (
              result[index2].id == thermometer_id
              && result[index2].te != undefined
              && result[index2].hu != undefined
              && typeof result[index2].te != 'undefined'
              && typeof result[index2].hu != 'undefined'
            ) {
              let te = (result[index2].te.toFixed(1) * 2) / 2;
              let hu = (result[index2].hu.toFixed(1) * 2) / 2;

              // First adjust retrieved temperature with offset
              const offset_temp = this.getSetting('offset_temperature');
              te += offset_temp;

              // Check current temperature
              if (this.getCapabilityValue('measure_temperature') != te) {
                if (debug) { this.log(`New TE - ${te}`); }
                await this.setCapabilityValue('measure_temperature', te).catch(this.error);
                await this.setStoreValue('lastTempUpdate', Date.now()).catch(this.error);
                // Reset trigger state
                await this.setStoreValue('unchangedTriggered', false).catch(this.error);
              }

              // Check trigger condition
              const last = await this.getStoreValue('lastTempUpdate');
              if (last) {
                const diffHours = (Date.now() - last) / 1000 / 3600;

                const triggerCard = this.homey.flow.getDeviceTriggerCard('temp_not_changed_trigger');

                // Haal ingestelde uren op uit device settings of store
                const hours = this.getSetting('temp_not_changed_hours')
                          ?? await this.getStoreValue('temp_not_changed_hours');

                if (hours && diffHours >= hours) {
                  const alreadyTriggered = await this.getStoreValue('unchangedTriggered');

                  if (!alreadyTriggered) {
                    await triggerCard.trigger(this, { hours }).catch(this.error);
                    await this.setStoreValue('unchangedTriggered', true).catch(this.error);
                  }
                }
              }

              // First adjust retrieved humidity with offset
              const offset_hu = this.getSetting('offset_humidity');
              hu += offset_hu;

              // Check current humidity
              if (this.getCapabilityValue('measure_humidity') != hu) {
                if (debug) { this.log(`New HU - ${hu}`); }
                await this.setCapabilityValue('measure_humidity', hu).catch(this.error);
              }

              if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
                if (!this.hasCapability('alarm_battery')) {
                  await this.addCapability('alarm_battery').catch(this.error);
                }

                const lowBattery_temp = result[index2].lowBattery;
                const lowBattery_status = lowBattery_temp == 'yes';

                if (this.getCapabilityValue('alarm_battery') != lowBattery_status) {
                  if (debug) { this.log(`New status - ${lowBattery_status}`); }
                  await this.setCapabilityValue('alarm_battery', lowBattery_status).catch(this.error);
                }
              } else if (this.hasCapability('alarm_battery')) {
                await this.removeCapability('alarm_battery').catch(this.error);
              }
            }
          }
        }
      }

      await this.setAvailable().catch(this.error);
    } catch (err) {
      this.error(err);
      await this.setUnavailable(err).catch(this.error);
    }
  }
  
  onDeleted() {
    const deviceId = this.getData().id;
    homewizard.removeDevice(deviceId);

    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
      if (debug) { this.log('--Stopped Polling--'); }
    }

    this.log(`deleted: ${JSON.stringify(this)}`);
  }

  // Catch offset updates
  onSettings({ oldSettings, newSettings, changedKeys = [] }) {
  this.log('Settings updated');

  for (const key of changedKeys) {
    if (key.startsWith('offset_')) {
      const cap = `measure_${key.slice(7)}`;
      const value = this.getCapabilityValue(cap);
      const delta = newSettings[key] - oldSettings[key];

      this.log('Updating value of', cap, 'from', value, 'to', value + delta);

      this.setCapabilityValue(cap, value + delta)
        .catch((err) => this.error(err));
    }
  }
}


  updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('measure', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

}

module.exports = HomeWizardThermometer;
