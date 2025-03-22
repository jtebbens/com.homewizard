'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');


async function requestToken(address) {
  const payload = {
    name: 'local/homey_user',
  };

  console.log("Trying...")

  const response = await fetch(`https:/${address}/api/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Version': '2',
    },
    body: JSON.stringify(payload),
    agent: new (require('https').Agent)({ rejectUnauthorized: false }),
  });

  if (response.status == 403) {
    return null;
  }

  console.log("Succes!")

  const result = await response.json();
  return result.token;
}

module.exports = class HomeWizardEnergyDriverV2 extends Homey.Driver {

  async onPair(session) {

    this.interval = null;
    this.timeout = null;
    this.devices = [];

    session.setHandler('list_devices', async () => {

      const discoveryStrategy = this.getDiscoveryStrategy();
      const discoveryResults = discoveryStrategy.getDiscoveryResults();

      const devices = [];
      for (const discoveryResult of Object.values(discoveryResults)) {

        devices.push({
          name: `${discoveryResult.txt.product_name} (${discoveryResult.txt.serial.substr(6)})`,
          data: {
            id: discoveryResult.txt.serial,
          },
          store: {
            address: discoveryResult.address,
          },
        });
      }

      this.devices = devices;

      return devices;
    });

    session.setHandler('showView', async (view) => {
      console.log("View: ", view);
    });

    session.setHandler('list_devices_selection', async (data) => {
      console.log("List devices selection: ", data);
      this.selectedDevices = data;
    });

    // This event is triggered when the authorize screen is shown or when the user presses retry action
    session.setHandler('try_authorize', async (view) => {

      if (this.interval !== null) {
        clearInterval(this.interval);
        clearInterval(this.timeout);
      }

      this.interval = setInterval(async () => {
        console.log("Checking for button press...");
        let token = await requestToken(this.selectedDevices[0].store.address);
        if (token) {

          // We are done trying, stop timers
          clearInterval(this.interval);
          clearInterval(this.timeout);

          this.selectedDevices[0].store.token = token;
          session.emit("create", this.selectedDevices[0]);
          // console.log("Button pressed!");
          // await session.showView("done");
        }
      }, 2000);

      this.timeout = setInterval(async () => {
        clearInterval(this.interval);
        clearInterval(this.timeout);
        console.log("Timeout!");
        session.emit("authorize_timeout");
      }, 10000);

    });
  }

};
