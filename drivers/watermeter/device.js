'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');

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

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;

    const settings = this.getSettings();

    // Ensure polling interval exists
    if (settings.offset_polling == null) {
      await this.setSettings({ offset_polling: 10 });
    }

    // Ensure water offset exists
    if (settings.offset_water == null) {
      await this.setSettings({ offset_water: 0 });
    }

    const interval = Math.max(settings.offset_polling, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      this.onPoll();
      this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
    }, offset);

    // Ensure required capabilities exist
    const requiredCaps = ['measure_water', 'meter_water', 'identify', 'rssi'];
    for (const cap of requiredCaps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    this.registerCapabilityListener('identify', async () => {
      await this.onIdentify();
    });
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

  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetch(`${this.url}/identify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {
      this.error('Identify failed:', err);
      throw new Error('Network error during identify');
    }
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

      this.log('Cloud enabled');

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

      this.log('Cloud disabled');

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

      // Offset logic
      const offsetWater =
        data.total_liter_offset_m3 === 0 || data.total_liter_offset_m3 === '0'
          ? settings.offset_water
          : data.total_liter_offset_m3;

      const totalM3 = data.total_liter_m3 + offsetWater;

      // Update capabilities (deletion-safe)
      await updateCapability(this, 'measure_water', data.active_liter_lpm);
      await updateCapability(this, 'meter_water', totalM3);
      await updateCapability(this, 'rssi', data.wifi_strength);

      // Sync URL if changed
      if (this.url !== settings.url) {
        await this.setSettings({ url: this.url }).catch(this.error);
      }

      await this.setAvailable();
      this.failCount = 0;

    } catch (err) {
      this.error('Polling failed:', err);
      this.failCount++;

      if (this.failCount > 3) {
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        await this.setUnavailable('Device unreachable');
      } else {
        await this.setUnavailable(err.message || 'Polling error');
      }

    } finally {
      this.pollingActive = false;
    }
  }

  async onSettings(oldSettings) {
    const changedKeys = oldSettings.changedKeys || [];

    for (const key of changedKeys) {

      if (key === 'offset_polling') {
        const interval = oldSettings.newSettings.offset_polling;

        if (typeof interval === 'number' && interval > 0) {
          if (this.onPollInterval) clearInterval(this.onPollInterval);
          this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
        } else {
          this.log('Invalid polling interval:', interval);
        }
      }

      if (key === 'cloud') {
        try {
          if (oldSettings.newSettings.cloud == 1) await this.setCloudOn();
          else await this.setCloudOff();
        } catch (err) {
          this.error('Failed to update cloud setting:', err);
        }
      }
    }
  }

};
