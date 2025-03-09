'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

module.exports = class HomeWizardEnergySocketDevice extends Homey.Driver {

  async onPairListDevices() {

      const discoveryStrategy = this.getDiscoveryStrategy();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const discoveryResults = discoveryStrategy.getDiscoveryResults();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const devices = [];
      await Promise.all(Object.values(discoveryResults).map(async discoveryResult => {
        try {
          const url = `http://${discoveryResult.address}:${discoveryResult.port}/api`;
          const res = await fetch(url);
          if( !res.ok )
            throw new Error(res.statusText);

          const data = await res.json();
          devices.push({
            name: `${data.product_name} (${data.serial})`,
            data: {
              id: discoveryResult.id,
            },
          })
        } catch( err ) {
          this.error(discoveryResult.id, err);
        }
      }));
      return devices;

  }

}
