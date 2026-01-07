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



module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;
    this._pendingStateUpdate = false;
    this._debugLogs = [];

    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 11000
    });

    const settings = this.getSettings();

    if (settings.offset_polling == null) {
      await this.setSettings({ offset_polling: 10 });
    }

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
   * PUT /identify
   */
  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      }, 5000);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {

      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during PUT /identify`);
      }

      this.error('Identify failed:', err);
      throw new Error('Network error during identify');
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
    const offsetWater =
      data.total_liter_offset_m3 === 0 || data.total_liter_offset_m3 === '0'
        ? settings.offset_water
        : data.total_liter_offset_m3;

    const totalM3 = data.total_liter_m3 + offsetWater;

    await updateCapability(this, 'measure_water', data.active_liter_lpm);
    await updateCapability(this, 'meter_water', totalM3);
    await updateCapability(this, 'rssi', data.wifi_strength);

    // --- DAILY USAGE ---
    const dailyStart = await this._ensureDailyBaseline(totalM3);
    const dailyUsage = Math.max(0, totalM3 - dailyStart);

    await updateCapability(this, 'meter_water.daily', dailyUsage);


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

  /**
   * Daily baseline logic — deletion‑safe, timezone‑correct
   */
  async _ensureDailyBaseline(totalM3) {
    // Homey’s ISO date is LOCAL date (Amsterdam-correct)
    const today = new Date().toISOString().slice(0, 10);

    const storedDate = await this.getStoreValue('dailyStartDate');
    const storedValue = await this.getStoreValue('dailyStartM3');

    // Eerste keer of nieuwe dag → baseline resetten
    if (storedDate !== today || storedValue == null) {
      await this.setStoreValue('dailyStartDate', today);
      await this.setStoreValue('dailyStartM3', totalM3);
      return totalM3;
    }

    return storedValue;
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
