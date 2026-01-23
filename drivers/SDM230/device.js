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

    // KeepAlive agent (blijft)
    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000,
    });


    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    const settings = this.getSettings();

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
    }

    const interval = Math.max(settings.polling_interval, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      this.onPoll().catch(this.error);
      this.onPollInterval = setInterval(() => {
        this.onPoll().catch(this.error);
      }, interval * 1000);
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
   * Per‑device debug logger
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
   * PUT /system cloud on/off — zonder timeout wrapper
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

      this.log('Cloud enabled');

    } catch (err) {
      this._debugLog(`Cloud ON failed: ${err.code || ''} ${err.message || err}`);
      this.error('Failed to enable cloud:', err);
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

      this.log('Cloud disabled');

    } catch (err) {
      this._debugLog(`Cloud OFF failed: ${err.code || ''} ${err.message || err}`);
      this.error('Failed to disable cloud:', err);
    }
  }

  /**
   * GET /data
   */
  async onPoll() {
    const settings = this.getSettings();
    
    // URL alleen uit settings; nooit terugschrijven
    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`Restored URL from settings: ${this.url}`);
      } else {
        this.setUnavailable('Missing URL').catch(this.error);
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

      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        this.error('JSON parse error:', err.message, 'Body:', text?.slice(0, 200));
        throw new Error('Invalid JSON');
      }

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid JSON');
      }

      
      await updateCapability(this, 'rssi', data.wifi_strength);

      const power = this.getClass() === 'solarpanel'
        ? data.active_power_w * -1
        : data.active_power_w;
      await updateCapability(this, 'measure_power', power);

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

      
      await updateCapability(this, 'measure_voltage', data.active_voltage_v);
      await updateCapability(this, 'measure_current', data.active_current_a);

      await this.setAvailable();

    } catch (err) {
      this._debugLog(`❌ ${err.code || ''} ${err.message || err}`);
      this.error('Polling failed:', err);
      this.setUnavailable(err.message || 'Polling error').catch(this.error);
    
    }

  }

  onSettings(event) {
    const { newSettings, changedKeys } = event;

    for (const key of changedKeys) {

      if (key === 'polling_interval') {
        const interval = newSettings.polling_interval;

        if (typeof interval === 'number' && interval > 0) {
          if (this.onPollInterval) clearInterval(this.onPollInterval);
          this.onPollInterval = setInterval(() => {
            this.onPoll().catch(this.error);
          }, interval * 1000);
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
