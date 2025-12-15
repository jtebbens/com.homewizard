'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');
const api = require('../../includes/v2/Api');
const WebSocketManager = require('../../includes/v2/Ws');

// const fetch = require('../../includes/utils/fetchQueue');

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
  const current = device.getCapabilityValue(capability);

  if (value == null) {
    if (device.hasCapability(capability) && current !== null) {
      await device.removeCapability(capability).catch(device.error);
      device.log(`🗑️ Removed capability "${capability}"`);
    }
    return;
  }

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
    device.log(`➕ Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
    // device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return await res.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
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
  
      // Tariff totals t1,t2,t3,t4 import/export
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
  
    for (const [capability, value] of Object.entries(mappings)) {
      await updateCapability(device, capability, value ?? null);
    }
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

    this.onPollInterval = null;
    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;
    this._lastFullUpdate = 0;

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    await updateCapability(this, 'connection_error', 'No errors').catch(this.error);

    this.token = await this.getStoreValue('token');
    console.log('P1 Token:', this.token);

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
      const lastBatteryState = await device.getStoreValue('last_battery_state');

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
    
    if (settings.use_polling) {
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




  async _handleExternalMeters(external) {
  const setCapabilityPromises = [];

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
  // this.log('📟 Gas meter data:', gas);

  const water = latest('water_meter');

  // Gas meter
  if (gas) {
    if (!this.hasCapability('meter_gas')) {
      setCapabilityPromises.push(this.addCapability('meter_gas').catch(this.error));
    }
    if (this.getCapabilityValue('meter_gas') !== gas.value) {
      setCapabilityPromises.push(this.setCapabilityValue('meter_gas', gas.value).catch(this.error));
    }
  } else if (this.hasCapability('meter_gas')) {
    setCapabilityPromises.push(this.removeCapability('meter_gas').catch(this.error));
    this.log('Removed meter_gas — no gas meter found.');
  }

  // Water meter
  if (water) {
    if (!this.hasCapability('meter_water')) {
      setCapabilityPromises.push(this.addCapability('meter_water').catch(this.error));
    }
    if (this.getCapabilityValue('meter_water') !== water.value) {
      setCapabilityPromises.push(this.setCapabilityValue('meter_water', water.value).catch(this.error));
    }
  } else if (this.hasCapability('meter_water')) {
    setCapabilityPromises.push(this.removeCapability('meter_water').catch(this.error));
    this.log('Removed meter_water — no water meter found.');
  }

  await Promise.all(setCapabilityPromises);

  return { gas, water };
}





async _handleMeasurement(m) {
  const settings = this.getSettings();
  const showGas = settings.show_gas === true;
  const homey_lang = this.homey.i18n.getLanguage();
  // Skip if device has been deleted or no ID
  if (!this.getData() || !this.getData().id) {
      this.log('⚠️ Ignoring measurement: device no longer exists');
      return;
  }

  this.lastMeasurementAt = Date.now();

  // this.log('📊 Measurement data received:', m);
  // this.log(`📊 Raw import value:`, m.energy_import_kwh);

  const currentPower = this.getCapabilityValue('measure_power');
  if (currentPower !== m.power_w) {
    await updateCapability(this, 'measure_power', m.power_w).catch(this.error);
    await updateCapability(this, 'measure_power.l1', m.power_l1_w).catch(this.error);
    await updateCapability(this, 'measure_power.l2', m.power_l2_w).catch(this.error);
    await updateCapability(this, 'measure_power.l3', m.power_l3_w).catch(this.error);
  }


  if (m.current_l1_a !== undefined) {
    const load1 = Math.abs((m.current_l1_a / settings.phase_capacity) * 100);
    await updateCapability(this, 'net_load_phase1_pct', load1).catch(this.error);
    this._handlePhaseOverload('l1', load1, homey_lang);
  }

  if (m.current_l2_a !== undefined) {
    const load2 = Math.abs((m.current_l2_a / settings.phase_capacity) * 100);
    await updateCapability(this, 'net_load_phase2_pct', load2).catch(this.error);
    this._handlePhaseOverload('l2', load2, homey_lang);
  }

  if (m.current_l3_a !== undefined) {
    const load3 = Math.abs((m.current_l3_a / settings.phase_capacity) * 100);
    await updateCapability(this, 'net_load_phase3_pct', load3).catch(this.error);
    this._handlePhaseOverload('l3', load3, homey_lang);
  }

  // Every 10s, refresh the rest
  if (!this._lastFullUpdate || Date.now() - this._lastFullUpdate > 10000) {
    await applyMeasurementCapabilities(this, m).catch(this.error);
    this._lastFullUpdate = Date.now();
  }

  // Trigger Flows

  // Trigger Flows only if values changed
  if (typeof m.energy_import_kwh === 'number' && this._triggerFlowPrevious.import !== m.energy_import_kwh) {
    this._triggerFlowPrevious.import = m.energy_import_kwh;
    this.flowTriggerImport(this, m.energy_import_kwh);
  }

  if (typeof m.energy_export_kwh === 'number' && this._triggerFlowPrevious.export !== m.energy_export_kwh) {
    this._triggerFlowPrevious.export = m.energy_export_kwh;
    this.flowTriggerExport(this, m.energy_export_kwh);
  }

  if (typeof m.active_tariff === 'number' && this._triggerFlowPrevious.tariff !== m.active_tariff) {
    this._triggerFlowPrevious.tariff = m.active_tariff;
    this.flowTriggerTariff(this, m.active_tariff);
  }


  // Net power
  if ((m.energy_import_kwh !== undefined) &&  (m.energy_export_kwh !== undefined)) {
    const net = m.energy_import_kwh - m.energy_export_kwh;
    if (this.getCapabilityValue('meter_power') !== net) {
      await updateCapability(this, 'meter_power', net).catch(this.error);
    }
  }

  // External meters
  // this.log('🔍 External meter payload:', m.external);
let gas = null;
let water = null;

const previousExternal = await this.getStoreValue('external_last_payload');

if (JSON.stringify(previousExternal) === JSON.stringify(m.external)) {
  // this.log('⏸️ External meter payload unchanged — skipping capability updates');

  const lastResult = await this.getStoreValue('external_last_result');
  gas = lastResult?.gas ?? null;
  water = lastResult?.water ?? null;
} else {
  // this.log('🔄 External meter payload changed — updating capabilities');

  const result = await this._handleExternalMeters(m.external);
  gas = result.gas;
  water = result.water;

  await this.setStoreValue('external_last_payload', m.external).catch(this.error);
  await this.setStoreValue('external_last_result', result).catch(this.error);
}

// ✅ GAS DISABLED — remove all gas capabilities and skip all gas logic
if (!showGas) {
  if (this.hasCapability('meter_gas')) await this.removeCapability('meter_gas').catch(this.error);
  if (this.hasCapability('measure_gas')) await this.removeCapability('measure_gas').catch(this.error);
  if (this.hasCapability('meter_gas.daily')) await this.removeCapability('meter_gas.daily').catch(this.error);

  // Prevent any gas logic below from running
  gas = null;
}



  const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));

  // Daily reset at midnight
  if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
    if (typeof m.energy_import_kwh === 'number') {
      await this.setStoreValue('meter_start_day', m.energy_import_kwh).catch(this.error);
    }
    if (typeof gas?.value === 'number') {
      await this.setStoreValue('gasmeter_start_day', gas.value).catch(this.error);
    }
  } else {
    const meterStartDay = await this.getStoreValue('meter_start_day');
    const gasmeterStartDay = await this.getStoreValue('gasmeter_start_day');
    if (!meterStartDay && typeof m.energy_import_kwh === 'number') {
      await this.setStoreValue('meter_start_day', m.energy_import_kwh).catch(this.error);
    }
    if (!gasmeterStartDay && typeof gas?.value === 'number') {
      await this.setStoreValue('gasmeter_start_day', gas.value).catch(this.error);
    }
  }

  // Gas delta every 5 minutes
  const currentMinute = nowLocal.getMinutes();
  const lastMinute = await this.getStoreValue('last_gas_delta_minute');

  if (showGas && currentMinute % 5 === 0 && lastMinute !== currentMinute) {
    await this.setStoreValue('last_gas_delta_minute', currentMinute).catch(this.error);

    if (!gas || typeof gas.value !== 'number') {
      return;
    }

    const prevTimestamp = await this.getStoreValue('gasmeter_previous_reading_timestamp');
    if (gas.timestamp != null && prevTimestamp == null) {
      await this.setStoreValue('gasmeter_previous_reading_timestamp', gas.timestamp).catch(this.error);
      return;
    }

    if (gas.timestamp !== prevTimestamp) {
      const prevReading = await this.getStoreValue('gasmeter_previous_reading');
      if (typeof prevReading === 'number') {
        const delta = gas.value - prevReading;
        if (delta >= 0) {
          // this.log(`📈 Gas delta: ${delta} m³`);
          await updateCapability(this, 'measure_gas', delta).catch(this.error);
        }
      } else {
        this.log('🆕 No previous gas reading — storing current value');
      }

      await this.setStoreValue('gasmeter_previous_reading', gas.value).catch(this.error);
      await this.setStoreValue('gasmeter_previous_reading_timestamp', gas.timestamp).catch(this.error);
    } else {
      // this.log(`⏸️ Skipping gas delta — timestamp unchanged (${gas.timestamp})`);
    }
  }

  // Daily usage
  const meterStart = await this.getStoreValue('meter_start_day');
  if (meterStart != null) {
    const dailyImport = m.energy_import_kwh - meterStart;
    await updateCapability(this, 'meter_power.daily', dailyImport).catch(this.error);
  }

  if (showGas) {
    const gasStart = await this.getStoreValue('gasmeter_start_day');
    const gasDiff = (gas?.value != null && gasStart != null) ? gas.value - gasStart : null;
    await updateCapability(this, 'meter_gas.daily', gasDiff).catch(this.error);
  }


  // 🔋 Battery Group
  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  const now = Date.now();
  const batteries = Object.values(group).filter((b) => now - b.updated_at < 60000);

  if (batteries.length === 0) {
    this.log('⚠️ No fresh battery data found — skipping group update');
    return;
  }

  const totalCapacity = batteries.reduce((sum, b) => sum + b.capacity_kwh, 0);
  const averageSoC = batteries.reduce((sum, b) => sum + b.soc_pct, 0) / batteries.length;
  const totalPowerW = batteries.reduce((sum, b) => sum + b.power_w, 0);

  let chargeState = 'idle';
  if (totalPowerW > 0) chargeState = 'charging';
  else if (totalPowerW < 0) chargeState = 'discharging';

  await Promise.all([
    this._setCapabilityValue('battery_group_total_capacity_kwh', totalCapacity).catch(this.error),
    this._setCapabilityValue('battery_group_average_soc', averageSoC).catch(this.error),
    this._setCapabilityValue('battery_group_state', chargeState).catch(this.error),
  ]);


  await this.setStoreValue('external_last_payload', m.external).catch(this.error);
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
  // Soft guard
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) {
    this.log('⚠️ Ignoring batteries event: device no longer exists');
    return;
  }

  // Hard guard — correct Homey registry check
  const driver = this.homey.drivers.getDriver('energy_v2');
  if (!driver || !driver.getDevice(dataObj)) {
    this.log('⚠️ Ignoring batteries event: device was deleted (driver lookup)');
    return;
  }

  // If data is an array, pick the first element
  const battery = Array.isArray(data) ? data[0] : data;

  // If the element is just a string, merge with outer data
  const payload = typeof battery === 'string'
    ? { ...data, mode: battery, permissions: [] }
    : battery;

  // Normalize mode
  const normalizedMode = normalizeBatteryMode(payload);

  // Retrieve previous normalized mode
  const lastBatteryMode = await this.getStoreValue('last_battery_mode');

  // Trigger only when normalized mode changes
  if (normalizedMode !== lastBatteryMode) {
    this.flowTriggerBatteryMode(this);
    await this.setStoreValue('last_battery_mode', normalizedMode).catch(this.error);
  }

  // Update settings
  if (normalizedMode) {
    try {
      await this.setSettings({ mode: normalizedMode });
    } catch (err) {
      this.error('❌ Failed to update setting "mode":', err);
    }
  }

  // Use payload for capability updates
  await updateCapability(this, 'measure_power.battery_group_power_w', payload.power_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_target_power_w', payload.target_power_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_max_consumption_w', payload.max_consumption_w ?? 0).catch(this.error);
  await updateCapability(this, 'measure_power.battery_group_max_production_w', payload.max_production_w ?? 0).catch(this.error);

  const settings = this.getSettings();

  // Update settings if mode changed
  if (settings.mode !== normalizedMode) {
    this.log('Battery mode changed to:', normalizedMode);
    try {
      await this.setSettings({ mode: normalizedMode });
    } catch (err) {
      this.error('❌ Failed to update setting "mode":', err);
    }
  }

  // ✅ Store raw WS state for condition card
  await this.setStoreValue('last_battery_state', {
    mode: payload.mode,
    permissions: payload.permissions
  });

  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  const batteries = Object.values(group);

  const isGridReturn = (payload.power_w ?? 0) < -400;
  const batteriesPresent = batteries.length > 0;
  const shouldBeCharging = (payload.target_power_w ?? 0) > 0;
  const isNotStandby = normalizedMode !== 'standby';

  const now = Date.now();

  if (isGridReturn && batteriesPresent && shouldBeCharging && isNotStandby) {
    if (!this.gridReturnStart) {
      this.gridReturnStart = now;
    }

    const duration = now - this.gridReturnStart;

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
  }


async onDiscoveryAvailable(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Discovery available — IP set to: ${discoveryResult.address}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  const settings = this.getSettings();

  // Debounce reconnects to avoid hammering
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(async () => {
    if (settings.use_polling) {
      this.log('🔁 Discovery: polling is active, skipping WebSocket reconnect');
      return;
    }

    // Preflight reachability check
    try {
      const res = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent: new https.Agent({ rejectUnauthorized: false })
      }, 3000);

      if (!res || typeof res.cloud_enabled === 'undefined') {
        this.error(`❌ Discovery: device at ${this.url} is unreachable — skipping WebSocket`);
        return;
      }

      this.log('✅ Discovery: device reachable — restarting WebSocket');
      if (this.wsManager) {
        this.wsManager.restartWebSocket();
      }

    } catch (err) {
      this.error(`❌ Discovery: preflight check failed — ${err.message}`);
    }
  }, 500);
}




async onDiscoveryAddressChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Address changed — new URL: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!this.getSettings().use_polling) {
      if (this.wsManager) {
        this.wsManager.restartWebSocket();
      }
    } else {
      this.log('🔁 Address change: polling is active, skipping WebSocket reconnect');
    }
  }, 500);
}

async onDiscoveryLastSeenChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`📡 Device seen again — URL refreshed: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);
  await this.setAvailable();

  const settings = this.getSettings();

  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!settings.use_polling) {
      this.log('🔁 Reconnecting WebSocket due to last seen update...');
      if (this.wsManager) {
        this.wsManager.restartWebSocket();
      }
    } else {
      this.log('🔁 Device seen again: polling is active, skipping WebSocket reconnect');
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
      await this.setStoreValue(`last_${flow_id}`, value).catch(this.error);
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
    await this.setStoreValue(`last_${flow_id}`, value).catch(this.error);
  }


  // onPoll method if websocket is to heavy for Homey unit
  async onPoll() {
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
