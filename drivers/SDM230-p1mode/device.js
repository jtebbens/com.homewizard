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


module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this.failCount = 0;
    this._pendingStateUpdate = false;
    this._debugLogs = [];


    const settings = this.getSettings();
    this.log('Settings for SDM230: ', settings.polling_interval);


    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      
    
    if (this.getClass() == 'sensor') {
      this.setClass('socket');
      this.log('Changed sensor to socket.');
    }

    // Save export data check if capabilities are present first
    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power').catch(this.error);
    }

    if (this.hasCapability('measure_power.active_power_w')) {
      await this.removeCapability('measure_power.active_power_w').catch(this.error);
    } // remove

    if (!this.hasCapability('meter_power.consumed.t1')) {
      await this.addCapability('meter_power.consumed.t1').catch(this.error);
      // await this.addCapability('meter_power.consumed.t2').catch(this.error);
    }

    if (!this.hasCapability('measure_power.l1')) {
      await this.addCapability('measure_power.l1').catch(this.error);
    }

    if (!this.hasCapability('rssi')) {
      await this.addCapability('rssi').catch(this.error);
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
  }

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




  async setCloudOn() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    }).catch(this.error);

    if (!res.ok)
    { 
      // await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }


  async setCloudOff() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    }).catch(this.error);

    if (!res.ok)
    { 
      // await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }


  _onNewPowerValue(power) {
    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.updatePowerFromDevice(this, power);
    }
  }

  async onPoll() {
  const settings = this.getSettings();

  // Restore URL only from settings, never write back
  if (!this.url) {
    if (settings.url) {
      this.url = settings.url;
      this.log(`ℹ️ Restored URL from settings: ${this.url}`);
    } else {
      this.error('❌ Missing URL and no fallback settings.url found');
      await this.setUnavailable().catch(this.error);
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
    // CAPABILITY UPDATES (exactly your original logic)
    // -----------------------------
    await updateCapability(this, 'rssi', data.wifi_strength);

    // measure_power
    if (this.getClass() === 'solarpanel') {
      await updateCapability(this, 'measure_power', data.active_power_w * -1);
    } else {
      await updateCapability(this, 'measure_power', data.active_power_w);
      this._onNewPowerValue(data.active_power_w);
    }

    // meter_power.consumed.t1
    await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);

    // measure_power.l1
    if (this.getClass() === 'solarpanel') {
      await updateCapability(this, 'measure_power.l1', data.active_power_l1_w * -1);
    } else {
      await updateCapability(this, 'measure_power.l1', data.active_power_l1_w);
    }

    // meter_power.produced.t1
    if (data.total_power_export_t1_kwh > 1) {
      await updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh);
    } else if (this.hasCapability('meter_power.produced.t1')) {
      await this.removeCapability('meter_power.produced.t1').catch(this.error);
    }

    // aggregated meter_power
    await updateCapability(
      this,
      'meter_power',
      data.total_power_import_t1_kwh - data.total_power_export_t1_kwh
    );

    // measure_voltage
    if (data.active_voltage_v !== undefined) {
      await updateCapability(this, 'measure_voltage', data.active_voltage_v);
    } else if (this.hasCapability('measure_voltage')) {
      await this.removeCapability('measure_voltage').catch(this.error);
    }

    // measure_current
    if (data.active_current_a !== undefined) {
      await updateCapability(this, 'measure_current', data.active_current_a);
    } else if (this.hasCapability('measure_current')) {
      await this.removeCapability('measure_current').catch(this.error);
    }

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
      await this.setUnavailable(err.message || 'Polling error');
    }

  } finally {
    this.pollingActive = false;
  }
}


  async onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings 
      && MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for SDM230 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      // this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

      if ('cloud' in MySettings.oldSettings
        && MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
      ) {
        this.log('Cloud connection in advanced settings changed to:', MySettings.newSettings.cloud);

        if (MySettings.newSettings.cloud == 1) {
            this.setCloudOn();  
        }
        else if (MySettings.newSettings.cloud == 0) {
            this.setCloudOff();
        }
      }

      if ('baseload_notifications' in MySettings.oldSettings &&
        MySettings.oldSettings.baseload_notifications !== MySettings.newSettings.baseload_notifications
      ) {
        this._baseloadNotificationsEnabled = MySettings.newSettings.baseload_notifications;

        const app = this.homey.app;
        if (app.baseloadMonitor) {
          app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
        }

        this.log('Baseload notifications changed to:', this._baseloadNotificationsEnabled);
      }

    // return true;
  }

};
