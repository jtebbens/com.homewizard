'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');

module.exports = class HomeWizardEnergyWatermeterDriver extends Homey.Driver {

  
/**
 * Discovers available devices and returns them for pairing.
 *
 * @async
 * @returns {Promise<Array>} List of discovered devices with name and ID.
 */
  async onPairListDevices() {

    const discoveryStrategy = this.getDiscoveryStrategy();
    // Allow discovery process to settle 2seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const discoveryResults = discoveryStrategy.getDiscoveryResults();
    const numberOfDiscoveryResults = Object.keys(discoveryResults).length;
    console.log('Discovered devices:', discoveryResults);
        
    const devices = [];
    await Promise.all(Object.values(discoveryResults).map(async (discoveryResult) => {
      try {
        const url = `http://${discoveryResult.address}:${discoveryResult.port}/api`;
        const res = await fetch(url);
        if (!res.ok)
        { throw new Error(res.statusText); }

        const data = await res.json();

        // Construct device name
        let name = data.product_name;
        if (numberOfDiscoveryResults > 1) {
          name = `${data.product_name} (${data.serial})`;
        }

        devices.push({
          name,
          data: {
            id: discoveryResult.id,
          },
        });
      } catch (err) {
        this.error(`Discovery failed for ${discoveryResult.id}:`, err.message);
      }
    }));
    if (devices.length === 0) {
      throw new Error('No new devices found on the network.');
    }
    return devices;

  }

};
