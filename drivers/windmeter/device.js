'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('windmeter');

let refreshIntervalId;
const devices = {};
const debug = false;
// var temperature;

class HomeWizardWindmeter extends Homey.Device {

  async onInit() {

    //await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    console.log(`HomeWizard Windmeter ${this.getName()} has been inited`);

    const devices = this.homey.drivers.getDriver('windmeter').getDevices();
    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    // this.startPolling(devices);

    if (Object.keys(devices).length > 0) {
      this.startPolling();
		  }

  }

  /*
	startPolling() {
		// Clear interval
		if (this.refreshIntervalId) {
		  clearInterval(this.refreshIntervalId);
		}

		// Start polling for thermometer
		this.refreshIntervalId = setInterval(() => {
		  this.pollStatus();
		}, 1000 * 20);
	  }

	  async pollStatus() {
		try {
		  await this.getStatus();
		} catch (error) {
		  // Handle error appropriately
		}
	  }
	  */

	  startPolling() {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      if (debug) { console.log('--Start Windmeter Polling-- '); }

      // this.getStatus(devices);
      this.getStatus();

    }, 1000 * 20);

  }

	  async getStatus(devices) {
    if (this.getSetting('homewizard_id') !== undefined) {
		  const homewizard_id = this.getSetting('homewizard_id');
      
		  try {
        const callback = await homewizard.getDeviceData(homewizard_id, 'windmeters');

        if (Object.keys(callback).length > 0) {

          this.setAvailable().catch(this.error); 

          // Check Battery
          if (callback[0].lowBattery != undefined && callback[0].lowBattery != null) {
            if (!this.hasCapability('alarm_battery')) {
					  await this.addCapability('alarm_battery').catch(this.error);
            }

            const lowBattery_temp = callback[0].lowBattery;
            const lowBattery_status = lowBattery_temp == 'yes';

            if (this.getCapabilityValue('alarm_battery') != lowBattery_status) {
					  if (debug) { console.log(`New status - ${lowBattery_status}`); }
					  await this.setCapabilityValue('alarm_battery', lowBattery_status).catch(this.error);
            }
				  } else if (this.hasCapability('alarm_battery')) {
					  await this.removeCapability('alarm_battery').catch(this.error);
          }

          // Skip update if JSON.ws is not null
          if ((callback[0].ws != null))
          {

            this.setAvailable().catch(this.error); // maybe this can be removed

            const wind_angle_tmp = callback[0].dir;
            const wind_angle_int = wind_angle_tmp.split(' ');
            const wind_strength_current = callback[0].ws;
            const wind_strength_min = callback[0]['ws-'];
            const wind_strength_max = callback[0]['ws+'];
            const gust_strength = callback[0].gu;
            const temp_real = callback[0].te;
            const temp_windchill = callback[0].wc;

            const wind_angle_str = wind_angle_int[1];
            const wind_angle = parseInt(wind_angle_str);

            // Wind angle
            if (this.getCapabilityValue('measure_wind_angle') !== wind_angle && wind_angle !== undefined) {
              await this.setCapabilityValue('measure_wind_angle', wind_angle);
            }
            // Wind speed current
            if (this.getCapabilityValue('measure_wind_strength.cur') !== wind_strength_current && wind_strength_current !== undefined) {
              await this.setCapabilityValue('measure_wind_strength.cur', wind_strength_current);
            }
            // Wind speed min
            if (this.getCapabilityValue('measure_wind_strength.min') !== wind_strength_min && wind_strength_min !== undefined) {
              await this.setCapabilityValue('measure_wind_strength.min', wind_strength_min);
            }
            // Wind speed max
            if (this.getCapabilityValue('measure_wind_strength.max') !== wind_strength_max && wind_strength_max !== undefined) {
              await this.setCapabilityValue('measure_wind_strength.max', wind_strength_max);
            }
            // Wind speed
            if (this.getCapabilityValue('measure_gust_strength') !== gust_strength && gust_strength !== undefined) {
              await this.setCapabilityValue('measure_gust_strength', gust_strength);
            }
            // Temp real
            if (this.getCapabilityValue('measure_temperature.real') !== temp_real && temp_real !== undefined) {
              await this.setCapabilityValue('measure_temperature.real', temp_real);
            }
            // Temp Windchill
            if (this.getCapabilityValue('measure_temperature.windchill') !== temp_windchill && temp_windchill !== undefined) {
              await this.setCapabilityValue('measure_temperature.windchill', temp_windchill);
            }

          }
        }
		  } catch (err) {
        console.log('ERROR WindMeter getStatus', err);
        this.setUnavailable(err);
		  }
    } else {
		  console.log('Windmeter settings not found, stop polling set unavailable');
		  this.setUnavailable();
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

module.exports = HomeWizardWindmeter;
