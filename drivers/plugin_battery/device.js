'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');
const WebSocketManager = require('../../includes/v2/Ws');
const wsDebug = require('../../includes/v2/wsDebug');
const api = require('../../includes/v2/Api');
const debug = false;

// Shared HTTPS agent (no timeout wrapper)
const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  keepAliveMsecs: 15000
});


// ---------------------------------------------------------
// estimateBatteryKWh (unchanged)
// ---------------------------------------------------------
function estimateBatteryKWh(loadPct, cycles, inverterEfficiency) {
  const nominalCapacity = 2.8;
  const referenceCycles = 6000;
  const referenceDegradation = 0.7;

  const degradationRate = (1 - referenceDegradation) / referenceCycles;
  let degradationFactor = 1 - (degradationRate * cycles);
  degradationFactor = Math.max(degradationFactor, 0);

  if (inverterEfficiency < 0.75) inverterEfficiency = 0.75;

  return nominalCapacity * inverterEfficiency * (loadPct / 100) * degradationFactor;
}

// ---------------------------------------------------------
// checkSoCDrift (unchanged)
// ---------------------------------------------------------
function checkSoCDrift({ previousSoC, previousTimestamp, currentSoC, currentPowerW, batteryCapacityWh = 2470, driftMargin = 0.5 }) {
  if (previousSoC === undefined || previousTimestamp === undefined) return { drift: false };

  const now = Date.now();
  const deltaTimeMin = (now - previousTimestamp) / 60000;
  if (deltaTimeMin < 0.2) return { drift: false, timestamp: now };

  const deltaSoC = currentSoC - previousSoC;
  const rateOfChange = deltaSoC / deltaTimeMin;

  const expectedWhChange = currentPowerW * deltaTimeMin;
  const expectedSoCChange = (expectedWhChange / batteryCapacityWh) * 100;

  if (Math.abs(rateOfChange - expectedSoCChange) > driftMargin) {
    return { drift: true, rateOfChange, expectedSoCChange, timestamp: now };
  }

  return { drift: false, timestamp: now };
}

// ---------------------------------------------------------
// getWifiQuality (unchanged)
// ---------------------------------------------------------
function getWifiQuality(strength) {
  if (typeof strength !== 'number') return 'Unknown';
  if (strength >= -30) return 'Excellent';
  if (strength >= -60) return 'Strong';
  if (strength >= -70) return 'Moderate';
  if (strength >= -80) return 'Weak';
  if (strength >= -90) return 'Poor';
  return 'Unusable';
}

// ---------------------------------------------------------
// updateCapability (unchanged)
// ---------------------------------------------------------
async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  if (value === undefined || value === null) return;

  if (!device.hasCapability(capability)) {
    try {
      await device.addCapability(capability);
      device.log(`➕ Added capability "${capability}"`);
    } catch (err) {
      if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
        device.log(`Capability already exists: ${capability} — ignoring`);
      } else {
        device.error(err);
      }
    }
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
  }
}


// ---------------------------------------------------------
// fetchWithTimeout (unchanged)
// ---------------------------------------------------------

function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}


