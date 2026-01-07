'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000
});


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
  const current = device.getCapabilityValue(capability);

  if (value === undefined || value === null) return;

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
    device.log(`Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}

module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;
    this._pendingStateUpdate = false;
    this._debugLogs = [];

    await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    const settings = this.getSettings();

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
    }

    const interval = Math.max(settings.polling_interval, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      this.onPoll();
      this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
    }, offset);

    if (this.getClass() === 'sensor') {
      this.setClass('socket');
      this.log('Changed class from sensor to socket');
    }

    const requiredCaps = [
      'measure_power',
      'meter_power.consumed.t1',
      'measure_power.l1',
      'rssi',
      'meter_power'
    ];

    for (const cap of requiredCaps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
  }

  /**
   * Discovery — burst‑safe
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
    // this._debugLog(`🔄 Discovery last seen: ${this.url}`);
    this._pendingStateUpdate = true;
    this.setAvailable();
  }

  /**
   * Per‑device debug logger
   */
_debugLog(msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}`;

  this._debugLogs.push(line);
  if (this._debugLogs.length > 200) this._debugLogs.shift();

  // Per-device store
  this.setStoreValue('debug_logs', this._debugLogs).catch(() => {});

  // App settings (synchronous, no Promise)
  try {
    this.homey.settings.set('debug_logs', this._debugLogs);
  } catch (err) {
    this.error('Failed to write debug_logs:', err);
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

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.log('Cloud enabled');

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system`);
      }

      this.error('Failed to enable cloud:', err);
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

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.log('Cloud disabled');

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system`);
      }

      this.error('Failed to disable cloud:', err);
    }
  }

  /**
   * GET /data
   */
 async onPoll() {
  const settings = this.getSettings();

  // Restore URL only from settings, never write back
  if (!this.url) {
    if (settings.url) {
      this.url = settings.url;
      this.log(`Restored URL from settings: ${this.url}`);
    } else {
      await this.setUnavailable('Missing URL');
      return;
    }
  }

  // Burst‑safe discovery handling
  if (this._pendingStateUpdate) {
    this._pendingStateUpdate = false;
    this._debugLog(`🔁 Forced poll due to discovery/state update`);
  }

  // Polling guard
  if (this.pollingActive) return;
  this.pollingActive = true;

  try {
    // -----------------------------
    // FETCH WITH TIMEOUT
    // -----------------------------
    let res;
    try {
      res = await fetchWithTimeout(`${this.url}/data`, {
        agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      }, 5000);
    } catch (err) {
      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during GET /data`);
      }
      throw err;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    // -----------------------------
    // JSON PARSE WITH DEBUG
    // -----------------------------
    let text;
    let data;

    try {
      text = await res.text();
      data = JSON.parse(text);
    } catch (err) {
      this.error('JSON parse error:', err.message, 'Body:', text?.slice(0, 200));
      throw new Error('Invalid JSON');
    }

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid JSON');
    }

    // -----------------------------
    // CAPABILITY UPDATES (exactly your original set)
    // -----------------------------
    const updates = [];

    updates.push(updateCapability(this, 'rssi', data.wifi_strength));

    const power = this.getClass() === 'solarpanel'
      ? data.active_power_w * -1
      : data.active_power_w;

    updates.push(updateCapability(this, 'measure_power', power));
    updates.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));

    const l1 = this.getClass() === 'solarpanel'
      ? data.active_power_l1_w * -1
      : data.active_power_l1_w;

    updates.push(updateCapability(this, 'measure_power.l1', l1));

    if (data.total_power_export_t1_kwh > 1) {
      updates.push(updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh));
    }

    const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
    updates.push(updateCapability(this, 'meter_power', net));

    updates.push(updateCapability(this, 'measure_voltage', data.active_voltage_v));
    updates.push(updateCapability(this, 'measure_current', data.active_current_a));

    await Promise.allSettled(updates);

    await this.setAvailable();
    this.failCount = 0;

  } catch (err) {

    if (err.message === 'TIMEOUT') {
      this._debugLog(`⏱️ Timeout during GET /data (outer catch)`);
    }

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


  onSettings(event) {
    const { newSettings, changedKeys } = event;

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
