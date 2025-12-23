'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('wattcher');

let refreshIntervalId;
const devices = {};


class HomeWizardWattcher extends Homey.Device {

  async onInit() {

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    this.log(`HomeWizard Wattcher ${this.getName()} has been inited`);

    const devices = this.homey.drivers.getDriver('wattcher').getDevices();
    devices.forEach((device) => {
      this.log(`add device: ${JSON.stringify(device.getName())}`);

      devices[device.getData().id] = device;
      devices[device.getData().id].settings = device.getSettings();
    });

    this.startPolling();
  }

  startPolling() {

    // Clear interval
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }

    // Start polling for thermometer
    this.refreshIntervalId = setInterval(() => {
      this.log('--Start Wattcher Polling-- ');

      this.getStatus();

    }, 1000 * 20);

  }

  async getStatus() {
    Promise.resolve()
      .then(async () => {

        if (this.getSetting('homewizard_id') !== undefined) {
          const homewizard_id = this.getSetting('homewizard_id');
          const callback = await homewizard.getDeviceData(homewizard_id, 'energymeters');

          if (Object.keys(callback).length > 0) {
            try {
              // this.log('Start capturing data');

              const energy_current_cons = callback[0].po; // WATTS Energy used JSON $energymeters[0]['po']
              const energy_daytotal_cons = callback[0].dayTotal; // KWH Energy used JSON $energymeters[0]['dayTotal']

              // Wattcher elec current
              this.setCapabilityValue('measure_power', energy_current_cons).catch(this.error);
              // Wattcher elec total day
              this.setCapabilityValue('meter_power', energy_daytotal_cons).catch(this.error);

              // this.log('End capturing data');
              // this.log('Wattcher usage- ' + energy_current_cons);
              // this.log('Wattcher Daytotal- ' + energy_daytotal_cons);
            } catch (err) {
              this.log('ERROR Wattcher getStatus ', err);
              this.setUnavailable(err);
            }
          }
        } else {
          this.log('Wattcher settings not found, stop polling set unavailable');
          this.setUnavailable();
          clearInterval(this.refreshIntervalId);

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
        clearInterval(this.refreshIntervalId);
      });
  }

  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(this.refreshIntervalId);
      this.log('--Stopped Polling--');
    }

    this.log(`deleted: ${JSON.stringify(this)}`);
  }

}

module.exports = HomeWizardWattcher;
