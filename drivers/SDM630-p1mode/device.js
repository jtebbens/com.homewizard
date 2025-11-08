'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

//const POLL_INTERVAL = 1000 * 1; // 1 seconds

//const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  if (value == null) {
    if (device.hasCapability(capability) && current !== null) {
      await device.removeCapability(capability).catch(device.error);
      device.log(`🗑️ Removed capability "${capability}"`);
    }
    return;
  }

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
    device.log(`➕ Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
    //device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}

module.exports = class HomeWizardEnergyDevice630 extends Homey.Device {

async onInit() {
    //await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);
    const settings = this.getSettings();
    this.log('Settings for SDM630:', settings.polling_interval);

    if (settings.polling_interval == null) {
      settings.polling_interval = 10;
      await this.setSettings({ polling_interval: 10 });
    }

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

//    if (this.getClass() === 'sensor') {
//      this.setClass('socket');
//      this.log('Changed sensor to socket.');
//    }

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

  async onPoll() {
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`ℹ️ this.url was empty, restored from settings: ${this.url}`);
      } else {
        this.error('❌ this.url is empty and no fallback settings.url found — aborting poll');
        return;
      }
    }


    if (!this.onPollInterval) {
      this.log('Polling interval is not running, starting now...');
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
    }

    try {
      let res = await fetch(`${this.url}/data`);
      if (!res || !res.ok) {
        await new Promise(resolve => setTimeout(resolve, 60000));
        res = await fetch(`${this.url}/data`);
        if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

      const data = await res.json();

      // Core capabilities
      await updateCapability(this, 'rssi', data.wifi_strength);
      await updateCapability(this, 'measure_power', data.active_power_w);
      await updateCapability(this, 'measure_power.active_power_w', data.active_power_w);
      await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);

      // Solar export
      if (data.total_power_export_t1_kwh > 1) {
        await updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh);
      } else {
        await updateCapability(this, 'meter_power.produced.t1', null);
      }

      // Aggregated meter
      await updateCapability(
        this,
        'meter_power',
        data.total_power_import_t1_kwh - data.total_power_export_t1_kwh
      );

      // Always update 3‑phase values
      await updateCapability(this, 'measure_power.l1', data.active_power_l1_w);
      await updateCapability(this, 'measure_power.l2', data.active_power_l2_w);
      await updateCapability(this, 'measure_power.l3', data.active_power_l3_w);

      // Voltage per phase
      await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v);
      await updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v);
      await updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v);

      // Current per phase
      await updateCapability(this, 'measure_current.l1', data.active_current_l1_a);
      await updateCapability(this, 'measure_current.l2', data.active_current_l2_a);
      await updateCapability(this, 'measure_current.l3', data.active_current_l3_a);

      // Update settings URL if changed
      if (this.url !== settings.url) {
        this.log("SDM630-p1mode - Updating settings url");
        await this.setSettings({ url: this.url });
      }

      this.setAvailable().catch(this.error);

    } catch (err) {
      this.error(err);
      this.setUnavailable(err).catch(this.error);
    }
}



  async onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for SDM630-p1 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      //this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    // return true;
  }

};
