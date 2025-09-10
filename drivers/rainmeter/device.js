'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('rainmeter');

var refreshIntervalId;
const devices = {};
// var temperature;

class HomeWizardRainmeter extends Homey.Device {

  onInit() {

    console.log(`HomeWizard Rainmeter ${this.getName()} has been inited`);

    const devices = this.homey.drivers.getDriver('rainmeter').getDevices();
    devices.forEach((device) => {
      console.log(`add device: ${JSON.stringify(device.getName())}`);

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();

    this._flowTriggerValueChanged = this.homey.flow.getDeviceTriggerCard('rainmeter_value_changed');

  }

  flowTriggerValueChanged(device, tokens) {
    this._flowTriggerValueChanged.trigger(device, tokens).catch(this.error);
  }

  startPolling() {

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(() => {
      // console.log("--Start Rainmeter Polling-- ");

      this.getStatus();

    }, 1000 * 20);

  }

  async getStatus() {
    Promise.resolve()
      .then(async () => {

        const me = this;

        if (this.getSetting('homewizard_id') !== undefined) {
          const homewizard_id = this.getSetting('homewizard_id');
          const callback = await homewizard.getDeviceData(homewizard_id, 'rainmeters');

          if (Object.keys(callback).length > 0) {
            try {
              // me.setAvailable();

              // Check Battery
              if (callback[0].lowBattery != undefined && callback[0].lowBattery != null) {
                if (!this.hasCapability('alarm_battery')) {
                  await this.addCapability('alarm_battery').catch(me.error);
                }

                const lowBattery_temp = callback[0].lowBattery;
                const lowBattery_status = lowBattery_temp == 'yes';

                if (this.getCapabilityValue('alarm_battery') != lowBattery_status) {
                  // if (debug) { console.log("New status - " + lowBattery_status); }
                  await this.setCapabilityValue('alarm_battery', lowBattery_status).catch(me.error);
                }
              } else if (this.hasCapability('alarm_battery')) {
                await this.removeCapability('alarm_battery').catch(me.error);
              }

              const rain_daytotal = callback[0].mm; // Total Rain in mm used JSON $rainmeters[0]['mm']
              const rain_last3h = callback[0]['3h']; // Last 3 hours rain in mm used JSON $rainmeters[0]['3h']

              // Rain last 3 hours
              await me.setCapabilityValue('measure_rain.last3h', rain_last3h).catch(me.error);

              // Rain total day
              await me.setCapabilityValue('measure_rain.total', rain_daytotal).catch(me.error);

              // Trigger flows
              if (rain_daytotal != me.getStoreValue('last_raintotal') && rain_daytotal != 0 && rain_daytotal != undefined && rain_daytotal != null) {
                me.flowTriggerValueChanged(me, { rainmeter_changed: rain_daytotal });
                await me.setStoreValue('last_raintotal', rain_daytotal).catch(me.error); // Update last_raintotal
              }
            } catch (err) {
              console.log('ERROR RainMeter getStatus ', err);
              me.setUnavailable();
            }
          }
        } else {
          console.log('Rainmeter settings not found, stop polling set unavailable');
          // this.setUnavailable();

          // Only clear interval when the unavailable device is the only device on this driver
          // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
          // In the event that a user has multiple devices with old settings, this function will get called every 10 seconds, but that should not be a problem
        }
      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }

  /*
	getStatus() {

		var me = this;

		if(this.getSetting('homewizard_id') !== undefined ) {
			var homewizard_id = this.getSetting('homewizard_id');

			homewizard.getDeviceData(homewizard_id, 'rainmeters', function(callback) {
				if (Object.keys(callback).length > 0) {
					try {
						me.setAvailable();

						var rain_daytotal = ( callback[0].mm ); // Total Rain in mm used JSON $rainmeters[0]['mm']
						var rain_last3h = ( callback[0]['3h'] ); // Last 3 hours rain in mm used JSON $rainmeters[0]['3h']
						// Rain last 3 hours
						me.setCapabilityValue("measure_rain.last3h", rain_last3h ).catch(me.error);
						// Rain total day
						me.setCapabilityValue("measure_rain.total", rain_daytotal ).catch(me.error);

						// Trigger flows
						if (rain_daytotal != me.getStoreValue("last_raintotal") && rain_daytotal != 0 && rain_daytotal != undefined && rain_daytotal != null) {
							//console.log("Current Total Rainfall - "+ rain_daytotal);
							me.flowTriggerValueChanged(me, {rainmeter_changed: rain_daytotal})
						  me.setStoreValue("last_raintotal",rain_daytotal); // Update last_raintotal
						}

					} catch (err) {
						console.log('ERROR RainMeter getStatus ', err);
						me.setUnavailable();
					}
				}
			});
		} else {
			console.log('Rainmeter settings not found, stop polling set unavailable');
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

module.exports = HomeWizardRainmeter;
