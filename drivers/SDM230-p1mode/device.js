'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const BaseloadMonitor = require('../../includes/utils/baseloadMonitor');

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
 * Stable capability updater — never removes capabilities.
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

module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;
    this._pendingStateUpdate = false;
    this._debugLogs = [];

    const settings = this.getSettings();
    this.log('Settings for SDM230:', settings.polling_interval);

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
    }

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);

    if (this.getClass() === 'sensor') {
      this.setClass('socket');
      this.log('Changed sensor to socket.');
    }

    // Ensure required capabilities exist
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

    // Baseload monitor wiring
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
    this._debugLog(`🔄 Discovery available: ${this.url}`);
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
    this._debugLog(`🔄 Discovery last seen: ${this.url}`);
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

    const res = await fetchWithTimeout(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    }, 5000).catch(this.error);

    if (!res?.ok) throw new Error(res?.statusText || 'Cloud enable failed');
  }

  async setCloudOff() {
    if (!this.url) return;

    const res = await fetchWithTimeout(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    }, 5000).catch(this.error);

    if (!res?.ok) throw new Error(res?.statusText || 'Cloud disable failed');
  }

  _onNewPowerValue(power) {
    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.updatePowerFromDevice(this, power);
    }
  }

  async onPoll() {
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`ℹ️ Restored URL from settings: ${this.url}`);
      } else {
        this.error('❌ Missing URL and no fallback settings.url found');
        await this.setUnavailable('Missing URL');
        return;
      }
    }

    if (this._pendingStateUpdate) {
      this._pendingStateUpdate = false;
      this._debugLog(`🔁 Forced poll due to discovery/state update`);
    }

    if (this.pollingActive) return;
    this.pollingActive = true;

    try {
      let res;
      try {
        res = await fetchWithTimeout(`${this.url}/data`, {
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

      let text;
      let data;

      try {
        text = await res.text();
        data = JSON.parse(text);
      } catch (err) {
        this.error(`JSON parse error at ${this.url}/data:`, err.message, 'Body:', text?.slice(0, 200));
        throw new Error('Invalid JSON');
      }

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid JSON');
      }

      // CAPABILITY UPDATES (stable, no removals)
      await updateCapability(this, 'rssi', data.wifi_strength);

      if (this.getClass() === 'solarpanel') {
        await updateCapability(this, 'measure_power', data.active_power_w * -1);
      } else {
        await updateCapability(this, 'measure_power', data.active_power_w);
        this._onNewPowerValue(data.active_power_w);
      }

      await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);

      if (this.getClass() === 'solarpanel') {
        await updateCapability(this, 'measure_power.l1', data.active_power_l1_w * -1);
      } else {
        await updateCapability(this, 'measure_power.l1', data.active_power_l1_w);
      }

      if (data.total_power_export_t1_kwh > 1) {
        await updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh);
      }

      await updateCapability(
        this,
        'meter_power',
        data.total_power_import_t1_kwh - data.total_power_export_t1_kwh
      );

      if (data.active_voltage_v !== undefined) {
        await updateCapability(this, 'measure_voltage', data.active_voltage_v);
      }

      if (data.active_current_a !== undefined) {
        await updateCapability(this, 'measure_current', data.active_current_a);
      }

      await this.setAvailable();
      this.failCount = 0;

    } catch (err) {
      if (err.message === 'TIMEOUT') {
        this._debugLog(`⏱️ Timeout during GET /data (outer catch)`);
      }

      this.error('Polling failed:', err);
      this.failCount++;

      if (this.failCount > 3) {
        await this.setUnavailable('Device unreachable');
      } else {
        await this.setUnavailable(err.message || 'Polling error');
      }

    } finally {
      this.pollingActive = false;
    }
  }

  async onSettings(MySettings) {
    this.log('Settings updated:', MySettings);

    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for SDM230 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      this.pollingActive = false;
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

    if ('cloud' in MySettings.oldSettings &&
        MySettings.oldSettings.cloud !== MySettings.newSettings.cloud) {

      this.log('Cloud connection changed to:', MySettings.newSettings.cloud);

      if (MySettings.newSettings.cloud == 1) {
        this.setCloudOn();
      } else {
        this.setCloudOff();
      }
    }

    if ('baseload_notifications' in MySettings.oldSettings &&
        MySettings.oldSettings.baseload_notifications !== MySettings.newSettings.baseload_notifications) {

      this._baseloadNotificationsEnabled = MySettings.newSettings.baseload_notifications;

      const app = this.homey.app;
      if (app.baseloadMonitor) {
        app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
      }

      this.log('Baseload notifications changed to:', this._baseloadNotificationsEnabled);
    }
  }
};
