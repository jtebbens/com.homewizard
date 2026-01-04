'use strict';

const Homey = require('homey');
const fetch = require('../../includes/utils/fetchQueue');
const http = require('http');

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000
});

async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  // deletion-safe: never remove capabilities based on null/undefined
  if (value === undefined || value === null) return;

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
    device.log(`Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}

module.exports = class HomeWizardEnergyDevice630 extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;

    const settings = this.getSettings();
    this.log('Polling settings for SDM630:', settings.polling_interval);

    // Ensure polling interval exists
    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
    }

    const interval = Math.max(this.getSettings().polling_interval, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      this.onPoll();
      this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
    }, offset);

    if (this.getClass() === 'sensor') {
      this.setClass('socket');
      this.log('Changed class from sensor to socket.');
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
    this.log(`URL updated: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL restored: ${this.url}`);
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

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.log('Cloud enabled successfully');
    } catch (err) {
      this.error('Failed to enable cloud:', err);
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

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.log('Cloud disabled successfully');
    } catch (err) {
      this.error('Failed to disable cloud:', err);
    }
  }

  async onPoll() {
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`Restored URL from settings: ${this.url}`);
      } else {
        await this.setUnavailable('Missing URL');
        return;
      }
    }

    if (this.pollingActive) return;
    this.pollingActive = true;

    try {
      const res = await fetch(`${this.url}/data`, {
        agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

      const updates = [];

      // Core capabilities
      updates.push(updateCapability(this, 'measure_power', data.active_power_w));
      updates.push(updateCapability(this, 'measure_power.active_power_w', data.active_power_w));
      updates.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));
      updates.push(updateCapability(this, 'rssi', data.wifi_strength));

      // Solar export (production)
      if (data.total_power_export_t1_kwh > 1) {
        updates.push(updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh));
      }

      // Net power
      const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
      updates.push(updateCapability(this, 'meter_power', net));

      // 3‑phase power
      updates.push(updateCapability(this, 'measure_power.l1', data.active_power_l1_w));
      updates.push(updateCapability(this, 'measure_power.l2', data.active_power_l2_w));
      updates.push(updateCapability(this, 'measure_power.l3', data.active_power_l3_w));

      // 3‑phase voltages
      updates.push(updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v));
      updates.push(updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v));
      updates.push(updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v));

      // 3‑phase currents
      updates.push(updateCapability(this, 'measure_current.l1', data.active_current_l1_a));
      updates.push(updateCapability(this, 'measure_current.l2', data.active_current_l2_a));
      updates.push(updateCapability(this, 'measure_current.l3', data.active_current_l3_a));

      // Sync URL if changed
      if (this.url !== settings.url) {
        this.log('SDM630 - Updating settings url');
        await this.setSettings({ url: this.url }).catch(this.error);
      }

      await Promise.allSettled(updates);

      await this.setAvailable().catch(this.error);
      this.failCount = 0;

    } catch (err) {
      this.error('Polling failed:', err);
      this.failCount++;

      if (this.failCount > 3) {
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        await this.setUnavailable('Device unreachable');
      } else {
        await this.setUnavailable(err.message || 'Polling error').catch(this.error);
      }

    } finally {
      this.pollingActive = false;
    }
  }

  onSettings(event) {
    const { oldSettings, newSettings, changedKeys } = event;

    for (const key of changedKeys) {

      if (key === 'polling_interval') {
        const interval = newSettings.polling_interval;

        if (typeof interval === 'number' && interval > 0) {
          if (this.onPollInterval) clearInterval(this.onPollInterval);
          this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
        } else {
          this.log('Invalid polling interval:', interval);
        }
      }

      if (key === 'cloud') {
        if (newSettings.cloud == 1) this.setCloudOn();
        else this.setCloudOff();
      }
    }
  }

};
