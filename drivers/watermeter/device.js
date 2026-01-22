'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');


async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}



/**
 * Safe capability updater
 */
async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  if (value === undefined || value === null) return;

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this._debugLogs = [];

    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
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
      this.onPoll().catch(this.error);
      this.onPollInterval = setInterval(() => {
        this.onPoll().catch(this.error);
      }, interval * 1000);
    }, offset);

    const requiredCaps = [
      'measure_water',
      'meter_water',
      'meter_water.daily',
      'identify',
      'rssi'
    ];

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
   * Discovery — simpel gehouden
   */
  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.setAvailable();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`🔄 Discovery address changed: ${this.url}`);
    this.setAvailable();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.setAvailable();
  }

  /**
   * Per-device debug logger (batched writes)
   */
_debugLog(msg) {
  try {
    if (!this._debugBuffer) this._debugBuffer = [];
    const ts = new Date().toLocaleString('nl-NL', { hour12: false, timeZone: 'Europe/Amsterdam' });
    const driverName = this.driver.id;
    const deviceName = this.getName();
    const safeMsg = typeof msg === 'string' ? msg : (msg instanceof Error ? msg.message : JSON.stringify(msg));
    const line = `${ts} [${driverName}] [${deviceName}] ${safeMsg}`;
    this._debugBuffer.push(line);
    if (this._debugBuffer.length > 20) this._debugBuffer.shift();
    if (!this._debugFlushTimeout) {
      this._debugFlushTimeout = setTimeout(() => {
        this._flushDebugLogs();
        this._debugFlushTimeout = null;
      }, 5000);
    }
  } catch (err) {
    this.error('Failed to write debug logs:', err.message || err);
  }
}
_flushDebugLogs() {
  if (!this._debugBuffer || this._debugBuffer.length === 0) return;
  try {
    const logs = this.homey.settings.get('debug_logs') || [];
    logs.push(...this._debugBuffer);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    this.homey.settings.set('debug_logs', logs);
    this._debugBuffer = [];
  } catch (err) {
    this.error('Failed to flush debug logs:', err.message || err);
  }
}

  /**
   * PUT /identify — zonder timeout wrapper
   */
  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    } catch (err) {
      this._debugLog(`Identify failed: ${err.code || ''} ${err.message || err}`);
      this.error('Identify failed:', err);
      throw new Error('Network error during identify');
    }
  }

  /**
   * GET /data
   */
  async onPoll() {
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      } else {
        await this.setUnavailable('Missing URL');
        return;
      }
    }

    try {

      if (this.pollingActive) return;
      this.pollingActive = true;

      const res = await fetchWithTimeout(`${this.url}/data`, {
        agent: this.agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const text = await res.text();
      const data = JSON.parse(text);

      // --- Capability updates ---
      const offsetWater =
        data.total_liter_offset_m3 === 0 || data.total_liter_offset_m3 === '0'
          ? settings.offset_water
          : data.total_liter_offset_m3;

      const totalM3 = data.total_liter_m3 + offsetWater;

      await updateCapability(this, 'measure_water', data.active_liter_lpm);
      await updateCapability(this, 'meter_water', totalM3);
      await updateCapability(this, 'rssi', data.wifi_strength);

      // --- Daily baseline ---
      const dailyStart = await this._ensureDailyBaseline(totalM3);
      const dailyUsage = Math.max(0, totalM3 - dailyStart);

      await updateCapability(this, 'meter_water.daily', dailyUsage);

      await this.setAvailable();

    } catch (err) {
      this._debugLog(`❌ ${err.code || ''} ${err.message || err}`);
      this.error('Polling failed:', err);
      this.setUnavailable(err.message || 'Polling error').catch(this.error);

    } finally {
      this.pollingActive = false;
    }
  }

  /**
   * Daily baseline logic — deletion‑safe
   */
  async _ensureDailyBaseline(totalM3) {
    const today = new Date().toISOString().slice(0, 10);

    const storedDate = await this.getStoreValue('dailyStartDate');
    const storedValue = await this.getStoreValue('dailyStartM3');

    if (storedDate !== today || storedValue == null) {
      await this.setStoreValue('dailyStartDate', today);
      await this.setStoreValue('dailyStartM3', totalM3);
      return totalM3;
    }

    return storedValue;
  }

  onSettings(event) {
    const { newSettings, changedKeys } = event;

    for (const key of changedKeys) {

      if (key === 'offset_polling') {
        const interval = newSettings.offset_polling;

        if (typeof interval === 'number' && interval > 0) {
          if (this.onPollInterval) clearInterval(this.onPollInterval);
          this.onPollInterval = setInterval(() => {
            this.onPoll().catch(this.error);
          }, interval * 1000);
        }
      }

      if (key === 'cloud') {
        if (newSettings.cloud == 1) this.setCloudOn?.();
        else this.setCloudOff?.();
      }
    }
  }
};
