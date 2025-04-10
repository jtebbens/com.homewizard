'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 1; // 1 seconds

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

  async onInit() {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);

    this.registerCapabilityListener('identify', async (value) => {
      await this.onIdentify();
    });
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  async onIdentify() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/identify`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    }).catch(this.error);

    if (!res.ok)
    { throw new Error(res.statusText); }
  }

  onPoll() {
    if (!this.url) return;

    Promise.resolve().then(async () => {
      let res = await fetch(`${this.url}/data`);

      if (!res || !res.ok) {
        await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s to avoid false reports due to bad wifi from users
        // try again
        res = await fetch(`${this.url}/data`);
        if (!res || !res.ok)
        { throw new Error(res ? res.statusText : 'Unknown error during fetch'); }
      }

      const data = await res.json();

      let offset_water_m3;

      // if watermeter offset is set in Homewizard Energy app take that value else use the configured value in Homey Homewizard water offset
      if (data.total_liter_offset_m3 = '0') {
        offset_water_m3 = this.getSetting('offset_water');
      }
      else if (data.total_liter_offset_m3 != '0') {
        offset_water_m3 = data.total_liter_offset_m3;
      }

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_water')) {
        await this.addCapability('measure_water').catch(this.error);
      }

      if (!this.hasCapability('meter_water')) {
        await this.addCapability('meter_water').catch(this.error);
      }

      if (!this.hasCapability('identify')) {
        await this.addCapability('identify').catch(this.error);
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error);
      }

      const temp_total_liter_m3 = data.total_liter_m3 + offset_water_m3;

      // Update values
      if (this.getCapabilityValue('measure_water') != data.active_liter_lpm)
      { await this.setCapabilityValue('measure_water', data.active_liter_lpm).catch(this.error); }
      if (this.getCapabilityValue('meter_water') != temp_total_liter_m3)
      { await this.setCapabilityValue('meter_water', temp_total_liter_m3).catch(this.error); }
      if (this.getCapabilityValue('rssi') != data.wifi_strength)
      { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error); }

    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }

  // Catch offset updates
  onSettings(oldSettings, newSettings, changedKeys) {
    this.log('Settings updated');
    // Update display values if offset has changed
    for (const k in changedKeys) {
      const key = changedKeys[k];
      if (key.slice(0, 7) === 'offset_') {
        const cap = `meter_${key.slice(7)}`;
        const value = this.getCapabilityValue(cap);
        const delta = newSettings[key] - oldSettings[key];
        this.log('Updating value of', cap, 'from', value, 'to', value + delta);
        this.setCapabilityValue(cap, value + delta)
          .catch((err) => this.error(err));
      }
    }
    // return true;
  }

  updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('meter', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

};
