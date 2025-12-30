'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');
const WebSocketManager = require('../../includes/v2/Ws');
const api = require('../../includes/v2/Api');

const agent = new https.Agent({ rejectUnauthorized: false });

process.on('uncaughtException', err => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) =>
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason)
);

// ---------------------------------------------------------
// fetchWithTimeout (unchanged)
// ---------------------------------------------------------
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fetch timeout')), timeout);

    fetch(url, options)
      .then(async res => {
        clearTimeout(timer);
        const text = await res.text();
        try { resolve(JSON.parse(text)); }
        catch { resolve(text); }
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

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
  }
}

// ---------------------------------------------------------
// DEVICE CLASS
// ---------------------------------------------------------
module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    this.previousChargingState = null;
    this.previousTimeToEmpty = null;
    this.previousStateOfCharge = null;
    this._prevTimeToFull = this.getCapabilityValue('time_to_full') ?? 0;
    this._prevTimeToEmpty = this.getCapabilityValue('time_to_empty') ?? 0;



    this.token = await this.getStoreValue('token');

    const settings = { use_polling: false, ...this.getSettings() };
    this.log('Settings for Plugin Battery:', settings);

    if (!this.url && settings.url) {
      this.url = settings.url;
      this.log(`Restored URL from settings: ${this.url}`);
    }

    if (settings.polling_interval == null) {
      await this.setSettings({ polling_interval: 10 });
      settings.polling_interval = 10;
    }

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }

    // 🔥 CRUCIALE FIX: altijd oude WebSocket stoppen
    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    // -----------------------------------------------------
    // SELECT DATA SOURCE (identiek aan energy_v2)
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
        log: this.log.bind(this),
        error: this.error.bind(this),
        setAvailable: this.setAvailable.bind(this),
        getSetting: this.getSetting.bind(this),
        handleMeasurement: (data) => {
          this.lastWsMeasurementAt = Date.now();
          this._handleMeasurement(data);
        },
        handleSystem: this._handleSystem.bind(this),
      });

      this.wsManager.start();

      // Idle watchdog: fallback poll if WS is silent too long
      this._wsIdleWatchdog = setInterval(() => {
        const last = this.lastWsMeasurementAt || 0;
        const diff = Date.now() - last;

        // 10 minutes idle → fallback poll
        if (diff > 10 * 60 * 1000) {
          this.log(`🕒 WS idle for ${diff}ms → performing fallback poll`);
          this._fallbackPoll();
        }
      }, 60 * 1000);


      this._wsWatchdog = setInterval(() => {
        const staleMs = Date.now() - (this.wsManager?.lastMeasurementAt || 0);
        if (!this.getSettings().use_polling && staleMs > 190000) {
          this.log(`🕒 Driver watchdog: stale >3min (${staleMs}ms), restarting WS`);
          this.wsManager?.restartWebSocket();
        }
      }, 60000);

      // Battery group updater (every 10 sec, like energy_v2)
      this._batteryGroupInterval = setInterval(() => {
        this._updateBatteryGroup();
      }, 10000);


    }
  }

  onDeleted() {
  // Stop stale-WS watchdog
  if (this._wsWatchdog) {
    clearInterval(this._wsWatchdog);
    this._wsWatchdog = null;
  }

  // Stop idle-fallback watchdog
  if (this._wsIdleWatchdog) {
    clearInterval(this._wsIdleWatchdog);
    this._wsIdleWatchdog = null;
  }

  // Stop polling interval
  if (this.onPollInterval) {
    clearInterval(this.onPollInterval);
    this.onPollInterval = null;
  }

  // Stop WebSocket manager
  if (this.wsManager) {
    this.wsManager.stop();
    this.wsManager = null;
  }

  // Remove from pluginBatteryGroup
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
 * Updates stored URL and rebuilds WebSocket if needed.
 */
async onDiscoveryAvailable(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Discovery available — IP set to: ${discoveryResult.address}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  const settings = this.getSettings();

  // Debounce reconnects
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(async () => {

    // Polling mode → skip WS rebuild
    if (settings.use_polling) {
      this.log('🔁 Discovery: polling active → skipping WebSocket rebuild');
      return;
    }

    // Preflight reachability check
    try {
      const res = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent: new https.Agent({ rejectUnauthorized: false })
      }, 3000);

      if (!res || typeof res.cloud_enabled === 'undefined') {
        this.error(`❌ Discovery: device unreachable → skipping WebSocket`);
        return;
      }

      this.log('✅ Discovery: device reachable — rebuilding WebSocket');

      // FULL REBUILD (never restart)
      if (this.wsManager) {
        this.wsManager.stop();
        this.wsManager = null;
      }

      this.wsManager = new WebSocketManager({
        device: this,
        url: this.url,
        token: this.token,
        log: this.log.bind(this),
        error: this.error.bind(this),
        setAvailable: this.setAvailable.bind(this),
        getSetting: this.getSetting.bind(this),
        handleMeasurement: (data) => {
          this.lastWsMeasurementAt = Date.now();
          this._handleMeasurement(data);
        },
        handleSystem: this._handleSystem.bind(this),
      });

      this.wsManager.start();

    } catch (err) {
      this.error(`❌ Discovery: preflight failed — ${err.message}`);
    }

  }, 500);
}


