'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');
const BaseloadMonitor = require('../../includes/utils/baseloadMonitor');


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
 * Stable capability updater — never removes capabilities.
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

module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {

  async onInit() {

    this._debugLogs = [];

    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
    });
    

    const settings = this.getSettings();

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
    }

    const interval = Math.max(settings.polling_interval, 2);

    if (this.onPollInterval) clearInterval(this.onPollInterval);
    this.onPollInterval = setInterval(() => {
      this.onPoll().catch(this.error);
    }, interval * 1000);

    if (this.getClass() === 'sensor') {
      this.setClass('socket');
    }

    // Required capabilities
    const requiredCaps = [
      'measure_power',
      'meter_power.consumed.t1',
      'measure_power.l1',
      'rssi'
    ];

    for (const cap of requiredCaps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    // Baseload monitor
    this._baseloadNotificationsEnabled = this.getSetting('baseload_notifications') ?? true;

    const app = this.homey.app;
    if (!app.baseloadMonitor) {
      app.baseloadMonitor = new BaseloadMonitor(this.homey);
    }

    app.baseloadMonitor.registerP1Device(this);
    app.baseloadMonitor.trySetMaster(this);
    app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }

    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.unregisterP1Device(this);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`Discovery available: ${this.url}`);
    this.setAvailable();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`Discovery address changed: ${this.url}`);
    this.setAvailable();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._debugLog(`Discovery last seen: ${this.url}`);
    this.setAvailable();
  }

  /**
   * Debug logger (batched writes)
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

  async setCloudOn() {
    if (!this.url) return;

    const res = await fetchWithTimeout(`${this.url}/system`, {
      agent: this.agent,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  async setCloudOff() {
    if (!this.url) return;

    const res = await fetchWithTimeout(`${this.url}/system`, {
      agent: this.agent,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  _onNewPowerValue(power) {
    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.updatePowerFromDevice(this, power);
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
    
    const res = await fetchWithTimeout(`${this.url}/data`, {
      agent: this.agent,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

    // CAPABILITY UPDATES
    await updateCapability(this, 'rssi', data.wifi_strength);

    const power = this.getClass() === 'solarpanel'
      ? data.active_power_w * -1
      : data.active_power_w;

    await updateCapability(this, 'measure_power', power);
    this._onNewPowerValue(power);

    await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);

    const l1 = this.getClass() === 'solarpanel'
      ? data.active_power_l1_w * -1
      : data.active_power_l1_w;

    await updateCapability(this, 'measure_power.l1', l1);

    if (data.total_power_export_t1_kwh > 1) {
      await updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh);
    }

    const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
    await updateCapability(this, 'meter_power', net);

    if (data.active_voltage_v !== undefined) {
      await updateCapability(this, 'measure_voltage', data.active_voltage_v);
    }

    if (data.active_current_a !== undefined) {
      await updateCapability(this, 'measure_current', data.active_current_a);
    }

    await this.setAvailable();

    } catch (err) {

    if (err.message === 'TIMEOUT') {
      this._debugLog('SDM230 P1-mode timeout — no new telegrams, keeping last known values');
      // No return — allow finally to run
    } else {
      this._debugLog(`Poll failed: ${err.message}`);
      this.log('Polling error:', err.message || err);
      this.setUnavailable(err.message || 'Polling error').catch(this.error);
    }
  }

}


  async onSettings(event) {
    const { newSettings, oldSettings, changedKeys } = event;

    if (changedKeys.includes('polling_interval')) {
      clearInterval(this.onPollInterval);

      const interval = Math.max(newSettings.polling_interval, 2);

      this.onPollInterval = setInterval(() => {
        this.onPoll().catch(this.error);
      }, interval * 1000);
    }

    if (changedKeys.includes('cloud')) {
      if (newSettings.cloud == 1) {
        this.setCloudOn();
      } else {
        this.setCloudOff();
      }
    }

    if (changedKeys.includes('baseload_notifications')) {
      this._baseloadNotificationsEnabled = newSettings.baseload_notifications;

      const app = this.homey.app;
      if (app.baseloadMonitor) {
        app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
      }
    }
  }
};
