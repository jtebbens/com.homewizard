'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergyDevice extends Homey.Device {

  onInit() {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);
  }

  onDeleted() {
    if( this.onPollInterval ) {
      clearInterval(this.onPollInterval);
    }
  }
  
  async onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }
  
  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onPoll() {
    if( !this.url ) return;

    Promise.resolve().then(async () => {
      const res = await fetch(`${this.url}/data`);
      if( !res.ok )
        throw new Error(res.statusText);
      
      const data = await res.json();

      await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error);
      await this.setCapabilityValue('meter_gas', data.total_gas_m3).catch(this.error);
    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch(err => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      })
  }

}