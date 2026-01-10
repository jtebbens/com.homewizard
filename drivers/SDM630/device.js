'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

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
 * Shared keep‑alive agent (blijft)
 */
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000
});

/**
 * Stable capability updater — deletion‑safe
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

module.exports = class HomeWizardEnergyDevice630 extends Homey.Device {

  async onInit() {

    this.pollingActive = false;
    this._debugLogs = [];

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
    }
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
  }

  /**
   * Discovery
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
   * Debug logger
   */
  _debugLog(msg) {
  try {
    const ts = new Date().toLocaleString('nl-NL', {
      hour12: false,
      timeZone: 'Europe/Amsterdam'
    });

    const driverName = this.driver.id;

    const safeMsg = typeof msg === 'string'
      ? msg
      : (msg instanceof Error ? msg.message : JSON.stringify(msg));

    const line = `${ts} [${driverName}] ${safeMsg}`;

    const logs = this.homey.settings.get('debug_logs') || [];
    logs.push(line);
    if (logs.length > 200) logs.shift();

    this.homey.settings.set('debug_logs', logs);

  } catch (err) {
    this.error('Failed to write debug logs:', err.message || err);
  }
}

  /**
   * Cloud toggles
   */
  async setCloudOn() {
    if (!this.url) return;

    const res = await fetchWithTimeout(`${this.url}/system`, {
      agent,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  async setCloudOff() {
    if (!this.url) return;

    const res = await fetchWithTimeout(`${this.url}/system`, {
      agent,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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

    if (this.pollingActive) return;
    this.pollingActive = true;

    try {
      const res = await fetchWithTimeout(`${this.url}/data`, {
        agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

      const tasks = [];

      // 1‑fase + totaal
      tasks.push(updateCapability(this, 'measure_power', data.active_power_w));
      tasks.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));
      tasks.push(updateCapability(this, 'rssi', data.wifi_strength));

      if (data.total_power_export_t1_kwh > 1) {
        tasks.push(updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh));
      }

      const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
      tasks.push(updateCapability(this, 'meter_power', net));

      // 3‑fase power
      tasks.push(updateCapability(this, 'measure_power.l1', data.active_power_l1_w));
      tasks.push(updateCapability(this, 'measure_power.l2', data.active_power_l2_w));
      tasks.push(updateCapability(this, 'measure_power.l3', data.active_power_l3_w));

      // 3‑fase voltage
      tasks.push(updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v));
      tasks.push(updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v));
      tasks.push(updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v));

      // 3‑fase current
      tasks.push(updateCapability(this, 'measure_current.l1', data.active_current_l1_a));
      tasks.push(updateCapability(this, 'measure_current.l2', data.active_current_l2_a));
      tasks.push(updateCapability(this, 'measure_current.l3', data.active_current_l3_a));

      await Promise.allSettled(tasks);

      await this.setAvailable();

    } catch (err) {
      this._debugLog(`Poll failed: ${err.message}`);
      await this.setUnavailable(err.message || 'Polling error');

    } finally {
      this.pollingActive = false;
    }
  }

  /**
   * Settings handler
   */
  onSettings(event) {
    const { newSettings, changedKeys } = event;

    for (const key of changedKeys) {

      if (key === 'polling_interval') {
        const interval = Math.max(newSettings.polling_interval, 2);

        if (this.onPollInterval) clearInterval(this.onPollInterval);

        this.onPollInterval = setInterval(() => {
          this.onPoll().catch(this.error);
        }, interval * 1000);
      }

      if (key === 'cloud') {
        if (newSettings.cloud == 1) this.setCloudOn();
        else this.setCloudOff();
      }
    }
  }
};