/**
 * Handle discovery address changes.
 */
async onDiscoveryAddressChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Address changed — new URL: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {

    if (this.getSettings().use_polling) {
      this.log('🔁 Address change: polling active → skipping WebSocket rebuild');
      return;
    }

    this.log('🔁 Address change: rebuilding WebSocket');

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    this.wsManager = new WebSocketManager({
      device: this,
      url: this.url,
      token: this.token,
      log: this.log.bind(this),
      error: this.error.bind(this),
      setAvailable: this.setAvailable.bind(this),
      getSetting: this.getSetting.bind(this),
      handleMeasurement: (data) => {
          this.lastWsMeasurementAt = Date.now();
          this._handleMeasurement(data);
      },
      handleSystem: this._handleSystem.bind(this),
    });

    this.wsManager.start();

  }, 500);
}


/**
 * Handle "last seen" discovery update.
 */
async onDiscoveryLastSeenChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`📡 Device seen again — URL refreshed: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);
  await this.setAvailable();

  const settings = this.getSettings();

  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {

    if (settings.use_polling) {
      this.log('🔁 Last seen: polling active → skipping WebSocket rebuild');
      return;
    }

    this.log('🔁 Last seen: rebuilding WebSocket');

    if (this.wsManager) {
      this.wsManager.stop();
      this.wsManager = null;
    }

    this.wsManager = new WebSocketManager({
      device: this,
      url: this.url,
      token: this.token,
      log: this.log.bind(this),
      error: this.error.bind(this),
      setAvailable: this.setAvailable.bind(this),
      getSetting: this.getSetting.bind(this),
      handleMeasurement: (data) => {
          this.lastWsMeasurementAt = Date.now();
          this._handleMeasurement(data);
      },
      handleSystem: this._handleSystem.bind(this),
    });

    this.wsManager.start();

  }, 500);
}


async onPoll() {
  try {
    const measurement = await fetchWithTimeout(`${this.url}/api/measurement`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    if (measurement) {
      this._handleMeasurement(measurement);
    }

    const system = await fetchWithTimeout(`${this.url}/api/system`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    if (system) {
      this._handleSystem(system);
    }

  } catch (err) {
    this.error('Polling error:', err.message);
  }
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
  // 5. Charging state (realtime, maar alleen bij verandering)
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
// 6. Time to full / empty (smooth + CPU‑vriendelijk)
// ---------------------------------------------------------
if (typeof data.state_of_charge_pct === 'number' && typeof data.power_w === 'number') {

  const current_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);

    // LADEN
  if (data.power_w > 10) {
    const remaining = BATTERY_CAPACITY_WH - current_capacity;
    let ttf = Math.round((remaining / data.power_w) * 60);

    // Smooth: alleen bij verschil ≥ 5
    if (Math.abs(this._prevTimeToFull - ttf) >= 5) {
      await updateCapability(this, 'time_to_full', ttf);
      this._prevTimeToFull = ttf;
    }

    // Alleen 0 zetten als het verandert
    if (this._prevTimeToEmpty !== 0) {
      await updateCapability(this, 'time_to_empty', 0);
      this._prevTimeToEmpty = 0;
    }
  }

  // ONTLADEN
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

  // IDLE
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
  // 9. Store latest values for group updater (interval-based)
  // ---------------------------------------------------------

  this._lastPower = data.power_w;
  this._lastSoC = data.state_of_charge_pct;
  this._lastCycles = data.cycles;

}



  /**
   * Handle system events (wifi, cloud, etc.)
   */
  /**
 * Handle system events (wifi, cloud, etc.)
 * Optimized for low CPU load with value-change filtering + debouncing.
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
  // 2. Cloud status (optional future expansion)
  // ---------------------------------------------------------
  // if (typeof data.cloud_enabled === 'boolean') {
  //   // Only update if you add a capability for cloud status
  // }

  // ---------------------------------------------------------
  // 3. Firmware info (ignored unless you add capabilities)
  // ---------------------------------------------------------
  // if (data.firmware_version) { ... }
}



  /**
   * Ensure required capabilities exist.
   */
  async _updateCapabilities() {
    const caps = [
      'identify',
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
      'estimate_kwh'
    ];

    for (const cap of caps) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
        this.log(`created capability ${cap} for ${this.getName()}`);
      }
    }
  }


  async _fallbackPoll() {
  try {
    const measurement = await fetchWithTimeout(`${this.url}/api/measurement`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    if (measurement) {
      this._handleMeasurement(measurement);
    }

    const system = await fetchWithTimeout(`${this.url}/api/system`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Api-Version': '2'
      },
      agent: new https.Agent({ rejectUnauthorized: false })
    });

    if (system) {
      this._handleSystem(system);
    }

    this.log('📡 Fallback poll completed');

  } catch (err) {
    this.error('Fallback poll error:', err.message);
  }
}

/**
 * Update battery group every 10 seconds (energy_v2 style)
 */
_updateBatteryGroup() {
  const batteryId = this.getData()?.id;
  if (!batteryId) return;

  const info = {
    id: batteryId,
    capacity_kwh: 2.8,
    cycles: this._lastCycles,
    power_w: this._lastPower,
    soc_pct: this._lastSoC,
    updated_at: Date.now()
  };

  let group = this.homey.settings.get('pluginBatteryGroup') || {};
  const prev = JSON.stringify(group[batteryId]);
  const next = JSON.stringify(info);

  // Only write if changed
  if (prev !== next) {
    group[batteryId] = info;
    this.homey.settings.set('pluginBatteryGroup', group);
  }
}


  /**
   * Register capability listeners.
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async () => {
      await api.identify(this.url, this.token);
    });
  }


  /**
   * Settings handler — fully patched for WS/polling switching.
   */
  async onSettings({ oldSettings = {}, newSettings = {}, changedKeys = [] } = {}) {
    this.log('Plugin Battery Settings updated', newSettings, changedKeys);

    const oldUsePolling = oldSettings.use_polling;
    const newUsePolling = newSettings.use_polling;

    const oldInterval = oldSettings.polling_interval;
    const newInterval = newSettings.polling_interval;

    // ---------------------------------------------------------
    // 🔀 1. use_polling toggled → switch between WS and polling
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
          log: this.log.bind(this),
          error: this.error.bind(this),
          setAvailable: this.setAvailable.bind(this),
          getSetting: this.getSetting.bind(this),
          handleMeasurement: (data) => {
          this.lastWsMeasurementAt = Date.now();
          this._handleMeasurement(data);
        },
          handleSystem: this._handleSystem.bind(this),
        });

        this.log('🔌 Starting WebSocket (polling disabled)');
        this.wsManager.start();
      }
    }

    // ---------------------------------------------------------
    // ⏱️ 2. Polling interval changed → restart polling if active
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
