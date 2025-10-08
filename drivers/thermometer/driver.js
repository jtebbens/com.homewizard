'use strict';

const Homey = require('homey');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

//let homewizard_devices;

class HomeWizardThermometer extends Homey.Driver {

  onInit() {
    console.log('HomeWizard Thermometer has been inited');
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
        // You can keep this if you plan to use main unit metadata later
        const homewizardDriver = this.homey.drivers.getDriver('homewizard');
        const mainUnitDevices = homewizardDriver?.getDevices?.();

        if (!Array.isArray(mainUnitDevices)) {
          console.warn('Main unit driver did not return an array');
        }

        // This is your actual device registry
        const fetchedDevices = await getDevicesAsync();
        const hw_devices = {};

        for (const [key, device] of Object.entries(fetchedDevices)) {
          const thermometers = device.polldata?.thermometers ?? {};
          hw_devices[key] = {
            id: key,
            name: device.name,
            model: device.model,
            thermometers,
            // Add other fields if needed
          };
        }

        console.log(`Emitting ${Object.keys(hw_devices).length} devices`);
        socket.emit('hw_devices', hw_devices);
      } catch (err) {
        console.error('Error emitting hw_devices:', err);
      }
    });



    await socket.setHandler('manual_add', (device) => {
      if (typeof device.settings.homewizard_id == 'string' && device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        console.log(`Thermometer added ${device.data.id}`);
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

    await socket.setHandler('disconnect', () => {
      console.log('User aborted pairing, or pairing is finished');
    });
  }

  onPairListDevices(data, callback) {
    const devices = [

    ];

    callback(null, devices);
  }

}

module.exports = HomeWizardThermometer;
