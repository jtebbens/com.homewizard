/*
 * HomeWizard Energy (P1) Driver - APIv2
 * Copyright (C) 2025 Jeroen Tebbens
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');
const api = require('../../includes/v2/Api');
const WebSocketManager = require('../../includes/v2/Ws');
const wsDebug = require('../../includes/v2/wsDebug');
const BaseloadMonitor = require('../../includes/utils/baseloadMonitor');
const debug = false; // Legacy constant — use this._debugLogging at runtime (toggle via device settings)

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

    // --- SPECIAL CASE: battery_group_charge_mode ---
    // This capability is managed exclusively by _updateBatteryGroup().
    if (capability === 'battery_group_charge_mode') {
      // Only update value, never add/remove
      if (value != null && current !== value) {
        await device.setCapabilityValue(capability, value);
      }
      return;
    }

    // --- SAFE REMOVE ---
    if (value == null && current == null) {
      if (device.hasCapability(capability)) {
        await device.removeCapability(capability);
        device.log(`🗑️ Removed capability "${capability}"`);
      }
      return;
    }

    // --- ADD IF MISSING ---
    if (!device.hasCapability(capability)) {
      try {
        await device.addCapability(capability);
        device.log(`➕ Added capability "${capability}"`);
      } catch (err) {
        if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
          device.log(`Capability already exists: ${capability} — ignoring`);
        } else {
          throw err;
        }
      }
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


/**
 * Safe add capability helper — avoids race 409 errors
 */
async function safeAddCapability(device, capability) {
  try {
    if (!device.hasCapability(capability)) {
      await device.addCapability(capability);
      device.log(`➕ Safely added capability "${capability}"`);
    }
  } catch (err) {
    if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
      device.log(`Capability already exists: ${capability} — ignoring`);
      return;
    }
    throw err;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
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
    const now = Date.now();
    
    // ✅ CPU FIX: Categorize capabilities by update frequency
    // High-frequency (realtime) capabilities: update on every message (but already throttled at WS level to 3s)
    const realtimeCapabilities = {
      'measure_power': m.power_w,
      'measure_power.l1': m.power_l1_w,
      'measure_power.l2': m.power_l2_w,
      'measure_power.l3': m.power_l3_w,
    };
    
    // Medium-frequency capabilities: update every 10 seconds
    const mediumFreqCapabilities = {
      'measure_voltage': m.voltage_v,
      'measure_current': m.current_a,
      'measure_frequency': m.frequency_hz,
      'measure_voltage.l1': m.voltage_l1_v,
      'measure_voltage.l2': m.voltage_l2_v,
      'measure_voltage.l3': m.voltage_l3_v,
      'measure_current.l1': m.current_l1_a,
      'measure_current.l2': m.current_l2_a,
      'measure_current.l3': m.current_l3_a,
      'tariff': m.tariff,
    };
    
    // Low-frequency capabilities: update every 30 seconds
    const lowFreqCapabilities = {
      'meter_power.consumed': m.energy_import_kwh,
      'meter_power.returned': m.energy_export_kwh,
      'meter_power.consumed.t1': m.energy_import_t1_kwh,
      'meter_power.produced.t1': m.energy_export_t1_kwh,
      'meter_power.consumed.t2': m.energy_import_t2_kwh,
      'meter_power.produced.t2': m.energy_export_t2_kwh,
      'meter_power.consumed.t3': m.energy_import_t3_kwh,
      'meter_power.produced.t3': m.energy_export_t3_kwh,
      'meter_power.consumed.t4': m.energy_import_t4_kwh,
      'meter_power.produced.t4': m.energy_export_t4_kwh,
      'measure_power.montly_power_peak': m.monthly_power_peak_w,
      'measure_power.average_power_15m_w': m.average_power_15m_w,
    };
    
    // Very low-frequency capabilities: update every 60 seconds
    const veryLowFreqCapabilities = {
      'long_power_fail_count': m.long_power_fail_count,
      'voltage_sag_l1': m.voltage_sag_l1_count,
      'voltage_sag_l2': m.voltage_sag_l2_count,
      'voltage_sag_l3': m.voltage_sag_l3_count,
      'voltage_swell_l1': m.voltage_swell_l1_count,
      'voltage_swell_l2': m.voltage_swell_l2_count,
      'voltage_swell_l3': m.voltage_swell_l3_count,
    };

    // Initialize debounce timestamps if needed
    if (!device._lastMediumUpdate) device._lastMediumUpdate = 0;
    if (!device._lastLowUpdate) device._lastLowUpdate = 0;
    if (!device._lastVeryLowUpdate) device._lastVeryLowUpdate = 0;

    const mappings = {
      ...realtimeCapabilities,
      ...(now - device._lastMediumUpdate >= 10000 ? mediumFreqCapabilities : {}),
      ...(now - device._lastLowUpdate >= 30000 ? lowFreqCapabilities : {}),
      ...(now - device._lastVeryLowUpdate >= 60000 ? veryLowFreqCapabilities : {}),
    };
    
    // Update timestamps
    if (now - device._lastMediumUpdate >= 10000) device._lastMediumUpdate = now;
    if (now - device._lastLowUpdate >= 30000) device._lastLowUpdate = now;
    if (now - device._lastVeryLowUpdate >= 60000) device._lastVeryLowUpdate = now;

    // Collect all capability updates as promises
    const tasks = [];
    
    // Track which capabilities changed for triggering flows
    const changed = {
      voltage_sag: null,
      voltage_swell: null,
      long_power_fail: false
    };

    for (const [capability, valueRaw] of Object.entries(mappings)) {
      let value = valueRaw;

      // Normalize tariff (critical for triggers)
      if (capability === 'tariff' && value != null) {
        value = Number(value);
      }

      const cur = device.getCapabilityValue(capability);
      if (cur !== value) {
        tasks.push(updateCapability(device, capability, value ?? null));
        
        // Track voltage sag changes
        if (capability === 'voltage_sag_l1' && value != null && value !== cur) {
          changed.voltage_sag = { phase: 'L1', count: value };
        } else if (capability === 'voltage_sag_l2' && value != null && value !== cur) {
          changed.voltage_sag = { phase: 'L2', count: value };
        } else if (capability === 'voltage_sag_l3' && value != null && value !== cur) {
          changed.voltage_sag = { phase: 'L3', count: value };
        }
        
        // Track voltage swell changes
        if (capability === 'voltage_swell_l1' && value != null && value !== cur) {
          changed.voltage_swell = { phase: 'L1', count: value };
        } else if (capability === 'voltage_swell_l2' && value != null && value !== cur) {
          changed.voltage_swell = { phase: 'L2', count: value };
        } else if (capability === 'voltage_swell_l3' && value != null && value !== cur) {
          changed.voltage_swell = { phase: 'L3', count: value };
        }
        
        // Track long power fail changes
        if (capability === 'long_power_fail_count' && value != null && value !== cur) {
          changed.long_power_fail = value;
        }
      }
    }


    // Run all updates in parallel
    await Promise.allSettled(tasks);
    
    // Trigger flow cards after updates complete
    if (changed.voltage_sag && device._flowTriggerVoltageSag) {
      device._flowTriggerVoltageSag.trigger(device, changed.voltage_sag).catch(device.error);
    }
    if (changed.voltage_swell && device._flowTriggerVoltageSwell) {
      device._flowTriggerVoltageSwell.trigger(device, changed.voltage_swell).catch(device.error);
    }
    if (changed.long_power_fail !== false && device._flowTriggerPowerFail) {
      device._flowTriggerPowerFail.trigger(device, { count: changed.long_power_fail }).catch(device.error);
    }
    
    // Check for voltage and power restoration
    device._checkVoltageRestoration(m);
    device._checkPowerRestoration(m);

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
  // If already normalized (string), return as-is
  if (typeof data === 'string') {
    return data.trim();
  }

  // Extract mode
  let rawMode = typeof data.mode === 'string'
    ? data.mode.trim().replace(/^["']+|["']+$/g, '')
    : null;

  const mode = rawMode ? rawMode.toLowerCase() : null;

  // Extract permissions (sorted for deterministic comparison)
  const perms = Array.isArray(data.permissions)
    ? [...data.permissions].map(p => p.toLowerCase()).sort().join(',')
    : null;

  // Direct modes
  if (mode === 'standby') return 'standby';
  if (mode === 'to_full') return 'to_full';

  // Vendor sometimes sends these directly
  if (mode === 'zero_charge_only') return 'zero_charge_only';
  if (mode === 'zero_discharge_only') return 'zero_discharge_only';

  // Normalize "zero" family
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
        console.log(`⚠️ Unknown permissions for mode=zero: ${perms}`);
        return 'zero';
    }
  }

  // Unknown combination
  console.log(`⚠️ Unknown battery mode: ${JSON.stringify(data)}`);
  return 'standby';
}











