'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('thermometer');

var refreshIntervalId;
const devices = {};
// const thermometers = {};
const debug = false;

class HomeWizardThermometer extends Homey.Device {

  onInit() {

    if (debug) { console.log(`HomeWizard Thermometer ${this.getName()} has been inited`); }

    const devices = this.homey.drivers.getDriver('thermometer').getDevices();

    devices.forEach((device) => {
      if (debug) { console.log(`add device: ${JSON.stringify(device.getName())}`); }
      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    if (Object.keys(devices).length > 0) {
		  this.startPolling(devices);
    }
  }

  startPolling(devices) {

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start Thermometer Polling-- '); }

      this.getStatus(devices);

    }, 1000 * 20);

  }

  async getStatus(devices) {
    try {
		  const promises = devices.map(async (device) => { // parallel processing using Promise.all
        if (device.settings.homewizard_id !== undefined) {
			  const { homewizard_id } = device.settings;
			  const { thermometer_id } = device.settings;

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
                const offset_temp = device.getSetting('offset_temperature');
                te += offset_temp;

                // Check current temperature
                if (device.getCapabilityValue('measure_temperature') != te) {
					  if (debug) { console.log(`New TE - ${te}`); }
					  await device.setCapabilityValue('measure_temperature', te).catch(this.error);
                }

                // First adjust retrieved humidity with offset
                const offset_hu = device.getSetting('offset_humidity');
                hu += offset_hu;

                // Check current humidity
                if (device.getCapabilityValue('measure_humidity') != hu) {
					  if (debug) { console.log(`New HU - ${hu}`); }
					  await device.setCapabilityValue('measure_humidity', hu).catch(this.error);
                }

                if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
					  if (!device.hasCapability('alarm_battery')) {
                    await device.addCapability('alarm_battery').catch(this.error);
					  }

					  const lowBattery_temp = result[index2].lowBattery;
					  const lowBattery_status = lowBattery_temp == 'yes';

					  if (device.getCapabilityValue('alarm_battery') != lowBattery_status) {
                    if (debug) { console.log(`New status - ${lowBattery_status}`); }
                    await device.setCapabilityValue('alarm_battery', lowBattery_status).catch(this.error);
					  }
                } else if (device.hasCapability('alarm_battery')) {
                  await device.removeCapability('alarm_battery').catch(this.error);
					  }
				  }
            }
			  }
        }
		  });

		  await Promise.all(promises);

		  await this.setAvailable().catch(this.error);
    } catch (err) {
		  this.error(err);
		  await this.setUnavailable(err).catch(this.error);
    }
	  }
  
  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      if (debug) { console.log('--Stopped Polling--'); }
    }

    console.log(`deleted: ${JSON.stringify(this)}`);
  }

  // Catch offset updates
  async onSettings(oldSettings, newSettings, changedKeys) {
    this.log('Settings updated');
    // Update display values if offset has changed
    for (const k in changedKeys) {
      const key = changedKeys[k];
      if (key.slice(0, 7) === 'offset_') {
        const cap = `measure_${key.slice(7)}`;
        const value = this.getCapabilityValue(cap);
        const delta = newSettings[key] - oldSettings[key];
        this.log('Updating value of', cap, 'from', value, 'to', value + delta);
        await this.setCapabilityValue(cap, value + delta)
          .catch((err) => this.error(err));
      }
    }

  }

  async updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('measure', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    await this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

}

module.exports = HomeWizardThermometer;
