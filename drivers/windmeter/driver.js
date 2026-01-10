'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const devices = {};

class HomeWizardWindmeter extends Homey.Driver {

  onInit() {
    // Driver initialized
  }

  onPair(socket) {

    // Show initial view
    socket.showView('start');

    // View change logging
    socket.setHandler('showView', (viewId) => {
      this.log(`View: ${viewId}`);
    });

    // Request list of HomeWizard controllers
    socket.setHandler('get_homewizards', () => {

      this.homey.drivers.getDriver('homewizard').getDevices();

      homewizard.getDevices((hwDevices) => {
        const result = {};

        Object.keys(hwDevices).forEach((key) => {
          result[key] = hwDevices[key];
        });

        this.log(result);
        socket.emit('hw_devices', result);
      });
    });

    // Add device manually
    socket.setHandler('manual_add', (device) => {

      const id = device.settings.homewizard_id;

      if (id.indexOf('HW_') === -1 && id.indexOf('HW') === 0) {

        this.log(`Windmeter added ${device.data.id}`);

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
      this.log('Pairing aborted or finished');
    });
  }
}

module.exports = HomeWizardWindmeter;
