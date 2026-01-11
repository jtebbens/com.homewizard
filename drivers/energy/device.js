'use strict';

const Homey = require('homey');
//const fetch = require('../../includes/utils/fetchQueue');
const fetch = require('node-fetch');
const BaseloadMonitor = require('../../includes/utils/baseloadMonitor');
const http = require('http');


// All phase‑dependent capabilities (L2/L3/T3)
const PHASE_CAPS = [
  'measure_power.l2', 'measure_power.l3',
  'measure_voltage.l2', 'measure_voltage.l3',
  'measure_current.l2', 'measure_current.l3',
  'net_load_phase2_pct', 'net_load_phase3_pct',
  'voltage_sag_l2', 'voltage_sag_l3',
  'voltage_swell_l2', 'voltage_swell_l3',
  'meter_power.consumed.t3', 'meter_power.produced.t3'
];

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



function getWifiQuality(percent) {
  if (percent >= 80) return 'Excellent / Strong';
  if (percent >= 60) return 'Moderate';
  if (percent >= 40) return 'Weak';
  if (percent >= 20) return 'Poor';
  if (percent > 0) return 'Unusable';
  return 'Unusable';
}

module.exports = class HomeWizardEnergyDevice extends Homey.Device {

  async onInit() {
    this.pollingActive = false;
    this.failCount = 0;
    this._lastSamples = {}; // mini-cache
    this._deleted = false;

    this.agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 10000
    });

    await updateCapability(this, 'connection_error', 'No errors');

    // Remove legacy capabilities once
    for (const cap of ['net_load_phase1', 'net_load_phase2', 'net_load_phase3']) {
      if (this.hasCapability(cap)) {
        await this.removeCapability(cap).catch(this.error);
      }
    }

    const settings = this.getSettings();

    this._overloadThreshold = settings.phase_overload_threshold ?? 97;
    this._overloadReset = settings.phase_overload_reset ?? 85;

    if (!settings.polling_interval) {
      await this.setSettings({ polling_interval: 10 });
    }

    if (settings.phase_capacity == null) {
      await this.setSettings({ phase_capacity: 40 });
    }

    if (settings.number_of_phases == null) {
      await this.setSettings({ number_of_phases: 1 });
    }

    if (settings.show_gas === undefined || settings.show_gas === null) {
      await this.setSettings({ show_gas: true });
    }

    // Initial phase count (user setting or autodetect later)
    this._phases = Number(this.getSettings().number_of_phases) || 1;

    // Clean slate: if 1 phase → remove all L2/L3/T3
    if (this._phases === 1) {
      for (const cap of PHASE_CAPS) {
        if (this.hasCapability(cap)) {
          await this.removeCapability(cap).catch(this.error);
        }
      }
    }

    // If 3 phases → ensure all L2/L3/T3 exist
    if (this._phases === 3) {
      for (const cap of PHASE_CAPS) {
        if (!this.hasCapability(cap)) {
          await this.addCapability(cap).catch(this.error);
        }
      }
    }

    // Autodetect counter for 1 → 3 phases promotion
    this._phaseDetectCount = 0;

    // Gas capabilities are settings-driven, not payload-driven
    if (!settings.show_gas) {
      for (const cap of ['meter_gas', 'measure_gas', 'meter_gas.daily']) {
        if (this.hasCapability(cap)) {
          await this.removeCapability(cap).catch(this.error);
        }
      }
    }

    const interval = Math.max(this.getSettings().polling_interval, 2);
    const offset = Math.floor(Math.random() * interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    setTimeout(() => {
      if (this._deleted) return;
      this.onPoll();
      this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
    }, offset);

    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed');

    this.registerCapabilityListener('identify', async () => {
      await this.onIdentify();
    });

    // Baseload monitor wiring
    this._baseloadNotificationsEnabled = this.getSetting('baseload_notifications') ?? true;
    this._phaseOverloadNotificationsEnabled = this.getSetting('phase_overload_notifications') ?? true;

    this._phaseOverloadState = {
      l1: { highCount: 0, notified: false },
      l2: { highCount: 0, notified: false },
      l3: { highCount: 0, notified: false },
    };

    const app = this.homey.app;
    if (!app.baseloadMonitor) {
      app.baseloadMonitor = new BaseloadMonitor(this.homey);
    }

    app.baseloadMonitor.registerP1Device(this);
    app.baseloadMonitor.trySetMaster(this);
    app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
  }

  // mini-cache helper
  _hasChanged(key, value) {
    const prev = this._lastSamples[key];
    if (prev === value) return false;
    this._lastSamples[key] = value;
    return true;
  }

  onDeleted() {
    this._deleted = true;

    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.unregisterP1Device(this);
    }

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
  }

  flowTriggerTariff(device, tokens) {
    this._flowTriggerTariff.trigger(device, tokens).catch(this.error);
  }

  flowTriggerImport(device, tokens) {
    this._flowTriggerImport.trigger(device, tokens).catch(this.error);
  }

  flowTriggerExport(device, tokens) {
    this._flowTriggerExport.trigger(device, tokens).catch(this.error);
  }

  _onNewPowerValue(power) {
    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.updatePowerFromDevice(this, power);
    }
  }

  async onIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

    } catch (err) {
      this.error(err);
      throw new Error('Network error during onIdentify');
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    if (this._deleted) return;
    try {
      if (!discoveryResult?.address || !discoveryResult?.port || !discoveryResult?.txt?.path) {
        throw new Error('Invalid discovery result: missing address, port, or path');
      }

      this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
      this.log(`Discovered device URL: ${this.url}`);
      this.onPoll();

    } catch (err) {
      this.log(`Discovery failed: ${err.message}`);
    }
  }

  onDiscoveryAddressChanged(discoveryResult) {
    if (this._deleted) return;
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL updated: ${this.url}`);
    this._debugLog(`Discovery address changed: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    if (this._deleted) return;
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL restored: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  async setCloudOn() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      });

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

    } catch (err) {
      this.error(err);
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

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

    } catch (err) {
      this.error(err);
      throw new Error('Network error during setCloudOff');
    }
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

  async onPoll() {
    if (this._deleted) return;
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`Restored URL from settings: ${this.url}`);
      } else {
        await this.setUnavailable('Missing URL');
        return;
      }
    }

    if (this.pollingActive) return;
    this.pollingActive = true;

    try {
      const tz = this.homey.clock.getTimezone();
      const now = new Date();
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const homeyLang = this.homey.i18n.getLanguage();

      const res = await fetchWithTimeout(`${this.url}/data`, {
        agent: this.agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', 'Fetch error');
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

      // const data = await res.json();
      // if (!data || typeof data !== 'object') throw new Error('Invalid JSON');

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


      const tasks = [];

      // ------------------------------
      // GAS SOURCE SELECTION (FIX)
      // ------------------------------
      let gasValue = null;
      let gasTimestamp = null;

      // 1. Prefer external gas meters with real timestamps
      if (Array.isArray(data.external)) {
        const gasMeters = data.external
          .filter(e => e.type === 'gas_meter' && e.value != null && e.timestamp != null);

        if (gasMeters.length > 0) {
          // pick the most recent gas meter
          gasMeters.sort((a, b) => b.timestamp - a.timestamp);
          gasValue = gasMeters[0].value;
          gasTimestamp = gasMeters[0].timestamp;
        }
      }

      // 2. Fallback to administrative gas meter
      if (gasValue == null && data.total_gas_m3 != null) {
        gasValue = data.total_gas_m3;
        gasTimestamp = data.gas_timestamp;
      }

      // Expose unified gas fields for the rest of the driver
      data._gasValue = gasValue;
      data._gasTimestamp = gasTimestamp;


      // Autodetect 3 phases (only promote, never demote)
      const hasRealL2 = typeof data.active_current_l2_a === 'number' && data.active_current_l2_a !== 0;
      const hasRealL3 = typeof data.active_current_l3_a === 'number' && data.active_current_l3_a !== 0;

      if (this._phases === 1 && (hasRealL2 || hasRealL3)) {
        this._phaseDetectCount++;

        // Require 5 consecutive polls with L2/L3 activity before promoting
        if (this._phaseDetectCount >= 5) {
          this._phases = 3;
          await this.setSettings({ number_of_phases: 3 }).catch(this.error);

          // Add all L2/L3/T3 capabilities
          for (const cap of PHASE_CAPS) {
            if (!this.hasCapability(cap)) {
              await this.addCapability(cap).catch(this.error);
            }
          }

          this.log('Autodetect: promoted to 3 phases');
        }
      } else {
        this._phaseDetectCount = 0;
      }

      // --- Midnight daily reset (store baseline) ---
      if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {

        // Electricity baseline
        if (data.total_power_import_kwh !== undefined) {
          tasks.push(
            this.setStoreValue('meter_start_day', data.total_power_import_kwh)
              .catch(this.error)
          );
        }

        // Gas baseline — always use last known value
        if (settings.show_gas) {
          const lastKnownGas =
            data._gasValue ??
            (await this.getStoreValue('gasmeter_start_day')) ??
            0;

          tasks.push(
            this.setStoreValue('gasmeter_start_day', lastKnownGas)
          );
        }
      }


      // Gas 5‑minute delta
      if (settings.show_gas && (nowLocal.getMinutes() % 5 === 0)) {
        const prevTs = await this.getStoreValue('gasmeter_previous_reading_timestamp');

        if (prevTs == null) {
          tasks.push(this.setStoreValue('gasmeter_previous_reading_timestamp', data._gasTimestamp));
        } else if (data._gasValue != null && prevTs !== data._gasTimestamp) {
          const prevReading = await this.getStoreValue('gasmeter_previous_reading');
          if (prevReading != null) {
            const gasDelta = data._gasValue - prevReading;
            if (gasDelta >= 0 && this._hasChanged('measure_gas_delta', gasDelta)) {
              tasks.push(updateCapability(this, 'measure_gas', gasDelta));
            }
          }
          tasks.push(this.setStoreValue('gasmeter_previous_reading', data._gasValue));
          tasks.push(this.setStoreValue('gasmeter_previous_reading_timestamp', data._gasTimestamp));
        }

      }

      // Daily totals electra
        const meterStart = await this.getStoreValue('meter_start_day');
        if (meterStart != null && data.total_power_import_kwh != null) {
          const dailyImport = data.total_power_import_kwh - meterStart;
          if (this._hasChanged('meter_power.daily', dailyImport)) {
            tasks.push(updateCapability(this, 'meter_power.daily', dailyImport));
          }
        }

        if (settings.show_gas) {

          // Daily totals when gas is enabled
          const gasStart = await this.getStoreValue('gasmeter_start_day');
          if (data._gasValue != null && gasStart != null) {
            const gasDiff = data._gasValue - gasStart;
            if (this._hasChanged('meter_gas.daily', gasDiff)) {
              tasks.push(updateCapability(this, 'meter_gas.daily', gasDiff));
            }
          }
        }


      // Core power + baseload
      if (this._hasChanged('measure_power', data.active_power_w)) {
        tasks.push(updateCapability(this, 'measure_power', data.active_power_w));
        this._onNewPowerValue(data.active_power_w);
      }

      if (this._hasChanged('rssi', data.wifi_strength)) {
        tasks.push(updateCapability(this, 'rssi', data.wifi_strength));
      }

      if (this._hasChanged('tariff', data.active_tariff)) {
        tasks.push(updateCapability(this, 'tariff', data.active_tariff));
      }

      tasks.push(updateCapability(this, 'identify', 'identify'));

      if (this._hasChanged('meter_power.consumed.t1', data.total_power_import_t1_kwh)) {
        tasks.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));
      }
      if (this._hasChanged('meter_power.consumed.t2', data.total_power_import_t2_kwh)) {
        tasks.push(updateCapability(this, 'meter_power.consumed.t2', data.total_power_import_t2_kwh));
      }
      if (this._hasChanged('meter_power.consumed', data.total_power_import_kwh)) {
        tasks.push(updateCapability(this, 'meter_power.consumed', data.total_power_import_kwh));
      }

      const wifiQuality = getWifiQuality(data.wifi_strength);
      if (this._hasChanged('wifi_quality', wifiQuality)) {
        tasks.push(updateCapability(this, 'wifi_quality', wifiQuality));
      }

      // Tariff flow trigger (store‑based, not cache‑based)
      const lastTariff = await this.getStoreValue('last_active_tariff');
      const currentTariff = data.active_tariff;
      if (typeof currentTariff === 'number' && currentTariff !== lastTariff) {
        this.flowTriggerTariff(this, { tariff_changed: currentTariff });
        tasks.push(this.setStoreValue('last_active_tariff', currentTariff).catch(this.error));
      }

      // Gas meter if enabled
      if (settings.show_gas && data._gasValue != null && this._hasChanged('meter_gas', data._gasValue)) {
        tasks.push(updateCapability(this, 'meter_gas', data._gasValue));
      }


      // Export (produced)
      if (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1) {
        if (this._hasChanged('meter_power.produced.t1', data.total_power_export_t1_kwh)) {
          tasks.push(updateCapability(this, 'meter_power.produced.t1', data.total_power_export_t1_kwh));
        }
        if (this._hasChanged('meter_power.produced.t2', data.total_power_export_t2_kwh)) {
          tasks.push(updateCapability(this, 'meter_power.produced.t2', data.total_power_export_t2_kwh));
        }
      }

      // Aggregated meter for Power by the hour
      const netImport = data.total_power_import_kwh === undefined
        ? (data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) -
          (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh)
        : data.total_power_import_kwh - data.total_power_export_kwh;

      if (this._hasChanged('meter_power', netImport)) {
        tasks.push(updateCapability(this, 'meter_power', netImport));
      }

      if (data.total_power_import_kwh !== undefined &&
          this._hasChanged('meter_power.returned', data.total_power_export_kwh)) {
        tasks.push(updateCapability(this, 'meter_power.returned', data.total_power_export_kwh));
      }

      // Import flow trigger (store‑based)
      const lastImport = await this.getStoreValue('last_total_import_kwh');
      const currentImport = data.total_power_import_kwh;
      if (typeof currentImport === 'number' && currentImport !== lastImport) {
        this.flowTriggerImport(this, { import_changed: currentImport });
        tasks.push(this.setStoreValue('last_total_import_kwh', currentImport).catch(this.error));
      }

      // Export flow trigger (store‑based)
      const lastExport = await this.getStoreValue('last_total_export_kwh');
      const currentExport = data.total_power_export_kwh;
      if (typeof currentExport === 'number' && currentExport !== lastExport) {
        this.flowTriggerExport(this, { export_changed: currentExport });
        tasks.push(this.setStoreValue('last_total_export_kwh', currentExport).catch(this.error));
      }

      // Belgium monthly peak
      if (this._hasChanged('measure_power.montly_power_peak', data.montly_power_peak_w)) {
        tasks.push(updateCapability(this, 'measure_power.montly_power_peak', data.montly_power_peak_w));
      }

      // Phase 1 voltage/current/power
      if (data.active_voltage_l1_v !== undefined &&
          this._hasChanged('measure_voltage.l1', data.active_voltage_l1_v)) {
        tasks.push(updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v));
      }
      if (data.active_current_l1_a !== undefined &&
          this._hasChanged('measure_current.l1', data.active_current_l1_a)) {
        tasks.push(updateCapability(this, 'measure_current.l1', data.active_current_l1_a));
      }
      if (data.active_power_l1_w !== undefined &&
          this._hasChanged('measure_power.l1', data.active_power_l1_w)) {
        tasks.push(updateCapability(this, 'measure_power.l1', data.active_power_l1_w));
      }

      if (data.long_power_fail_count !== undefined &&
          this._hasChanged('long_power_fail_count', data.long_power_fail_count)) {
        tasks.push(updateCapability(this, 'long_power_fail_count', data.long_power_fail_count));
      }

      if (data.voltage_sag_l1_count !== undefined &&
          this._hasChanged('voltage_sag_l1', data.voltage_sag_l1_count)) {
        tasks.push(updateCapability(this, 'voltage_sag_l1', data.voltage_sag_l1_count));
      }

      if (data.voltage_swell_l1_count !== undefined &&
          this._hasChanged('voltage_swell_l1', data.voltage_swell_l1_count)) {
        tasks.push(updateCapability(this, 'voltage_swell_l1', data.voltage_swell_l1_count));
      }

      // Phase overload L1
      if (data.active_current_l1_a !== undefined) {
        const load1 = Math.abs((data.active_current_l1_a / settings.phase_capacity) * 100);
        if (this._hasChanged('net_load_phase1_pct', load1)) {
          tasks.push(updateCapability(this, 'net_load_phase1_pct', load1));
          this._handlePhaseOverload('l1', load1, homeyLang);
        }
      }

      // Phases 2 and 3 — only when we truly run 3 phases
      if (this._phases === 3 && (data.active_current_l2_a !== undefined || data.active_current_l3_a !== undefined)) {

        if (data.voltage_sag_l2_count !== undefined &&
            this._hasChanged('voltage_sag_l2', data.voltage_sag_l2_count)) {
          tasks.push(updateCapability(this, 'voltage_sag_l2', data.voltage_sag_l2_count));
        }
        if (data.voltage_sag_l3_count !== undefined &&
            this._hasChanged('voltage_sag_l3', data.voltage_sag_l3_count)) {
          tasks.push(updateCapability(this, 'voltage_sag_l3', data.voltage_sag_l3_count));
        }
        if (data.voltage_swell_l2_count !== undefined &&
            this._hasChanged('voltage_swell_l2', data.voltage_swell_l2_count)) {
          tasks.push(updateCapability(this, 'voltage_swell_l2', data.voltage_swell_l2_count));
        }
        if (data.voltage_swell_l3_count !== undefined &&
            this._hasChanged('voltage_swell_l3', data.voltage_swell_l3_count)) {
          tasks.push(updateCapability(this, 'voltage_swell_l3', data.voltage_swell_l3_count));
        }

        if (data.active_power_l2_w !== undefined &&
            this._hasChanged('measure_power.l2', data.active_power_l2_w)) {
          tasks.push(updateCapability(this, 'measure_power.l2', data.active_power_l2_w));
        }
        if (data.active_power_l3_w !== undefined &&
            this._hasChanged('measure_power.l3', data.active_power_l3_w)) {
          tasks.push(updateCapability(this, 'measure_power.l3', data.active_power_l3_w));
        }

        if (data.active_voltage_l2_v !== undefined &&
            this._hasChanged('measure_voltage.l2', data.active_voltage_l2_v)) {
          tasks.push(updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v));
        }
        if (data.active_voltage_l3_v !== undefined &&
            this._hasChanged('measure_voltage.l3', data.active_voltage_l3_v)) {
          tasks.push(updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v));
        }

        if (data.active_current_l2_a !== undefined) {
          const load2 = Math.abs((data.active_current_l2_a / settings.phase_capacity) * 100);
          if (this._hasChanged('measure_current.l2', data.active_current_l2_a)) {
            tasks.push(updateCapability(this, 'measure_current.l2', data.active_current_l2_a));
          }
          if (this._hasChanged('net_load_phase2_pct', load2)) {
            tasks.push(updateCapability(this, 'net_load_phase2_pct', load2));
            this._handlePhaseOverload('l2', load2, homeyLang);
          }
        }

        if (data.active_current_l3_a !== undefined) {
          const load3 = Math.abs((data.active_current_l3_a / settings.phase_capacity) * 100);
          if (this._hasChanged('measure_current.l3', data.active_current_l3_a)) {
            tasks.push(updateCapability(this, 'measure_current.l3', data.active_current_l3_a));
          }
          if (this._hasChanged('net_load_phase3_pct', load3)) {
            tasks.push(updateCapability(this, 'net_load_phase3_pct', load3));
            this._handlePhaseOverload('l3', load3, homeyLang);
          }
        }
      }

      // T3 import/export: only relevant if we actually run 3 phases
      if (this._phases === 3) {
        if (this._hasChanged('meter_power.consumed.t3', data.total_power_import_t3_kwh)) {
          tasks.push(updateCapability(this, 'meter_power.consumed.t3', data.total_power_import_t3_kwh));
        }
        if (this._hasChanged('meter_power.produced.t3', data.total_power_export_t3_kwh)) {
          tasks.push(updateCapability(this, 'meter_power.produced.t3', data.total_power_export_t3_kwh));
        }
      }

      // External water (if present)
      const externalData = data.external;
      if (Array.isArray(externalData)) {
        const latestWater = externalData.reduce((prev, current) => {
          if (current.type === 'water_meter') {
            return !prev || current.timestamp > prev.timestamp ? current : prev;
          }
          return prev;
        }, null);

        if (latestWater && latestWater.value != null &&
            this._hasChanged('meter_water', latestWater.value)) {
          tasks.push(updateCapability(this, 'meter_water', latestWater.value));
        }
      }

      // Sync URL if changed
      if (this.url !== settings.url) {
        this.log(`Energy - Updating settings url from ${settings.url} → ${this.url}`);
        tasks.push(this.setSettings({ url: this.url }).catch(this.error));
      }

      await Promise.allSettled(tasks);

      await updateCapability(this, 'connection_error', 'No errors');
      await this.setAvailable();
      this.failCount = 0;

    } catch (err) {
      this.error('Poll failed:', err);

      await updateCapability(this, 'connection_error', err.message || 'Polling error');
      this.failCount++;

      if (['ETIMEDOUT', 'ECONNRESET'].includes(err.code)) {
        this.log('Timeout/connection reset detected — recreating HTTP agent and retrying');
        try {
          this.agent.destroy?.();
          this.agent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 10000,
            maxSockets: 1
          });
        } catch (createErr) {
          this.error('Failed to recreate agent:', createErr);
        }

        setTimeout(() => {
          if (this._deleted) return;
          this.onPoll();
        }, 2000);
      }

      if (this.failCount > 3) {
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        await this.setUnavailable('Device unreachable');
      } else {
        await this.setUnavailable(err.message || 'Polling error');
        this._debugLog(`Poll failed: ${err.message}`);
      }

    } finally {
      this.pollingActive = false;
    }
  }

  _handlePhaseOverload(phaseKey, loadPct, lang) {
    if (!this._phaseOverloadNotificationsEnabled) return;

    const state = this._phaseOverloadState[phaseKey];
    if (!state) return;

    const threshold = this._overloadThreshold ?? 97;
    const reset = this._overloadReset ?? 85;

    if (loadPct > threshold) {
      state.highCount++;

      if (!state.notified && state.highCount >= 3) {
        const phaseNum = phaseKey.replace('l', '');
        const msg = lang === 'nl'
          ? `Fase ${phaseNum} overbelast (${loadPct.toFixed(0)}%)`
          : `Phase ${phaseNum} overloaded (${loadPct.toFixed(0)}%)`;

        this.homey.notifications.createNotification({ excerpt: msg }).catch(this.error);
        state.notified = true;
      }

    } else if (loadPct < reset) {
      state.highCount = 0;
      state.notified = false;
    }
  }

  async onSettings(event) {
    const { newSettings, changedKeys } = event;
    this.log('Settings updated', changedKeys);

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
        try {
          if (newSettings.cloud == 1) await this.setCloudOn();
          else await this.setCloudOff();
        } catch (err) {
          this.error('Failed to update cloud connection:', err);
        }
      }

      if (key === 'baseload_notifications') {
        this._baseloadNotificationsEnabled = newSettings.baseload_notifications;
        const app = this.homey.app;
        if (app.baseloadMonitor) {
          app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
        }
        this.log('Baseload notifications changed to:', this._baseloadNotificationsEnabled);
      }

      if (key === 'phase_overload_notifications') {
        this._phaseOverloadNotificationsEnabled = newSettings.phase_overload_notifications;
        this.log('Phase overload notifications changed to:', this._phaseOverloadNotificationsEnabled);
      }

      if (key === 'show_gas') {
        const showGas = newSettings.show_gas;
        if (!showGas) {
          for (const cap of ['meter_gas', 'measure_gas', 'meter_gas.daily']) {
            if (this.hasCapability(cap)) {
              await this.removeCapability(cap).catch(this.error);
            }
          }
        }
      }

      if (key === 'phase_overload_threshold') {
        this._overloadThreshold = newSettings.phase_overload_threshold;
        this.log('Phase overload threshold changed to:', this._overloadThreshold);
      }

      if (key === 'phase_overload_reset') {
        this._overloadReset = newSettings.phase_overload_reset;
        this.log('Phase overload reset changed to:', this._overloadReset);
      }

      if (key === 'number_of_phases') {
        // Manual override: keep capabilities in sync with explicit phase setting
        this._phases = newSettings.number_of_phases;

        if (this._phases === 1) {
          for (const cap of PHASE_CAPS) {
            if (this.hasCapability(cap)) {
              await this.removeCapability(cap).catch(this.error);
            }
          }
        }

        if (this._phases === 3) {
          for (const cap of PHASE_CAPS) {
            if (!this.hasCapability(cap)) {
              await this.addCapability(cap).catch(this.error);
            }
          }
        }
      }

    }
  }

};
