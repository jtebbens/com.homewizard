'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/homewizard.js');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('windmeter');

let refreshIntervalId;
const devices = {};
const debug = false;
// var temperature;

class HomeWizardWindmeter extends Homey.Device {
  onInit() {
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
      if (debug) {
        console.log('--Start Windmeter Polling-- ');
      }

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
          // Check Battery
          if (callback[0].lowBattery != undefined && callback[0].lowBattery != null) {
            if (!this.hasCapability('alarm_battery')) {
              await this.addCapability('alarm_battery').catch(this.error);
            }

            const lowBattery_temp = callback[0].lowBattery;
            const lowBattery_status = lowBattery_temp == 'yes';

            if (this.getCapabilityValue('alarm_battery') != lowBattery_status) {
              if (debug) {
                console.log(`New status - ${lowBattery_status}`);
              }
              await this.setCapabilityValue('alarm_battery', lowBattery_status).catch(this.error);
            }
          } else if (this.hasCapability('alarm_battery')) {
            await this.removeCapability('alarm_battery').catch(this.error);
          }

          // Skip update if JSON.ws is not null
          if (callback[0].ws != null) {
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

  /*
	getStatus() {

		var me = this;
		var debug = false;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			homewizard.getDeviceData(homewizard_id, 'windmeters', async function(callback) {
				if (Object.keys(callback).length > 0) {
					try {
						me.setAvailable();

						if (debug) {me.log('Start capturing data')}
						var wind_angle_tmp = ( callback[0].dir ); // $windmeters[0]['dir'] SW 225
						var wind_angle_int = wind_angle_tmp.split(" ");
						// var wind_angle = parseInt(wind_angle_tmp); // Capture only the angle portion (number)
						var wind_strength_current = ( callback[0].ws ); // $windmeters[0]['ws'] Windspeed in km/h
						var wind_strength_min = ( callback[0]["ws-"] ); // $windmeters[0]['ws-'] Min Windspeed in km/h
						var wind_strength_max = ( callback[0]["ws+"] ); // $windmeters[0]['ws+'] Max Windspeed in km/h
						var gust_strength = ( callback[0].gu ); // $windmeters[0]['gu'] Gust speed in km/h
						var temp_real = ( callback[0].te ); // $windmeters[0]['te'] Temperature
						var temp_windchill = ( callback[0].wc); // $windmeters[0]['wc'] Windchill temperature

						if (debug) {me.log ("End capturing data")}
						// Export the data
						// Console data
						var wind_angle_str = wind_angle_int[1];
						var wind_angle = parseInt(wind_angle_str);

						if (debug) {
						console.log("Windangle in degrees: "+ wind_angle);
						console.log("Windspeed in km/u: "+ wind_strength_current);
						console.log("Min Windspeed in km/u: "+ wind_strength_min);
						console.log("Min Windspeed in km/u: "+ wind_strength_max);
						console.log("Gust strength in km/u: "+ gust_strength);
						console.log("Temperature current: "+ temp_real);
						console.log("Temperature windchill: "+ temp_windchill);
					  }
						// // Wind angle
						await me.setCapabilityValue("measure_wind_angle", wind_angle ).catch(me.error);
						// // Wind speed current
						await me.setCapabilityValue("measure_wind_strength.cur", wind_strength_current ).catch(me.error);
						// // Wind speed min
						await me.setCapabilityValue("measure_wind_strength.min", wind_strength_min ).catch(me.error);
						// // Wind speed max
						await me.setCapabilityValue("measure_wind_strength.max", wind_strength_max ).catch(me.error);
						// // Wind speed
						await me.setCapabilityValue("measure_gust_strength", gust_strength ).catch(me.error);
						// // Temp real
						await me.setCapabilityValue("measure_temperature.real", temp_real ).catch(me.error);
						// // Temp Windchill
						await me.setCapabilityValue("measure_temperature.windchill", temp_windchill ).catch(me.error);

					} catch (err) {
						console.log('ERROR WindMeter getStatus ', err);
						me.setUnavailable();
					}
				}
			});
		} else {
			console.log('Windmeter settings not found, stop polling set unavailable');
			this.setUnavailable();

			// Only clear interval when the unavailable device is the only device on this driver
			// This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
			// In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem

		}
	}
	*/

  onDeleted() {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      console.log('--Stopped Polling--');
    }

    console.log(`deleted: ${JSON.stringify(this)}`);
  }
}

module.exports = HomeWizardWindmeter;
