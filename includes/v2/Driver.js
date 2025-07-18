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
    name: 'local/homey_user',
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

  async onPair(session) {

    // Initialize variables to prevent undefined errors
    this.interval = null;
    this.timeout = null;
    this.devices = [];

    // First screen, get list of devices.
    session.setHandler('list_devices', async () => {

      const discoveryStrategy = this.getDiscoveryStrategy();
      const discoveryResults = discoveryStrategy.getDiscoveryResults();

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
        clearInterval(this.timeout);
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
          await session.emit('error', error.message); //timer - timeout issue  at Timeout._onTimeout (/app/includes/v2/Driver.js:112:19)

          // Stop trying
          clearInterval(this.interval);
          clearInterval(this.timeout);

          return;
        }

        if (token) {

          // We are done trying, stop timers
          clearInterval(this.interval);
          clearInterval(this.timeout);

          this.selectedDevice.store.token = token;
          await session.emit('create', this.selectedDevice);
        }
      }, 2000); // Check every 2 seconds

      // Stop trying after a certain duration
      // This is to make sure we don't keep trying forever, as we do not get a notification that
      // the flow has been stopped by the user
      this.timeout = setInterval(async () => {
        clearInterval(this.interval);
        clearInterval(this.timeout);
        console.log('Timeout!');
        await session.emit('authorize_timeout'); //Timeout._onTimeout (/app/includes/v2/Driver.js:140:23)
      }, duration);

    }
    catch (error) {
      console.log('Pair Session Timeout error', error); // at Timeout.<anonymous> (/app/includes/v2/Driver.js:139:17)
    }
  }

  );
  }

};
