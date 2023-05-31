'use strict';

const Homey = require('homey');
const homewizard = require('./../../includes/homewizard.js');

let refreshIntervalId;
const devices = {};

class HomeWizardWindmeter extends Homey.Device {
  async onInit() {
    console.log('HomeWizard Windmeter ' + this.getName() + ' has been initialized');

    const devices = this.homey.drivers.getDriver('windmeter').getDevices();
    devices.forEach((device) => {
      console.log('add device: ' + JSON.stringify(device.getName()));

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();
  }

  startPolling() {
    const me = this;

    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    refreshIntervalId = setInterval(async function () {
      me.getStatus();
    }, 1000 * 20);
  }

  async getStatus() {
	const me = this;
	const debug = false;
  
	if (this.getSetting('homewizard_id') !== undefined) {
	  const homewizard_id = this.getSetting('homewizard_id');
  
	  try {
		const callback = await homewizard.getDeviceData(homewizard_id, 'windmeters');
  
		if (Object.keys(callback).length > 0) {
		  try {
			me.setAvailable();
  
			if (debug) {
			  me.log('Start capturing data');
			}
  
			const wind_angle_tmp = callback[0].dir; // $windmeters[0]['dir'] SW 225
			const wind_angle_int = wind_angle_tmp.split(' ');
			const wind_angle_str = wind_angle_int[1];
			const wind_angle = parseInt(wind_angle_str);
			const wind_strength_current = callback[0].ws; // $windmeters[0]['ws'] Windspeed in km/h
			const wind_strength_min = callback[0]['ws-']; // $windmeters[0]['ws-'] Min Windspeed in km/h
			const wind_strength_max = callback[0]['ws+']; // $windmeters[0]['ws+'] Max Windspeed in km/h
			const gust_strength = callback[0].gu; // $windmeters[0]['gu'] Gust speed in km/h
			const temp_real = callback[0].te; // $windmeters[0]['te'] Temperature
			const temp_windchill = callback[0].wc; // $windmeters[0]['wc'] Windchill temperature
  
			if (debug) {
			  console.log('End capturing data');
			}
  
			await me.setCapabilityValue('measure_wind_angle', wind_angle).catch(me.error);
			await me.setCapabilityValue('measure_wind_strength.cur', wind_strength_current).catch(me.error);
			await me.setCapabilityValue('measure_wind_strength.min', wind_strength_min).catch(me.error);
			await me.setCapabilityValue('measure_wind_strength.max', wind_strength_max).catch(me.error);
			await me.setCapabilityValue('measure_gust_strength', gust_strength).catch(me.error);
			await me.setCapabilityValue('measure_temperature.real', temp_real).catch(me.error);
			await me.setCapabilityValue('measure_temperature.windchill', temp_windchill).catch(me.error);
		  } catch (err) {
			console.log('ERROR WindMeter getStatus ', err);
			me.setUnavailable();
		  }
		}
	  } catch (error) {
		console.log('Windmeter data error', error);
		me.setUnavailable();
	  }
	} else {
	  console.log('Windmeter settings not found, stop polling and set unavailable');
	  this.setUnavailable();
  
	  if (Object.keys(devices).length === 1) {
		clearInterval(refreshIntervalId);
	  }
	}
  }
  

  onDeleted() {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      console.log('--Stopped Polling--');
    }

    console.log('deleted: ' + JSON.stringify(this));
  }
}

module.exports = HomeWizardWindmeter;
