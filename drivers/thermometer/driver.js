'use strict';

const Homey = require('homey');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');


class HomeWizardThermometer extends Homey.Driver {

  onInit() {
    // this.log('HomeWizard Thermometer has been inited');
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
      this.log(`View: ${viewId}`);
      // this.log("data", viewId);
    });

    // socket.on('get_homewizards', function () {
    await socket.setHandler('get_homewizards', async () => {
      const fetchedDevices = homewizard.self.devices || {};
      const thermometerList = [];

      const hwIds = Object.keys(fetchedDevices);

      // We wachten op ALLE /get-sensors calls
      await Promise.all(
        hwIds.map(hwId => {
          return new Promise(resolve => {
            homewizard.callnew(hwId, '/get-sensors', (err, response) => {
              if (err || !response) return resolve();

              const thermometers = response.thermometers || [];
              thermometers.forEach(t => {
                thermometerList.push({
                  id: t.id,
                  name: t.name,
                  homewizard_id: hwId
                });
              });

              resolve();
            });
          });
        })
      );

      this.log('[PAIRING] Emitting thermometer list:', thermometerList);
      socket.emit('thermometer_list', thermometerList);
    });



    await socket.setHandler('manual_add', async (device) => {
  const hwId = device.settings.homewizard_id;
  const sensorId = device.settings.thermometer_id;

  if (!hwId || sensorId === undefined) {
    socket.emit('error', 'Invalid selection');
    return;
  }

  // Zoek thermometer opnieuw via /get-sensors
  homewizard.callnew(hwId, '/get-sensors', (err, response) => {
    if (err || !response) {
      socket.emit('error', 'Could not read sensors');
      return;
    }

    const selected = (response.thermometers || []).find(t => t.id == sensorId);
    if (!selected) {
      socket.emit('error', 'Thermometer not found');
      return;
    }

    // Naam opslaan
    device.settings.thermometer_name = selected.name;

    devices[device.data.id] = {
      id: device.data.id,
      name: device.name,
      settings: device.settings,
    };

    socket.emit('success', device);
  });
});



    await socket.setHandler('disconnect', () => {
      this.log('User aborted pairing, or pairing is finished');
    });
  }

  onPairListDevices(data, callback) {
    const devices = [

    ];

    callback(null, devices);
  }

}

module.exports = HomeWizardThermometer;
