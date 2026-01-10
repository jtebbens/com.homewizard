'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const devices = {};

class HomeWizardEnergyLink extends Homey.Driver {

  onInit() {
    // Driver initialized
  }

  async onPair(socket) {

    // Show initial view
    await socket.showView('start');

    // View change logging
    socket.setHandler('showView', (viewId) => {
      this.log(`View: ${viewId}`);
    });

    // Request list of HomeWizard controllers
    socket.setHandler('get_homewizards', () => {

      const hwControllers = this.homey.drivers.getDriver('homewizard').getDevices();

      homewizard.getDevices((hwDevices) => {
        const result = {};

        Object.keys(hwDevices).forEach((key) => {

          const energylinks = hwDevices[key].polldata?.energylinks || {};

          result[key] = {
            id: key,
            name: hwDevices[key].name,
            settings: hwDevices[key].settings,
            energylinks: energylinks
          };
        });

        socket.emit('hw_devices', result);
      });
    });

    // Manual add
    socket.setHandler('manual_add', (device) => {

      const id = device.settings.homewizard_id;

      if (id.indexOf('HW_') === -1 && id.indexOf('HW') === 0) {

        this.log(`EnergyLink added ${device.data.id}`);

        devices[device.data.id] = {
          id: device.data.id,
          name: 'EnergyLink',
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

module.exports = HomeWizardEnergyLink;