module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

_hashExternal(external) {
  if (!Array.isArray(external) || external.length === 0) return 'none';

  // Only hash if there's actually data to process
  let hash = '';
  for (let i = 0; i < external.length; i++) {
    const e = external[i];
    const type = e?.type ?? 'unknown';
    const value = e?.value ?? 'null';
    const ts = e?.timestamp ?? 'null';
    hash += (hash ? '|' : '') + `${type}:${value}:${ts}`;
  }
  return hash;
}

/**
 * Get effective URL - manual IP overrides discovery
 * @returns {string} URL to use for API calls
 */
_getEffectiveURL() {
  const manualIP = this.getSetting('manual_ip');
  if (manualIP) {
    this.log(`🔧 Using manual IP: ${manualIP}`);
    return `https://${manualIP}`;
  }
  
  const settings = this.getSettings();
  if (settings.url) {
    return settings.url;
  }
  
  return null;
}

/**
 * Reconnect with manual IP after repair flow
 * @param {string} ip - The manual IP address
 */
async reconnectWithManualIP(ip) {
  this.log(`🔧 Reconnecting with manual IP: ${ip}`);
  
  this.url = `https://${ip}`;
  
  // Restart WebSocket if not polling
  if (!this.getSettings().use_polling && this.wsManager) {
    this.log('🔁 Manual IP: restarting WebSocket');
    this.wsManager.restartWebSocket();
  } else if (this.getSettings().use_polling) {
    this.log('🔁 Manual IP: polling mode, will reconnect on next poll');
  }
}


 async onInit() {
    wsDebug.init(this.homey);
    this.onPollInterval = null;
    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;
    this._lastFullUpdate = 0;
    this._lastDiscoveryIP = null;

    // Add rate limiting state to onInit() - place near the top of onInit()
    this._lastBatteryModeChange = 0;
    this._batteryModeChangeCooldown = 5000; // 5 seconds minimum between changes


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

    // Get effective URL (manual IP overrides discovery)
    this.url = this._getEffectiveURL();



    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    await updateCapability(this, 'connection_error', 'No errors').catch(this.error);

    this.token = await getStoreValueSafe(this, 'token');
    //console.log('P1 Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();
    await this._ensureBatteryCapabilities();

    // Register with baseload monitor
    const app = this.homey.app;
    if (!app.baseloadMonitor) {
      app.baseloadMonitor = new BaseloadMonitor(this.homey);
    }
    app.baseloadMonitor.registerP1Device(this);
    app.baseloadMonitor.trySetMaster(this);

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

    

    // Store flow listener references for cleanup in onDeleted()
    this._flowListenerReferences = [];

    // Register flow card listeners only once (prevent "already registered" warnings)
    if (!this.homey.app._flowListenersRegistered) {
      this.homey.app._flowListenersRegistered = true;


// ============================================================================
// CONDITION CARD - Check Battery Mode
// ============================================================================

const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode');

ConditionCardCheckBatteryMode.registerRunListener(async ({ device, mode }) => {
  if (!device) return false;

  device.log('ConditionCard: Check Battery Mode');

  try {
    const { wsManager, url, token } = device;

    // Prefer WebSocket cache
    if (wsManager?.isConnected()) {
      const lastBatteryState = device._cacheGet('last_battery_state');

      if (lastBatteryState) {
        const normalized = normalizeBatteryMode(lastBatteryState);
        return mode === normalized;
      }
    }

    // Fallback: HTTP
    const response = await api.getMode(url, token);
    if (!response || typeof response !== 'object') {
      device.log('⚠️ Invalid battery mode response:', response);
      return false;
    }

    // Update cache
    device._cacheSet('last_battery_state', {
      mode: response.mode,
      permissions: response.permissions,
      battery_count: response.battery_count ?? 1
    });

    // Normalize
    const normalized = normalizeBatteryMode(response);

    // Update capability
    await updateCapability(device, 'battery_group_charge_mode', normalized);

    // ✅ FIXED: Only trigger flow on actual change
    const prev = device._cacheGet('last_battery_mode');
    if (normalized !== prev) {
      device.flowTriggerBatteryMode(device, { mode: normalized });
      device._cacheSet('last_battery_mode', normalized);
    }

    return mode === normalized;

  } catch (error) {
    device?.error('Error retrieving mode:', error);
    return false;
  }
});

// ============================================================================
// ACTION CARD 1: Set Battery to Zero Mode
// ============================================================================

this.homey.flow
  .getActionCard('set-battery-to-zero-mode')
  .registerRunListener(async ({ device }) => {
    if (!device) return false;

    // ✅ RATE LIMITING: Prevent rapid successive calls
    const now = Date.now();
    if (now - device._lastBatteryModeChange < device._batteryModeChangeCooldown) {
      device.log('⏸️ Battery mode change throttled - cooldown active');
      return 'zero';
    }
    device._lastBatteryModeChange = now;
    device._cacheSet('last_commanded_mode', 'zero');

    device.log('ActionCard: Set Battery to Zero Mode');

    try {
      const { wsManager, url, token } = device;

      // Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero');
        device.log('Set mode to zero via WebSocket');
        return 'zero';
      }

      // HTTP fallback: set mode
      const response = await api.setMode(url, token, 'zero');
      if (!response) {
        device.log('Invalid response from setMode()');
        return false;
      }

      // Fetch real battery state after setting mode
      const modeResponse = await api.getMode(url, token);
      if (!modeResponse || typeof modeResponse !== 'object') {
        device.log('⚠️ Invalid battery mode response after setMode:', modeResponse);
        return false;
      }

      // Update cache
      device._cacheSet('last_battery_state', {
        mode: modeResponse.mode,
        permissions: modeResponse.permissions,
        battery_count: modeResponse.battery_count ?? 1
      });

      // Normalize
      const normalized = normalizeBatteryMode(modeResponse);

      // Update capability
      await updateCapability(device, 'battery_group_charge_mode', normalized);

      // ✅ FIXED: Only trigger flow on actual change
      const prev = device._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        device.flowTriggerBatteryMode(device, { mode: normalized });
        device._cacheSet('last_battery_mode', normalized);
      }

      device.log('Set mode to zero via HTTP');
      return 'zero';

    } catch (error) {
      device.error('Error set mode to zero:', error);
      return false;
    }
  });

