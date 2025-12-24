'use strict';

const Homey = require('homey');
const fetch = require('../../includes/utils/fetchQueue');
const http = require('http');

let agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 2
});

async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  // deletion-safe: never remove capabilities based on null/undefined
  if (value === undefined || value === null) return;

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);j
    device.log(`➕ Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this._pendingStateUpdate = false;
    this._lastStatePoll = 0;
    this.failCount = 0;

    await updateCapability(this, 'connection_error', 'No errors').catch(this.error);

    const custom_interval = Math.max(this.getSetting('offset_polling') || 10, 2);
    const offset = Math.floor(Math.random() * custom_interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      this.onPoll();
      this.onPollInterval = setInterval(this.onPoll.bind(this), custom_interval * 1000);
    }, offset);

    if (this.getClass() === 'sensor') {
      this.setClass('socket');
    }

    // Capability listeners trigger a state refresh
    this.registerCapabilityListener('onoff', async (value) => {
      if (this.getCapabilityValue('locked')) throw new Error('Device is locked');
      this._pendingStateUpdate = true;
      await this.onRequest({ power_on: value });
    });

    this.registerCapabilityListener('identify', async () => {
      await this.onIdentify();
    });

    this.registerCapabilityListener('dim', async (value) => {
      this._pendingStateUpdate = true;
      await this.onRequest({ brightness: 255 * value });
    });

    this.registerCapabilityListener('locked', async (value) => {
      this._pendingStateUpdate = true;
      await this.onRequest({ switch_lock: value });
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
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  async onRequest(body) {
    if (!this.url) return;

    const maxRetries = 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const res = await fetch(`${this.url}/state`, {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        });

        if (res.ok) return;

        throw new Error(res.statusText || 'Unknown error during fetch');

      } catch (err) {
        this.error(`Attempt ${attempt + 1} failed:`, err);

        if (attempt === maxRetries) {
          await updateCapability(this, 'connection_error', 'fetch failed').catch(this.error);
          throw new Error('Network error during onRequest');
        }

        attempt++;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetch(`${this.url}/identify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

    } catch (err) {
      this.error(err);
      throw new Error('Network error during onIdentify');
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

      if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error');

    } catch (err) {
      this.error(err);
      throw new Error(`Network error during setCloudOn: ${err.message}`);
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

      if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error');

    } catch (err) {
      this.error(err);
      throw new Error(`Network error during setCloudOff: ${err.message}`);
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

    if (!this.getData()) return;

    if (this.pollingActive) return;
    this.pollingActive = true;

    try {
      // --- Fetch /data ---
      const res = await fetch(`${this.url}/data`, {
        agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      }, 5000);

      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid response format');

      const offset_socket = this.getSetting('offset_socket') || 0;
      const temp_socket_watt = data.active_power_w + offset_socket;

      await updateCapability(this, 'measure_power', temp_socket_watt);
      await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);
      await updateCapability(this, 'measure_power.l1', data.active_power_l1_w);
      await updateCapability(this, 'rssi', data.wifi_strength);

      const solarExport = data.total_power_export_t1_kwh;
      await updateCapability(this, 'meter_power.produced.t1', solarExport > 1 ? solarExport : undefined);

      const netImport = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
      await updateCapability(this, 'meter_power', netImport);

      await updateCapability(this, 'measure_voltage', data.active_voltage_v);
      await updateCapability(this, 'measure_current', data.active_current_a);

      // --- Conditional /state poll ---
      const now = Date.now();
      const mustPollState =
        !this._lastStatePoll ||
        (now - this._lastStatePoll) > 30000 ||
        this._pendingStateUpdate;

      if (mustPollState) {
        this._pendingStateUpdate = false;
        this._lastStatePoll = now;

        try {
          const resState = await fetch(`${this.url}/state`, {
            agent,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
          }, 5000);

          const state = await resState.json();
          if (!state || typeof state !== 'object') throw new Error('Invalid state response');

          await updateCapability(this, 'onoff', state.power_on);
          await updateCapability(this, 'dim', state.brightness * (1 / 255));
          await updateCapability(this, 'locked', state.switch_lock);

        } catch (err) {
          this.error('State poll error:', err);
          await updateCapability(this, 'connection_error', err.message || 'State polling error');
        }
      }

      if (this.url !== settings.url) {
        try {
          await this.setSettings({ url: this.url });
        } catch (err) {
          this.error('Failed to update settings URL', err);
        }
      }

      await updateCapability(this, 'connection_error', 'No errors');
      await this.setAvailable();
      this.failCount = 0;

    } catch (err) {

      if (err.code === 'ECONNRESET') {
        await updateCapability(this, 'connection_error', 'Connection reset');
      } else if (err.code === 'EHOSTUNREACH') {
        await updateCapability(this, 'connection_error', 'Socket unreachable');
      } else if (err.code === 'ETIMEDOUT') {
        await updateCapability(this, 'connection_error', 'Timeout');
        agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1 });
        setTimeout(() => this.onPoll(), 2000);
      } else {
        await updateCapability(this, 'connection_error', err.message || 'Polling error');
      }

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

  async onSettings(oldSettings, newSettings) {
    const changedKeys = oldSettings.changedKeys || [];

    for (const key of changedKeys) {

      if (key.startsWith('offset_') && key !== 'offset_polling') {
        const cap = `measure_${key.slice(7)}`;
        const value = this.getCapabilityValue(cap) || 0;
        const delta = newSettings[key] - (oldSettings[key] || 0);

        await this.setCapabilityValue(cap, value + delta).catch(this.error);
      }

      else if (key === 'offset_polling') {
        if (this.onPollInterval) clearInterval(this.onPollInterval);

        const interval = newSettings.offset_polling;
        if (typeof interval === 'number' && interval > 0) {
          this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
        }
      }

      else if (key === 'cloud') {
        try {
          if (newSettings.cloud == 1) await this.setCloudOn();
          else await this.setCloudOff();
        } catch (err) {
          this.error('Failed to update cloud connection:', err);
        }
      }
    }
  }

};
