'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

class HomeWizardKakusensors extends Homey.Driver {

  onInit() {
    // this.log('HomeWizard Kakusensors driver inited');
  }

  async onPair(socket) {

    await socket.showView('start');

    socket.setHandler('get_homewizards', async () => {
      const hwDevices = this.homey.drivers.getDriver('homewizard').getDevices();
      const result = {};

      await Promise.all(
        Object.keys(hwDevices).map(hwId => {
          return new Promise(resolve => {
            homewizard.callnew(hwId, '/get-sensors', (err, response) => {
              if (err || !response) {
                result[hwId] = { id: hwId, kakusensors: [] };
                return resolve();
              }

              result[hwId] = {
                id: hwId,
                kakusensors: response.kakusensors || []
              };

              resolve();
            });
          });
        })
      );

      socket.emit('hw_devices', result);
    });

    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;
      const sensorId = device.settings.kakusensors_id;

      if (!hwId || !sensorId) {
        socket.emit('error', this.homey.__("settings.selection_error"));
        return;
      }

      // Sensor type opslaan
      const sensors = device.kakusensors;
      const selected = sensors[sensorId];

      if (!selected) {
        socket.emit('error', this.homey.__("settings.notfound_error"));
        return;
      }

      device.settings.kakusensor_type = selected.type;

      socket.emit('success', device);
      return device;
    });

    socket.setHandler('disconnect', () => {});
  }
}

module.exports = HomeWizardKakusensors;
