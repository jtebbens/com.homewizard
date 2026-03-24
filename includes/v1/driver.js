'use strict';

const Homey = require('homey');
const fetchWithTimeout = require('../utils/fetchWithTimeout');


module.exports = class HomeWizardEnergyWatermeterDriver extends Homey.Driver {

logDiscovery(status, detail = null) {
  const dbg = this.homey.settings.get('debug_discovery') || {};

  dbg.lastStatus = status;               // 'ok', 'error', 'timeout', 'not_found'
  dbg.lastDetail = detail ? String(detail) : null;
  dbg.lastUpdate = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour12: false }),

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
  //console.log('Discovered devices:', discoveryResults); Error: Circular Reference "device"

  console.log(
    '[DISCOVERY]',
    Object.values(discoveryResults).map(r => ({
      id: r.id,
      address: r.address,
      port: r.port,
      product: r.txt?.product_name,
      serial: r.txt?.serial,
    }))
  );


  const devices = [];
  const results = Object.values(discoveryResults);

  // Al-gepaarde devices hoeven niet opnieuw geverifieerd te worden via HTTP —
  // we kennen hun naam al. Alleen nieuwe (nog niet gepaarde) devices fetchen.
  // Dit voorkomt een RSS-piek van 16+ gelijktijdige fetches bij grote setups.
  const pairedMap = new Map(
    this.getDevices().map(d => [d.getData().id, d.getName()])
  );

  for (const r of results) {
    if (pairedMap.has(r.id)) {
      devices.push({ name: pairedMap.get(r.id), data: { id: r.id } });
    }
  }

  const newResults = results.filter(r => !pairedMap.has(r.id));
  console.log(`[DISCOVERY] ${pairedMap.size} al-gepaird (geen fetch), ${newResults.length} nieuw te verifiëren`);

  const CONCURRENCY = 2;
  for (let i = 0; i < newResults.length; i += CONCURRENCY) {
    const batch = newResults.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (discoveryResult) => {
      try {
        const url = `http://${discoveryResult.address}:${discoveryResult.port}/api`;
        const res = await fetchWithTimeout(url, {}, 2000);
        if (!res.ok) throw new Error(res.statusText);

        const data = await res.json();

        const productName = typeof data.product_name === 'string' && data.product_name
          ? data.product_name
          : (data.product_type || 'HomeWizard Device');

        this.logDiscovery('ok', `Found ${productName} at ${discoveryResult.address}`);

        let name = productName;
        if (numberOfDiscoveryResults > 1) {
          name = `${productName} (${data.serial || discoveryResult.id})`;
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
  }

  if (devices.length === 0) {
    this.logDiscovery('not_found', 'No devices responded to mDNS');
    throw new Error(this.homey.__('pair.no_devices_found'));
  }

  return devices;
}

async onRepair(session, device) {
  console.log('[REPAIR] Starting repair session for device:', device.getName());

  // Get current manual IP if set
  session.setHandler('get_current_ip', async () => {
    const manualIP = device.getSetting('manual_ip');
    const discoveryIP = device.getStoreValue('address');
    return {
      manual_ip: manualIP || '',
      discovery_ip: discoveryIP || this.homey.__('repair.unknown'),
      using_manual: !!manualIP
    };
  });

  // Validate and set manual IP
  session.setHandler('set_manual_ip', async (data) => {
    const ip = data.ip?.trim();
    
    // Clear manual IP if requested
    if (data.clear) {
      await device.setSettings({ manual_ip: '' });
      console.log('[REPAIR] Manual IP cleared, returning to mDNS discovery');
      return { success: true };
    }

    // Validate IP format
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      throw new Error(this.homey.__('repair.invalid_ip'));
    }

    // Test connection to device
    try {
      const response = await fetchWithTimeout(`http://${ip}/api`, { method: 'GET' }, 5000);

      if (!response.ok) {
        throw new Error(this.homey.__('repair.connection_failed'));
      }

      const apiData = await response.json();
      
      // Verify it's the same device by serial number
      if (apiData.serial && apiData.serial !== device.getData().id) {
        throw new Error(this.homey.__('repair.wrong_device'));
      }

      // Save manual IP
      await device.setSettings({ manual_ip: ip });
      console.log('[REPAIR] Manual IP set to:', ip);

      // Trigger device reconnection if it has the method
      if (typeof device.reconnectWithManualIP === 'function') {
        await device.reconnectWithManualIP(ip);
      }

      return { success: true };

    } catch (error) {
      console.error('[REPAIR] Connection test failed:', error.message);
      throw new Error(this.homey.__('repair.connection_failed') + ': ' + error.message);
    }
  });
}


};
