'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const https = require('https');
const WebSocketManager = require('../../includes/v2/Ws');

const api = require('../../includes/v2/Api');

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
 * Perform a fetch with a timeout using AbortController.
 *
 * @param {string} url - The URL to fetch.
 * @param {object} [options={}] - Fetch options (headers, agent, etc.).
 * @param {number} [timeout=5000] - Timeout in milliseconds.
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {Error} If the request times out or fetch fails.
 */
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Fetch timeout'));
    }, timeout);

    fetch(url, options)
      .then(async res => {
        clearTimeout(timer);

        const text = await res.text();
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}


/**
 * Estimate battery kWh capacity left based on state of charge, cycles and inverter efficiency.
 *
 * @param {number} loadPct - Current state of charge in percent (0-100).
 * @param {number} cycles - Number of charge/discharge cycles the battery has gone through.
 * @param {number} inverterEfficiency - Round trip inverter efficiency (0..1).
 * @returns {number} Estimated kWh left in the battery.
 */
function estimateBatteryKWh(loadPct, cycles, inverterEfficiency) {
  const nominalCapacity = 2.8; // kWh
  const referenceCycles = 6000;
  const referenceDegradation = 0.7; // 70% capacity at 6000 cycles

  // Linear degradation rate
  const degradationRate = (1 - referenceDegradation) / referenceCycles;

  // Degradation factor based on cycles
  let degradationFactor = 1 - (degradationRate * cycles);
  degradationFactor = Math.max(degradationFactor, 0);

  // Final usable energy
  if (inverterEfficiency < 0.75) inverterEfficiency = 0.75; // minimum 75% to avoid unrealistic low values based on cycles
  const estimatedKWh = nominalCapacity * inverterEfficiency * (loadPct / 100) * degradationFactor;

  return estimatedKWh;
}

/**
 * Experimental State-of-Charge (SoC) drift detector.
 *
 * Compares the observed SoC change rate with the expected SoC change based on reported power and battery capacity.
 *
 * @param {object} params
 * @param {number} params.previousSoC - Previous SoC percentage.
 * @param {number} params.previousTimestamp - Timestamp (ms) of previous reading.
 * @param {number} params.currentSoC - Current SoC percentage.
 * @param {number} params.currentPowerW - Current battery power in watts (positive = charging).
 * @param {number} [params.batteryCapacityWh=2470] - Battery capacity in Wh.
 * @param {number} [params.driftMargin=5] - Margin (%) to consider drift significant.
 * @returns {object} { drift: boolean, rateOfChange, expectedSoCChange, timestamp }
 */
function checkSoCDrift({
  previousSoC,
  previousTimestamp,
  currentSoC,
  currentPowerW,
  batteryCapacityWh = 2470,
  driftMargin = 0.5
}) {
  if (previousSoC === undefined || previousTimestamp === undefined) return { drift: false };

  const now = Date.now();
  // Number of minutes between readings 60000ms is 60s
  const deltaTimeMin = (now - previousTimestamp) / 60000;
  
  // Ignore intervals shorter than 12 seconds
  if (deltaTimeMin < 0.2) return { drift: false, timestamp: now };
  
  // Calculate rate of SoC change in % per minute
  const deltaSoC = currentSoC - previousSoC;
  const rateOfChange = deltaSoC / deltaTimeMin;

  // Calculate expected usage in Wh over the period
  const expectedWhChange = currentPowerW * deltaTimeMin;
  const expectedSoCChange = (expectedWhChange / batteryCapacityWh) * 100;

  // Compare actual vs expected if difference exceeds margin
  if (Math.abs(rateOfChange - expectedSoCChange) > driftMargin) {
    return {
      drift: true,
      rateOfChange,
      expectedSoCChange,
      timestamp: now
    };
  }

  // Else no drift
  return { drift: false, timestamp: now };
}

/**
 * Map RSSI dBm value to a human readable wifi quality label.
 *
 * @param {number} strength - RSSI in dBm.
 * @returns {string} Quality label (Excellent, Strong, Moderate, Weak, Poor, Unusable).
 */
function getWifiQuality(strength) {
  if (typeof strength !== 'number') return 'Unknown';
  if (strength >= -30) return 'Excellent';  // Strongest signal
  if (strength >= -60) return 'Strong';
  if (strength >= -70) return 'Moderate';
  if (strength >= -80) return 'Weak';
  if (strength >= -90) return 'Poor';
  return 'Unusable';
}

/**
 * Add, remove or update a capability on a device based on the supplied value.
 *
 * - If value is null/undefined the capability is removed (if present).
 * - If capability does not exist it will be added.
 * - Capability value is only changed when it differs from current value.
 *
 * @param {Homey.Device} device
 * @param {string} capability
 * @param {*} value
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
    //  device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}

/**
 * Homey driver for the HomeWizard Plugin Battery device.
 *
 * Manages polling, WebSocket updates, capability mapping and flow triggers.
 */
module.exports = class HomeWizardPluginBattery extends Homey.Device {

  /**
   * Called when the device is initialized by Homey.
   * - Ensures capabilities exist
   * - Registers listeners
   * - Starts polling and WebSocket manager according to settings
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    //  await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    this.previousChargingState = null;
    this.previousTimeToEmpty = null;
    this.previousStateOfCharge = null;

    this.token = await this.getStoreValue('token');
    //this.log('PIB Token:', this.token);

    const settings = this.getSettings();
    this.log('Settings for Plugin Battery: ', settings.polling_interval);

    if (!this.url && settings.url) { this.url = settings.url; this.log(`Restored URL from settings: ${this.url}`); }

    if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
      await this.setSettings({ polling_interval: 10 });
      settings.polling_interval = 10; // update local variable
    }

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }

    // Start polling only if enabled in settings (commented out by default; enable if required)
    // this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    // Initialize WebSocket manager (preferred real-time updates)
    this.wsManager = new WebSocketManager({
      url: this.url,
      token: this.token,
      log: this.log.bind(this),
      error: this.error.bind(this),
      setAvailable: this.setAvailable.bind(this),
      getSetting: this.getSetting.bind(this),
      handleMeasurement: this._handleMeasurement.bind(this),
      handleSystem: this._handleSystem.bind(this),
      // handleBatteries: this._handleBatteries.bind(this)
    });
    this.wsManager.start();
  
    // 🕒 Driver-side watchdog
    this._wsWatchdog = setInterval(() => {
      const staleMs = Date.now() - (this.wsManager?.lastMeasurementAt || 0);
      if (!this.getSettings().use_polling && staleMs > 190000) { // just over 3min
        this.log(`🕒 Driver watchdog: stale >3min (${staleMs}ms), restarting WS`);
        this.wsManager?.restartWebSocket();
      }
    }, 60000); // check every minute
    
  }

  /**
   * Clean up timers, websockets and settings on device deletion.
   * @returns {void}
   */
  onDeleted() {
    // Clear watchdog timer
    if (this._wsWatchdog) {
      clearInterval(this._wsWatchdog);
      this._wsWatchdog = null;
    }

    // Clear polling interval
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }

    // Stop WebSocket manager once
    if (this.wsManager) {
      this.wsManager.stop(); // Cleanly shuts down the WebSocket
      this.wsManager = null;
    }

    // Remove battery from shared group
    const batteryId = this.getData().id;
    const group = this.homey.settings.get('pluginBatteryGroup') || {};
    if (group[batteryId]) {
      delete group[batteryId];
      this.homey.settings.set('pluginBatteryGroup', group);
      this.log(`Battery ${batteryId} removed from pluginBatteryGroup`);
    }
  }


  /**
   * Handle discovery available event from Homey MDNS discovery.
   * Updates stored URL and optionally restarts WebSocket (debounced).
   *
   * @param {object} discoveryResult
   * @returns {Promise<void>}
   */
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

  /**
   * Handle discovery address changes.
   * @param {object} discoveryResult
   * @returns {Promise<void>}
   */
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

  /**
   * Handle "last seen" discovery update.
   * Refresh URL, mark available and restart WS if needed.
   * @param {object} discoveryResult
   * @returns {Promise<void>}
   */
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
   * Handle incoming measurement payloads from WS.
   * Maps fields to capabilities, updates shared group info and triggers flows.
   *
   * @param {object} data Measurement payload from device.
   * @returns {Promise<void>}
   */
  async _handleMeasurement(data) {
    // Skip if device has been deleted or no ID
    if (!this.getData() || !this.getData().id) {
      this.log('⚠️ Ignoring measurement: device no longer exists');
      return;
    }

    this.lastMeasurementAt = Date.now();

    let time_to_empty = null;
    let time_to_full = null;
    const BATTERY_CAPACITY_WH = 2470;

    // this.log('🔎 WS measurement payload:', JSON.stringify(data));

    // Power and measurement capabilities (use updateCapability helper)
    await updateCapability(this, 'meter_power.import', data.energy_import_kwh ?? null).catch(this.error);
    await updateCapability(this, 'meter_power.export', data.energy_export_kwh ?? null).catch(this.error);
    await updateCapability(this, 'measure_power', data.power_w ?? null).catch(this.error);
    await updateCapability(this, 'measure_voltage', data.voltage_v ?? null).catch(this.error);
    await updateCapability(this, 'measure_current', data.current_a ?? null).catch(this.error);
    await updateCapability(this, 'measure_battery', data.state_of_charge_pct ?? null).catch(this.error);
    await updateCapability(this, 'measure_voltage', data.voltage_v ?? null).catch(this.error);
    await updateCapability(this, 'measure_frequency', data.frequency_hz ?? null).catch(this.error);
    await updateCapability(this, 'cycles', data.cycles ?? null).catch(this.error);

    // Update shared pluginBatteryGroup in app settings
    const batteryId = this.getData().id;
    const batteryInfo = {
      id: batteryId,
      capacity_kwh: 2.8,
      cycles: data.cycles,
      power_w: data.power_w,
      soc_pct: data.state_of_charge_pct,
      updated_at: Date.now()
    };

    let group = this.homey.settings.get('pluginBatteryGroup') || {};
    group[batteryId] = batteryInfo;
    this.homey.settings.set('pluginBatteryGroup', group);

    // battery_charging_state
    let chargingState;
    if (data.power_w > 10) {
      chargingState = 'charging';
    } else if (data.power_w < 0) {
      chargingState = 'discharging';
    } else {
      chargingState = 'idle';
    }
    await updateCapability(this, 'battery_charging_state', chargingState).catch(this.error);

    // Time to full / empty calculations (guard against divide-by-zero)
    if (typeof data.state_of_charge_pct === 'number' && typeof data.power_w === 'number') {
      if (data.power_w > 10) {
        const current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_full = (BATTERY_CAPACITY_WH - current_battery_capacity) / (data.power_w * 60);
        await updateCapability(this, 'time_to_full', Math.round(time_to_full)).catch(this.error);
        await updateCapability(this, 'time_to_empty', 0).catch(this.error);

      }

      if (data.power_w < -10) {
        const current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_empty = (current_battery_capacity / Math.abs(data.power_w)) * 60;
        await updateCapability(this, 'time_to_empty', Math.round(time_to_empty)).catch(this.error);
        await updateCapability(this, 'time_to_full', 0).catch(this.error);
        
      }
    }

    // Flow triggers
    if (chargingState !== this.previousChargingState) {
      this.previousChargingState = chargingState;
      this.homey.flow
        .getDeviceTriggerCard('battery_state_changed')
        .trigger(this, { state: chargingState })
        .catch(this.error);
    }

    if (typeof time_to_empty === 'number' && time_to_empty < 30 && this.previousTimeToEmpty >= 30) {
      this.previousTimeToEmpty = time_to_empty;
      this.homey.flow
        .getDeviceTriggerCard('battery_low_runtime')
        .trigger(this, { minutes: Math.round(time_to_empty) })
        .catch(this.error);
    } else {
      this.previousTimeToEmpty = time_to_empty;
    }

    if (data.state_of_charge_pct === 100 && this.previousStateOfCharge < 100) {
      this.previousStateOfCharge = data.state_of_charge_pct;
      this.homey.flow
        .getDeviceTriggerCard('battery_full')
        .trigger(this)
        .catch(this.error);
    } else {
      this.previousStateOfCharge = data.state_of_charge_pct;
    }

    // Net frequency out of range trigger
    if (typeof data.frequency_hz === 'number' && (data.frequency_hz > 50.2 || data.frequency_hz < 49.8)) {
      this.homey.flow
        .getDeviceTriggerCard('net_frequency_out_of_range')
        .trigger(this)
        .catch(this.error);
    }

    // Inverter efficiency and estimate_kwh
    const inverterEfficiency = (data.energy_import_kwh > 0)
      ? data.energy_export_kwh / data.energy_import_kwh
      : 0.75; // fallback default

    const estimate_kwh = estimateBatteryKWh(data.state_of_charge_pct, data.cycles, inverterEfficiency);
    await updateCapability(this, 'estimate_kwh', Math.round(estimate_kwh * 100) / 100).catch(this.error);

    // Initialize drift state if not already set
    if (this.driftActive === undefined) {
      this.driftActive = false;
    }

    // State of charge drift detection (experimental)
    const driftResult = checkSoCDrift({
      previousSoC: this.previousSoC,
      previousTimestamp: this.previousTimestamp,
      currentSoC: data.state_of_charge_pct,
      currentPowerW: data.power_w,
      currentTimestamp: Date.now()
    });

    this.previousSoC = data.state_of_charge_pct;
    this.previousTimestamp = driftResult.timestamp;

    if (driftResult.drift && !this.driftActive) {
      this.driftActive = true;
      this.log(`⚠️ SoC drift detected: ${driftResult.rateOfChange.toFixed(2)}%/min vs expected ${driftResult.expectedSoCChange.toFixed(2)}%/min`);
      this.homey.flow
        .getDeviceTriggerCard('battery_soc_drift_detected')
        .trigger(this, {
          rate: Math.round(driftResult.rateOfChange),
          expected: Math.round(driftResult.expectedSoCChange)
        })
        .catch(this.error);
    }

    if (!driftResult.drift && this.driftActive) {
      this.driftActive = false;
      this.log('✅ SoC drift resolved.');
    }
  }

  /**
   * Handle system events from the device (e.g., wifi rssi, cloud enabled).
   *
   * @param {object} data System payload from device.
   * @returns {void}
   */
    _handleSystem(data) {

      // Skip if device has been deleted or no ID
      if (!this.getData() || !this.getData().id) {
        this.log('⚠️ Ignoring system event: device no longer exists');
        return;
      }

      try {
        
        if (typeof data.wifi_rssi_db === 'number') {
          updateCapability(this, 'rssi', data.wifi_rssi_db).catch(this.error);
          const wifiQuality = getWifiQuality(data.wifi_rssi_db);
          updateCapability(this, 'wifi_quality', wifiQuality).catch(this.error);
        }
        
      } catch (err) {
        this.error(`System handler failed: ${err.message}`);
      }
    }


  /**
   * Ensure required capabilities exist on the device.
   * Adds capabilities if missing (runs once on init).
   *
   * @returns {Promise<void>}
   */
  async _updateCapabilities() {
    if (!this.hasCapability('identify')) {
      await this.addCapability('identify').catch(this.error);
      this.log(`created capability identify for ${this.getName()}`);
    }

    if (!this.hasCapability('meter_power.import')) {
      await this.addCapability('meter_power.import').catch(this.error);
      this.log(`created capability meter_power.import for ${this.getName()}`);
    }

    if (!this.hasCapability('meter_power.export')) {
      await this.addCapability('meter_power.export').catch(this.error);
      this.log(`created capability meter_power.export for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power').catch(this.error);
      this.log(`created capability measure_power for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_voltage')) {
      await this.addCapability('measure_voltage').catch(this.error);
      this.log(`created capability measure_voltage for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_current')) {
      await this.addCapability('measure_current').catch(this.error);
      this.log(`created capability measure_current for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_battery')) {
      await this.addCapability('measure_battery').catch(this.error);
      this.log(`created capability measure_battery for ${this.getName()}`);
    }

    if (!this.hasCapability('battery_charging_state')) {
      await this.addCapability('battery_charging_state').catch(this.error);
      this.log(`created capability battery_charging_state for ${this.getName()}`);
    }

    if (!this.hasCapability('cycles')) {
      await this.addCapability('cycles').catch(this.error);
      this.log(`created capability cycles for ${this.getName()}`);
    }

    if (!this.hasCapability('time_to_empty')) {
      await this.addCapability('time_to_empty').catch(this.error);
      this.log(`created capability time_to_empty for ${this.getName()}`);
    }

    if (!this.hasCapability('time_to_full')) {
      await this.addCapability('time_to_full').catch(this.error);
      this.log(`created capability time_to_full for ${this.getName()}`);
    }

    if (!this.hasCapability('rssi')) {
      await this.addCapability('rssi').catch(this.error);
      this.log(`created capability rssi for ${this.getName()}`);
    }

    if (!this.hasCapability('estimate_kwh')) {
      await this.addCapability('estimate_kwh').catch(this.error);
      this.log(`created capability estimate_kwh for ${this.getName()}`);
    }
  }

  /**
   * Register capability listeners (e.g., identify button).
   *
   * @returns {Promise<void>}
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  /**
   * Settings handler for Homey SDK3.
   *
   * Starts/stops/restarts polling based on changed settings.
   *
   * @param {object} param0
   * @param {object} param0.oldSettings
   * @param {object} param0.newSettings
   * @param {string[]} param0.changedKeys
   * @returns {boolean} Return true to accept settings.
   */
  async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] } = {}) {
    this.log('Plugin Battery Settings updated', newSettings, changedKeys);

    // handle polling enable/disable
    const oldUsePolling = oldSettings.use_polling;
    const newUsePolling = newSettings.use_polling;

    const oldInterval = oldSettings.polling_interval;
    const newInterval = newSettings.polling_interval;

    // if polling toggled
    if (typeof newUsePolling !== 'undefined' && newUsePolling !== oldUsePolling) {
      if (newUsePolling) {
        // start polling
        const intervalSec = newInterval || (await this.getSettings()).polling_interval || 10;
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * intervalSec);
        this.log(`🔁 Polling enabled, interval ${intervalSec}s`);
      } else {
        // stop polling
        if (this.onPollInterval) {
          clearInterval(this.onPollInterval);
          this.onPollInterval = null;
        }
        this.log('🔁 Polling disabled by settings');
      }
    }

    // if interval changed while polling enabled, restart with new value
    if (typeof newInterval !== 'undefined' && newInterval !== oldInterval) {
      const settings = await this.getSettings();
      const intervalSec = newInterval || settings.polling_interval || 10;
      if (this.onPollInterval) clearInterval(this.onPollInterval);
      if (settings.use_polling) {
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * intervalSec);
        this.log(`🔁 Polling interval updated to ${intervalSec}s`);
      } else {
        this.onPollInterval = null;
      }
    }

    return true;
  }

};