// ============================================================================
// ACTION CARD 2: Set Battery to Standby Mode
// ============================================================================

this.homey.flow
  .getActionCard('set-battery-to-standby-mode')
  .registerRunListener(async ({ device }) => {
    if (!device) return false;

    // ✅ RATE LIMITING: Prevent rapid successive calls
    const now = Date.now();
    if (now - device._lastBatteryModeChange < device._batteryModeChangeCooldown) {
      device.log('⏸️ Battery mode change throttled - cooldown active');
      return 'standby';
    }
    device._lastBatteryModeChange = now;
    device._cacheSet('last_commanded_mode', 'standby');

    device.log('ActionCard: Set Battery to Standby Mode');

    try {
      const { wsManager, url, token } = device;

      // Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('standby');
        device.log('Set mode to standby via WebSocket');
        return 'standby';
      }

      // HTTP fallback: set mode
      const response = await api.setMode(url, token, 'standby');
      if (!response) return false;

      // Fetch real battery state
      const modeResponse = await api.getMode(url, token);
      if (!modeResponse || typeof modeResponse !== 'object') return false;

      // Update cache
      device._cacheSet('last_battery_state', {
        mode: modeResponse.mode,
        permissions: modeResponse.permissions,
        battery_count: modeResponse.battery_count ?? 1
      });

      // Normalize
      const normalized = normalizeBatteryMode(modeResponse);

      // Update capability
      await updateCapability(device, 'battery_group_charge_mode', normalized);

      // ✅ FIXED: Only trigger flow on actual change
      const prev = device._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        device.flowTriggerBatteryMode(device, { mode: normalized });
        device._cacheSet('last_battery_mode', normalized);
      }

      device.log('Set mode to standby via HTTP');
      return 'standby';

    } catch (error) {
      device.error('Error set mode to standby:', error);
      return false;
    }
  });

// ============================================================================
// ACTION CARD 3: Set Battery to Full Charge Mode
// ============================================================================

this.homey.flow
  .getActionCard('set-battery-to-full-charge-mode')
  .registerRunListener(async ({ device }) => {
    if (!device) return false;

    // ✅ RATE LIMITING: Prevent rapid successive calls
    const now = Date.now();
    if (now - device._lastBatteryModeChange < device._batteryModeChangeCooldown) {
      device.log('⏸️ Battery mode change throttled - cooldown active');
      return 'to_full';
    }
    device._lastBatteryModeChange = now;
    device._cacheSet('last_commanded_mode', 'to_full');

    device.log('ActionCard: Set Battery to Full Charge Mode');

    try {
      const { wsManager, url, token } = device;

      // Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('to_full');
        device.log('Set mode to full charge via WebSocket');
        return 'to_full';
      }

      // HTTP fallback
      const response = await api.setMode(url, token, 'to_full');
      if (!response) return false;

      // Fetch real battery state
      const modeResponse = await api.getMode(url, token);
      if (!modeResponse || typeof modeResponse !== 'object') return false;

      // Update cache
      device._cacheSet('last_battery_state', {
        mode: modeResponse.mode,
        permissions: modeResponse.permissions,
        battery_count: modeResponse.battery_count ?? 1
      });

      // Normalize
      const normalized = normalizeBatteryMode(modeResponse);

      // Update capability
      await updateCapability(device, 'battery_group_charge_mode', normalized);

      // ✅ FIXED: Only trigger flow on actual change
      const prev = device._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        device.flowTriggerBatteryMode(device, { mode: normalized });
        device._cacheSet('last_battery_mode', normalized);
      }

      device.log('Set mode to full charge via HTTP');
      return 'to_full';

    } catch (error) {
      device.error('Error set mode to full charge:', error);
      return false;
    }
  });

// ============================================================================
// ACTION CARD 4: Set Battery to Zero Charge Only Mode
// ============================================================================

this.homey.flow
  .getActionCard('set-battery-to-zero-charge-only-mode')
  .registerRunListener(async ({ device }) => {
    if (!device) return false;

    // ✅ RATE LIMITING: Prevent rapid successive calls
    const now = Date.now();
    if (now - device._lastBatteryModeChange < device._batteryModeChangeCooldown) {
      device.log('⏸️ Battery mode change throttled - cooldown active');
      return 'zero_charge_only';
    }
    device._lastBatteryModeChange = now;
    device._cacheSet('last_commanded_mode', 'zero_charge_only');

    device.log('ActionCard: Set Battery to Zero Charge Only Mode');

    try {
      const { wsManager, url, token } = device;

      // Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero_charge_only');
        device.log('Set mode to zero_charge_only via WebSocket');
        return 'zero_charge_only';
      }

      // HTTP fallback
      const response = await api.setMode(url, token, 'zero_charge_only');
      if (!response) return false;

      // Fetch real battery state
      const modeResponse = await api.getMode(url, token);
      if (!modeResponse || typeof modeResponse !== 'object') return false;

      // Update cache
      device._cacheSet('last_battery_state', {
        mode: modeResponse.mode,
        permissions: modeResponse.permissions,
        battery_count: modeResponse.battery_count ?? 1
      });

      // Normalize
      const normalized = normalizeBatteryMode(modeResponse);

      // Update capability
      await updateCapability(device, 'battery_group_charge_mode', normalized);

      // ✅ FIXED: Only trigger flow on actual change
      const prev = device._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        device.flowTriggerBatteryMode(device, { mode: normalized });
        device._cacheSet('last_battery_mode', normalized);
      }

      device.log('Set mode to zero_charge_only via HTTP');
      return 'zero_charge_only';

    } catch (error) {
      device.error('Error set mode to zero_charge_only:', error);
      return false;
    }
  });

// ============================================================================
// ACTION CARD 5: Set Battery to Zero Discharge Only Mode
// ============================================================================

