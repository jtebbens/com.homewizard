'use strict';

const Homey = require('homey');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let homewizard_devices;

class HomeWizardRainmeter extends Homey.Driver {

  onInit() {
    // this.log('HomeWizard Rainmeter has been inited');
  }

  async onPair(socket) {
    // socket.on('get_homewizards', function () {
    socket.setHandler('get_homewizards', () => {

      // homewizard_devices = driver.getDevices();
      homewizard_devices = this.homey.drivers.getDriver('homewizard').getDevices();

      homewizard.getDevices((homewizard_devices) => {
        const hw_devices = {};

        Object.keys(homewizard_devices).forEach((key) => {
          hw_devices[key] = homewizard_devices[key];
        });

        this.log(hw_devices);
        socket.emit('hw_devices', hw_devices);

      });
    });

    socket.setHandler('manual_add', (device) => {

      if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        this.log(`Rainmeter added ${device.data.id}`);
        devices[device.data.id] = {
          id: device.data.id,
          name: device.name,
          settings: device.settings,
        };
        socket.emit('success', device);
        return devices;

      }
      socket.emit('error', 'No valid HomeWizard found, re-pair if problem persists');

    });

    socket.setHandler('disconnect', () => {
      this.log('User aborted pairing, or pairing is finished');
    });

  }

}

module.exports = HomeWizardRainmeter;
