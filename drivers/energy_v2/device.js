'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');
const api = require('../../includes/v2/Api');
const WebSocketManager = require('../../includes/v2/Ws');
const wsDebug = require('../../includes/v2/wsDebug');
const debug = false;

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Create an agent that skips TLS verification
const agent = new https.Agent({
  rejectUnauthorized: false
});



/**
 * Helper function to add, remove or update a capability
 * @async
 * @param {Homey.Device} device The device instance
 * @param {string} capability The capability identifier
 * @param {any} value The value to set
 * @returns {Promise<void>} 
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


async function setStoreValueSafe(device, key, value) {
  try {
    return await device.setStoreValue(key, value);
  } catch (err) {
    if (err.message === 'device_not_found') {
      device.log(`⚠️ Skipping setStoreValue("${key}") — device not found`);
      return null;
    }
    device.error(`❌ Failed setStoreValue("${key}")`, err);
    return null;
  }
}

async function getStoreValueSafe(device, key) {
  try {
    return await device.getStoreValue(key);
  } catch (err) {
    if (err.message === 'device_not_found') {
      device.log(`⚠️ Skipping getStoreValue("${key}") — device not found`);
      return null;
    }
    device.error(`❌ Failed getStoreValue("${key}")`, err);
    return null;
  }
}


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
      .then(async res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const text = await res.text();
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
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
 * Helper function to determine WiFi quality
 * @param {number} strength The WiFi signal strength
 * @returns {string} The quality level ('poor', 'fair', 'good')
 */
function getWifiQuality(strength) {
  if (strength >= -30) return 'Excellent';  // Strongest signal
  if (strength >= -60) return 'Strong';     // Strong
  if (strength >= -70) return 'Moderate';  // Good to Fair
  if (strength >= -80) return 'Weak';     // Fair to Weak
  if (strength >= -90) return 'Poor'; // Weak to Unusable
  return 'Unusable';                      // Very poor signal
}

async function applyMeasurementCapabilities(device, m) {
  try {
    const mappings = {
      // Generic
      'measure_power': m.power_w,
      'measure_voltage': m.voltage_v,
      'measure_current': m.current_a,
      'meter_power.consumed': m.energy_import_kwh,
      'meter_power.returned': m.energy_export_kwh,
      'tariff': m.tariff,
      'measure_frequency': m.frequency_hz,

      // Per phase
      'measure_power.l1': m.power_l1_w,
      'measure_power.l2': m.power_l2_w,
      'measure_power.l3': m.power_l3_w,
      'measure_voltage.l1': m.voltage_l1_v,
      'measure_voltage.l2': m.voltage_l2_v,
      'measure_voltage.l3': m.voltage_l3_v,
      'measure_current.l1': m.current_l1_a,
      'measure_current.l2': m.current_l2_a,
      'measure_current.l3': m.current_l3_a,

      // Tariff totals
      'meter_power.consumed.t1': m.energy_import_t1_kwh,
      'meter_power.produced.t1': m.energy_export_t1_kwh,
      'meter_power.consumed.t2': m.energy_import_t2_kwh,
      'meter_power.produced.t2': m.energy_export_t2_kwh,
      'meter_power.consumed.t3': m.energy_import_t3_kwh,
      'meter_power.produced.t3': m.energy_export_t3_kwh,
      'meter_power.consumed.t4': m.energy_import_t4_kwh,
      'meter_power.produced.t4': m.energy_export_t4_kwh,

      // Net quality
      'long_power_fail_count': m.long_power_fail_count,
      'voltage_sag_l1': m.voltage_sag_l1_count,
      'voltage_sag_l2': m.voltage_sag_l2_count,
      'voltage_sag_l3': m.voltage_sag_l3_count,
      'voltage_swell_l1': m.voltage_swell_l1_count,
      'voltage_swell_l2': m.voltage_swell_l2_count,
      'voltage_swell_l3': m.voltage_swell_l3_count,

      // Belgium
      'measure_power.montly_power_peak': m.monthly_power_peak_w,
      'measure_power.average_power_15m_w': m.average_power_15m_w,
    };

    // Collect all capability updates as promises
    const tasks = [];

    for (const [capability, value] of Object.entries(mappings)) {
      const cur = device.getCapabilityValue(capability);
      if (cur !== value) {
        tasks.push(updateCapability(device, capability, value ?? null));
      }
    }

    // Run all updates in parallel
    await Promise.allSettled(tasks);

  } catch (error) {
    device.error('Failed to apply measurement capabilities:', error);
    throw error;
  }
}




/**
 * Normalize battery mode from raw payload
 * @param {Object} data - battery payload { mode, permissions }
 * @returns {string} normalized mode string
 */
