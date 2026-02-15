'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

class HomeWizardKakusensors extends Homey.Driver {

  onInit() {
    // this.log('HomeWizard Kakusensors driver inited');
  }

  async onPair(socket) {

    await socket.showView('start');

    socket.setHandler('get_kakusensors', async () => {
      const fetchedDevices = homewizard.self.devices || {};
      const sensorList = [];
      const hwIds = Object.keys(fetchedDevices);

      await Promise.all(
        hwIds.map(hwId => {
          return new Promise(resolve => {
            homewizard.callnew(hwId, '/get-sensors', (err, response) => {
              if (err || !response) return resolve();

              const kakusensors = response.kakusensors || [];
              kakusensors.forEach(sensor => {
                sensorList.push({
                  id: sensor.id,
                  name: sensor.name,
                  type: sensor.type,
                  homewizard_id: hwId
                });
              });

              resolve();
            });
          });
        })
      );

      this.log('[PAIRING] Kakusensor list:', sensorList);
      socket.emit('kakusensor_list', sensorList);
    });

    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;
      const sensorId = device.settings.kakusensors_id;

      if (!hwId || sensorId === undefined) {
        socket.emit('error', this.homey.__("settings.selection_error"));
        return;
      }

      socket.emit('success', device);
    });

    socket.setHandler('disconnect', () => {});
  }
}

module.exports = HomeWizardKakusensors;
