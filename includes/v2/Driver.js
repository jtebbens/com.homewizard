'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const https = require('https');

/**
 * Helper method to request a token from the HomeWizard Energy device
 *
 * @param {string} address
 * @returns {string|null} token or null if the button has not been pressed yet
 * @throws {Error} When response is not 200 or token is not present
 */
async function requestToken(address) {
  const payload = {
    name: `local/homey_${Math.random().toString(16).substr(2, 6)}`,
  };

  console.log('Trying to get token...');

  // The request...
  const response = await fetch(`https:/${address}/api/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': '2',
    },
    body: JSON.stringify(payload),
    agent: new (https.Agent)({ rejectUnauthorized: false }),
  });

  // See if we get an unauthorized response, meaning the button has not been pressed yet
  if (response.status == 403) {
    console.log('Button not pressed yet...');
    return null;
  }

  // Some error checking
  if (response.status != 200) {
    throw new Error(response.statusText);
  }

  const result = await response.json();

  if (result.token === undefined) {
    throw new Error('No token received');
  }

  return result.token;
}

module.exports = class HomeWizardEnergyDriverV2 extends Homey.Driver {

  logDiscovery(status, detail = null) {
    const dbg = this.homey.settings.get('debug_discovery') || {};

    dbg.lastStatus = status;               // 'ok', 'error', 'not_found'
    dbg.lastDetail = detail ? String(detail) : null;
    dbg.lastUpdate = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour12: false }),

    this.homey.settings.set('debug_discovery', dbg);
  }


  async onPair(session) {

    // Initialize variables to prevent undefined errors
    this.interval = null;
    this.timeout = null;
    this.devices = [];

    // First screen, get list of devices.
    session.setHandler('list_devices', async () => {

      const discoveryStrategy = this.getDiscoveryStrategy();
      const discoveryResults = discoveryStrategy.getDiscoveryResults();

      // console.log('Discovered devices:', discoveryResults); Error: Circular Reference "device"
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


      if (!discoveryResults || Object.keys(discoveryResults).length === 0) {
        this.logDiscovery('not_found', 'No devices found via mDNS');
        
        // Throw helpful error to guide users with mDNS/network issues
        throw new Error(this.homey.__('pair.no_devices_found'));
      } else {
        this.logDiscovery('ok', `Found ${Object.keys(discoveryResults).length} devices`);
      }


      // Return list of devices, we do not test if device is reachable as we trust the discovery results
      const devices = [];
      for (const discoveryResult of Object.values(discoveryResults)) {

        devices.push({
          name: `${discoveryResult.txt.product_name} (${discoveryResult.txt.serial.substr(6)})`,
          data: {
            id: discoveryResult.txt.serial,
          },
          store: {
            address: discoveryResult.address, // Used for the authorize step, not _really_ needed later on
          },
        });
      }

      return devices;
    });

    // Undocumented event, triggered when the user selects a device
    // This is a list of devices. We only expect exactly one device to be selected,
    // as enforced by the singular option in driver.compose.json
    session.setHandler('list_devices_selection', async (data) => {
      this.selectedDevice = data[0];
    });

    // This event is triggered when the authorize screen is shown or when the user presses retry action
    session.setHandler('try_authorize', async (duration) => {
      try {
        // Check if any previous timers are running and stop them
        if (this.interval !== null) {
          clearInterval(this.interval);
          clearTimeout(this.timeout);
        }

        // Try obtaining the token at intervals
        this.interval = setInterval(async () => {
          console.debug('Checking for button press...');

          let token = null;

          try {
            token = await requestToken(this.selectedDevice.store.address);
          }
          catch (error) {
              console.error('Error while trying to get token: ', error);
              this.logDiscovery('error', `Token request failed: ${error.message}`);

            try {
              await session.emit('error', error.message);
            } catch (e) {
              console.error('Pair session already closed:', e.message);
            }
            clearInterval(this.interval);
            clearTimeout(this.timeout);
            return;
          }

          if (token) {
            clearInterval(this.interval);
            clearTimeout(this.timeout);
            this.selectedDevice.store.token = token;
            try {
              await session.emit('create', this.selectedDevice);
            } catch (e) {
              console.error('Pair session already closed:', e.message);
            }
          }
        }, 2000); // Check every 2 seconds

        // Stop trying after a certain duration (use setTimeout, not setInterval)
        this.timeout = setTimeout(async () => {
          clearInterval(this.interval);
          clearTimeout(this.timeout);
          console.log('Timeout!');
          this.logDiscovery('error', 'Authorization timeout');

          try {
            await session.emit('authorize_timeout');
          } catch (e) {
            console.error('Pair session already closed:', e.message);
          }
        }, duration);

      } catch (error) {
        console.log('Pair Session Timeout error', error);
      }
    });
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
        const response = await fetch(`http://${ip}/api`, {
          method: 'GET',
          timeout: 5000
        });

        if (!response.ok) {
          throw new Error(this.homey.__('repair.connection_failed'));
        }

        const data = await response.json();
        
        // Verify it's the same device by serial number
        if (data.serial && data.serial !== device.getData().id) {
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