function normalizeBatteryMode(data) {
  // ✅ Already normalized (string)
  if (typeof data === 'string') {
    return data;
  }

  let mode = typeof data.mode === 'string'
    ? data.mode.trim().replace(/^["']+|["']+$/g, '')
    : data.mode;

  const perms = Array.isArray(data.permissions)
    ? [...data.permissions].sort().join(',')
    : null;

  if (mode === 'standby') return 'standby';
  if (mode === 'to_full') return 'to_full';

  if (mode === 'zero_charge_only' || mode === 'zero_discharge_only') {
    mode = 'zero';
  }

  if (mode === 'zero') {
    switch (perms) {
      case 'charge_allowed,discharge_allowed':
        return 'zero';
      case 'charge_allowed':
        return 'zero_charge_only';
      case 'discharge_allowed':
        return 'zero_discharge_only';
      case '':
      case null:
        return 'zero';
      default:
        console.log(`⚠️ Unknown permissions mode=zero: ${perms}`);
        return 'zero';
    }
  }

  console.log(`⚠️ Unknown mode+permissions combination: ${JSON.stringify(data)}`);
  return 'standby';
}










module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

 async onInit() {
    wsDebug.init(this.homey);
    this.onPollInterval = null;
    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;
    this._lastFullUpdate = 0;
    this._lastDiscoveryIP = null;

    this._cache = {
      external_last_payload: null,
      external_last_result: null,
      meter_start_day: null,
      gasmeter_start_day: null,
      last_gas_delta_minute: null,
      gasmeter_previous_reading: null,
      gasmeter_previous_reading_timestamp: null,
      last_battery_state: null,
    };

    this._cacheDirty = false;

    // Load store values once
    for (const key of Object.keys(this._cache)) {
      this._cache[key] = await getStoreValueSafe(this, key);
    }



    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    await updateCapability(this, 'connection_error', 'No errors').catch(this.error);

    this.token = await getStoreValueSafe(this, 'token');
    //console.log('P1 Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = this.getSettings();
    this.log('Settings for P1 apiv2: ', settings.polling_interval);

    // Check if polling interval is set in settings else set default value
    if (settings.polling_interval === undefined) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    if (settings.cloud === undefined) {
      settings.cloud = 1; // Default true
      await this.setSettings({
        // Update settings in Homey
        cloud: 1,
      });
    }

    

    // Condition Card
    const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode');

    ConditionCardCheckBatteryMode.registerRunListener(async ({ device, mode }) => {
  if (!device) return false; // ✅ Prevents crashes

  device.log('ConditionCard: Check Battery Mode');

  try {
    // ✅ Prefer WebSocket cache
    const { wsManager, url, token } = device;

    if (wsManager?.isConnected()) {
      // const lastBatteryState = await device.getStoreValue('last_battery_state');
      const lastBatteryState = device._cacheGet('last_battery_state');

      if (lastBatteryState) {
        const normalized = normalizeBatteryMode(lastBatteryState);
        return mode === normalized;
      }
    }

    // ✅ Fallback: HTTP
    const response = await api.getMode(url, token);
    if (!response) return false;

    const normalized = normalizeBatteryMode(response);
    return mode === normalized;

  } catch (error) {
    device?.error('Error retrieving mode:', error);
    return false;
  }
});





    this.homey.flow
  .getActionCard('set-battery-to-zero-mode')
  .registerRunListener(async ({ device }) => {
    device.log('ActionCard: Set Battery to Zero Mode');

    try {
      // ✅ Prefer WebSocket when available
      const { wsManager, url, token } = device;

      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero');
        device.log('Set mode to zero via WebSocket');
        return 'zero';
      }

      // ✅ Fallback to HTTP
      const response = await api.setMode(url, token, 'zero');
      if (!response) return false;

      await device._handleBatteries(response);
      device.log('Set mode to zero via HTTP');
      return 'zero';

    } catch (error) {
      device.error('Error set mode to zero:', error);
      return false;
    }
  });




this.homey.flow
  .getActionCard('set-battery-to-standby-mode')
  .registerRunListener(async ({ device }) => {
    device.log('ActionCard: Set Battery to Standby Mode');

    try {
      const { wsManager, url, token } = device;

      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('standby');
        device.log('Set mode to standby via WebSocket');
        return 'standby';
      }

      const response = await api.setMode(url, token, 'standby');
      if (!response) {
        device.log('Invalid response, returning false');
        return false;
      }

      await device._handleBatteries(response);
      device.log('Set mode to standby via HTTP');
      return 'standby';

    } catch (error) {
      device.error('Error set mode to standby:', error);
      return false;
    }
  });



this.homey.flow
  .getActionCard('set-battery-to-full-charge-mode')
  .registerRunListener(async ({ device }) => {
    device.log('ActionCard: Set Battery to Full Charge Mode');

    try {
      const { wsManager, url, token } = device;

      // ✅ Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('to_full');
        device.log('Set mode to full charge via WebSocket');
        return 'to_full';
      }

      // ✅ Fallback to HTTP
      const response = await api.setMode(url, token, 'to_full');
      if (!response) {
        device.log('Invalid response, returning false');
        return false;
      }

      await device._handleBatteries(response);
      device.log('Set mode to full charge via HTTP');
      return 'to_full';

    } catch (error) {
      device.error('Error set mode to full charge:', error);
      return false;
    }
  });



    this.homey.flow
  .getActionCard('set-battery-to-zero-charge-only-mode')
  .registerRunListener(async ({ device }) => {
    device.log('ActionCard: Set Battery to Zero Charge Only Mode');

    try {
      const { wsManager, url, token } = device;

      // ✅ Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero_charge_only');
        device.log('Set mode to zero_charge_only via WebSocket');
        return 'zero_charge_only';
      }

      // ✅ Fallback to HTTP
      const response = await api.setMode(url, token, 'zero_charge_only');
      if (!response) {
        device.log('Invalid response, returning false');
        return false;
      }

      await device._handleBatteries(response);
      device.log('Set mode to zero_charge_only via HTTP');
      return 'zero_charge_only';

    } catch (error) {
      device.error('Error set mode to zero_charge_only:', error);
      return false;
    }
  });



