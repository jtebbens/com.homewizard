'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs : 11000
});


//const POLL_INTERVAL = 1000 * 1; // 1 seconds

//const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {

  async onInit() {

      const settings = this.getSettings();
      console.log('Settings for SDM230: ',settings.polling_interval);


      // Check if polling interval is set in settings, if not set default to 10 seconds
      if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
        settings.polling_interval = 10; // Default to 10 second if not set
        await this.setSettings({
          // Update settings in Homey
          polling_interval: 10,
        });
      }

      if (this.onPollInterval) {
        clearInterval(this.onPollInterval);
      }

      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      
    
      if (this.getClass() == 'sensor') {
        this.setClass('socket');
        this.log('Changed sensor to socket.');
      }

      if (!this.hasCapability('measure_power')) {
          await this.addCapability('measure_power').catch(this.error);
      }

      if (!this.hasCapability('meter_power.consumed.t1')) {
        await this.addCapability('meter_power.consumed.t1').catch(this.error);
      }

      if (!this.hasCapability('measure_power.l1')) {
        await this.addCapability('measure_power.l1').catch(this.error);
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error);
      }
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error);
      }
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
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

  async setCloudOn() {
    if (!this.url) return;

    try {
      const res = await fetch(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Optionally log success
      this.log('Cloud enabled successfully');
    } catch (err) {
      this.error('Failed to enable cloud:', err);
      // Optionally set a capability or trigger a flow here
      // await this.setCapabilityValue('connection_error', err.message).catch(this.error);
    }
  }




  async setCloudOff() {
    if (!this.url) return;

    try {
      const res = await fetch(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: false })
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Optionally log success
      this.log('Cloud disabled successfully');
    } catch (err) {
      this.error('Failed to disable cloud:', err);
      // Optionally set a capability or trigger a flow here
      // await this.setCapabilityValue('connection_error', err.message).catch(this.error);
    }
  }


  async onPoll() {

    const settings = this.getSettings();

    const promises = [];

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      }
      else return;
      this.log("No URL found for SDM230, please check your device settings.");
    }

    // Check if polling interval is running)
      if (!this.onPollInterval) {
        this.log('Polling interval is not running, starting now...');
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }


    Promise.resolve().then(async () => {

      //let res = await fetch(`${this.url}/data`);

      const res = await fetch(`${this.url}/data`, {
          agent,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
      });


      if (!res || !res.ok) {
        throw new Error(res ? res.statusText : 'Unknown error during fetch'); 
      }

      const data = await res.json();

      
      if (this.getCapabilityValue('rssi') != data.wifi_strength)
      { promises.push((this.setCapabilityValue('rssi', data.wifi_strength)).catch(this.error)); }

      // There are old paired SDM230 devices that still have the old sensor and show negative values that needs to be inverted
      if (this.getClass() == 'solarpanel') {
        promises.push((this.setCapabilityValue('measure_power', data.active_power_w * -1)).catch(this.error));
      } else {
        promises.push((this.setCapabilityValue('measure_power', data.active_power_w)).catch(this.error));
      }

      // await this.setCapabilityValue('measure_power.active_power_w', data.active_power_w).catch(this.error);
      promises.push((this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh)).catch(this.error));

      // There are old paired SDM230 devices that still have the old sensor and show negative values that needs to be inverted
      if (this.getClass() == 'solarpanel') {
        promises.push((this.setCapabilityValue('measure_power.l1', data.active_power_l1_w * -1)).catch(this.error));
      } else {
        promises.push((this.setCapabilityValue('measure_power.l1', data.active_power_l1_w)).catch(this.error));
      }
      // await this.setCapabilityValue('meter_power.consumed.t2', data.total_power_import_t2_kwh).catch(this.error);

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if (data.total_power_export_t1_kwh > 1) {
        if (!this.hasCapability('meter_power.produced.t1')) {
          // add production meters
          await this.addCapability('meter_power.produced.t1').catch(this.error);
        }
        // update values for solar production
        promises.push((this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh)).catch(this.error));
      }
      else if (data.total_power_export_t1_kwh < 1) {
        await this.removeCapability('meter_power.produced.t1').catch(this.error);
      }

      
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      promises.push((this.setCapabilityValue('meter_power', (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh))).catch(this.error));

      // active_voltage_l1_v
      if (data.active_voltage_v !== undefined) {
        if (!this.hasCapability('measure_voltage')) {
          await this.addCapability('measure_voltage').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage') != data.active_voltage_v)
        { promises.push((this.setCapabilityValue('measure_voltage', data.active_voltage_v)).catch(this.error)); }
      }
      else if ((data.active_voltage_v == undefined) && (this.hasCapability('measure_voltage'))) {
        await this.removeCapability('measure_voltage').catch(this.error);
      }

      // active_current_a  Amp's
      if (data.active_current_a !== undefined) {
        if (!this.hasCapability('measure_current')) {
          await this.addCapability('measure_current').catch(this.error);
        }
        if (this.getCapabilityValue('measure_current') != data.active_current_a)
        { promises.push((this.setCapabilityValue('measure_current', data.active_current_a)).catch(this.error)); }
      }
      else if ((data.active_current_a == undefined) && (this.hasCapability('measure_current'))) {
        await this.removeCapability('measure_current').catch(this.error);
      }

      if (this.url != settings.url) {
            this.log("SDM230 - Updating settings url");
            await this.setSettings({
                  // Update url settings
                  url: this.url
                });
      }

    await Promise.allSettled(promises);

    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }

  onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for SDM230 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      //this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

      if ('cloud' in MySettings.oldSettings &&
        MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
      ) {
        this.log('Cloud connection in advanced settings changed to:', MySettings.newSettings.cloud);

        if (MySettings.newSettings.cloud == 1) {
            this.setCloudOn();  
        }
        else if (MySettings.newSettings.cloud == 0) {
            this.setCloudOff();
        }
      }
    // return true;
  }

};
