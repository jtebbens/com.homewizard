'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

module.exports = class HomeWizardPluginBattery extends Homey.Driver {

  async onPairListDevices() {

    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();
    const devices = [];
    await Promise.all(Object.values(discoveryResults).map(async discoveryResult => {
      try {
        // start.html -> Confirmation pressing button on device
        const payload = {
          name: "local/homey_user"
        };
        
        const result = await fetch(`https://${discoveryResult.address}:${discoveryResult.port}/api/user`, {
          method: 'POST',
          body: JSON.stringify(payload),
          agent: new (require('https').Agent)({ rejectUnauthorized: false }),
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Version': '2'
          }
        });

        if (!result.ok) {
          throw new Error('Network response was not ok');
        }

        const responseData = await result.json();
        const bearer_token = responseData.token;
        
        //verify token?

        const url = `https://${discoveryResult.address}:${discoveryResult.port}/api/measurement`;
        const res = await fetch(url);
        if( !res.ok )
          throw new Error(res.statusText);

        const data = await res.json();
        devices.push({
          name: data.meter_model,
          data: {
            id: discoveryResult.id,
            token: bearer_token, // store the token for later use? 
          },
        })
      } catch( err ) {
        this.error(discoveryResult.id, err);
      }
    }));
    return devices;

}

}