// ---------------------------------------------------------
// DEVICE CLASS
// ---------------------------------------------------------
module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    wsDebug.init(this.homey);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    this.previousChargingState = null;
    this.previousTimeToEmpty = null;
    this.previousStateOfCharge = null;
    this._prevTimeToFull = this.getCapabilityValue('time_to_full') ?? 0;
    this._prevTimeToEmpty = this.getCapabilityValue('time_to_empty') ?? 0;
    this._lastDiscoveryIP = null;

    this.token = await this.getStoreValue('token');

    const settings = { use_polling: false, ...this.getSettings() };
    this.log('Plugin Battery settings:', settings);

    if (!this.url && settings.url) {
      this.url = settings.url;
      this.log(`Restored URL from settings: ${this.url}`);
    }

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
      settings.polling_interval = 10;
    }

    // Stop old WS if present
    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    // Bind handler functions ONCE to avoid creating new function objects on every reconnect (memory leak)
    this._boundLog = this.log.bind(this);
    this._boundError = this.error.bind(this);
    this._boundSetAvailable = this.setAvailable.bind(this);
    this._boundGetSetting = this.getSetting.bind(this);
    this._boundHandleMeasurement = (data) => {
      this.lastWsMeasurementAt = Date.now();
      this._handleMeasurement(data);
    };
    this._boundHandleSystem = this._handleSystem.bind(this);

    // -----------------------------------------------------
    // SELECT DATA SOURCE
    // -----------------------------------------------------
    if (settings.use_polling) {
      const intervalSec = settings.polling_interval || 10;
      this.log(`⏱️ Polling enabled at init, interval ${intervalSec}s`);

      this.onPollInterval = setInterval(
        this.onPoll.bind(this),
        intervalSec * 1000
      );

    } else {
      this.log('🔌 WebSocket enabled at init');

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
      });

      this.wsManager.start();

      // Idle watchdog
      this._wsIdleWatchdog = setInterval(() => {
        const last = this.lastWsMeasurementAt || 0;
        const diff = Date.now() - last;

        if (diff > 10 * 60 * 1000) {
          this.log(`🕒 WS idle for ${diff}ms → fallback poll`);
          this._fallbackPoll();
        }
      }, 60000);

      // Stale WS watchdog
      this._wsWatchdog = setInterval(() => {
        const staleMs = Date.now() - (this.wsManager?.lastMeasurementAt || 0);
        if (!this.getSettings().use_polling && staleMs > 190000) {
          this.log(`🕒 WS stale >3min (${staleMs}ms), restarting`);
          this.wsManager?.restartWebSocket();
        }
      }, 60000);

      // Battery group updater
      this._batteryGroupInterval = setInterval(() => {
        this._updateBatteryGroup();
      }, 10000);
    }
  }

  onDeleted() {
    if (this._wsWatchdog) {
      clearInterval(this._wsWatchdog);
      this._wsWatchdog = null;
    }
    if (this._wsIdleWatchdog) {
      clearInterval(this._wsIdleWatchdog);
      this._wsIdleWatchdog = null;
    }
    if (this._wsReconnectTimeout) {
      clearTimeout(this._wsReconnectTimeout);
      this._wsReconnectTimeout = null;
    }
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    if (this._batteryGroupInterval) {
      clearInterval(this._batteryGroupInterval);
      this._batteryGroupInterval = null;
    }

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    const batteryId = this.getData().id;
    const group = this.homey.settings.get('pluginBatteryGroup') || {};
    if (group[batteryId]) {
      delete group[batteryId];
      this.homey.settings.set('pluginBatteryGroup', group);
      this.log(`Battery ${batteryId} removed from pluginBatteryGroup`);
    }
  }

  /**
   * Discovery handlers
   */
  async onDiscoveryAvailable(discoveryResult) {
    const newIP = discoveryResult.address;

    if (!this._lastDiscoveryIP) {
      this._lastDiscoveryIP = newIP;
      this.url = `https://${newIP}`;
      this.log(`🌐 Discovery: initial IP ${newIP}`);
      await this.setSettings({ url: this.url }).catch(this.error);
      return;
    }

    if (this._lastDiscoveryIP === newIP) {
      this.log(`🌐 Discovery: IP unchanged (${newIP})`);
      return;
    }

    this._lastDiscoveryIP = newIP;
    this.url = `https://${newIP}`;
    this.log(`🌐 Discovery: IP changed → ${newIP}`);
    await this.setSettings({ url: this.url }).catch(this.error);

    this._rebuildWebSocketDebounced();
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    const newIP = discoveryResult.address;

    if (this._lastDiscoveryIP === newIP) {
      this.log(`🌐 AddressChanged: IP unchanged (${newIP})`);
      return;
    }

    this._lastDiscoveryIP = newIP;
    this.url = `https://${newIP}`;
    this.log(`🌐 Address changed → ${newIP}`);
    await this.setSettings({ url: this.url }).catch(this.error);

    this._rebuildWebSocketDebounced();
  }

  async onDiscoveryLastSeenChanged(discoveryResult) {
    const newIP = discoveryResult.address;

    if (this._lastDiscoveryIP !== newIP) {
      this._lastDiscoveryIP = newIP;
      this.url = `https://${newIP}`;
      this.log(`📡 LastSeen: IP updated → ${newIP}`);
      await this.setSettings({ url: this.url }).catch(this.error);
    } else {
      this.log(`📡 LastSeen: IP unchanged (${newIP})`);
    }

    await this.setAvailable();

    if (!this.getSettings().use_polling && !this.wsManager?.isConnected()) {
      this._rebuildWebSocketDebounced();
    }
  }

  /**
   * Debounced WebSocket rebuild
   */
  _rebuildWebSocketDebounced() {
    if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);

    this._wsReconnectTimeout = setTimeout(() => {
      if (this.getSettings().use_polling) {
        this.log('🔁 Polling active → skip WS rebuild');
        return;
      }

      this.log('🔁 Rebuilding WebSocket');

      if (this.wsManager) {
        this.wsManager.stop();
        this.wsManager = null;
      }

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
      });

      this.wsManager.start();

    }, 500);
  }
  /**
   * Handle incoming measurement payloads from WS.
   * Maps fields to capabilities, updates shared group info and triggers flows.
   */
  async _handleMeasurement(data) {
    if (!this.getData() || !this.getData().id) {
      this.log('⚠️ Ignoring measurement: device no longer exists');
      return;
    }

    if (debug) this.log('HANDLE MEASUREMENT:', data);

    const now = Date.now();
    this.lastMeasurementAt = now;

    const BATTERY_CAPACITY_WH = 2470;

    // ---------------------------------------------------------
    // 1. REALTIME capabilities (max 1 Hz)
    // ---------------------------------------------------------
    const realtimeCaps = [
      ['measure_power', data.power_w],
      ['measure_voltage', data.voltage_v],
      ['measure_current', data.current_a],
      ['measure_frequency', data.frequency_hz]
    ];

    for (const [cap, val] of realtimeCaps) {
      const cur = this.getCapabilityValue(cap);
      if (cur !== val) {
        await updateCapability(this, cap, val);
      }
    }

    // ---------------------------------------------------------
    // 2. SOC debounced (max 1× per 5 sec)
    // ---------------------------------------------------------
    if (!this._socLastUpdate || now - this._socLastUpdate > 5000) {
      const cur = this.getCapabilityValue('measure_battery');
      if (cur !== data.state_of_charge_pct) {
        await updateCapability(this, 'measure_battery', data.state_of_charge_pct);
      }
      this._socLastUpdate = now;
    }

    // ---------------------------------------------------------
    // 3. Import/export debounced (max 1× per 10 sec)
    // ---------------------------------------------------------
    if (!this._energyLastUpdate || now - this._energyLastUpdate > 10000) {
      const imp = this.getCapabilityValue('meter_power.import');
      const exp = this.getCapabilityValue('meter_power.export');

      if (imp !== data.energy_import_kwh) {
        await updateCapability(this, 'meter_power.import', data.energy_import_kwh);
      }
      if (exp !== data.energy_export_kwh) {
        await updateCapability(this, 'meter_power.export', data.energy_export_kwh);
      }

      this._energyLastUpdate = now;
    }

    // ---------------------------------------------------------
    // 4. Cycles debounced (max 1× per 60 sec)
    // ---------------------------------------------------------
    if (!this._cyclesLastUpdate || now - this._cyclesLastUpdate > 60000) {
      const cur = this.getCapabilityValue('cycles');
      if (cur !== data.cycles) {
        await updateCapability(this, 'cycles', data.cycles);
      }
      this._cyclesLastUpdate = now;
    }

    // ---------------------------------------------------------
    // 5. Charging state (realtime, only on change)
    // ---------------------------------------------------------
    let chargingState;
    if (data.power_w > 10) chargingState = 'charging';
    else if (data.power_w < -10) chargingState = 'discharging';
    else chargingState = 'idle';

    if (chargingState !== this.previousChargingState) {
      await updateCapability(this, 'battery_charging_state', chargingState);
      this.previousChargingState = chargingState;

      this.homey.flow
        .getDeviceTriggerCard('battery_state_changed')
        .trigger(this, { state: chargingState })
        .catch(this.error);
    }

    // ---------------------------------------------------------
    // 6. Time to full / empty (smooth + CPU‑friendly)
    // ---------------------------------------------------------
    if (typeof data.state_of_charge_pct === 'number' && typeof data.power_w === 'number') {

      const current_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);

      // Charging
      if (data.power_w > 10) {
        const remaining = BATTERY_CAPACITY_WH - current_capacity;
        let ttf = Math.round((remaining / data.power_w) * 60);

        if (Math.abs(this._prevTimeToFull - ttf) >= 5) {
          await updateCapability(this, 'time_to_full', ttf);
          this._prevTimeToFull = ttf;
        }

        if (this._prevTimeToEmpty !== 0) {
          await updateCapability(this, 'time_to_empty', 0);
          this._prevTimeToEmpty = 0;
        }
      }

      // Discharging
      else if (data.power_w < -10) {
        let tte = Math.round((current_capacity / Math.abs(data.power_w)) * 60);

        if (Math.abs(this._prevTimeToEmpty - tte) >= 5) {
          await updateCapability(this, 'time_to_empty', tte);
          this._prevTimeToEmpty = tte;
        }

        if (this._prevTimeToFull !== 0) {
          await updateCapability(this, 'time_to_full', 0);
          this._prevTimeToFull = 0;
        }
      }

      // Idle
      else {
        if (this._prevTimeToFull !== 0) {
          await updateCapability(this, 'time_to_full', 0);
          this._prevTimeToFull = 0;
        }
        if (this._prevTimeToEmpty !== 0) {
          await updateCapability(this, 'time_to_empty', 0);
          this._prevTimeToEmpty = 0;
        }
      }
    }

    // ---------------------------------------------------------
    // 7. Estimate KWh (max 1× per 30 sec)
    // ---------------------------------------------------------
    if (!this._estimateLastUpdate || now - this._estimateLastUpdate > 30000) {
      const inverterEfficiency = (data.energy_import_kwh > 0)
        ? data.energy_export_kwh / data.energy_import_kwh
        : 0.75;

      const estimate_kwh = estimateBatteryKWh(
        data.state_of_charge_pct,
        data.cycles,
        inverterEfficiency
      );

      const rounded = Math.round(estimate_kwh * 100) / 100;
      if (this.getCapabilityValue('estimate_kwh') !== rounded) {
        await updateCapability(this, 'estimate_kwh', rounded);
      }

      this._estimateLastUpdate = now;
    }

    // ---------------------------------------------------------
    // 8. Drift detection (max 1× per 30 sec)
    // ---------------------------------------------------------
    if (!this._driftLastUpdate || now - this._driftLastUpdate > 30000) {
      const driftResult = checkSoCDrift({
        previousSoC: this.previousSoC,
        previousTimestamp: this.previousTimestamp,
        currentSoC: data.state_of_charge_pct,
        currentPowerW: data.power_w,
        currentTimestamp: now
      });

      this.previousSoC = data.state_of_charge_pct;
      this.previousTimestamp = driftResult.timestamp;

      if (driftResult.drift && !this.driftActive) {
        this.driftActive = true;
        this.log(`⚠️ SoC drift detected`);
        this.homey.flow
          .getDeviceTriggerCard('battery_soc_drift_detected')
          .trigger(this)
          .catch(this.error);
      }

      if (!driftResult.drift && this.driftActive) {
        this.driftActive = false;
        this.log('✅ SoC drift resolved.');
      }

      this._driftLastUpdate = now;
    }

    // ---------------------------------------------------------
    // 9. Store latest values for group updater
    // ---------------------------------------------------------
    this._lastPower = data.power_w;
    this._lastSoC = data.state_of_charge_pct;
    this._lastCycles = data.cycles;
  }


  /**
   * Handle system events (wifi, cloud, etc.)
   */
  _handleSystem(data) {
  if (!this.getData() || !this.getData().id) {
    this.log('⚠️ Ignoring system event: device no longer exists');
    return;
  }

  const now = Date.now();

  // ---------------------------------------------------------
  // 1. WiFi RSSI (debounced: max 1× per 5 sec)
  // ---------------------------------------------------------
  if (typeof data.wifi_rssi_db === 'number') {
    if (!this._wifiLastUpdate || now - this._wifiLastUpdate > 5000) {
      const curRssi = this.getCapabilityValue('rssi');
      if (curRssi !== data.wifi_rssi_db) {
        updateCapability(this, 'rssi', data.wifi_rssi_db);
      }

      const quality = getWifiQuality(data.wifi_rssi_db);
      const curQuality = this.getCapabilityValue('wifi_quality');
      if (curQuality !== quality) {
        updateCapability(this, 'wifi_quality', quality);
      }

      this._wifiLastUpdate = now;
    }
  }

  // ---------------------------------------------------------
  // LED brightness → Homey dim (0–1)
  // ---------------------------------------------------------
  if (typeof data.status_led_brightness_pct === 'number') {
    const apiValue = data.status_led_brightness_pct; // 0–100
    const dimValue = apiValue / 100;                 // 0–1

    if (!this._dimLastUpdate || now - this._dimLastUpdate > 5000) {
      const cur = this.getCapabilityValue('dim');

      if (cur !== dimValue) {
        updateCapability(this, 'dim', dimValue);
      }

      this._dimLastUpdate = now;
    }
  }

}



  /**
   * Ensure required capabilities exist.
   */
  async _updateCapabilities() {
    const caps = [
      'identify',
      'dim',
      'meter_power.import',
      'meter_power.export',
      'measure_power',
      'measure_voltage',
      'measure_current',
      'measure_battery',
      'battery_charging_state',
      'cycles',
      'time_to_empty',
      'time_to_full',
      'rssi',
      'wifi_quality',
      'estimate_kwh'
    ];

    for (const cap of caps) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`Created capability ${cap} for ${this.getName()}`);
        } catch (err) {
          if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
            this.log(`Capability already exists: ${cap} — ignoring`);
          } else {
            this.error(`Failed to add capability ${cap}:`, err);
          }
        }
      }
    }
  }

