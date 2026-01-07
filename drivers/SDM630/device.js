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
 * Shared HTTP agent
 */
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000
});

/**
 * Safe capability updater
 */
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
    this._pendingStateUpdate = false;
    this._debugLogs = [];

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

  /**
   * Discovery — burst-safe
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





  async setCloudOn() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      }, 5000);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      this.log('Cloud enabled successfully');
    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system (enable)`);
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

      this.log('Cloud disabled successfully');
    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /system (disable)`);
      }

      this.error('Failed to disable cloud:', err);
    }
  }

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
    // CAPABILITY UPDATES (exactly as in your original driver)
    // -----------------------------
    const updates = [];

    updates.push(updateCapability(this, 'measure_power', data.active_power_w));
    updates.push(updateCapability(this, 'measure_power.active_power_w', data.active_power_w));
    updates.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));
    updates.push(updateCapability(this, 'rssi', data.wifi_strength));

    if (data.total_power_export_t1_kwh > 1) {
      updates.push(updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh));
    }

    const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
    updates.push(updateCapability(this, 'meter_power', net));

    // 3‑phase power
    updates.push(updateCapability(this, 'measure_power.l1', data.active_power_l1_w));
    updates.push(updateCapability(this, 'measure_power.l2', data.active_power_l2_w));
    updates.push(updateCapability(this, 'measure_power.l3', data.active_power_l3_w));

    // 3‑phase voltage
    updates.push(updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v));
    updates.push(updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v));
    updates.push(updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v));

    // 3‑phase current
    updates.push(updateCapability(this, 'measure_current.l1', data.active_current_l1_a));
    updates.push(updateCapability(this, 'measure_current.l2', data.active_current_l2_a));
    updates.push(updateCapability(this, 'measure_current.l3', data.active_current_l3_a));

    await Promise.allSettled(updates);

    await this.setAvailable().catch(this.error);
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
      await this.setUnavailable(err.message || 'Polling error').catch(this.error);
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
