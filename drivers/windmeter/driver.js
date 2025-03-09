'use strict';

const Homey = require('homey');

const devices = {};
const homewizard = require('../../includes/homewizard.js');

let homewizard_devices;

class HomeWizardWindmeter extends Homey.Driver {
  onInit() {
    console.log('HomeWizard Windmeter has been inited');
  }

  onPair(socket) {
    // Show a specific view by ID
    socket.showView('start');

    // Show the next view
    socket.nextView();

    // Show the previous view
    socket.prevView();

    // Close the pair session
    socket.done();

    // Received when a view has changed
    socket.setHandler('showView', (viewId) => {
      console.log(`View: ${viewId}`);
      // this.log("data", viewId);
    });

    socket.setHandler('get_homewizards', () => {
      // const devices = this.homey.drivers.getDriver('homewizard').getDevices(); eslint
      this.homey.drivers.getDriver('homewizard').getDevices();

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
        console.log(`Windmeter added ${device.data.id}`);
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

module.exports = HomeWizardWindmeter;
