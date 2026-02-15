'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const devices = {};

class HomeWizardEnergyLink extends Homey.Driver {

  onInit() {
    // Driver initialized
  }

  async onPair(socket) {

    // Show initial view
    await socket.showView('start');

    // View change logging
    socket.setHandler('showView', (viewId) => {
      this.log(`View: ${viewId}`);
    });

    // Request list of EnergyLinks from all HomeWizard controllers
    socket.setHandler('get_energylinks', async () => {
      const fetchedDevices = homewizard.self.devices || {};
      const energyLinkList = [];

      this.log('[PAIRING] Fetched devices:', Object.keys(fetchedDevices));

      Object.keys(fetchedDevices).forEach(hwId => {
        const device = fetchedDevices[hwId];
        this.log(`[PAIRING] Device ${hwId} polldata:`, device.polldata ? 'exists' : 'missing');
        
        const energylinks = device.polldata?.energylinks || [];
        this.log(`[PAIRING] Device ${hwId} energylinks:`, energylinks);
        
        // Energylinks is een array
        if (Array.isArray(energylinks) && energylinks.length > 0) {
          energylinks.forEach(el => {
            energyLinkList.push({
              homewizard_id: hwId,
              energylink_id: el.id,
              name: el.name || 'EnergyLink',
              hw_name: device.name || device.settings?.homewizard_ip || hwId,
              hw_ip: device.settings?.homewizard_ip
            });
          });
        }
      });

      this.log('[PAIRING] EnergyLinks found:', energyLinkList.length, energyLinkList);
      socket.emit('energylink_list', energyLinkList);
    });

    // Manual add
    socket.setHandler('manual_add', async (device) => {
      const hwId = device.settings.homewizard_id;

      if (!hwId || hwId === '') {
        socket.emit('error', 'No HomeWizard selected');
        return;
      }

      this.log(`EnergyLink added ${device.data.id} on HomeWizard ${hwId}`);

      devices[device.data.id] = {
        id: device.data.id,
        name: device.name,
        settings: device.settings,
      };

      socket.emit('success', device);
    });

    socket.setHandler('disconnect', () => {
      this.log('Pairing aborted or finished');
    });
  }
}

module.exports = HomeWizardEnergyLink;
