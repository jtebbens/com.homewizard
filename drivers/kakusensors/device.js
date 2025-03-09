'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/homewizard.js');

const debug = false;

let refreshIntervalId;
const devices = {};
// const thermometers = {};

class HomeWizardKakusensors extends Homey.Device {

  onInit() {

    if (debug) { console.log(`HomeWizard Kakusensors ${this.getName()} has been inited`); }

    const devices = this.homey.drivers.getDriver('kakusensors').getDevices();

    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    if (Object.keys(devices).length > 0) {
		  this.startPolling(devices);
    }

  }

  startPolling(devices) {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start Kakusensors Polling-- '); }

      this.getStatus(devices);

    }, 1000 * 20);

  }

  async getStatus(devices) {
    if (debug) {
		  console.log('Start Polling');
    }

    for (const index in devices) {
		  if (devices[index].settings.homewizard_id !== undefined) {
        const { homewizard_id } = devices[index].settings;
        const { kakusensor_id } = devices[index].settings;

        try {
			  const result = await homewizard.getDeviceData(homewizard_id, 'kakusensors');

			  if (Object.keys(result).length > 0) {
            for (const index2 in result) {
				  if (result[index2].id == kakusensor_id) {
                const sensor_status_temp = result[index2].status;
                const sensor_status = (sensor_status_temp == 'yes');

                if (result[index2].type == 'motion') {
					  if (!devices[index].hasCapability('alarm_motion')) {
                    await devices[index].addCapability('alarm_motion');
					  }

					  if (devices[index].getCapabilityValue('alarm_motion') != sensor_status) {
                    if (debug) {
						  console.log(`New status - ${sensor_status}`);
                    }

                    await devices[index].setCapabilityValue('alarm_motion', sensor_status);
					  }
                }

                if (result[index2].type == 'smoke868' || result[index2].type == 'smoke') {
					  if (!devices[index].hasCapability('alarm_smoke')) {
                    await devices[index].addCapability('alarm_smoke');
					  }

					  if (devices[index].getCapabilityValue('alarm_smoke') != sensor_status) {
                    if (debug) {
						  console.log(`New status - ${sensor_status}`);
                    }

                    await devices[index].setCapabilityValue('alarm_smoke', sensor_status);
					  }
                }

                if (result[index2].type == 'leakage') {
					  if (!devices[index].hasCapability('alarm_water')) {
                    await devices[index].addCapability('alarm_water');
					  }

					  if (devices[index].getCapabilityValue('alarm_water') != sensor_status) {
                    if (debug) {
						  console.log(`New status - ${sensor_status}`);
                    }

                    await devices[index].setCapabilityValue('alarm_water', sensor_status);
					  }
                }

                if (result[index2].type == 'contact' || result[index2].type == 'contact868') {
					  if (!devices[index].hasCapability('alarm_contact')) {
                    await devices[index].addCapability('alarm_contact');
					  }

					  if (devices[index].getCapabilityValue('alarm_contact') != sensor_status) {
                    if (debug) {
						  console.log(`New status - ${sensor_status}`);
                    }

                    await devices[index].setCapabilityValue('alarm_contact', sensor_status);
					  }
                }

                if (result[index2].type == 'doorbell') {
					  if (!devices[index].hasCapability('alarm_generic')) {
                    await devices[index].addCapability('alarm_generic');
					  }

					  if (devices[index].getCapabilityValue('alarm_generic') != sensor_status) {
                    if (debug) {
						  console.log(`New status - ${sensor_status}`);
                    }

                    await devices[index].setCapabilityValue('alarm_generic', sensor_status);
					  }
                }

                if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
					  if (!devices[index].hasCapability('alarm_battery')) {
                    await devices[index].addCapability('alarm_battery');
					  }

					  const lowBattery_temp = result[index2].lowBattery;
					  const lowBattery_status = (lowBattery_temp == 'yes');

					  if (devices[index].getCapabilityValue('alarm_battery') != lowBattery_status) {
                    console.log(`New status - ${lowBattery_status}`);
                    await devices[index].setCapabilityValue('alarm_battery', lowBattery_status);
					  }
                }
				  }
            }
			  }
        } catch (err) {
			  console.log(err);
			  console.log('Kakusensors data corrupt');
        }
		  }
    }
	  }

  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      if (debug) { console.log('--Stopped Polling--'); }
    }

    console.log(`deleted: ${JSON.stringify(this)}`);
  }

}

module.exports = HomeWizardKakusensors;