this.homey.flow
  .getActionCard('set-battery-to-zero-discharge-only-mode')
  .registerRunListener(async ({ device }) => {
    device.log('ActionCard: Set Battery to Zero Discharge Only Mode');

    try {
      const { wsManager, url, token } = device;

      // ✅ Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero_discharge_only');
        device.log('Set mode to zero_discharge_only via WebSocket');
        return 'zero_discharge_only';
      }

      // ✅ Fallback to HTTP
      const response = await api.setMode(url, token, 'zero_discharge_only');
      if (!response) {
        device.log('Invalid response, returning false');
        return false;
      }

      await device._handleBatteries(response);
      device.log('Set mode to zero_discharge_only via HTTP');
      return 'zero_discharge_only';

    } catch (error) {
      device.error('Error set mode to zero_discharge_only:', error);
      return false;
    }
  });






    // this.flowTriggerBatteryMode
    
    this._flowTriggerBatteryMode = this.homey.flow.getDeviceTriggerCard('battery_mode_changed');
    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed_v2');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed_v2');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed_v2');


  
    this._triggerFlowPrevious = {};

    // this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    this.pollingEnabled = !!settings.use_polling;
    
    if (this.pollingEnabled) {
      this.log('⚙️ Polling enabled via settings');
      this.startPolling();
    } else {
      this.wsManager = new WebSocketManager({
        device: this,
        url: this.url,
        token: this.token,
        log: this.log.bind(this),
        error: this.error.bind(this),
        setAvailable: this.setAvailable.bind(this),
        getSetting: this.getSetting.bind(this),
        handleMeasurement: this._handleMeasurement.bind(this),
        handleSystem: this._handleSystem.bind(this),
        handleBatteries: this._handleBatteries.bind(this)
      });

      this.wsManager.start();
    }
    
    if (debug) setInterval(() => {
      this.log(
        'CPU diag:',
        'ws=', this.wsManager?.isConnected(),
        'poll=', this.pollingEnabled,
        'batteryGroup=', this._phaseOverloadNotificationsEnabled,
        'external=', !!this._cache.external_last_payload,
        'lastWS=', Date.now() - (this.wsManager?.lastMeasurementAt || 0)
      );
    }, 10000);


    // 🕒 Driver-side watchdog
    this._wsWatchdog = setInterval(() => {
      const staleMs = Date.now() - (this.wsManager?.lastMeasurementAt || 0);
      if (!this.getSettings().use_polling && staleMs > 190000) { // just over 3min
        this.log(`🕒 P1 watchdog: stale >3min (${staleMs}ms), restarting WS`);
        this.wsManager?.restartWebSocket();
      }
    }, 60000); // check every minute
    
    // Overload notification true/false
    this._phaseOverloadNotificationsEnabled = this.getSetting('phase_overload_notifications') ?? true;

    this._phaseOverloadState = {
      l1: { highCount: 0, notified: false },
      l2: { highCount: 0, notified: false },
      l3: { highCount: 0, notified: false }
    };

    this._cacheFlushInterval = setInterval(async () => {
      if (!this._cacheDirty) return;
      this._cacheDirty = false;

      for (const [key, value] of Object.entries(this._cache)) {
        await setStoreValueSafe(this, key, value);
      }
    }, 30000);

    this._batteryGroupInterval = setInterval(() => {
      this._updateBatteryGroup().catch(this.error);
    }, 10000); // elke 10 seconden

    this._dailyInterval = setInterval(() => {
      this._updateDaily().catch(this.error);
    }, 60000); // elke minuut

    
  } 

  _cacheGet(key) {
  return this._cache[key];
  }

  _cacheSet(key, value) {
    this._cache[key] = value;
    this._cacheDirty = true;
  }


  flowTriggerBatteryMode(device, tokens) {
    this._flowTriggerBatteryMode.trigger(device, tokens).catch(this.error);
  }


  flowTriggerTariff(device, value) {
  // this.log(`⚡ Triggering tariff change with value:`, value);
  this._flowTriggerTariff.trigger(device, { tariff: value }).catch(this.error);
  }

  flowTriggerImport(device, value) {
    // this.log(`📥 Triggering import change with value:`, value);
    this._flowTriggerImport.trigger(device, { import: value }).catch(this.error);
  }

  flowTriggerExport(device, value) {
    // this.log(`📤 Triggering export change with value:`, value);
    this._flowTriggerExport.trigger(device, { export: value }).catch(this.error);
  }

async _updateBatteryGroup() {
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) return;

  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  if (!group || Object.keys(group).length === 0) return;

  const batteries = Object.values(group).filter(b => Date.now() - b.updated_at < 60000);
  if (batteries.length === 0) return;

  const totalCapacity = batteries.reduce((sum, b) => sum + b.capacity_kwh, 0);
  const averageSoC = batteries.reduce((sum, b) => sum + b.soc_pct, 0) / batteries.length;
  const totalPowerW = batteries.reduce((sum, b) => sum + b.power_w, 0);

  let chargeState = 'idle';
  if (totalPowerW > 0) chargeState = 'charging';
  else if (totalPowerW < 0) chargeState = 'discharging';

  await Promise.allSettled([
    this._setCapabilityValue('battery_group_total_capacity_kwh', totalCapacity),
    this._setCapabilityValue('battery_group_average_soc', averageSoC),
    this._setCapabilityValue('battery_group_state', chargeState),
  ]);
}

