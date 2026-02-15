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
    socket.setHandler('get_heatlinks', async () => {
      const fetchedDevices = homewizard.self.devices || {};
      const heatLinkList = [];

      Object.keys(fetchedDevices).forEach(hwId => {
        const device = fetchedDevices[hwId];
        const heatlinks = device.polldata?.heatlinks || [];
        
        if (Array.isArray(heatlinks) && heatlinks.length > 0) {
          heatLinkList.push({
            homewizard_id: hwId,
            name: device.name || device.settings?.homewizard_ip || hwId,
            ip: device.settings?.homewizard_ip,
            heatlink_name: heatlinks[0].name || 'HeatLink'
          });
        }
      });
      
      this.log('HomeWizard devices with HeatLinks:', heatLinkList.length);
      socket.emit('heatlink_list', heatLinkList);
    });

    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;
      
      if (!hwId || hwId === '') {
        socket.emit('error', 'No HomeWizard selected');
        return;
      }
      
      this.log(`HeatLink added ${device.data.id} on HomeWizard ${hwId}`);
      devices[device.data.id] = {
        id: device.data.id,
        name: device.name,
        settings: device.settings,
      };
      socket.emit('success', device);
    });

    socket.setHandler('disconnect', () => {
      this.log('User aborted pairing, or pairing is finished');
    });
  }

}

module.exports = HomeWizardHeatlink;


