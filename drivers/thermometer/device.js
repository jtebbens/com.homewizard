'use strict';

const Homey = require('homey');
const homewizard = require('./../../includes/homewizard.js');

const debug = false;

class HomeWizardThermometer extends Homey.Device {
  devices = {};
  refreshIntervalId = null;

  async onInit() {
    if (debug) {
      console.log('HomeWizard Thermometer ' + this.getName() + ' has been initialized');
    }

    const thermometerDevices = this.homey.drivers.getDriver('thermometer').getDevices();

    thermometerDevices.forEach(device => {
      if (debug) {
        console.log('Add device: ' + JSON.stringify(device.getName()));
      }
      this.devices[device.getData().id] = device;
      this.devices[device.getData().id].settings = device.getSettings();
    });

    if (Object.keys(this.devices).length > 0) {
      this.startPolling();
    }
  }

  startPolling() {
    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) {
        console.log("--Start Thermometer Polling-- ");
      }

      this.getStatus();
    }, 1000 * 20);
  }

  async getStatus() {
    try {
      for (const index in this.devices) {
        const device = this.devices[index];
        if (device.settings.homewizard_id !== undefined) {
          const homewizard_id = device.settings.homewizard_id;
          const thermometer_id = device.settings.thermometer_id;

          const result = await homewizard.getDeviceData(homewizard_id, 'thermometers');
          if (Object.keys(result).length > 0) {
            for (const index2 in result) {
              if (result[index2].id == thermometer_id && result[index2].te != undefined && result[index2].hu != undefined && (typeof result[index2].te != 'undefined') && (typeof result[index2].hu != 'undefined')) {
                let te = (result[index2].te.toFixed(1) * 2) / 2;
                let hu = (result[index2].hu.toFixed(1) * 2) / 2;

                // Adjust retrieved temperature with offset
                const offset_temp = device.getSetting('offset_temperature');
                te += offset_temp;

                // Check current temperature
                if (device.getCapabilityValue('measure_temperature') != te) {
                  if (debug) {
                    console.log("New TE - " + te);
                  }
                  device.setCapabilityValue('measure_temperature', te);
                }

                // Adjust retrieved humidity with offset
                const offset_hu = device.getSetting('offset_humidity');
                hu += offset_hu;

                // Check current humidity
                if (device.getCapabilityValue('measure_humidity') != hu) {
                  if (debug) {
                    console.log("New HU - " + hu);
                  }
                  device.setCapabilityValue('measure_humidity', hu);
                }

                // Handle low battery status
                if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
                  const lowBattery_temp = result[index2].lowBattery;
                  const lowBattery_status = lowBattery_temp === 'yes';
                  if (!device.hasCapability('alarm_battery')) {
                    device.addCapability('alarm_battery');
                  }
                  if (device.getCapabilityValue('alarm_battery') != lowBattery_status) {
                    if (debug) {
                      console.log("New status - " + lowBattery_status);
                    }
                    device.setCapabilityValue('alarm_battery', lowBattery_status);
                  }
                } else {
                  if (device.hasCapability('alarm_battery')) {
                    device.removeCapability('alarm_battery');
                  }
                }
              }
            }
          }
        }
      }
      this.setAvailable();
    } catch (error) {
      console.log('An error occurred while getting the status:', error);
      this.error(error);
      this.setUnavailable(error);
    }
  }

  onDeleted() {
    if (Object.keys(this.devices).length === 0) {
      clearInterval(this.refreshIntervalId);
      if (debug) {
        console.log("--Stopped Polling--");
      }
    }
    console.log('Deleted: ' + JSON.stringify(this));
  }

  // Catch offset updates
  onSettings(oldSettings, newSettings, changedKeys) {
    this.log('Settings updated');
    // Update display values if offset has changed
    for (const key of changedKeys) {
      if (key.slice(0, 7) === 'offset_') {
        const cap = 'measure_' + key.slice(7);
        const value = this.getCapabilityValue(cap);
        const delta = newSettings[key] - oldSettings[key];
        this.log('Updating value of', cap, 'from', value, 'to', value + delta);
        this.setCapabilityValue(cap, value + delta).catch(err => this.error(err));
      }
    }
  }

  updateValue(cap, value) {
    // Add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('measure', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    this.setCapabilityValue(cap, value).catch(err => this.error(err));
  }
}

module.exports = HomeWizardThermometer;