async _fetchFallbackSoC() {
  try {
    const res = await fetchWithTimeout(`${this.url}/api/measurement`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent
    });

    if (!res.ok) {
      this.log(`⚠️ Fallback SoC fetch failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (typeof data.state_of_charge_pct === 'number') {
      this.log(`✅ Fallback SoC available: ${data.state_of_charge_pct}%`);
      return data.state_of_charge_pct;
    } else {
      this.log(`⚠️ Fallback SoC not present in API response`);
      return null;
    }
  } catch (err) {
    this.error('Fallback SoC fetch error:', err.message);
    return null;
  }
}



  /**
   * Update battery group every 10 seconds
   */
async _updateBatteryGroup() {
  const batteryId = this.getData()?.id;
  if (!batteryId) return;

  // 1. Start with WS SoC (can be null)
  let soc = (typeof this._lastSoC === 'number') ? this._lastSoC : null;

  // 2. ALWAYS do extra API call
  let apiSoc = null;
  try {
    const res = await fetchWithTimeout(`${this.url}/api/measurement`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent
    });

    if (res.ok) {
      const data = await res.json();

      // Only accept API SoC if > 0
      if (typeof data.state_of_charge_pct === 'number' && data.state_of_charge_pct > 0) {
        apiSoc = data.state_of_charge_pct;
        if (debug) this.log(`🔄 Extra API SoC: ${apiSoc}%`);
      } else {
        if (debug) this.log(`⚠️ Extra API SoC missing or is 0 — exception`);
      }
    } else {
      if (debug) this.log(`⚠️ Extra API SoC fetch failed: ${res.status}`);
    }
  } catch (err) {
    this.error('Extra API SoC fetch error:', err.message);
  }

  // 3. API SoC takes precedence (but 0 is invalid)
  if (typeof apiSoc === 'number' && apiSoc > 0) {
    soc = apiSoc;
  }

  // 4. Last fallback
  if (typeof soc !== 'number' || soc < 0) soc = 0;

  const info = {
    id: batteryId,
    capacity_kwh: 2.8,
    cycles: typeof this._lastCycles === 'number' ? this._lastCycles : 0,
    power_w: typeof this._lastPower === 'number' ? this._lastPower : 0,
    soc_pct: Math.round(soc),
    updated_at: Date.now()
  };

  let group = this.homey.settings.get('pluginBatteryGroup') || {};
  const prev = JSON.stringify(group[batteryId]);
  const next = JSON.stringify(info);

  if (prev !== next) {
    group[batteryId] = info;
    this.homey.settings.set('pluginBatteryGroup', group);
  }
}





  /**
   * Fallback poll (pure fetch)
   */
  async _fallbackPoll() {
    try {
      const measurementRes = await fetchWithTimeout(`${this.url}/api/measurement`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Api-Version': '2'
        },
        agent
      });

      if (measurementRes.ok) {
        const measurement = await measurementRes.json();
        this._handleMeasurement(measurement);
      }

      const systemRes = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          'X-Api-Version': '2'
        },
        agent
      });

      if (systemRes.ok) {
        const system = await systemRes.json();
        this._handleSystem(system);
      }

      this.log('📡 Fallback poll completed');

    } catch (err) {
      this.error('Fallback poll error:', err.message);
    }
  }

  /**
   * Polling (pure fetch, no timeout wrapper)
   */
  async onPoll() {
  try {
    const measurementRes = await fetchWithTimeout(`${this.url}/api/measurement`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent
    });

    if (measurementRes.ok) {
      const measurement = await measurementRes.json();

      if (debug) this.log('📡 POLL MEASUREMENT:', measurement);

      this._handleMeasurement(measurement);
    } else {
      if (debug) this.log('❌ POLL measurementRes NOT OK:', measurementRes.status);
    }

    const systemRes = await fetchWithTimeout(`${this.url}/api/system`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent
    });

    if (systemRes.ok) {
      const system = await systemRes.json();

      if (debug) this.log('📡 POLL SYSTEM:', system);

      this._handleSystem(system);
    } else {
      if (debug) this.log('❌ POLL systemRes NOT OK:', systemRes.status);
    }

  } catch (err) {
    this.error('Polling error:', err.message);
  }
}



/**
 * Register capability listeners.
 */
async _registerCapabilityListeners() {

  // IDENTIFY
  this.registerCapabilityListener('identify', async () => {
    await api.identify(this.url, this.token);
  });

  // LED BRIGHTNESS
  this.registerCapabilityListener('dim', async (value) => {
    // value is 0–1 → API wil 0–100
    const brightness = Math.round(value * 100);

    try {
      await api.setLedBrightness(this.url, this.token, brightness);
      this.log(`LED brightness set to ${brightness}%`);
    } catch (err) {
      this.error('LED brightness set error:', err.message);
      throw new Error('Failed to set LED brightness');
    }
  });

}



  /**
   * Settings handler — switching between WS and polling.
   */
  async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] } = {}) {
    this.log('Plugin Battery Settings updated', newSettings, changedKeys);

    const oldUsePolling = oldSettings.use_polling;
    const newUsePolling = newSettings.use_polling;

    const oldInterval = oldSettings.polling_interval;
    const newInterval = newSettings.polling_interval;

    // ---------------------------------------------------------
    // 1. use_polling toggled → switch between WS and polling
    // ---------------------------------------------------------
    if (changedKeys.includes('use_polling')) {
      if (newUsePolling) {
        // SWITCH TO POLLING
        this.log('⚙️ Switching to POLLING mode');

        // Stop WebSocket
        if (this.wsManager) {
          this.log('🔌 Stopping WebSocket (polling enabled)');
          this.wsManager.stop();
          this.wsManager = null;
        }

        // Start polling
        const intervalSec = newInterval || newSettings.polling_interval || 10;
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        this.onPollInterval = setInterval(this.onPoll.bind(this), intervalSec * 1000);

        this.log(`⏱️ Polling enabled, interval ${intervalSec}s`);

      } else {
        // SWITCH TO WEBSOCKET
        this.log('⚙️ Switching to WEBSOCKET mode');

        // Stop polling
        if (this.onPollInterval) {
          clearInterval(this.onPollInterval);
          this.onPollInterval = null;
          this.log('⏹️ Polling stopped');
        }

        // FULL REBUILD of WebSocketManager
        if (this.wsManager) {
          this.wsManager.stop();
          this.wsManager = null;
        }

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
        });

        this.log('🔌 Starting WebSocket (polling disabled)');
        this.wsManager.start();
      }
    }

    // ---------------------------------------------------------
    // 2. Polling interval changed → restart polling if active
    // ---------------------------------------------------------
    if (changedKeys.includes('polling_interval')) {
      const intervalSec = newInterval || newSettings.polling_interval || 10;

      if (newSettings.use_polling) {
        if (this.onPollInterval) clearInterval(this.onPollInterval);
        this.onPollInterval = setInterval(this.onPoll.bind(this), intervalSec * 1000);
        this.log(`⏱️ Polling interval updated to ${intervalSec}s`);
      } else {
        this.log('⏱️ Polling interval changed, but polling is disabled');
      }
    }

    return true;
  }
};
