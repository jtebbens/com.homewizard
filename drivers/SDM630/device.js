'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

//const POLL_INTERVAL = 1000 * 1; // 1 seconds

//const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

module.exports = class HomeWizardEnergyDevice630 extends Homey.Device {

  async onInit() {

    const settings = await this.getSettings();
    console.log('Settings for SDM630: ',settings.polling_interval);
    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
        
    if (this.getClass() == 'sensor') {
      this.setClass('socket');
      console.log('Changed sensor to socket.');
    }
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

  async setCloudOn() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    }).catch(this.error);

    if (!res.ok)
    { 
      //await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }


  async setCloudOff() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    }).catch(this.error);

    if (!res.ok)
    { 
      //await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }

  onPoll() {
    if (!this.url) return;

    // Check if polling interval is running)
    if (!this.onPollInterval) {
      this.log('Polling interval is not running, starting now...');
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

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

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_power')) {
        await this.addCapability('measure_power').catch(this.error);
      }

      if (!this.hasCapability('measure_power.active_power_w')) {
        await this.addCapability('measure_power.active_power_w').catch(this.error);
      }

      if (!this.hasCapability('meter_power.consumed.t1')) {
        await this.addCapability('meter_power.consumed.t1').catch(this.error);
      //  await this.addCapability('meter_power.consumed.t2').catch(this.error);
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error);
      }

      if (this.getCapabilityValue('rssi') != data.wifi_strength)
      { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error); }

      // Update values 3phase kwh
      // KWH 1 fase
      // total_power_import_t1_kwh *
      // total_power_export_t1_kwh *
      // active_power_w
      // active_power_l1_w
      // active_power_l2_w
      // active_power_l3_w

      await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error);
      await this.setCapabilityValue('measure_power.active_power_w', data.active_power_w).catch(this.error);
      await this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);
      // await this.setCapabilityValue('meter_power.consumed.t2', data.total_power_import_t2_kwh).catch(this.error);

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if (data.total_power_export_t1_kwh > 1) {
        if (!this.hasCapability('meter_power.produced.t1')) {
          // add production meters
          await this.addCapability('meter_power.produced.t1').catch(this.error);
        }
        // update values for solar production
        await this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error);
      }
      else if (data.total_power_export_t1_kwh < 1) {
        await this.removeCapability('meter_power.produced.t1').catch(this.error);
      }

      // aggregated meter for Power by the hour support
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error);
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      this.setCapabilityValue('meter_power', (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh)).catch(this.error);

      // Phase 3 support when meter has values active_power_l2_w will be valid else ignore ie the power grid is a Phase1 household connection
      if (data.active_power_l2_w !== null) {
        if (!this.hasCapability('measure_power.l2')) {
          await this.addCapability('measure_power.l1').catch(this.error);
          await this.addCapability('measure_power.l2').catch(this.error);
          await this.addCapability('measure_power.l3').catch(this.error);
        }
        this.setCapabilityValue('measure_power.l1', data.active_power_l1_w).catch(this.error);
        this.setCapabilityValue('measure_power.l2', data.active_power_l2_w).catch(this.error);
        this.setCapabilityValue('measure_power.l3', data.active_power_l3_w).catch(this.error);
      }
      else if (data.active_power_l2_w == null) {
        if (this.hasCapability('measure_power.l2')) {
          await this.removeCapability('measure_power.l1').catch(this.error);
          await this.removeCapability('measure_power.l2').catch(this.error);
          await this.removeCapability('measure_power.l3').catch(this.error);
          await this.removeCapability('measure_power.active_power_w').catch(this.error);
        }
      }

      // active_voltage_l1_v
      if (data.active_voltage_l1_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l1')) {
          await this.addCapability('measure_voltage.l1').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage.l1') != data.active_voltage_l1_v)
        { await this.setCapabilityValue('measure_voltage.l1', data.active_voltage_l1_v).catch(this.error); }
      }
      else if ((data.active_voltage_l1_v == undefined) && (this.hasCapability('measure_voltage.l1'))) {
        await this.removeCapability('measure_voltage.l1').catch(this.error);
      }

      // active_voltage_l2_v
      if (data.active_voltage_l2_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l2')) {
          await this.addCapability('measure_voltage.l2').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage.l2') != data.active_voltage_l2_v)
        { await this.setCapabilityValue('measure_voltage.l2', data.active_voltage_l2_v).catch(this.error); }
      }
      else if ((data.active_voltage_l2_v == undefined) && (this.hasCapability('measure_voltage.l2'))) {
        await this.removeCapability('measure_voltage.l2').catch(this.error);
      }

      // active_voltage_l3_v
      if (data.active_voltage_l3_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l3')) {
          await this.addCapability('measure_voltage.l3').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage.l3') != data.active_voltage_l3_v)
        { await this.setCapabilityValue('measure_voltage.l3', data.active_voltage_l3_v).catch(this.error); }
      }
      else if ((data.active_voltage_l3_v == undefined) && (this.hasCapability('measure_voltage.l3'))) {
        await this.removeCapability('measure_voltage.l3').catch(this.error);
      }

      // active_current_a  Amp's L1
      if (data.active_current_l1_a !== undefined) {
        if (!this.hasCapability('measure_current.l1')) {
          await this.addCapability('measure_current.l1').catch(this.error);
        }
        if (this.getCapabilityValue('measure_current.l1') != data.active_current_l1_a)
        { await this.setCapabilityValue('measure_current.l1', data.active_current_l1_a).catch(this.error); }
      }
      else if ((data.active_current_l1_a == undefined) && (this.hasCapability('measure_current.l1'))) {
        await this.removeCapability('measure_current.l1').catch(this.error);
      }

      // active_current_a  Amp's L2
      if (data.active_current_l2_a !== undefined) {
        if (!this.hasCapability('measure_current.l2')) {
          await this.addCapability('measure_current.l2').catch(this.error);
        }
        if (this.getCapabilityValue('measure_current.l2') != data.active_current_l2_a)
        { await this.setCapabilityValue('measure_current.l2', data.active_current_l2_a).catch(this.error); }
      }
      else if ((data.active_current_l2_a == undefined) && (this.hasCapability('measure_current.l2'))) {
        await this.removeCapability('measure_current.l2').catch(this.error);
      }

      // active_current_a  Amp's L3
      if (data.active_current_l3_a !== undefined) {
        if (!this.hasCapability('measure_current.l3')) {
          await this.addCapability('measure_current.l3').catch(this.error);
        }
        if (this.getCapabilityValue('measure_current.l3') != data.active_current_l3_a)
        { await this.setCapabilityValue('measure_current.l3', data.active_current_l3_a).catch(this.error); }
      }
      else if ((data.active_current_l3_a == undefined) && (this.hasCapability('measure_current.l3'))) {
        await this.removeCapability('measure_current.l3').catch(this.error);
      }

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
      this.log('Polling_interval for SDM630 changed to:', MySettings.newSettings.polling_interval);
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
