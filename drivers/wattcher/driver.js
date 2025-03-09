'use strict';

const Homey = require('homey');

// const request = require('request');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('homewizard');
const devices = {};
const homewizard = require('../../includes/homewizard.js');

let homewizard_devices;

class HomeWizardWattcher extends Homey.Driver {
  onInit() {
    console.log('HomeWizard Wattcher has been inited');
  }

  async onPair(socket) {
    // Show a specific view by ID
    await socket.showView('start');

    // Show the next view
    await socket.nextView();

    // Show the previous view
    await socket.prevView();

    // Close the pair session
    await socket.done();

    // Received when a view has changed
    socket.setHandler('showView', (viewId) => {
      console.log(`View: ${viewId}`);
      this.log('data', viewId);
    });

    socket.setHandler('get_homewizards', () => {
      homewizard_devices = this.homey.drivers.getDriver('homewizard').getDevices();
      // socket.on('get_homewizards', function () {

      // homewizard_devices = driver.getDevices();

      homewizard.getDevices((homewizard_devices) => {
        const hw_devices = {};

        Object.keys(homewizard_devices).forEach((key) => {
          hw_devices[key] = homewizard_devices[key];
        });

        console.log(hw_devices);
        socket.emit('hw_devices', hw_devices);
      });
    });

    socket.setHandler('manual_add', (device) => {
      if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        console.log(`Wattcher added ${device.data.id}`);
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
      console.log('User aborted pairing, or pairing is finished');
    });
  }
}

module.exports = HomeWizardWattcher;
