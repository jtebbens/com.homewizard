'use strict';

const Homey = require('homey');
const homewizard = require('./../../includes/homewizard.js');
const debug = false;

let refreshIntervalId;
const devices = {};

class HomeWizardKakusensors extends Homey.Device {

  async onInit() {
    if (debug) {
      console.log('HomeWizard Kakusensors ' + this.getName() + ' has been initialized');
    }

    const driver = this.homey.drivers.getDriver('homewizard');
    const driverDevices = driver.getDevices();

    driverDevices.forEach(device => {
      if (debug) {
        console.log('add device: ' + JSON.stringify(device.getName()));
      }

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    if (Object.keys(devices).length > 0) {
      this.startPolling(devices);
    }

    this._flowTriggerLeak = this.homey.flow.getDeviceTriggerCard('leak_changed');

  }

  flowTriggerLeak( device, tokens ) {
    this._flowTriggerLeak.trigger( device, tokens ).catch( this.error )
  }

  startPolling(devices) {
    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId);
    }

    const me = this;

    // Start polling for thermometer
    refreshIntervalId = setInterval(async function() {
      if (debug) {
        console.log("--Start Kakusensors Polling--");
      }

      try {
        await me.getStatus(devices);
      } catch (error) {
        console.log('Error while polling:', error);
      }
    }, 1000 * 20);
  }

  async getStatus(devices) {
    if (debug) {
      console.log('Start Polling');
    }

    for (const index in devices) {
      if (devices[index].settings.homewizard_id !== undefined) {
        const homewizard_id = devices[index].settings.homewizard_id;
        const kakusensor_id = devices[index].settings.kakusensor_id;

        try {
          const result = await homewizard.getDeviceData(homewizard_id, 'kakusensors');

          if (Object.keys(result).length > 0) {
            for (const index2 in result) {
              if (result[index2].id === kakusensor_id) {
                const sensor_status_temp = result[index2].status;
                const sensor_status = sensor_status_temp === 'yes';

                switch (result[index2].type) {
                  case 'motion':
                    await handleCapability(devices[index], 'alarm_motion', sensor_status);
                    break;
                  case 'smoke868':
                    await handleCapability(devices[index], 'alarm_smoke', sensor_status);
                    await handleLowBatteryCapability(devices[index], result[index2].lowBattery);
                    break;
                  case 'leakage':
                    await handleCapability(devices[index], 'alarm_water', sensor_status);
                    await handleLowBatteryCapability(devices[index], result[index2].lowBattery);

                      // Leak
                      if (sensor_status != this.getStoreValue("last_sensor_status")) {
                        this.flowTriggerLeak(this, { leak_changed: sensor_status });
                        this.setStoreValue("last_sensor_status",sensor_status).catch(this.error);
                      }

                    break;
                  case 'smoke':
                    await handleCapability(devices[index], 'alarm_smoke', sensor_status);
                    devices[index].removeCapability('alarm_battery').catch(me.error);
                    break;
                  case 'contact':
                    await handleCapability(devices[index], 'alarm_contact', sensor_status);
                    break;
                  case 'doorbell':
                    await handleCapability(devices[index], 'alarm_generic', sensor_status);
                    break;
                }
              }
            }
          }
        } catch (error) {
          console.log('Error while getting Kakusensors data:', error);
        }
      }
    }
  }

  onDeleted() {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      if (debug) {
        console.log("--Stopped Polling--");
      }
    }

    console.log('deleted: ' + JSON.stringify(this));
  }

}

async function handleCapability(device, capability, sensorStatus) {
  if (!device.hasCapability(capability)) {
    await device.addCapability(capability);
  }

  if (device.getCapabilityValue(capability) !== sensorStatus) {
    if (debug) {
      console.log("New status - " + sensorStatus);
    }

    await device.setCapabilityValue(capability, sensorStatus);
  }
}

async function handleLowBatteryCapability(device, lowBattery) {
  if (lowBattery !== undefined && lowBattery !== null) {
    if (!device.hasCapability('alarm_battery')) {
      await device.addCapability('alarm_battery');
    }

    const lowBatteryStatus = lowBattery === 'yes';

    if (device.getCapabilityValue('alarm_battery') !== lowBatteryStatus) {
      console.log("New status - " + lowBatteryStatus);
      await device.setCapabilityValue('alarm_battery', lowBatteryStatus);
    }
  }
}

module.exports = HomeWizardKakusensors;
