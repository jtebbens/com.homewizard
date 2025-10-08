'use strict';

const Homey = require('homey');

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('homewizard');
const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let homewizard_devices;

class HomeWizardHeatlink extends Homey.Driver {

  onInit() {
    console.log('HomeWizard Heatlink has been inited');

    this.homey.flow.getActionCard('heatlink_off')
    // .register()
      .registerRunListener((args) => {
        if (!args.device) {
          return false;
        }

        return new Promise((resolve) => {

          homewizard.callnew(args.device.getData().id, '/hl/0/settarget/0', (err) => {
            if (err) {
              console.log('ERR flowCardAction heatlink_off  -> returned false');
              return resolve(false);
            }

            console.log('flowCardAction heatlink_off  -> returned true');
            return resolve(true);
          });

        });
      });

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
    await socket.setHandler('showView', (viewId) => {
      console.log(`View: ${viewId}`);
      // this.log("data", viewId);
    });

    // socket.on('get_homewizards', function () {
    await socket.setHandler('get_homewizards', async () => {
      try {
        const homewizardDriver = this.homey.drivers.getDriver('homewizard');
        const homewizard_devices = homewizardDriver.getDevices();

        const fetchedDevices = await getDevicesAsync();

        const hw_devices = {};
        Object.keys(fetchedDevices).forEach((key) => {
          hw_devices[key] = fetchedDevices[key];
        });

        socket.emit('hw_devices', hw_devices);
      } catch (err) {
        console.error('Error during get_homewizards:', err);
      }
    });

    await socket.setHandler('manual_add', (device) => {

      if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        console.log(`HeatLink added ${device.data.id}`);
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
      console.log('User aborted pairing, or pairing is finished');
    });

  }

}

module.exports = HomeWizardHeatlink;
