'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');

module.exports = class HomeWizardEnergyWatermeterDriver extends Homey.Driver {

logDiscovery(status, detail = null) {
  const dbg = this.homey.settings.get('debug_discovery') || {};

  dbg.lastStatus = status;               // 'ok', 'error', 'timeout', 'not_found'
  dbg.lastDetail = detail ? String(detail) : null;
  dbg.lastUpdate = new Date().toISOString();

  this.homey.settings.set('debug_discovery', dbg);
}


  
/**
 * Discovers available devices and returns them for pairing.
 *
 * @async
 * @returns {Promise<Array>} List of discovered devices with name and ID.
 */
  async onPairListDevices() {

  const discoveryStrategy = this.getDiscoveryStrategy();
  this.logDiscovery('start', 'Beginning mDNS discovery');

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const discoveryResults = discoveryStrategy.getDiscoveryResults();
  const numberOfDiscoveryResults = Object.keys(discoveryResults).length;
  console.log('Discovered devices:', discoveryResults);

  const devices = [];
  await Promise.all(Object.values(discoveryResults).map(async (discoveryResult) => {
    try {
      const url = `http://${discoveryResult.address}:${discoveryResult.port}/api`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);

      const data = await res.json();

      this.logDiscovery('ok', `Found ${data.product_name} at ${discoveryResult.address}`);

      let name = data.product_name;
      if (numberOfDiscoveryResults > 1) {
        name = `${data.product_name} (${data.serial})`;
      }

      devices.push({
        name,
        data: { id: discoveryResult.id },
      });

    } catch (err) {
      console.log(`Discovery failed for ${discoveryResult.id}:`, err.message);
      this.logDiscovery('error', err.message);
    }
  }));

  if (devices.length === 0) {
    this.logDiscovery('not_found', 'No devices responded to mDNS');
    throw new Error('No new devices found on the network.');
  }

  return devices;
}


};