this.homey.flow
  .getActionCard('set-battery-to-zero-discharge-only-mode')
  .registerRunListener(async ({ device }) => {
    if (!device) return false;

    // ✅ RATE LIMITING: Prevent rapid successive calls
    const now = Date.now();
    if (now - device._lastBatteryModeChange < device._batteryModeChangeCooldown) {
      device.log('⏸️ Battery mode change throttled - cooldown active');
      return 'zero_discharge_only';
    }
    device._lastBatteryModeChange = now;
    device._cacheSet('last_commanded_mode', 'zero_discharge_only');

    device.log('ActionCard: Set Battery to Zero Discharge Only Mode');

    try {
      const { wsManager, url, token } = device;

      // Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode('zero_discharge_only');
        device.log('Set mode to zero_discharge_only via WebSocket');
        return 'zero_discharge_only';
      }

      // HTTP fallback
      const response = await api.setMode(url, token, 'zero_discharge_only');
      if (!response) return false;

      // Fetch real battery state
      const modeResponse = await api.getMode(url, token);
      if (!modeResponse || typeof modeResponse !== 'object') return false;

      // Update cache
      device._cacheSet('last_battery_state', {
        mode: modeResponse.mode,
        permissions: modeResponse.permissions,
        battery_count: modeResponse.battery_count ?? 1
      });

      // Normalize
      const normalized = normalizeBatteryMode(modeResponse);

      // Update capability
      await updateCapability(device, 'battery_group_charge_mode', normalized);

      // ✅ FIXED: Only trigger flow on actual change
      const prev = device._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        device.flowTriggerBatteryMode(device, { mode: normalized });
        device._cacheSet('last_battery_mode', normalized);
      }

      device.log('Set mode to zero_discharge_only via HTTP');
      return 'zero_discharge_only';

    } catch (error) {
      device.error('Error set mode to zero_discharge_only:', error);
      return false;
    }
  });







    } // End of _flowListenersRegistered guard

    // this.flowTriggerBatteryMode
    
    this._flowTriggerBatteryMode = this.homey.flow.getDeviceTriggerCard('battery_mode_changed');
    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed_v2');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed_v2');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed_v2');
    this._flowTriggerVoltageSag = this.homey.flow.getDeviceTriggerCard('voltage_sag_detected');
    this._flowTriggerVoltageSwell = this.homey.flow.getDeviceTriggerCard('voltage_swell_detected');
    this._flowTriggerPowerFail = this.homey.flow.getDeviceTriggerCard('long_power_fail_detected');
    this._flowTriggerVoltageRestored = this.homey.flow.getDeviceTriggerCard('voltage_restored');
    this._flowTriggerPowerRestored = this.homey.flow.getDeviceTriggerCard('power_restored');

    // Track voltage state for restoration detection
    this._voltageState = {
      l1: { abnormal: false, lastAbnormalTime: null },
      l2: { abnormal: false, lastAbnormalTime: null },
      l3: { abnormal: false, lastAbnormalTime: null }
    };
    
    // Track power state for restoration detection
    this._powerState = {
      offline: false,
      offlineStartTime: null
    };


  
    this._triggerFlowPrevious = {};

    // Bind handler functions ONCE to avoid creating new function objects on every reconnect (memory leak)
    this._boundHandleMeasurement = this._handleMeasurement.bind(this);
    this._boundHandleSystem = this._handleSystem.bind(this);
    this._boundHandleBatteries = this._handleBatteries.bind(this);
    this._boundLog = this.log.bind(this);
    this._boundError = this.error.bind(this);
    this._boundSetAvailable = this.setAvailable.bind(this);
    this._boundGetSetting = this.getSetting.bind(this);

    // this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    this.pollingEnabled = !!settings.use_polling;
    
    // ✅ Debug logging via settings (toggle in device settings without redeploy)
    this._debugLogging = this.getSetting('debug_logging') ?? false;
    if (this._debugLogging) this.log('🐛 Debug logging enabled via settings');
    
    if (this.pollingEnabled) {
      this.log('⚙️ Polling enabled via settings');
      this.startPolling();
    } else {
      this.wsManager = new WebSocketManager({
        device: this,
        url: this.url,
        token: this.token,
        log: this._boundLog,
        error: this._boundError,
        setAvailable: this._boundSetAvailable,
        getSetting: this._boundGetSetting,
        handleMeasurement: this._boundHandleMeasurement,
        handleSystem: this._boundHandleSystem,
        handleBatteries: this._boundHandleBatteries,
        measurementThrottleMs: (this.getSetting('ws_throttle_ms') || 2) * 1000,
        onJournalEvent: (type, deviceId, data) => {
          if (type === 'snapshot') wsDebug.snapshot(deviceId, data);
          else wsDebug.log(type, deviceId, typeof data === 'string' ? data : JSON.stringify(data));
        },
      });

      this.wsManager.start();
    }
    
    if (debug) this._debugInterval = setInterval(() => {
      this.log(
        'CPU diag:',
        'ws=', this.wsManager?.isConnected(),
        'poll=', this.pollingEnabled,
        'batteryGroup=', this._phaseOverloadNotificationsEnabled,
        'external=', !!this._cache.external_last_payload,
        'lastWS=', Date.now() - (this.wsManager?.lastMeasurementAt || 0)
      );
    }, 60000);  // Reduced frequency: every 60s instead of 10s


    // 🕒 Driver-side watchdog
    // 🕒 Driver-side watchdog (ORIGINEEL)
    this._wsWatchdog = setInterval(() => {
      const staleMeasurement = Date.now() - (this.wsManager?.lastMeasurementAt || 0);

      if (!this.getSettings().use_polling) {
        if (staleMeasurement > 190000) {
          this.log(`🕒 P1 watchdog: measurement stale >3min (${staleMeasurement}ms), restarting WS`);
          this.wsManager?.restartWebSocket();
        }
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

      // Batch all store operations in parallel instead of sequential awaits
      const storePromises = Object.entries(this._cache).map(
        ([key, value]) => setStoreValueSafe(this, key, value)
      );
      await Promise.all(storePromises).catch(this.error);
    }, 30000);

    this._batteryGroupInterval = setInterval(() => {
      this._updateBatteryGroup().catch(this.error);
    }, 60000); // reduced from 10s to 60s for CPU efficiency

    this._dailyInterval = setInterval(() => {
      this._updateDaily().catch(this.error);
    }, 60000); // elke minuut

    
  } 

  _cacheGet(key) {
  return this._cache[key];
  }

  _cacheSet(key, value) {
    this._cache[key] = (value === undefined ? null : value);
    this._cacheDirty = true;
  }

  /**
 * Public API: Set battery group mode
 * Can be called from other drivers (e.g. BatteryPolicyDevice)
 */
