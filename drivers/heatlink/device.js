'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');
//const { ManagerDrivers } = require('homey');
//const driver = ManagerDrivers.getDriver('heatlink');

var refreshIntervalId;
var devices = {};
//var temperature;

var debug = false;

class HomeWizardHeatlink extends Homey.Device {

	onInit() {

		console.log('HomeWizard Heatlink '+this.getName() +' has been inited');


		const devices = this.homey.drivers.getDriver('heatlink').getDevices(); // or heatlink
		devices.forEach(function initdevice(device) {
			console.log('add device: ' + JSON.stringify(device.getName()));

			devices[device.getData().id] = device;
			devices[device.getData().id].settings = device.getSettings();
		});

		this.startPolling();

		this.registerCapabilityListener('target_temperature', ( temperature) => {
			// Catch faulty trigger and max/min temp
			if (!temperature) {
				//callback(true, temperature);
				return false;
			}
			else if (temperature < 5) {
				temperature = 5;
			}
			else if (temperature > 35) {
				temperature = 35;
			}
			temperature = Math.round(temperature.toFixed(1) * 2) / 2;

			return new Promise((resolve) => {
					var url = '/hl/0/settarget/'+temperature;
					console.log(url); // Console log url
					var homewizard_id = this.getSetting('homewizard_id');
			    homewizard.callnew(homewizard_id, '/hl/0/settarget/'+temperature, function(err) {
						if (err) {
							console.log('ERR settarget target_temperature -> returned false');
							return resolve(false);
						}
						console.log('settarget target_temperature - returned true');
						return resolve(true);
				});
			});
			//return Promise.resolve(); eslint?
		});
	}

	startPolling() {

		// Clear interval
		if (this.refreshIntervalId) {
			clearInterval(this.refreshIntervalId);
		}

		// Start polling for thermometer
		this.refreshIntervalId = setInterval(() => {
			if (debug) {console.log("--Start Heatlink Polling-- ");}

			this.getStatus();

		}, 1000 * 20 );

	}

	async getStatus() {
		if (this.getSetting('homewizard_id') !== undefined) {
		  const homewizard_id = this.getSetting('homewizard_id');
	
		  try {
			const callback = await homewizard.getDeviceData(homewizard_id, 'heatlinks');
	
			if (Object.keys(callback).length > 0) {
			  this.setAvailable();
	
			  const rte = (callback[0].rte.toFixed(1) * 2) / 2;
			  const rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
			  const tte = (callback[0].tte.toFixed(1) * 2) / 2;
			  const wte = (callback[0].wte.toFixed(1) * 2) / 2;
	
			  if (this.getStoreValue('temperature') != rte) {
				if (debug) {console.log('New RTE - ' + rte);}
				this.setCapabilityValue('measure_temperature', rte);
				this.setStoreValue('temperature', rte);
			  } else {
				if (debug) {console.log('RTE: no change');}
			  }
	
			  if (this.getStoreValue('thermTemperature') != rsp) {
				if (debug){console.log('New RSP - ' + rsp);}
				if (this.getStoreValue('setTemperature') === 0) {
				  this.setCapabilityValue('target_temperature', rsp);
				}
				this.setStoreValue('thermTemperature', rsp);
			  } else {
				if (debug){console.log('RSP: no change');}
			  }
	
			  if (this.getStoreValue('setTemperature') != tte) {
				if (debug){console.log('New TTE - ' + tte);}
				if (tte > 0) {
				  this.setCapabilityValue('target_temperature', tte);
				} else {
				  this.setCapabilityValue('target_temperature', this.getStoreValue('thermTemperature'));
				}
				this.setStoreValue('setTemperature', tte);
			  } else {
				if (debug){console.log('TTE: no change');}
			  }
	
			  if (!this.hasCapability('measure_temperature.boiler')) {
				this.addCapability('measure_temperature.boiler');
			  }
			  this.setCapabilityValue('measure_temperature.boiler', wte);
	
			  if (!this.hasCapability('measure_temperature.heatlink')) {
				this.addCapability('measure_temperature.heatlink');
			  }
			  this.setCapabilityValue('measure_temperature.heatlink', tte);
	
			  if (!this.hasCapability('central_heating_flame')) {
				this.addCapability('central_heating_flame');
			  }
			  this.setCapabilityValue('central_heating_flame', callback[0].heating === 'on');
	
			  if (!this.hasCapability('central_heating_pump')) {
				this.addCapability('central_heating_pump');
			  }
			  this.setCapabilityValue('central_heating_pump', callback[0].pump === 'on');
	
			  if (!this.hasCapability('measure_pressure')) {
				this.addCapability('measure_pressure');
			  }
			  this.setCapabilityValue('measure_pressure', callback[0].wp);
			}
		  } catch (error) {
			console.log('Heatlink data error', error);
			this.setUnavailable();
		  }
		} else {
		  console.log('HW ID not found');
		  if (Object.keys(devices).length === 1) {
			clearInterval(this.refreshIntervalId);
		  }
		}
	  }
	  

/*
	getStatus() {

		var me = this;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			//me.log('Gather data');

			homewizard.getDeviceData(homewizard_id, 'heatlinks', function(callback) {

				if (Object.keys(callback).length > 0) {

					try {
						me.setAvailable();
						if (callback[0].rte != null) {
						var rte = (callback[0].rte.toFixed(1) * 2) / 2;
                		var rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
                		var tte = (callback[0].tte.toFixed(1) * 2) / 2;
						}
						//Check current temperature
						if (me.getStoreValue('temperature') != rte) {
							if (debug) {console.log("New RTE - "+ rte);}
							me.setCapabilityValue('measure_temperature', rte ).catch(me.error);
							me.setStoreValue('temperature',rte).catch(me.error);
						} else {
							if (debug) {console.log("RTE: no change");}
						}

						//Check thermostat temperature
						if (me.getStoreValue('thermTemperature') != rsp) {
							if (debug) {console.log("New RSP - "+ rsp);}
						  if (me.getStoreValue('setTemperature') === 0) {
							me.setCapabilityValue('target_temperature', rsp).catch(me.error);
						  }
							me.setStoreValue('thermTemperature',rsp).catch(me.error);
						} else {
							if (debug) {console.log("RSP: no change");}
						}

						//Check heatlink set temperature
						if (me.getStoreValue('setTemperature') != tte) {
							if (debug) {console.log("New TTE - "+ tte);}
						  if (tte > 0) {
							 me.setCapabilityValue('target_temperature', tte).catch(me.error);
						  } else {
							 me.setCapabilityValue('target_temperature',me.getStoreValue('thermTemperature')).catch(me.error);
						  }
							 me.setStoreValue('setTemperature',tte).catch(me.error);
						} else {
							if (debug) {console.log("TTE: no change");}
						}
					} catch (err) {
						console.log ("Heatlink data corrupt", err);
						me.setUnavailable();
					}
				} else {
					me.log('No data');
				}
			});
		} else {
			console.log('HW ID not found');
			if(Object.keys(devices).length === 1) {
				clearInterval(refreshIntervalId);
			}
		}
	}

	*/

onDeleted() {

		if (Object.keys(devices).length === 0) {
			clearInterval(refreshIntervalId);
			console.log("--Stopped Polling--");
		}

		console.log('deleted: ' + JSON.stringify(this));
	}

}

module.exports = HomeWizardHeatlink;