async _updateDaily() {
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) return;

  const showGas = this.getSetting('show_gas') === true;

  const m = this._cacheGet('last_measurement');
  if (!m) return;

  const nowLocal = new Date(new Date().toLocaleString('en-US', {
    timeZone: 'Europe/Brussels'
  }));

  const hour = nowLocal.getHours();
  const minute = nowLocal.getMinutes();

  // --- MIDNIGHT RESET ---
  if (hour === 0 && minute === 0) {
    if (typeof m.energy_import_kwh === 'number') {
      this._cacheSet('meter_start_day', m.energy_import_kwh);
    }

    const lastExternal = this._cacheGet('external_last_result');
    const gas = lastExternal?.gas;

    if (showGas && typeof gas?.value === 'number') {
      this._cacheSet('gasmeter_start_day', gas.value);
    }
  }

  // --- DAILY ELECTRICITY ---
  const meterStart = this._cacheGet('meter_start_day');
  if (meterStart != null && typeof m.energy_import_kwh === 'number') {
    const dailyImport = m.energy_import_kwh - meterStart;
    const cur = this.getCapabilityValue('meter_power.daily');
    if (cur !== dailyImport) {
      await updateCapability(this, 'meter_power.daily', dailyImport).catch(this.error);
    }
  }

  // --- DAILY GAS ---
  if (showGas) {
    const lastExternal = this._cacheGet('external_last_result');
    const gas = lastExternal?.gas;
    const gasStart = this._cacheGet('gasmeter_start_day');

    if (gas?.value != null && gasStart != null) {
      const gasDiff = gas.value - gasStart;
      const cur = this.getCapabilityValue('meter_gas.daily');
      if (cur !== gasDiff) {
        await updateCapability(this, 'meter_gas.daily', gasDiff).catch(this.error);
      }
    }
  }

  // --- GAS DELTA (5‑minute interval) ---
  if (showGas && minute % 5 === 0) {
    const lastMinute = this._cacheGet('last_gas_delta_minute');
    if (lastMinute !== minute) {
      this._cacheSet('last_gas_delta_minute', minute);

      const lastExternal = this._cacheGet('external_last_result');
      const gas = lastExternal?.gas;

      if (gas && typeof gas.value === 'number') {
        const prevTimestamp = this._cacheGet('gasmeter_previous_reading_timestamp');

        if (prevTimestamp == null) {
          this._cacheSet('gasmeter_previous_reading_timestamp', gas.timestamp);
        } else if (gas.timestamp !== prevTimestamp) {
          const prevReading = this._cacheGet('gasmeter_previous_reading');

          if (typeof prevReading === 'number') {
            const delta = gas.value - prevReading;
            if (delta >= 0) {
              const cur = this.getCapabilityValue('measure_gas');
              if (cur !== delta) {
                await updateCapability(this, 'measure_gas', delta).catch(this.error);
              }
            }
          }

          this._cacheSet('gasmeter_previous_reading', gas.value);
          this._cacheSet('gasmeter_previous_reading_timestamp', gas.timestamp);
        }
      }
    }
  }
}





async _handleExternalMeters(external) {
  const tasks = [];

  // Determine structural presence of gas/water meters
  const gasExists = external?.some(e => e.type === 'gas_meter');
  const waterExists = external?.some(e => e.type === 'water_meter');

  // Extract latest values (if any)
  const latest = (type) => {
    let newest = null;
    for (const { type: t, value, timestamp } of external ?? []) {
      if (t === type && typeof value === 'number') {
        if (!newest || timestamp > newest.timestamp) {
          newest = { type: t, value, timestamp };
        }
      }
    }
    return newest;
  };

  const gas = latest('gas_meter');
  const water = latest('water_meter');

  // GAS CAPABILITY MANAGEMENT (structural)
  if (gasExists && !this.hasCapability('meter_gas')) {
    tasks.push(this.addCapability('meter_gas').catch(this.error));
  }
  if (!gasExists && this.hasCapability('meter_gas')) {
    tasks.push(this.removeCapability('meter_gas').catch(this.error));
    this.log('Removed meter_gas — no gas meter found.');
  }

  // GAS VALUE UPDATE (data)
  if (gasExists && gas && this.getCapabilityValue('meter_gas') !== gas.value) {
    tasks.push(this.setCapabilityValue('meter_gas', gas.value).catch(this.error));
  }

  // WATER CAPABILITY MANAGEMENT (structural)
  if (waterExists && !this.hasCapability('meter_water')) {
    tasks.push(this.addCapability('meter_water').catch(this.error));
  }
  if (!waterExists && this.hasCapability('meter_water')) {
    tasks.push(this.removeCapability('meter_water').catch(this.error));
    this.log('Removed meter_water — no water meter found.');
  }

  // WATER VALUE UPDATE (data)
  if (waterExists && water && this.getCapabilityValue('meter_water') !== water.value) {
    tasks.push(this.setCapabilityValue('meter_water', water.value).catch(this.error));
  }

  await Promise.all(tasks);

  return { gas, water };
}





