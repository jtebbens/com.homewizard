'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const devices = {};

class HomeWizardWindmeter extends Homey.Driver {

  onInit() {
    // Driver initialized
  }

  async onPair(socket) {

    await socket.showView('start');

    socket.setHandler('showView', (viewId) => {
      this.log(`View: ${viewId}`);
    });

    socket.setHandler('get_homewizards', async () => {
      this.homey.drivers.getDriver('homewizard').getDevices();

      return new Promise((resolve) => {
        homewizard.getDevices((hwDevices) => {
          const result = {};

          Object.keys(hwDevices).forEach((key) => {
            result[key] = {
              id: key,
              name: hwDevices[key].name,
              settings: hwDevices[key].settings
            };
          });

          this.log('HomeWizard devices found:', Object.keys(result).length);
          socket.emit('hw_devices', result);
          resolve(result);
        });
      });
    });

    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;

      if (!hwId || hwId === '') {
        socket.emit('error', 'No HomeWizard selected');
        return;
      }

      this.log(`Windmeter added ${device.data.id} on HomeWizard ${hwId}`);

      devices[device.data.id] = {
        id: device.data.id,
        name: device.name,
        settings: device.settings,
      };

      socket.emit('success', device);
      return devices;
    });

    socket.setHandler('disconnect', () => {
      this.log('Pairing aborted or finished');
    });
  }
}

module.exports = HomeWizardWindmeter;
