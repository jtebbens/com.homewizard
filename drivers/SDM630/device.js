'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');

// const POLL_INTERVAL = 1000 * 1; // 1 seconds

// const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

async function updateCapability(device, capability, value) {
  if (value == null) {
    if (device.hasCapability(capability) && device.getCapabilityValue(capability) !== null) {
      await device.removeCapability(capability).catch(device.error);
    }
    return;
  }

  if (!device.hasCapability(capability)) {
    // device.log(`⚠️ Capability "${capability}" missing — skipping update`);
    // return;
    await device.addCapability(capability).catch(device.error);
    device.log(`➕ Added capability "${capability}"`);
  }

  const current = device.getCapabilityValue(capability);
  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}


module.exports = class HomeWizardEnergyDevice630 extends Homey.Device {

  async onInit() {

    const settings = this.getSettings();
    console.log('Settings for SDM630: ', settings.polling_interval);
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

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`ℹ️ this.url was empty, restored from settings: ${this.url}`);
      } else {
        this.error('❌ this.url is empty and no fallback settings.url found — aborting poll');
        await this.setUnavailable().catch(this.error);
        return;
      }
    }

    try {
      let res = await fetch(`${this.url}/data`);
      if (!res || !res.ok) {
        await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s
        res = await fetch(`${this.url}/data`);
        if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

      const data = await res.json();

      // Core capabilities
      await updateCapability(this, 'measure_power', data.active_power_w).catch(this.error);
      await updateCapability(this, 'measure_power.active_power_w', data.active_power_w).catch(this.error);
      await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);
      await updateCapability(this, 'rssi', data.wifi_strength).catch(this.error);

      // Solar export
      if (data.total_power_export_t1_kwh > 1) {
        await updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error);
      } else {
        await updateCapability(this, 'meter_power.produced.t1', null).catch(this.error);
      }

      // Aggregated meter
      await updateCapability(
        this,
        'meter_power',
        data.total_power_import_t1_kwh - data.total_power_export_t1_kwh
      ).catch(this.error);

      // Always update 3‑phase values
      await updateCapability(this, 'measure_power.l1', data.active_power_l1_w).catch(this.error);
      await updateCapability(this, 'measure_power.l2', data.active_power_l2_w).catch(this.error);
      await updateCapability(this, 'measure_power.l3', data.active_power_l3_w).catch(this.error);

      // Voltage per phase
      await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v).catch(this.error);
      await updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v).catch(this.error);
      await updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v).catch(this.error);

      // Current per phase
      await updateCapability(this, 'measure_current.l1', data.active_current_l1_a).catch(this.error);
      await updateCapability(this, 'measure_current.l2', data.active_current_l2_a).catch(this.error);
      await updateCapability(this, 'measure_current.l3', data.active_current_l3_a).catch(this.error);

      // Update settings URL if changed
      if (this.url !== settings.url) {
        this.log('SDM630 - Updating settings url');
        await this.setSettings({ url: this.url });
      }

      await this.setAvailable().catch(this.error);

    } catch (err) {
      this.error(err);
      await this.setUnavailable(err).catch(this.error);
    }
}


  onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings
      && MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for SDM630 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      // this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

    if ('cloud' in MySettings.oldSettings
        && MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
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
