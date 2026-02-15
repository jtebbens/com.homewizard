'use strict';

const Homey = require('homey');

// const request = require('request');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('homewizard');
const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let homewizard_devices;

class HomeWizardWattcher extends Homey.Driver {

  onInit() {
    // this.log('HomeWizard Wattcher has been inited');
  }

  async onPair(socket) {
    socket.setHandler('get_homewizards', async () => {
      homewizard_devices = this.homey.drivers.getDriver('homewizard').getDevices();

      return new Promise((resolve) => {
        homewizard.getDevices((homewizard_devices) => {
          const hw_devices = {};

          Object.keys(homewizard_devices).forEach((key) => {
            hw_devices[key] = {
              id: key,
              name: homewizard_devices[key].name,
              settings: homewizard_devices[key].settings
            };
          });

          this.log('HomeWizard devices found:', Object.keys(hw_devices).length);
          socket.emit('hw_devices', hw_devices);
          resolve(hw_devices);
        });
      });
    });

    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;
      
      if (!hwId || hwId === '') {
        socket.emit('error', 'No HomeWizard selected');
        return;
      }
      
      this.log(`Wattcher added ${device.data.id} on HomeWizard ${hwId}`);
      devices[device.data.id] = {
        id: device.data.id,
        name: device.name,
        settings: device.settings,
      };
      socket.emit('success', device);
      return devices;
    });

    socket.setHandler('disconnect', () => {
      this.log('User aborted pairing, or pairing is finished');
    });
  }
}

module.exports = HomeWizardWattcher;
