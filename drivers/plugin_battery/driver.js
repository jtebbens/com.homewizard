'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');

module.exports = class HomeWizardEnergyDriverV2 extends Homey.Driver {

  async onPair(session) {

    session.setHandler('list_devices', async () => {

      const httpsAgent = new https.Agent({
        rejectUnauthorized: false, // ignore SSL errors
      });

      const discoveryStrategy = this.getDiscoveryStrategy();
      const discoveryResults = discoveryStrategy.getDiscoveryResults();
      const numberOfDiscoveryResults = Object.keys(discoveryResults).length;

      const devices = [];
      await Promise.all(Object.values(discoveryResults).map(async (discoveryResult) => {
        try {

          // start.html -> Confirmation pressing button on device
          const payload = {
            name: 'local/homey_user',
          };

          const response = await fetch(`https://${discoveryResult.address}/api/user`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Version': '2',
            },
            body: JSON.stringify(payload),
            agent: new (require('https').Agent)({ rejectUnauthorized: false }),

          });

          // if (!response.ok) {
          //  throw new Error(`Error: ${response.statusText}`);
          // }

          const result = await response.json();
          console.log('Result received: ', result);

          // const responseData = await result.json();
          const bearer_token = result.token;

          console.log('Bearer token: ', result.token);

          const res = await fetch(`https://${discoveryResult.address}/api`, {
            headers: {
              Authorization: `Bearer ${bearer_token}`,
            },
            agent: new (require('https').Agent)({ rejectUnauthorized: false }), // Ignore SSL errors
          });

          if (!res.ok)
          { throw new Error(res.statusText); }

          const data = await res.json();

          let name = data.product_name;
          if (numberOfDiscoveryResults > 1) {
            name = `${data.product_name} (${data.serial})`;
          }

          devices.push({
            name,
            data: {
              id: discoveryResult.id,
            },
            store: {
              token: bearer_token,
            },
          });
        } catch (err) {
          this.error(discoveryResult.id, err);
        }
      }));
      return devices;
    });

    session.setHandler('showView', async (view) => {
      if (view === 'loading') {

        await session.nextView();
      }
    });

  }

};
