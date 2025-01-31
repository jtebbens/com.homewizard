'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');

module.exports = class HomeWizardPluginBattery extends Homey.Driver {

  async onPairListDevices() {

    async function fetchWithRetry(url, options, maxRetries = 30, delay = 1000) {
      let attempts = 0;
  
      while (attempts < maxRetries) {
          const response = await fetch(url, options);
          const result = await response.json();
  
          if (response.ok) {
              return result; // Return the successful response
          } else if (response.status === 403 && result.error === "user:creation-not-enabled") {
              attempts++;
              console.log(`Attempt ${attempts} failed with error: ${result.error}. Retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
          } else {
              throw new Error(`Error: ${response.statusText}`);
          }
      }
  
      throw new Error('Max retries reached. Request failed.');
  }

    const httpsAgent = new https.Agent({
      rejectUnauthorized: false, //ignore SSL errors
    });

    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();
    const devices = [];
    await Promise.all(Object.values(discoveryResults).map(async discoveryResult => {
      try {

        // start.html -> Confirmation pressing button on device
        const payload = {
          name: 'local/homey_user'
        };
        
        const response  = await fetchWithRetry(`https://${discoveryResult.address}/api/user`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Version': '2'
          },
          body: JSON.stringify(payload),
          agent: new (require('https').Agent)({ rejectUnauthorized: false }),
          
        });

        if (!response.ok) {
          throw new Error(`Error: ${response.statusText}`);
        }


        const result = await response.json();
        console.log("Result received: ", result);

        //const responseData = await result.json();
        const bearer_token = result.token;

        console.log("Bearer token: ", result.token);
        
        const res = await fetch(`https://${discoveryResult.address}/api/measurement`, {
          headers: {
            'Authorization': `Bearer ${bearer_token}`
          },
          agent: new (require('https').Agent)({ rejectUnauthorized: false }) // Ignore SSL errors
        });

        if( !res.ok )
          throw new Error(res.statusText);

        const data = await res.json();

        devices.push({
          name: data.meter_model,
          data: {
            id: discoveryResult.id,
          },
          store: {
            token: bearer_token,
          }
        })
      } catch( err ) {
        this.error(discoveryResult.id, err);
      }
    }));
    return devices;

}

}