async _handleMeasurement(m) {
  const now = Date.now();
  const settings = this.getSettings();
  const showGas = settings.show_gas === true;
  const homey_lang = this.homey.i18n.getLanguage();
  this._cacheSet('last_measurement', m);

  // Skip if device was deleted
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) {
    this.log('⚠️ Ignoring measurement: device no longer exists');
    return;
  }

  this.lastMeasurementAt = now;

  // Collect all capability updates here
  const tasks = [];

  // Helper: push capability update tasks instead of awaiting them
  const cap = (name, value) => {
    const cur = this.getCapabilityValue(name);
    if (cur !== value) {
      tasks.push(updateCapability(this, name, value).catch(this.error));
    }
  };

  // Power and phases (only when measure_power changes)
  const currentPower = this.getCapabilityValue('measure_power');
  if (currentPower !== m.power_w) {
    cap('measure_power', m.power_w);
    cap('measure_power.l1', m.power_l1_w);
    cap('measure_power.l2', m.power_l2_w);
    cap('measure_power.l3', m.power_l3_w);
  }

  // Phase loads
  if (m.current_l1_a !== undefined) {
    const load1 = Math.abs((m.current_l1_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase1_pct', load1);
    this._handlePhaseOverload('l1', load1, homey_lang);
  }

  if (m.current_l2_a !== undefined) {
    const load2 = Math.abs((m.current_l2_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase2_pct', load2);
    this._handlePhaseOverload('l2', load2, homey_lang);
  }

  if (m.current_l3_a !== undefined) {
    const load3 = Math.abs((m.current_l3_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase3_pct', load3);
    this._handlePhaseOverload('l3', load3, homey_lang);
  }

  // Every 10 seconds: full refresh (now parallel)
  if (!this._lastFullUpdate || now - this._lastFullUpdate > 10000) {
    tasks.push(applyMeasurementCapabilities(this, m).catch(this.error));
    this._lastFullUpdate = now;
  }

  // Flow triggers (no awaits needed)
  // Throttle flow triggers to once every 5 seconds
  if (!this._lastFlowTrigger || now - this._lastFlowTrigger > 5000) {

    if (typeof m.energy_import_kwh === 'number' &&
        this._triggerFlowPrevious.import !== m.energy_import_kwh) {
      this._triggerFlowPrevious.import = m.energy_import_kwh;
      this.flowTriggerImport(this, m.energy_import_kwh);
    }

    if (typeof m.energy_export_kwh === 'number' &&
        this._triggerFlowPrevious.export !== m.energy_export_kwh) {
      this._triggerFlowPrevious.export = m.energy_export_kwh;
      this.flowTriggerExport(this, m.energy_export_kwh);
    }

    if (typeof m.active_tariff === 'number' &&
        this._triggerFlowPrevious.tariff !== m.active_tariff) {
      this._triggerFlowPrevious.tariff = m.active_tariff;
      this.flowTriggerTariff(this, m.active_tariff);
    }

    this._lastFlowTrigger = now;
  }


  // Net power
  if (m.energy_import_kwh !== undefined && m.energy_export_kwh !== undefined) {
    const net = m.energy_import_kwh - m.energy_export_kwh;
    cap('meter_power', net);
  }

  // External meters (gas/water)
  let gas = null;
  let water = null;

  const previousExternal = this._cacheGet('external_last_payload');
  const prevHash = previousExternal?.map(e => e.timestamp).join('|') ?? null;
  const newHash  = m.external?.map(e => e.timestamp).join('|') ?? null;

  if (prevHash === newHash) {
    const lastResult = this._cacheGet('external_last_result');
    gas = lastResult?.gas ?? null;
    water = lastResult?.water ?? null;
  } else {
    tasks.push((async () => {
      const result = await this._handleExternalMeters(m.external);
      gas = result.gas;
      water = result.water;
      this._cacheSet('external_last_payload', m.external);
      this._cacheSet('external_last_result', result);
    })());
  }

  // Gas disabled → remove capabilities
  if (!showGas) {
    if (this.hasCapability('meter_gas')) tasks.push(this.removeCapability('meter_gas').catch(this.error));
    if (this.hasCapability('measure_gas')) tasks.push(this.removeCapability('measure_gas').catch(this.error));
    if (this.hasCapability('meter_gas.daily')) tasks.push(this.removeCapability('meter_gas.daily').catch(this.error));
    gas = null;
  }

  // Cache external payload
  this._cacheSet('external_last_payload', m.external);

  // Run all updates in parallel
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}



_handleSystem(data) {
  // this.log('⚙️ System data received:', data);
  if (!this.getData() || !this.getData().id) {
    this.log('⚠️ Ignoring system event: device no longer exists');
    return;
  }

  // Update wifi rssi and wifi text
  if (typeof data.wifi_rssi_db === 'number') {
    if (this.hasCapability('rssi')) {
      updateCapability(this, 'rssi', data.wifi_rssi_db).catch(this.error);
      const wifiQuality = getWifiQuality(data.wifi_rssi_db);
      updateCapability(this, 'wifi_quality', wifiQuality).catch(this.error);
    }

  }

  
}


async _handleBatteries(data) {
  // Soft guard: ignore events if the device no longer exists in Homey
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) {
    this.log('⚠️ Ignoring batteries event: device no longer exists');
    return;
  }

  // Hard guard: verify the device still exists in the driver registry
  let deviceInstance;
  try {
    const driver = this.homey.drivers.getDriver('energy_v2');
    deviceInstance = driver?.getDevice(dataObj);
  } catch (err) {
    // Homey throws "Could not get device" when the device was deleted
    if (err.message?.includes('Could not get device')) {
      this.log('⚠️ Ignoring batteries event: device lookup failed');
      return;
    }
    throw err; // Unexpected error → rethrow
  }

  if (!deviceInstance) {
    this.log('⚠️ Ignoring batteries event: device was deleted (driver lookup)');
    return;
  }

  // If the payload is an array, use the first element
  const battery = Array.isArray(data) ? data[0] : data;

  // If the payload is a string, merge it into the original object
  const payload = typeof battery === 'string'
    ? { ...data, mode: battery, permissions: [] }
    : battery;

  // Normalize the battery mode (handles mode + permissions combinations)
  const normalizedMode = normalizeBatteryMode(payload);

  // Retrieve the previously stored normalized mode
  const lastBatteryMode = this._cacheGet('last_battery_mode');

  // Trigger flow and update settings only when the mode actually changes
  if (normalizedMode !== lastBatteryMode) {
    try {
      this.flowTriggerBatteryMode(this);
      this._cacheSet('last_battery_mode', normalizedMode);
      await this.setSettings({ mode: normalizedMode });
    } catch (err) {
      this.error('❌ Failed to update setting "mode":', err);
    }
  }

  // Update battery‑related power capabilities
  await updateCapability(this, 'measure_power.battery_group_power_w', payload.power_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_target_power_w', payload.target_power_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_max_consumption_w', payload.max_consumption_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_max_production_w', payload.max_production_w ?? 0).catch(this.error);

  const settings = this.getSettings();

  // Ensure Homey settings reflect the current normalized mode
  if (settings.mode !== normalizedMode) {
    this.log('Battery mode changed to:', normalizedMode);
    try {
      await this.setSettings({ mode: normalizedMode });
    } catch (err) {
      this.error('❌ Failed to update setting "mode":', err);
    }
  }

  // Store raw WS battery state for condition cards
  this._cacheSet('last_battery_state', {
    mode: payload.mode,
    permissions: payload.permissions
  });

  // Retrieve the battery group from Homey settings
  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  const batteries = Object.values(group);

  // Conditions for detecting a battery error
  const isGridReturn = (payload.power_w ?? 0) < -400;          // Grid is receiving power
  const batteriesPresent = batteries.length > 0;               // At least one battery in the group
  const shouldBeCharging = (payload.target_power_w ?? 0) > 0;  // System expects charging
  const isNotStandby = normalizedMode !== 'standby';           // Battery mode is active

  const now = Date.now();

  // Detect prolonged mismatch between expected charging and actual grid return
  if (isGridReturn && batteriesPresent && shouldBeCharging && isNotStandby) {
    if (!this.gridReturnStart) {
      this.gridReturnStart = now; // Start timing the mismatch
    }

    const duration = now - this.gridReturnStart;

    // If mismatch persists for >30 seconds → trigger battery error flow
    if (duration > 30000 && !this.batteryErrorTriggered) {
      this.batteryErrorTriggered = true;
      this.log('❌ Battery error: batteries should be charging and grid is receiving power');

      this.homey.flow
        .getDeviceTriggerCard('battery_error_detected')
        .trigger(this, {}, {
          power: payload.power_w,
          target: payload.target_power_w,
          mode: normalizedMode,
          batteryCount: batteries.length
        })
        .catch(this.error);
    }

  } else {
    // Reset mismatch tracking when conditions no longer apply
    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;
  }
}




  startPolling() {
    if (this.wsActive || this.onPollInterval) return;

    const interval = this.getSettings().polling_interval || 10;
    this.log(`⏱️ Polling gestart met interval: ${interval}s`);

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * interval);
  }



  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    if (this._wsReconnectTimeout) {
      clearTimeout(this._wsReconnectTimeout);
      this._wsReconnectTimeout = null;
    }
    if (this._wsWatchdog) {
      clearInterval(this._wsWatchdog);
      this._wsWatchdog = null;
    }
    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }
    if (this._batteryGroupInterval) {
      clearInterval(this._batteryGroupInterval);
      this._batteryGroupInterval = null;
    }
    if (this._dailyInterval) {
      clearInterval(this._dailyInterval);
      this._dailyInterval = null;
    }


  }


async onDiscoveryAvailable(discoveryResult) {
  const newIP = discoveryResult.address;

  // Eerste keer discovery → IP opslaan
  if (!this._lastDiscoveryIP) {
    this._lastDiscoveryIP = newIP;
    this.url = `https://${newIP}`;
    this.log(`🌐 Discovery: initial IP set to ${newIP}`);
    await this.setSettings({ url: this.url }).catch(this.error);
  }

  // IP is NIET veranderd → niets doen
  if (this._lastDiscoveryIP === newIP) {
    this.log(`🌐 Discovery: IP unchanged (${newIP}) — ignoring`);
    return;
  }

  // IP is WEL veranderd → update + restart
  this._lastDiscoveryIP = newIP;
  this.url = `https://${newIP}`;
  this.log(`🌐 Discovery: IP changed → ${newIP}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  // Debounce reconnect
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(async () => {

    if (this.pollingEnabled) {
      this.log('🔁 Discovery: polling active — skipping WS reconnect');
      return;
    }

    // Preflight reachability check
    try {
      const res = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent: new https.Agent({ rejectUnauthorized: false })
      }, 3000);

      if (!res || typeof res.cloud_enabled === 'undefined') {
        this.error(`❌ Discovery: device at ${this.url} unreachable — skipping WS`);
        return;
      }

      this.log('🔁 Discovery: IP changed & reachable — restarting WebSocket');
      await this.setAvailable();
      this.wsManager?.restartWebSocket();

    } catch (err) {
      this.error(`❌ Discovery preflight failed — ${err.message}`);
    }

  }, 500);
}





async onDiscoveryAddressChanged(discoveryResult) {
  const newIP = discoveryResult.address;

  // Alleen reageren als het IP echt veranderd is
  if (this._lastDiscoveryIP === newIP) {
    this.log(`🌐 AddressChanged: IP unchanged (${newIP}) — ignoring`);
    return;
  }

  // IP is veranderd → opslaan + settings bijwerken
  this._lastDiscoveryIP = newIP;
  this.url = `https://${newIP}`;
  this.log(`🌐 Address changed — new URL: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  // Debounce reconnect
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!this.getSettings().use_polling) {
      this.log('🔁 Address change: restarting WebSocket');
      this.wsManager?.restartWebSocket();
    } else {
      this.log('🔁 Address change: polling active — skipping WS reconnect');
    }
  }, 500);
}


async onDiscoveryLastSeenChanged(discoveryResult) {
  const newIP = discoveryResult.address;

  // Update IP only if changed
  if (this._lastDiscoveryIP !== newIP) {
    this._lastDiscoveryIP = newIP;
    this.url = `https://${newIP}`;
    this.log(`📡 Device seen again — IP updated: ${newIP}`);
    await this.setSettings({ url: this.url }).catch(this.error);
  } else {
    this.log(`📡 Device seen again — IP unchanged (${newIP})`);
  }

  await this.setAvailable();

  // Debounce reconnect
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {

    if (this.pollingEnabled) {
      this.log('🔁 LastSeen: polling active — skipping WS reconnect');
      return;
    }

    // Only restart WS if it is NOT connected
    if (!this.wsManager?.isConnected()) {
      this.log('🔁 LastSeen: WS not connected → restarting WebSocket');
      this.wsManager?.restartWebSocket();
    } else {
      this.log('📡 LastSeen: WS already connected — ignoring');
    }

  }, 500);
}





  /**
   * Helper function to update capabilities configuration.
   * This function is called when the device is initialized.
   */
  async _updateCapabilities() {
    if (!this.hasCapability('identify')) {
      await this.addCapability('identify').catch(this.error);
      console.log(`created capability identify for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power').catch(this.error);
      console.log(`created capability measure_power for ${this.getName()}`);
    }

    

    // Remove capabilities that are not needed
    if (this.hasCapability('measure_power.power_w')) {
      await this.removeCapability('measure_power.power_w').catch(this.error);
      console.log(`removed capability measure_power.power_w for ${this.getName()}`);
    }

    if (this.hasCapability('meter_power.returned.t1')) {
      await this.removeCapability('meter_power.returned.t1').catch(this.error);
      console.log(`removed capability meter_power.returned.t1 for ${this.getName()}`);
    }

    if (this.hasCapability('meter_power.returned.t2')) {
      await this.removeCapability('meter_power.returned.t2').catch(this.error);
      console.log(`removed capability meter_power.returned.t2 for ${this.getName()}`);
    }

  }

  /**
   * Helper function to register capability listeners.
   * This function is called when the device is initialized.
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  /**
   * Helper function for 'optional' capabilities.
   * This function is called when the device is initialized.
   * It will create the capability if it doesn't exist.
   *
   * We do not remove capabilities here, as we assume the user may want to keep them.
   * Besides that we assume that the P1 Meter is connected to a smart meter that does not change often.
   *
   * @param {string} capability The capability to set
   * @param {*} value The value to set
   * @returns {Promise<void>} A promise that resolves when the capability is set
   */
  async _setCapabilityValue(capability, value) {
    // Test if value is undefined, if so, we don't set the capability
    if (value === undefined) {
      return;
    }

    // Create a new capability if it doesn't exist
    if (!this.hasCapability(capability)) {
      await this.addCapability(capability).catch(this.error);
    }

    // Set the capability value
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  /**
   * Helper function to trigger flows on change.
   * This function is called when the device is initialized.
   *
   * We use this function to trigger flows when the value changes.
   * We store the previous value in a variable.
   *
   * @param {*} flow_id Flow ID name
   * @param {*} value The value to check for changes
   * @returns {Promise<void>} A promise that resolves when the flow is triggered
   */
  async _triggerFlowOnChange(flow_id, value) {
    if (!Number.isFinite(value)) {
      this.log(`⚠️ Skipping flow "${flow_id}" — invalid or missing value:`, value);
      return;
    }

    this._triggerFlowPrevious = this._triggerFlowPrevious || {};

    if (this._triggerFlowPrevious[flow_id] === undefined) {
      this._triggerFlowPrevious[flow_id] = value;
      // await setStoreValueSafe(this, `last_${flow_id}`, value);
      this._cacheSet(`last_${flow_id}`, value);

      return;
    }

    if (this._triggerFlowPrevious[flow_id] === value) {
      return;
    }

    const card = this.homey.flow.getDeviceTriggerCard(flow_id);
    if (!card) {
      this.error(`❌ Flow card "${flow_id}" not found`);
      return;
    }

    this._triggerFlowPrevious[flow_id] = value;

    this.log(`🚀 Triggering flow "${flow_id}" with value:`, value);
    this.log(`📦 Token payload:`, { [flow_id]: value });

    await card.trigger(this, {}, { [flow_id]: value }).catch(this.error);
    // await setStoreValueSafe(this, `last_${flow_id}`, value);
    this._cacheSet(`last_${flow_id}`, value);
  }


  // onPoll method if websocket is to heavy for Homey unit
  async onPoll() {

    const settings = this.getSettings();
    
    // 1. Restore URL if runtime is empty
    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      } else {
        await this.setUnavailable('Missing URL');
        return;
      }
    }

    // 2. Sync settings if discovery changed the URL
    if (this.url && this.url !== settings.url) {
      await this.setSettings({ url: this.url }).catch(this.error);
    }

    try {
      const [measurement, system, batteries] = await Promise.all([
        api.getMeasurement(this.url, this.token),
        api.getSystem(this.url, this.token),
        api.getMode(this.url, this.token),
      ]);

      // Reuse websocket based measurement capabilities code
      if (measurement) {
        await this._handleMeasurement(measurement);

        // Reuse websocket based external measurement capabilities code (gas and water)
        if (measurement.external) {
          await this._handleExternalMeters(measurement.external);
        }
      }

      // Reuse websocket based system capabilities code
      if (system) {
        await this._handleSystem(system);
      }

      // console.log(batteries);
      // Reuse websocket based battery capabilities code
      if (batteries) {
        await this._handleBatteries(batteries);
      }

    } catch (err) {
      this.error('Polling error:', err.message || err);
    }
  }

  _handlePhaseOverload(phaseKey, loadPct, lang) {
  const state = this._phaseOverloadState[phaseKey];

  // Debounce: 3 opeenvolgende samples boven 97%
  if (loadPct > 97) {
    state.highCount++;

    if (!state.notified && state.highCount >= 3 && this._phaseOverloadNotificationsEnabled) {
      const phaseNum = phaseKey.replace('l', ''); // l1 → 1
      const msg = lang === 'nl'
        ? `Fase ${phaseNum} overbelast (${loadPct.toFixed(0)}%)`
        : `Phase ${phaseNum} overloaded (${loadPct.toFixed(0)}%)`;

      this.homey.notifications.createNotification({ excerpt: msg }).catch(this.error);
      state.notified = true;
    }
  } else {
    // Hysterese: reset pas onder 85%
    if (loadPct < 85) {
      state.highCount = 0;
      state.notified = false;
    }
  }
}

  async onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if ('polling_interval' in MySettings.oldSettings
      && MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for P1 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      // this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    if ('mode' in MySettings.oldSettings 
      && MySettings.oldSettings.mode !== MySettings.newSettings.mode
    ) {
      this.log('Mode for Plugin Battery via P1 advanced settings changed to:', MySettings.newSettings.mode);
      try {
        await api.setMode(this.url, this.token, MySettings.newSettings.mode);
      } catch (err) {
        this.log('Failed to set mode:', err.message);
      }
    }

    if ('cloud' in MySettings.oldSettings 
      && MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
    ) {
      this.log('Cloud connection in advanced settings changed to:', MySettings.newSettings.cloud);

      try {
            if (MySettings.newSettings.cloud == 1) {
              await api.setCloudOn(this.url, this.token);
            } else if (MySettings.newSettings.cloud == 0) {
              await api.setCloudOff(this.url, this.token);
            }
          } catch (err) {
            this.log('Failed to update cloud setting:', err.message);
        }
    }

    if (MySettings.changedKeys.includes('use_polling')) {
      this.log(`⚙️ use_polling gewijzigd naar: ${MySettings.newSettings.use_polling}`);

      // ⭐ FIX: update runtime flag
      this.pollingEnabled = MySettings.newSettings.use_polling;

      if (MySettings.newSettings.use_polling) {
        this.wsManager?.stop(); // cleanly stop WebSocket
        this.startPolling();
      } else {
        if (this.onPollInterval) {
          clearInterval(this.onPollInterval);
          this.onPollInterval = null;
        }

        if (!this.wsManager) {
          this.wsManager = new WebSocketManager({
            url: this.url,
            token: this.token,
            log: this.log.bind(this),
            error: this.error.bind(this),
            setAvailable: this.setAvailable.bind(this),
            getSetting: this.getSetting.bind(this),
            handleMeasurement: this._handleMeasurement.bind(this),
            handleSystem: this._handleSystem.bind(this),
            handleBatteries: this._handleBatteries.bind(this)
          });
        }

        this.wsManager.start();
      }

    }

    if ('phase_overload_notifications' in MySettings.newSettings) {
      this._phaseOverloadNotificationsEnabled = MySettings.newSettings.phase_overload_notifications;
      this.log('Phase overload notifications changed to:', this._phaseOverloadNotificationsEnabled);
    }
    
    return true;
  }

};
