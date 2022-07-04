'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

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

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_water')) {
        await this.addCapability('measure_water').catch(this.error);
      }

      if (!this.hasCapability('meter_water')) {
        await this.addCapability('meter_water').catch(this.error);
      }

      // Update values
      if (this.getCapabilityValue('measure_water') != data.active_liter_lpm)
        await this.setCapabilityValue('measure_water', data.active_liter_lpm).catch(this.error);
      if (this.getCapabilityValue('meter_water') != data.total_liter_m3)
          await this.setCapabilityValue('meter_water', data.total_liter_m3).catch(this.error);

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
