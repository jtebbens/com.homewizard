'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

/**
 * Timeout wrapper for node-fetch (Homey has no AbortController)
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('TIMEOUT'));
      }
    }, timeoutMs);

    fetch(url, options)
      .then(res => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch(err => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}


/**
 * Safe capability updater
 */
async function updateCapability(device, capability, value) {
  if (value === undefined || value === null) return;

  const current = device.getCapabilityValue(capability);

  if (!device.hasCapability(capability)) {
    try {
      await device.addCapability(capability);
      device.log(`➕ Added capability "${capability}"`);
    } catch (err) {
      if (!String(err.message).includes('already_exists')) {
        device.error(`Failed to add capability "${capability}"`, err);
      }
    }
  }

  if (current !== value) {
    try {
      await device.setCapabilityValue(capability, value);
    } catch (err) {
      device.error(`Failed to update capability "${capability}"`, err);
    }
  }
}

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this._pendingStateUpdate = false;
    this._lastStatePoll = 0;
    this.failCount = 0;
    this._debugLogs = [];

    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
      maxSockets: 2
    });

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

  /**
   * Discovery handlers — NO direct polling (prevents bursts)
   */
  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    // this._debugLog(`🔄 Discovery available: ${this.url}`);
    this._pendingStateUpdate = true;
    this.setAvailable();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`🔄 Discovery address changed: ${this.url}`);
    this._pendingStateUpdate = true;
    this.setAvailable();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    //this._debugLog(`🔄 Discovery last seen: ${this.url}`);
    this._pendingStateUpdate = true;
    this.setAvailable();
  }

  /**
   * Per-device debug logger
   */
_debugLog(msg) {
  try {
    const ts = new Date().toLocaleString('nl-NL', {
      hour12: false,
      timeZone: 'Europe/Amsterdam'
    });

    const name = this.getName() || this.getData().id;

    // Force everything to a pure string — no objects, no arrays, no errors
    const safeMsg = typeof msg === 'string'
      ? msg
      : (msg instanceof Error
          ? msg.message
          : JSON.stringify(msg, (key, value) => {
              // Strip circular references
              if (value === this) return '[device]';
              if (value === this.homey) return '[homey]';
              return value;
            })
        );

    const line = `${ts} [${name}] ${safeMsg}`;

    this._debugLogs.push(line);
    if (this._debugLogs.length > 200) this._debugLogs.shift();

    // Store per-device to avoid collisions and circular refs
    this.homey.settings.set(`debug_logs_${this.getData().id}`, this._debugLogs);

  } catch (err) {
    // Never throw from logger
    this.error('Failed to write debug logs:', err.message || err);
  }
}







  /**
   * PUT /state
   */
  async onRequest(body) {
    if (!this.url) return;

    const maxRetries = 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        const res = await fetchWithTimeout(`${this.url}/state`, {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }, 5000);

        if (res.ok) return;

        throw new Error(res.statusText || 'Unknown error during fetch');

      } catch (err) {

        if (err.message === 'TIMEOUT') {
          this._debugLog(`⏱️ Timeout during PUT /state`);
        }

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

  /**
   * PUT /identify
   */
  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      }, 5000);

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /identify`);
      }

      this.error(err);
      throw new Error('Network error during onIdentify');
    }
  }

  /**
   * PUT /system cloud on/off
   */
  async setCloudOn() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      }, 5000);

      if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error');

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system`);
      }

      this.error(err);
      throw new Error(`Network error during setCloudOn: ${err.message}`);
    }
  }

  async setCloudOff() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: false })
      }, 5000);

      if (!res || !res.ok) throw new Error(res ? res.statusText : 'Unknown error');

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system`);
      }

      this.error(err);
      throw new Error(`Network error during setCloudOff: ${err.message}`);
    }
  }

  /**
   * GET /data + GET /state
   */
  async onPoll() {
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`Restored URL from settings: ${this.url}`);
        this._debugLog(`Restored URL from settings: ${this.url}`);
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
      let res;
      try {
        res = await fetchWithTimeout(`${this.url}/data`, {
          agent: this.agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }, 5000);
      } catch (err) {
        if (err.message === 'TIMEOUT') {
          this._debugLog(`⏱️ Timeout during GET /data`);
        }
        throw err;
      }

      let text;
      let data;

      try {
        text = await res.text();
        data = JSON.parse(text);
      } catch (err) {
        this.error('JSON parse error:', err.message, 'Body:', text?.slice(0, 200));
        throw new Error('Invalid JSON');
      }

      if (!data || typeof data !== 'object') throw new Error('Invalid response format');

      const offset_socket = this.getSetting('offset_socket') || 0;
      const temp_socket_watt = data.active_power_w + offset_socket;

      const tasks = [];
      const cap = (name, value) => {
        if (value === undefined || value === null) return;
        const cur = this.getCapabilityValue(name);
        if (cur !== value) tasks.push(updateCapability(this, name, value));
      };

      cap('measure_power', temp_socket_watt);
      cap('meter_power.consumed.t1', data.total_power_import_t1_kwh);
      cap('measure_power.l1', data.active_power_l1_w);
      cap('rssi', data.wifi_strength);

      const solarExport = data.total_power_export_t1_kwh;
      if (solarExport > 1) cap('meter_power.produced.t1', solarExport);

      const netImport = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
      cap('meter_power', netImport);

      cap('measure_voltage', data.active_voltage_v);
      cap('measure_current', data.active_current_a);

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
          const resState = await fetchWithTimeout(`${this.url}/state`, {
            agent: this.agent,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
          }, 5000);

          let stateText;
          let state;

          try {
            stateText = await resState.text();
            state = JSON.parse(stateText);
          } catch (err) {
            this.error('JSON parse error (state):', err.message, 'Body:', stateText?.slice(0, 200));
            throw new Error('Invalid JSON');
          }

          if (!state || typeof state !== 'object') throw new Error('Invalid state response');

          cap('onoff', state.power_on);
          cap('dim', state.brightness * (1 / 255));
          cap('locked', state.switch_lock);

        } catch (err) {

          if (err.message === 'TIMEOUT') {
            this._debugLog(`⏱️ Timeout during GET /state`);
          }

          this.error('State poll error:', err);
          cap('connection_error', err.message || 'State polling error');
        }
      }

      if (this.url !== settings.url) {
        try {
          await this.setSettings({ url: this.url });
        } catch (err) {
          this.error('Failed to update settings URL', err);
        }
      }

      cap('connection_error', 'No errors');
      this.setAvailable();
      this.failCount = 0;

      if (tasks.length > 0) await Promise.allSettled(tasks);

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during GET /data (outer catch)`);
      }

      if (err.code === 'ECONNRESET') {
        await updateCapability(this, 'connection_error', 'Connection reset');
      } else if (err.code === 'EHOSTUNREACH') {
        await updateCapability(this, 'connection_error', 'Socket unreachable');
      } else if (err.code === 'ETIMEDOUT') {
        await updateCapability(this, 'connection_error', 'Timeout');
        this.agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 2 });
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