async setBatteryGroupMode(targetMode) {
  this.log(`🔋 setBatteryGroupMode(${targetMode}) called`);

  // ✅ ADD RATE LIMITING HERE:
  const now = Date.now();
  if (now - this._lastBatteryModeChange < this._batteryModeChangeCooldown) {
    this.log('⏸️ setBatteryGroupMode throttled - cooldown active');
    return true; // Return success, don't spam the device
  }
  this._lastBatteryModeChange = now;
  this._cacheSet('last_commanded_mode', targetMode);

  try {
    const { wsManager, url, token } = this;

    // --- Prefer WebSocket ---
    if (wsManager?.isConnected()) {
      this.log(`🔌 Setting mode via WebSocket: ${targetMode}`);
      wsManager.setBatteryMode(targetMode);
      // Add delay for WebSocket command to be processed
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      // --- HTTP fallback ---
      this.log(`🌐 Setting mode via HTTP: ${targetMode}`);
      const response = await api.setMode(url, token, targetMode);
      if (!response) {
        this.error('❌ HTTP setMode returned invalid response');
        return false;
      }
    }

    // --- Fetch updated mode from device with retry ---
    let modeResponse;
    let retries = 3;
    while (retries > 0) {
      try {
        modeResponse = await api.getMode(url, token);
        if (modeResponse) break;
      } catch (err) {
        this.log(`⚠️ getMode attempt failed (${retries} retries left):`, err.message);
        await new Promise(resolve => setTimeout(resolve, 300));
        retries--;
      }
    }

    if (!modeResponse) {
      this.error('❌ Failed to fetch mode after setting');
      return false;
    }

    // api.getMode returns a string, so normalize it directly
    const normalized = modeResponse;

    // --- Update cache ---
    this._cacheSet('last_battery_mode', normalized);

    // --- Update capability ---
    await updateCapability(this, 'battery_group_charge_mode', normalized);

    // --- Trigger flow if changed ---
    const prev = this._cacheGet('last_battery_mode');
    if (normalized !== prev) {
      this.flowTriggerBatteryMode(this, { mode: normalized });
      this._cacheSet('last_battery_mode', normalized);
    }

    this.log(`✅ Battery group mode applied: ${normalized}`);
    return true;

  } catch (err) {
    this.error('❌ Failed to set battery group mode:', err);
    return false;
  }
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

_getRealtimePluginBatteryData() {
  const driver = this.homey.drivers.getDriver('plugin_battery');
  if (!driver) return [];

  const devices = driver.getDevices();
  const result = [];

  for (const dev of devices) {
    const id = dev.getData()?.id;
    if (!id) continue;

    // Explicit realtime values
    const soc = (typeof dev._lastSoC === 'number')
      ? dev._lastSoC   // 0% is valid
      : null;

    const power = (typeof dev._lastPower === 'number')
      ? dev._lastPower
      : null;

    const capacity = (typeof dev._lastCapacity === 'number' && dev._lastCapacity > 0)
      ? dev._lastCapacity
      : null;

    const cycles = (typeof dev._lastCycles === 'number')
      ? dev._lastCycles
      : null;

    result.push({
      id,
      soc,
      power,
      capacity,
      cycles,
    });
  }

  return result;
}


_mergeBatterySources(realtime, group) {
  const merged = [];

  for (const rt of realtime) {
    const g = group[rt.id] || {};

    // Explicit realtime vs fallback selection
    const capacity = (typeof rt.capacity === 'number' && rt.capacity > 0)
      ? rt.capacity
      : (typeof g.capacity_kwh === 'number' && g.capacity_kwh > 0)
        ? g.capacity_kwh
        : 2.8; // default

    const soc = (typeof rt.soc === 'number')
      ? rt.soc   // realtime 0% is valid
      : (typeof g.soc_pct === 'number')
        ? g.soc_pct
        : 0;

    const power = (typeof rt.power === 'number')
      ? rt.power
      : (typeof g.power_w === 'number')
        ? g.power_w
        : 0;

    const cycles = (typeof rt.cycles === 'number')
      ? rt.cycles
      : (typeof g.cycles === 'number')
        ? g.cycles
        : 0;

    merged.push({
      id: rt.id,
      capacity_kwh: capacity,
      soc_pct: soc,
      power_w: power,
      cycles: cycles,
    });
  }

  return merged;
}




async _updateBatteryGroup() {
  const dataObj = this.getData();
  if (!dataObj?.id) return;

  // 1. Realtime pluginBattery data
  const realtime = this._getRealtimePluginBatteryData();

  // 2. Fallback batteryGroup data (cached)
  const cachedGroup = this._cacheGet('pluginBatteryGroup_cache');
  const group = cachedGroup || (this.homey.settings.get('pluginBatteryGroup') || {});

  // Refresh cache every 60s
  if (!this._lastBatteryGroupCacheUpdate || Date.now() - this._lastBatteryGroupCacheUpdate > 60000) {
    this._cacheSet('pluginBatteryGroup_cache', group);
    this._lastBatteryGroupCacheUpdate = Date.now();
  }

  // 3. Merge both sources
  const batteries = this._mergeBatterySources(realtime, group);

  const realtimeCount = realtime.length;
  const fallbackCount = Object.keys(group).length;

  // 4. Vendor battery_count gate (soft)
  const vendorCount = this._cacheGet('last_battery_state')?.battery_count;

  // --- Only remove capabilities if ALL sources agree there is no battery ---
  if (vendorCount === 0 && fallbackCount === 0) {
    if (debug) this.log('🔋 No battery detected — removing battery capabilities');

    const caps = [
      'measure_power.battery_group_power_w',
      'measure_power.battery_group_target_power_w',
      'measure_power.battery_group_max_consumption_w',
      'measure_power.battery_group_max_production_w',
      'battery_group_total_capacity_kwh',
      'battery_group_average_soc',
      'battery_group_state',
      'battery_group_charge_mode'
    ];

    for (const cap of caps) {
      if (this.hasCapability(cap)) {
        this.removeCapability(cap).catch(this.error);
      }
    }

    return;
  }

  // --- If we have ANY batteries, continue ---
  if (batteries.length === 0) return;


  // 5. Weighted SoC calculation
  let totalCapacity = 0;
  let weightedSoC = 0;
  let totalPower = 0;

  for (const b of batteries) {
    const cap = (typeof b.capacity_kwh === 'number' && b.capacity_kwh > 0)
      ? b.capacity_kwh
      : 1;

    const soc = (typeof b.soc_pct === 'number')
      ? b.soc_pct
      : 0;

    const power = (typeof b.power_w === 'number')
      ? b.power_w
      : 0;

    totalCapacity += cap;
    weightedSoC += cap * soc;
    totalPower += power;
  }

  const averageSoC = totalCapacity > 0
    ? Math.round(weightedSoC / totalCapacity)
    : 0;

  const chargeState =
    totalPower > 20 ? 'charging' :
    totalPower < -20 ? 'discharging' :
    'idle';

  // 6. Update capabilities
  await Promise.allSettled([
    updateCapability(this, 'battery_group_total_capacity_kwh', totalCapacity),
    updateCapability(this, 'battery_group_average_soc', averageSoC),
    updateCapability(this, 'battery_group_state', chargeState),
  ]);

  // 7. Vendor-native charge mode update
  const lastVendorState = this._cacheGet('last_battery_state');

  if (lastVendorState && typeof lastVendorState === 'object') {
    const normalized = normalizeBatteryMode(lastVendorState);

    // Alleen updaten als de waarde echt veranderd is
    const prev = this.getCapabilityValue('battery_group_charge_mode');
    if (prev !== normalized) {
      await updateCapability(this, 'battery_group_charge_mode', normalized);

      // Cache bijwerken
      this._cacheSet('last_battery_mode', normalized);

      // Flow triggeren
      this.flowTriggerBatteryMode(this, { mode: normalized });

      if (debug) this.log(`🔋 Updated battery_group_charge_mode → ${normalized}`);
    }
  }
}






_processBatteryGroupChargeMode(data, tasks) {
  const group = data.battery_group;
  if (!group || !group.charge_mode) return;

  const mode = this.normalizeBatteryMode(group.charge_mode);

  if (this._hasChanged('battery_group_charge_mode', mode)) {
    tasks.push(updateCapability(this, 'battery_group_charge_mode', mode));
  }
}



async _updateDaily() {
  if (!this._validateMeasurementContext()) return;

  const showGas = this.getSetting('show_gas') === true;
  const m = this._cacheGet('last_measurement');
  if (!m) return;

  const nowLocal = this._getLocalTimeSafe();
  const hour = nowLocal.getHours();
  const minute = nowLocal.getMinutes();

  this._dailyMidnightReset(m, showGas, hour, minute);
  await this._dailyElectricity(m);
  await this._dailyGas(m, showGas);
  await this._dailyGasDelta(showGas, minute);
}

_getLocalTimeSafe() {
  // ✅ CPU FIX: Cache the Intl.DateTimeFormat instance — creating it per call
  // is expensive (loads IANA timezone DB each time, called 1440×/day)
  if (!this._tzFormatter) {
    this._tzFormatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Brussels',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  }
  const parts = this._tzFormatter.formatToParts(new Date());
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`);
}

_dailyMidnightReset(m, showGas, hour, minute) {
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
}

async _dailyElectricity(m) {
  const meterStart = this._cacheGet('meter_start_day');
  if (meterStart != null && typeof m.energy_import_kwh === 'number') {
    const dailyImport = m.energy_import_kwh - meterStart;
    const cur = this.getCapabilityValue('meter_power.daily');
    if (cur !== dailyImport) {
      await updateCapability(this, 'meter_power.daily', dailyImport).catch(this.error);
    }
  }
}

async _dailyGas(m, showGas) {
  if (!showGas) return;

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

async _dailyGasDelta(showGas, minute) {
  if (!showGas || minute % 5 !== 0) return;

  const lastMinute = this._cacheGet('last_gas_delta_minute');
  if (lastMinute === minute) return;

  this._cacheSet('last_gas_delta_minute', minute);

  const lastExternal = this._cacheGet('external_last_result');
  const gas = lastExternal?.gas;
  if (!gas || typeof gas.value !== 'number') return;

  const prevTimestamp = this._cacheGet('gasmeter_previous_reading_timestamp');

  if (prevTimestamp == null) {
    this._cacheSet('gasmeter_previous_reading_timestamp', gas.timestamp);
    return;
  }

  if (gas.timestamp === prevTimestamp) return;

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


async _handleExternalMeters(external) {
  const tasks = [];

  // Single pass through external meters - extract latest for each type
  const latest = {};
  let gasExists = false;
  let waterExists = false;

  for (const meter of (external ?? [])) {
    if (meter.type === 'gas_meter') {
      gasExists = true;
      if (meter.value != null && meter.timestamp != null) {
        const current = latest['gas_meter'];
        if (!current || meter.timestamp > current.timestamp) {
          latest['gas_meter'] = meter;
        }
      }
    } else if (meter.type === 'water_meter') {
      waterExists = true;
      if (meter.value != null && meter.timestamp != null) {
        const current = latest['water_meter'];
        if (!current || meter.timestamp > current.timestamp) {
          latest['water_meter'] = meter;
        }
      }
    }
  }

  const gas = latest['gas_meter'];
  const water = latest['water_meter'];

  // GAS CAPABILITY MANAGEMENT (structural)
  if (gasExists && !this.hasCapability('meter_gas')) {
    tasks.push(safeAddCapability(this, 'meter_gas').catch(this.error));
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
    tasks.push(safeAddCapability(this, 'meter_water').catch(this.error));
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
  if (!this._validateMeasurementContext()) return;

  const now = Date.now();
  const settings = this.getSettings();
  const showGas = settings.show_gas === true;
  
  // Safely get language, default to 'en' if app instance is destroyed
  let homeyLang = 'en';
  try {
    homeyLang = this.homey.i18n.getLanguage();
  } catch (err) {
    this.log('⚠️ Could not get language (app destroyed?), defaulting to English');
  }

  this._measurementCache(m, now);
  const tasks = [];

  this._measurementPower(m, tasks);
  this._measurementPhases(m, tasks, settings, homeyLang);
  this._measurementFullRefresh(m, tasks, now);
  this._measurementFlows(m, now);
  this._measurementNetPower(m, tasks);

  const { gas, water } = await this._measurementExternalMeters(m, tasks);
  await this._measurementGasWater(gas, water, tasks, showGas);

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

_validateMeasurementContext() {
  const dataObj = this.getData();
  if (!dataObj || !dataObj.id) {
    this.log('⚠️ Ignoring measurement: device no longer exists');
    return false;
  }
  
  // Check if app instance is still valid (not destroyed)
  if (!this.homey) {
    this.log('⚠️ Ignoring measurement: app instance has been destroyed');
    return false;
  }
  
  return true;
}

_measurementCache(m, now) {
  this._cacheSet('last_measurement', m);
  this.lastMeasurementAt = now;
}

_measurementPower(m, tasks) {
  const cap = (name, value) => {
    const cur = this.getCapabilityValue(name);
    if (cur !== value) {
      tasks.push(updateCapability(this, name, value).catch(this.error));
    }
  };

  const currentPower = this.getCapabilityValue('measure_power');
  if (currentPower !== m.power_w) {
    cap('measure_power', m.power_w);
    cap('measure_power.l1', m.power_l1_w);
    cap('measure_power.l2', m.power_l2_w);
    cap('measure_power.l3', m.power_l3_w);

    // Feed baseload monitor with battery-aware power
    this._onNewPowerValue(m.power_w);
  }
}

_onNewPowerValue(gridPower) {
  const app = this.homey.app;
  if (app.baseloadMonitor) {
    // Get battery power if available
    const batteryPower = this.getCapabilityValue('measure_power.battery_group_power_w');
    app.baseloadMonitor.updatePowerFromDevice(this, gridPower, batteryPower);
  }
}

_measurementPhases(m, tasks, settings, homeyLang) {
  const cap = (name, value) => {
    const cur = this.getCapabilityValue(name);
    if (cur !== value) {
      tasks.push(updateCapability(this, name, value).catch(this.error));
    }
  };

  if (m.current_l1_a !== undefined) {
    const load1 = Math.abs((m.current_l1_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase1_pct', load1);
    this._handlePhaseOverload('l1', load1, homeyLang);
  }

  if (m.current_l2_a !== undefined) {
    const load2 = Math.abs((m.current_l2_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase2_pct', load2);
    this._handlePhaseOverload('l2', load2, homeyLang);
  }

  if (m.current_l3_a !== undefined) {
    const load3 = Math.abs((m.current_l3_a / settings.grid_phase_amps) * 100);
    cap('net_load_phase3_pct', load3);
    this._handlePhaseOverload('l3', load3, homeyLang);
  }
}

_measurementFullRefresh(m, tasks, now) {
  // ✅ CPU FIX: Raised from 10s to 30s — applyMeasurementCapabilities iterates
  // over ~25 capabilities and calls getCapabilityValue() on each; at 10s that
  // was 6×/min of 25+ Homey API calls. 30s cuts this work by 66%.
  if (!this._lastFullUpdate || now - this._lastFullUpdate > 30000) {
    tasks.push(applyMeasurementCapabilities(this, m).catch(this.error));
    this._lastFullUpdate = now;
  }
}

_measurementFlows(m, now) {
  // ✅ CPU FIX: Rate-limit flow triggers to 60s
  // energy_import_kwh changes every second at any load → was firing 12×/min
  if (!this._lastFlowTrigger || now - this._lastFlowTrigger > 60000) {

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

    if (typeof m.tariff !== 'undefined') {
      const newTariff = Number(m.tariff);
      const prevTariff = this._triggerFlowPrevious.tariff;

      if (prevTariff !== newTariff) {
        this._triggerFlowPrevious.tariff = newTariff;
        this.flowTriggerTariff(this, newTariff);
      }
    }


    this._lastFlowTrigger = now;
  }
}

_measurementNetPower(m, tasks) {
  if (m.energy_import_kwh !== undefined && m.energy_export_kwh !== undefined) {
    const net = m.energy_import_kwh - m.energy_export_kwh;
    const cur = this.getCapabilityValue('meter_power');
    if (cur !== net) {
      tasks.push(updateCapability(this, 'meter_power', net).catch(this.error));
    }
  }
}

async _measurementExternalMeters(m, tasks) {
  let gas = null;
  let water = null;

  const prevHash = this._cacheGet('external_last_hash') ?? null;
  const newHash  = this._hashExternal(m.external);

  if (prevHash === newHash) {
    // Geen verandering → gebruik cache
    const lastResult = this._cacheGet('external_last_result');
    gas = lastResult?.gas ?? null;
    water = lastResult?.water ?? null;
  } else {
    // Verandering → opnieuw verwerken
    const result = await this._handleExternalMeters(m.external);
    gas = result.gas;
    water = result.water;

    this._cacheSet('external_last_payload', m.external);
    this._cacheSet('external_last_result', result);
    this._cacheSet('external_last_hash', newHash);
  }

  return { gas, water };
}


async _measurementGasWater(gas, water, tasks, showGas) {
  if (!showGas) {
    if (this.hasCapability('meter_gas')) tasks.push(this.removeCapability('meter_gas').catch(this.error));
    if (this.hasCapability('measure_gas')) tasks.push(this.removeCapability('measure_gas').catch(this.error));
    if (this.hasCapability('meter_gas.daily')) tasks.push(this.removeCapability('meter_gas.daily').catch(this.error));
    return;
  }

  // (No extra logic — everything happens in _handleExternalMeters)
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

async _ensureBatteryCapabilities() {
  const caps = [
    'measure_power.battery_group_power_w',
    'measure_power.battery_group_target_power_w',
    'measure_power.battery_group_max_consumption_w',
    'measure_power.battery_group_max_production_w',
    'battery_group_total_capacity_kwh',
    'battery_group_average_soc',
    'battery_group_state',
    'battery_group_charge_mode'
  ];

  for (const cap of caps) {
    try {
      await safeAddCapability(this, cap);
    } catch (err) {
      this.error(`❌ Failed to ensure capability "${cap}":`, err);
    }
  }
}


async _handleBatteries(data) {
  try {
    if (debug) this.log('⚡ Battery event data:', data);

    // --- Device existence guard ---
    // ✅ CPU FIX: Removed pointless getDriver/getDevice lookup — _handleBatteries
    // already runs on the device instance itself, no need to look it up again.
    const dataObj = this.getData();
    if (!dataObj?.id) return;

    // --- Normalize payload ---
    const battery = Array.isArray(data) ? data[0] : data;
    const payload = typeof battery === 'string'
      ? { ...data, mode: battery, permissions: [] }
      : battery;

    if (debug && payload.battery_count != 0) {
      this.log('⚡ Battery event payload:', payload);
    }

    // --- Normalize mode ---
    const normalizedMode = normalizeBatteryMode(payload);
    const lastBatteryMode = this._cacheGet('last_battery_mode');

    // --- Firmware fallback: to_full but power_w = 0 ---
    if (normalizedMode === 'to_full' && (payload.power_w == null || payload.power_w === 0)) {
      const prev = this._cacheGet('last_battery_state') || {};

      const batteryCount =
        (typeof payload.battery_count === 'number' && payload.battery_count > 0)
          ? payload.battery_count
          : (typeof prev.battery_count === 'number' && prev.battery_count > 0)
            ? prev.battery_count
            : 1;

      const fallbackPower = batteryCount * 800;

      this.log(
        `⚠️ Firmware bug detected: power_w=0 in to_full. Applying fallback ${fallbackPower}W (battery_count=${batteryCount})`
      );

      payload.power_w = fallbackPower;
    }

    // --- Update capability battery_group_charge_mode ---
    try {
      await updateCapability(this, 'battery_group_charge_mode', normalizedMode);
    } catch (err) {
      this.error('❌ Failed to update battery_group_charge_mode:', err);
    }

    // --- Trigger flow only on real mode change ---
    if (normalizedMode !== lastBatteryMode) {
      const lastCommanded = this._cacheGet('last_commanded_mode');
      if (lastCommanded !== null && normalizedMode !== lastCommanded) {
        this.log(`⚠️ External battery mode override detected! Commanded: ${lastCommanded} → actual: ${normalizedMode}`);
        const extKey = 'external_mode_overrides';
        const stored = this.homey.settings.get(extKey) || { count: 0, last: null };
        stored.count += 1;
        stored.last = { from: lastCommanded, to: normalizedMode, ts: new Date().toISOString() };
        this.homey.settings.set(extKey, stored);
      }

      this.flowTriggerBatteryMode(this);
      this._cacheSet('last_battery_mode', normalizedMode);

      // ✅ CPU FIX: fire-and-forget — setSettings writes to persistent storage
      // and blocks the event loop if awaited on every battery update
      this.setSettings({ mode: normalizedMode }).catch(err => {
        this.error('❌ Failed to update setting "mode":', err);
      });
    }

    // --- Update battery power capabilities ---
    // ✅ CPU FIX: Run in parallel instead of 4 sequential awaits
    await Promise.allSettled([
      this._setCapabilityValue('measure_power.battery_group_power_w', payload.power_w ?? 0),
      this._setCapabilityValue('measure_power.battery_group_target_power_w', payload.target_power_w ?? 0),
      this._setCapabilityValue('measure_power.battery_group_max_consumption_w', payload.max_consumption_w ?? 0),
      this._setCapabilityValue('measure_power.battery_group_max_production_w', payload.max_production_w ?? 0),
    ]);

    // --- Store raw WS battery state for condition cards ---
    const prev = this._cacheGet('last_battery_state') || {};

    this._cacheSet('last_battery_state', {
      mode: payload.mode ?? prev.mode,
      permissions: Array.isArray(payload.permissions)
        ? payload.permissions
        : prev.permissions,
      battery_count: (typeof payload.battery_count === 'number')
        ? payload.battery_count
        : prev.battery_count
    });

    // --- Battery error detection ---
    const group = this.homey.settings.get('pluginBatteryGroup') || {};
    const batteries = Object.values(group);

    const isGridReturn = (payload.power_w ?? 0) < -400;
    const batteriesPresent = batteries.length > 0;
    const shouldBeCharging = (payload.target_power_w ?? 0) > 0;
    const isNotStandby = normalizedMode !== 'standby';

    const now = Date.now();

    if (isGridReturn && batteriesPresent && shouldBeCharging && isNotStandby) {
      if (!this.gridReturnStart) this.gridReturnStart = now;

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

  } catch (err) {
    this.error('❌ _handleBatteries failed:', err);
  }
}







  startPolling() {
    if (this.wsActive || this.onPollInterval) return;

    const interval = this.getSettings().polling_interval || 10;
    this.log(`⏱️ Polling gestart met interval: ${interval}s`);

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * interval);
  }



  onUninit() {
    // Cleanup intervals and timers when app stops/crashes
    this.__deleted = true;

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
    if (this._cacheFlushInterval) {
      clearInterval(this._cacheFlushInterval);
      this._cacheFlushInterval = null;
    }
    if (this._batteryGroupInterval) {
      clearInterval(this._batteryGroupInterval);
      this._batteryGroupInterval = null;
    }
    if (this._dailyInterval) {
      clearInterval(this._dailyInterval);
      this._dailyInterval = null;
    }
    if (this._debugInterval) {
      clearInterval(this._debugInterval);
      this._debugInterval = null;
    }
    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    // Unregister flow card listeners to prevent memory leak
    if (this._flowListenerReferences) {
      for (const listener of this._flowListenerReferences) {
        try {
          listener.unregister?.();
        } catch (_) {}
      }
      this._flowListenerReferences = null;
    }
  }

  onDeleted() {
    // Unregister from baseload monitor (only on explicit device deletion)
    const app = this.homey.app;
    if (app.baseloadMonitor) {
      app.baseloadMonitor.unregisterP1Device(this);
    }

    // Call onUninit to cleanup timers/intervals
    this.onUninit();
  }

async onDiscoveryAvailable(discoveryResult) {
  const newIP = discoveryResult.address;

  // Check if manual IP is set - if so, ignore discovery
  const manualIP = this.getSetting('manual_ip');
  if (manualIP) {
    this.log(`🌐 Discovery: Manual IP (${manualIP}) is set — ignoring discovery IP ${newIP}`);
    return;
  }

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

  // Check if manual IP is set - if so, ignore discovery
  const manualIP = this.getSetting('manual_ip');
  if (manualIP) {
    this.log(`🌐 AddressChanged: Manual IP (${manualIP}) is set — ignoring discovery IP ${newIP}`);
    return;
  }

  // Only respond if the IP actually changed
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
      await safeAddCapability(this, 'identify').catch(this.error);
      console.log(`created capability identify for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_power')) {
      await safeAddCapability(this, 'measure_power').catch(this.error);
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

  // Existing listener
  this.registerCapabilityListener('identify', async () => {
    await api.identify(this.url, this.token);
  });

  // Battery mode picker listener
  this.registerCapabilityListener('battery_group_charge_mode', async (value) => {
    // Track capability API mode changes (Homey UI, 3rd party apps, external Flows)
    // Does NOT count energy_v2 own action cards or battery-policy (they bypass this listener)
    // High counts = likely a 3rd party app repeatedly overriding the battery mode
    const _extKey = 'capability_api_mode_changes';
    const _extStored = this.homey.settings.get(_extKey) || { count: 0, last: null };
    _extStored.count += 1;
    _extStored.last = { mode: value, ts: new Date().toISOString() };
    this.homey.settings.set(_extKey, _extStored);
    wsDebug.log('capability_api_mode_change', this.getData().id,
      `mode="${value}" count=${_extStored.count}`);
    this.log(`⚠️ capability_api_mode_change #${_extStored.count} → ${value} (Homey capability API: UI, 3rd party app, or external Flow)`);

    // Rate limiting
    const now = Date.now();
    if (now - this._lastBatteryModeChange < this._batteryModeChangeCooldown) {
      this.log('⏸️ Battery mode change throttled - cooldown active');
      return value; // Return the requested value, don't fail
    }
    this._lastBatteryModeChange = now;
    this._cacheSet('last_commanded_mode', value);

    try {
      const { wsManager, url, token } = this;

      // 1. Prefer WebSocket
      if (wsManager?.isConnected()) {
        wsManager.setBatteryMode(value);
        this.log(`Set battery mode via WS → ${value}`);
      } else {
        // 2. HTTP fallback
        const response = await api.setMode(url, token, value);
        if (!response) {
          this.log(`⚠️ Invalid response from setMode(${value})`);
          return false;
        }
      }

      // 3. Fetch real vendor state
      const modeResponse = await api.getMode(url, token);

      if (!modeResponse) {
        this.log('⚠️ Invalid battery mode response after UI change:', modeResponse);
        return false;
      }

      // 4. Normalize (string OR object)
      const normalized = normalizeBatteryMode(modeResponse);

      // 5. Update cache in object-safe form
      this._cacheSet('last_battery_state', {
        mode: typeof modeResponse === 'object' ? modeResponse.mode : normalized,
        permissions: typeof modeResponse === 'object' ? modeResponse.permissions : [],
        battery_count: typeof modeResponse === 'object'
          ? (modeResponse.battery_count ?? 1)
          : 1
      });

      // 6. Update capability to the *real* vendor state
      await updateCapability(this, 'battery_group_charge_mode', normalized);

      // 7. Trigger flow if changed
      const prev = this._cacheGet('last_battery_mode');
      if (normalized !== prev) {
        this.flowTriggerBatteryMode(this, { mode: normalized });
        this._cacheSet('last_battery_mode', normalized);
      }

      return normalized;

    } catch (err) {
      this.error('❌ Failed to set battery_group_charge_mode via UI:', err);
      return false;
    }
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
  if (value === undefined) return;

  // Only update if the capability exists
  if (!this.hasCapability(capability)) return;

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
    if (this.__deleted) return; // Skip if device is deleted/uninit

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

      await this.setAvailable();

     } catch (err) {
      if (!this.__deleted) {
        this.log(`Polling error: ${err.message}`);
        this.setUnavailable(err.message || 'Polling error').catch(this.error);
      }
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
            log: this._boundLog,
            error: this._boundError,
            setAvailable: this._boundSetAvailable,
            getSetting: this._boundGetSetting,
            handleMeasurement: this._boundHandleMeasurement,
            handleSystem: this._boundHandleSystem,
            handleBatteries: this._boundHandleBatteries,
            measurementThrottleMs: (this.getSetting('ws_throttle_ms') || 2) * 1000,
            onJournalEvent: (type, deviceId, data) => {
              if (type === 'snapshot') wsDebug.snapshot(deviceId, data);
              else wsDebug.log(type, deviceId, typeof data === 'string' ? data : JSON.stringify(data));
            },
          });
        }

        //this.wsManager.start();
        this.wsManager.resume();
      }

    }

    if ('phase_overload_notifications' in MySettings.newSettings) {
      this._phaseOverloadNotificationsEnabled = MySettings.newSettings.phase_overload_notifications;
      this.log('Phase overload notifications changed to:', this._phaseOverloadNotificationsEnabled);
    }

    if (MySettings.changedKeys.includes('debug_logging')) {
      this._debugLogging = MySettings.newSettings.debug_logging ?? false;
      this.log(`🐛 Debug logging ${this._debugLogging ? 'enabled' : 'disabled'}`);
      // Also toggle WebSocket verbose logging
      this.wsManager?.setDebug(this._debugLogging);
    }

    if (MySettings.changedKeys.includes('ws_throttle_ms')) {
      const throttleSec = MySettings.newSettings.ws_throttle_ms || 2;
      this.log(`⚙️ WS measurement throttle changed to ${throttleSec}s — restarting WebSocket`);
      // Throttle is set at construction time, so we need a full WS restart
      this.wsManager?.restartWebSocket();
    }
    
    return true;
  }

  /**
   * Check if voltage has been restored to normal range after sag/swell
   * @param {Object} m - measurement data
   */
  _checkVoltageRestoration(m) {
    if (!this._voltageState || !this._flowTriggerVoltageRestored) return;
    
    // Voltage normal range (230V ±10% = 207-253V)
    const VOLTAGE_MIN = 207;
    const VOLTAGE_MAX = 253;
    
    const phases = [
      { name: 'l1', voltage: m.voltage_l1_v },
      { name: 'l2', voltage: m.voltage_l2_v },
      { name: 'l3', voltage: m.voltage_l3_v }
    ];
    
    phases.forEach(({ name, voltage }) => {
      if (voltage == null) return;
      
      const state = this._voltageState[name];
      const isNormal = voltage >= VOLTAGE_MIN && voltage <= VOLTAGE_MAX;
      
      // Detect restoration: was abnormal, now normal
      if (state.abnormal && isNormal) {
        const phaseName = name.toUpperCase();
        this.log(`Voltage restored on ${phaseName}: ${voltage}V`);
        
        this._flowTriggerVoltageRestored.trigger(this, {
          phase: phaseName,
          voltage: Math.round(voltage)
        }).catch(this.error);
        
        state.abnormal = false;
        state.lastAbnormalTime = null;
      }
      // Track abnormal state
      else if (!state.abnormal && !isNormal) {
        state.abnormal = true;
        state.lastAbnormalTime = Date.now();
      }
    });
  }

  /**
   * Check if power has been restored after being offline
   * @param {Object} m - measurement data
   */
  _checkPowerRestoration(m) {
    if (!this._powerState || !this._flowTriggerPowerRestored) return;
    
    // Consider online if we have active power reading or any voltage
    const hasActivePower = m.active_power_w != null && m.active_power_w !== 0;
    const hasVoltage = m.voltage_l1_v != null || m.voltage_l2_v != null || m.voltage_l3_v != null;
    const isOnline = hasActivePower || hasVoltage;
    
    // Detect restoration: was offline, now online
    if (this._powerState.offline && isOnline) {
      const offlineDuration = this._powerState.offlineStartTime 
        ? Math.round((Date.now() - this._powerState.offlineStartTime) / 1000)
        : 0;
      
      this.log(`Power restored after ${offlineDuration} seconds offline`);
      
      this._flowTriggerPowerRestored.trigger(this, {
        offline_duration: offlineDuration
      }).catch(this.error);
      
      this._powerState.offline = false;
      this._powerState.offlineStartTime = null;
    }
    // Track offline state
    else if (!this._powerState.offline && !isOnline) {
      this._powerState.offline = true;
      this._powerState.offlineStartTime = Date.now();
    }
  }

};