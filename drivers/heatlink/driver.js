'use strict';

const Homey = require('homey');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('homewizard');
const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let homewizard_devices;

function callnewAsync(device_id, uri_part, {
  timeout = 5000,
  retries = 2,
  retryDelay = 3000
} = {}) {

  return new Promise((resolve, reject) => {

    let attempts = 0;

    const attempt = () => {
      attempts++;

      let timeoutId;
      let finished = false;

      // Timeout mechanisme
      timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          return setTimeout(attempt, retryDelay);
        }

        return reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);

      // De echte call
      homewizard.callnew(device_id, uri_part, (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);

        if (err) {
          if (attempts <= retries) {
            return setTimeout(attempt, retryDelay);
          }
          return reject(err);
        }

        return resolve(result);
      });
    };

    attempt();
  });
}

class HomeWizardHeatlink extends Homey.Driver {

  onInit() {
    //this.log('HomeWizard Heatlink has been inited');

    this.homey.flow.getActionCard('heatlink_off')
    // .register()
      .registerRunListener(async (args) => {
        if (!args.device) return false;

        try {
          await callnewAsync(args.device.getData().id, '/hl/0/settarget/0');
          this.log('flowCardAction heatlink_off -> returned true');
          return true;
        } catch (err) {
          this.log('ERR flowCardAction heatlink_off -> returned false: ', err.message);
          return false;
        }
      });
  }

  async onPair(socket) {
    // socket.on('get_homewizards', function () {
    await socket.setHandler('get_homewizards', () => {

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

    await socket.setHandler('manual_add', (device) => {

      if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        this.log(`HeatLink added ${device.data.id}`);
        devices[device.data.id] = {
          id: device.data.id,
          name: device.name,
          settings: device.settings,
        };
        // callback( null, devices );
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

module.exports = HomeWizardHeatlink;


