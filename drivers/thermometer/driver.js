'use strict';

const Homey = require('homey');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');


class HomeWizardThermometer extends Homey.Driver {

  onInit() {
    // console.log('HomeWizard Thermometer has been inited');
  }

  async onPair(socket) {
    let homewizard_devices;
    // Show a specific view by ID
    await socket.showView('start');

    // Show the next view
    // await socket.nextView();

    // Show the previous view
    // await socket.prevView();

    // Close the pair session
    // await socket.done();

    // Received when a view has changed
    await socket.setHandler('showView', (viewId) => {
      console.log(`View: ${viewId}`);
      // this.log("data", viewId);
    });

    // socket.on('get_homewizards', function () {
await socket.setHandler('get_homewizards', async () => {
  const hwDevices = this.homey.drivers.getDriver('homewizard').getDevices();

  homewizard.getDevices((fetchedDevices) => {
    const thermometerList = [];

    Object.keys(fetchedDevices).forEach((hwId) => {
      const thermometers = fetchedDevices[hwId].polldata?.thermometers;
      if (Array.isArray(thermometers)) {
        thermometers.forEach((t) => {
          thermometerList.push({
            id: t.id,
            name: t.name,
            homewizard_id: hwId
          });
        });
      }
    });

    console.log('[PAIRING] Emitting thermometer list:', thermometerList);
    socket.emit('thermometer_list', thermometerList);
  });
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
