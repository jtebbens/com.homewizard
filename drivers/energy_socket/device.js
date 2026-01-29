'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const incomingSignal = options.signal;
  let controller;
  let timer;

  if (!incomingSignal) {
    controller = new AbortController();
    options = { ...options, signal: controller.signal };
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const res = await fetch(url, options);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('TIMEOUT');
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}



/**
 * Safe capability updater
 */
async function updateCapability(device, capability, value) {
  try {
    const current = device.getCapabilityValue(capability);

    // --- SAFE REMOVE ---
    // Removal is allowed only when:
    // 1) the new value is null
    // 2) the current value in Homey is also null

    if (value == null && current == null) {
      if (device.hasCapability(capability)) {
        await device.removeCapability(capability);
        device.log(`🗑️ Removed capability "${capability}"`);
      }
      return;
    }

    // --- ADD IF MISSING ---
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability);
      device.log(`➕ Added capability "${capability}"`);
    }

    // --- UPDATE ---
    if (current !== value) {
      await device.setCapabilityValue(capability, value);
    }

  } catch (err) {
    if (err.message === 'device_not_found') {
      device.log(`⚠️ Skipping capability "${capability}" — device not found`);
      return;
    }
    device.error(`❌ Failed updateCapability("${capability}")`, err);
  }
}

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    this._lastStatePoll = 0;
    this._debugLogs = [];
    this.__deleted = false;

    // KeepAlive agent (blijft)
    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
    });

    await updateCapability(this, 'connection_error', 'No errors');
    await updateCapability(this, 'alarm_connectivity', false);

    const interval = Math.max(this.getSetting('offset_polling') || 10, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    this.onPollInterval = setInterval(() => {
      this.onPoll().catch(this.error);
    }, interval * 1000);

    setTimeout(() => {
      this.onPoll().catch(this.error);
    }, offset);


    if (this.getClass() === 'sensor') {
      this.setClass('socket');
    }

    // Capability listeners
    this.registerCapabilityListener('onoff', async (value) => {
      if (this.getCapabilityValue('locked')) throw new Error('Device is locked');
      await this._putState({ power_on: value });
    });

    this.registerCapabilityListener('identify', async () => {
      await this._putIdentify();
    });

    this.registerCapabilityListener('dim', async (value) => {
      await this._putState({ brightness: Math.round(255 * value) });
    });

    this.registerCapabilityListener('locked', async (value) => {
      await this._putState({ switch_lock: value });
    });
  }

  onDeleted() {
    this.__deleted = true;

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    if (this._debugFlushTimeout) {
      clearTimeout(this._debugFlushTimeout);
      this._debugFlushTimeout = null;
    }
    // Flush remaining logs before device deletion
    if (this._debugBuffer && this._debugBuffer.length > 0) {
      this._flushDebugLogs();
    }
    // Destroy HTTP agent to close keep-alive sockets
    if (this.agent) {
      this.agent.destroy();
      this.agent = null;
    }
    // Clear debug buffer
    if (this._debugBuffer) {
      this._debugBuffer = null;
    }
  }

  /**
   * Discovery handlers
   */
  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.setAvailable();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`Discovery address changed: ${this.url}`);
    this.setAvailable();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.setAvailable();
  }

  /**
   * Debug logger (batched writes to shared app settings)
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
   * PUT /state (pure fetch, geen retries)
   */
  async _putState(body) {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/state`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {
      this._debugLog(`PUT /state failed: ${err.message}`);
      throw new Error('Network error during state update');
    }
  }

  /**
   * PUT /identify
   */
  async _putIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {
      this._debugLog(`PUT /identify failed: ${err.message}`);
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
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    } catch (err) {
      this._debugLog(`Cloud ON failed: ${err.message}`);
      throw new Error('Network error during setCloudOn');
    }
  }

  async setCloudOff() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: false })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    } catch (err) {
      this._debugLog(`Cloud OFF failed: ${err.message}`);
      throw new Error('Network error during setCloudOff');
    }
  }

  /**
   * GET /data + GET /state
   */
  async onPoll() {
  if (this.__deleted) return;

  const settings = this.getSettings();

  // URL restore when needed
  if (!this.url) {
    if (settings.url) {
      this.url = settings.url;
    } else {
      this.setUnavailable('Missing URL').catch(this.error);
      return;
    }
  }

  try {
    
    // -----------------------------
    // GET /data
    // -----------------------------
    const res = await fetchWithTimeout(`${this.url}/data`, {
      agent: this.agent,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

    const offset = Number(this.getSetting('offset_socket')) || 0;
    const watt = data.active_power_w + offset;

    const tasks = [];
    const cap = (name, value) => {
      if (value === undefined || value === null) return;
      const cur = this.getCapabilityValue(name);
      if (cur !== value) tasks.push(updateCapability(this, name, value));
    };

    cap('measure_power', watt);
    cap('meter_power.consumed.t1', data.total_power_import_t1_kwh);
    cap('measure_power.l1', data.active_power_l1_w);
    cap('rssi', data.wifi_strength);

    if (data.total_power_export_t1_kwh > 1) {
      cap('meter_power.produced.t1', data.total_power_export_t1_kwh);
    }

    const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
    cap('meter_power', net);

    cap('measure_voltage', data.active_voltage_v);
    cap('measure_current', data.active_current_a);

    // -----------------------------
    // GET /state (max 1× per 30s)
    // -----------------------------
    const now = Date.now();
    const mustPollState =
      !this._lastStatePoll ||
      (now - this._lastStatePoll) > 30000;

    if (mustPollState) {
      this._lastStatePoll = now;

      try {
        const resState = await fetchWithTimeout(`${this.url}/state`, {
          agent: this.agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!resState.ok) throw new Error(`HTTP ${resState.status}: ${resState.statusText}`);

        const state = await resState.json();
        if (!state || typeof state !== 'object') throw new Error('Invalid JSON');

        cap('onoff', state.power_on);
        cap('dim', state.brightness / 255);
        cap('locked', state.switch_lock);

      } catch (err) {
        this._debugLog(`State poll failed: ${err.message}`);
        cap('connection_error', err.message || 'State polling error');
        await updateCapability(this, 'alarm_connectivity', true);
      }
    }

    if (!this.__deleted && this.url !== settings.url) {
      this.setSettings({ url: this.url }).catch(this.error);
    }

    cap('connection_error', 'No errors');
    await updateCapability(this, 'alarm_connectivity', false);

    if (tasks.length > 0) await Promise.allSettled(tasks);
    this.setAvailable().catch(this.error);

  } catch (err) {
    if (!this.__deleted) {
      this._debugLog(`Poll failed: ${err.message}`);
      updateCapability(this, 'connection_error', err.message || 'Polling error')
        .catch(this.error);
      this.setUnavailable(err.message || 'Polling error')
        .catch(this.error);
      await updateCapability(this, 'alarm_connectivity', true);
    }
  }
}


  /**
   * Settings handler
   */
  async onSettings(oldSettings, newSettings, changedKeys = []) {

    for (const key of changedKeys) {

      if (key === 'offset_socket') {
        const cap = 'measure_power';
        const oldVal = Number(oldSettings[key]) || 0;
        const newVal = Number(newSettings[key]) || 0;
        const delta = newVal - oldVal;

        const current = this.getCapabilityValue(cap) || 0;
        await this.setCapabilityValue(cap, current + delta).catch(this.error);
      }

      if (key === 'offset_polling') {
        if (this.onPollInterval) {
          clearInterval(this.onPollInterval);
          this.onPollInterval = null;
        }

        const interval = Number(newSettings.offset_polling);
        if (interval >= 2) {  // Enforce minimum 2 second interval
          this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
        }
      }

      if (key === 'cloud') {
        try {
          if (newSettings.cloud == 1) await this.setCloudOn();
          else await this.setCloudOff();
        } catch (err) {
          this.error('Failed to update cloud setting:', err);
        }
      }
    }
  }
};
