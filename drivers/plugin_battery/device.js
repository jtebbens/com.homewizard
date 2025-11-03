'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');
const WebSocketManager = require('../../includes/v2/Ws')
//const fetch = require('node-fetch');


process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});



const WebSocket = require('ws');
const https = require('https');

// Create an agent that skips TLS verification
const agent = new https.Agent({
  rejectUnauthorized: false
});


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

// Estimate battery kWh capacity left based on load percentage, number of cycles and inverter efficiency
// Nominal capacity is 2.768kWh, at 6000 cycles it is 80% capacity left
// Linear degradation assumed
// loadPct is the current state of charge in percent (0-100)
// cycles is the number of charge/discharge cycles the battery has gone through

function estimateBatteryKWh(loadPct, cycles, inverterEfficiency) {
  const nominalCapacity = 2.8; // kWh
  const referenceCycles = 6000;
  const referenceDegradation = 0.8; // 80% capacity at 6000 cycles

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

// Experimental SoC drift detection
function checkSoCDrift({
  previousSoC,
  previousTimestamp,
  currentSoC,
  currentPowerW,
  batteryCapacityWh = 2470,
  driftMargin = 5
}) {
  if (previousSoC === undefined || previousTimestamp === undefined) return { drift: false };

  const now = Date.now();
  // Number of minutes between readings 60000ms is 60s
  const deltaTimeMin = (now - previousTimestamp) / 60000;
  // Calculate rate of SoC drop in % per minute
  const deltaSoC = currentSoC - previousSoC;
  const rateOfChange = deltaSoC / deltaTimeMin;

  // Calculate expected usage
  const expectedWhChange = currentPowerW * deltaTimeMin;
  const expectedSoCChange = (expectedWhChange / batteryCapacityWh) * 100;

  // Compare Actual vs Expected if that is higher than margin of 5% (needs tweaking)
  if (Math.abs(rateOfChange - expectedSoCChange) > driftMargin) {
    return {
      drift: true,
      rateOfChange,
      expectedSoCChange,
      timestamp: now
    };
  }

  // Else we are fine, no drift
  return { drift: false, timestamp: now };

}

function getWifiQuality(strength) {
  if (strength >= -30) return 'Excellent';  // Strongest signal
  if (strength >= -60) return 'Strong';     // Strong
  if (strength >= -70) return 'Moderate';  // Good to Fair
  if (strength >= -80) return 'Weak';     // Fair to Weak
  if (strength >= -90) return 'Poor'; // Weak to Unusable
  return 'Unusable';                      // Very poor signal
}

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
    //device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}


module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    this.previousChargingState = null;
    this.previousTimeToEmpty = null;
    this.previousStateOfCharge = null;

    this.token = await this.getStoreValue('token');
    console.log('PIB Token:', this.token);

    let settings = this.getSettings();
    this.log('Settings for Plugin Battery: ', settings.polling_interval);


    if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
      await this.setSettings({ polling_interval: 10 });
      settings.polling_interval = 10; // update local variable
    }

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    
    //this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    //this.startWebSocket(); // WebSocket first

    this.wsManager = new WebSocketManager({
      url: this.url,
      token: this.token,
      log: this.log.bind(this),
      error: this.error.bind(this),
      setAvailable: this.setAvailable.bind(this),
      getSetting: this.getSetting.bind(this),
      handleMeasurement: this._handleMeasurement.bind(this),
      handleSystem: this._handleSystem.bind(this),
      //handleBatteries: this._handleBatteries.bind(this)
    });
    this.wsManager.start();


  }

onDeleted() {
  if (this.onPollInterval) {
    clearInterval(this.onPollInterval);
    this.onPollInterval = null;
  }

  if (this.wsManager) {
    this.wsManager.stop(); // Cleanly shuts down the WebSocket
  }

  const batteryId = this.getData().id;
  const group = this.homey.settings.get('pluginBatteryGroup') || {};

  if (group[batteryId]) {
    delete group[batteryId];
    this.homey.settings.set('pluginBatteryGroup', group);
    this.log(`Battery ${batteryId} removed from pluginBatteryGroup`);
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


async _handleMeasurement(data) {


    this.lastMeasurementAt = Date.now();

    //const settings = this.getSettings();

    let time_to_empty = null;
    let time_to_full  = null;
    const BATTERY_CAPACITY_WH = 2470;
    // Power
    await updateCapability(this, 'meter_power.import', data.energy_import_kwh ?? null).catch(this.error);
    await updateCapability(this, 'meter_power.export', data.energy_export_kwh ?? null).catch(this.error);
    await updateCapability(this, 'measure_power', data.power_w ?? null).catch(this.error);
    await updateCapability(this, 'measure_voltage', data.voltage_v ?? null).catch(this.error);
    await updateCapability(this, 'measure_current', data.current_a ?? null).catch(this.error);
    await updateCapability(this, 'measure_battery', data.state_of_charge_pct ?? null).catch(this.error);
    await updateCapability(this, 'measure_voltage', data.voltage_v ?? null).catch(this.error);
    await updateCapability(this, 'measure_frequency', data.frequency_hz ?? null).catch(this.error);
    await updateCapability(this, 'cycles', data.cycles ?? null).catch(this.error);


    // Get the Group mode of the batteries
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

    //this.log('🔄 Updating pluginBatteryGroup:', batteryInfo);

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

          // Assumption battery has 2470Wh capacity, bruto 2688Wh, 8% reserved
      // Calculate when battery is full or empty pending on the load it has power_w
      // With load of 800W, 2470Wh / 800 = 3,08 * 60min = 185min till battery empty.
      // time_to_full time_to_empty
      // 2470Wh * (data.state_of_charge_pct / 100) = current Wh

      // Battery is charging
      if (data.power_w > 10) {
        let current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_full = (BATTERY_CAPACITY_WH - current_battery_capacity) / data.power_w * 60;
        await this.setCapabilityValue('time_to_full', Math.round(time_to_full) ).catch(this.error);
        // Set time_to_empty to 0 as we are charging
        await this.setCapabilityValue('time_to_empty', 0).catch(this.error);
      }

      // Battery is discharging
      if (data.power_w < -10) {
        let current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_empty = (current_battery_capacity / Math.abs(data.power_w)) * 60;
        await this.setCapabilityValue('time_to_empty', Math.round(time_to_empty)).catch(this.error);
        
        // Set time_to_full to 0 as we are discharging
        await this.setCapabilityValue('time_to_full', 0).catch(this.error);
      }

      // Triggers
      // Battery charging state change
      if (chargingState !== this.previousChargingState) {
        this.previousChargingState = chargingState;
        this.homey.flow
          .getDeviceTriggerCard('battery_state_changed')
          .trigger(this, { state: chargingState })
          .catch(this.error);
      }

      // Battery time-to-empty below threshold (e.g. 30 min)
      if (typeof time_to_empty === 'number' && time_to_empty < 30 && this.previousTimeToEmpty >= 30) {
        this.previousTimeToEmpty = time_to_empty;
        this.homey.flow
          .getDeviceTriggerCard('battery_low_runtime')
          .trigger(this, { minutes: Math.round(time_to_empty) })
          .catch(this.error);
      } else {
        this.previousTimeToEmpty = time_to_empty;
      }


      // Battery fully charged
      if (data.state_of_charge_pct === 100 && this.previousStateOfCharge < 100) {
        this.previousStateOfCharge = data.state_of_charge_pct;
        this.homey.flow
          .getDeviceTriggerCard('battery_full')
          .trigger(this)
          .catch(this.error);
      } else {
        this.previousStateOfCharge = data.state_of_charge_pct;
      }

      // Net frequency out of range net_frequency_out_of_range

       if (data.frequency_hz > 50.2 || data.frequency_hz < 49.8) {
        this.homey.flow
          .getDeviceTriggerCard('net_frequency_out_of_range')
          .trigger(this)
          .catch(this.error);
      } 


      // Calculate inverter efficiency based on total energy in and out
      // This is a rough estimate as energy losses are not only in the inverter
      // but also in the battery and other components.
      // RTE (Round Trip Efficiency) = input energy / output energy 
      const inverterEfficiency = data.energy_import_kwh > 0
        ? data.energy_export_kwh / data.energy_import_kwh
        : 0.75; // fallback default

      // Estimate kWh left in battery based on state_of_charge_pct, cycles and inverter efficiency
      // Example: 2.768kWh nominal capacity, at 6000 cycles it is 80% capacity left
      // Linear degradation assumed
      const estimate_kwh = estimateBatteryKWh(data.state_of_charge_pct, data.cycles, inverterEfficiency);
      await this.setCapabilityValue('estimate_kwh', Math.round(estimate_kwh * 100) / 100).catch(this.error);


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

      // Trigger only when drift starts
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

      // Reset drift state when drift ends
      if (!driftResult.drift && this.driftActive) {
        this.driftActive = false;
        this.log(`✅ SoC drift resolved.`);
      }
    
  }

  _handleSystem(data) {
  //this.log('⚙️ System data received:', data);

  // Example: cloud_enabled status
  if (typeof data.cloud_enabled !== 'undefined') {
    if (this.hasCapability('cloud_enabled')) {
      this.setCapabilityValue('cloud_enabled', !!data.cloud_enabled);
    }
  }

  // Example: status LED brightness (if you expose this as a capability)
  if (typeof data.wifi_rssi_db === 'number') {
    if (this.hasCapability('rssi')) {
      this.setCapabilityValue('rssi', data.wifi_rssi_db);
    }

  }

  const wifiQuality = getWifiQuality(data.wifi_rssi_db);
  updateCapability(this, 'wifi_quality', wifiQuality).catch(this.error);

  if (typeof data.status_led_brightness_pct === 'number') {
    if (this.hasCapability('led_brightness')) {
      this.setCapabilityValue('led_brightness', data.status_led_brightness_pct);
    }

  }

  // Add more mappings here as needed
}


  async _updateCapabilities() {

    if (!this.hasCapability('identify')) {
      await this.addCapability('identify').catch(this.error);
      console.log(`created capability identify for ${this.getName()}`);
    }

    if (!this.hasCapability('meter_power.import')) {
      await this.addCapability('meter_power.import').catch(this.error);
      console.log(`created capability meter_power.import for ${this.getName()}`);
    }

    if (!this.hasCapability('meter_power.export')) {
      await this.addCapability('meter_power.export').catch(this.error);
      console.log(`created capability meter_power.export for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power').catch(this.error);
      console.log(`created capability measure_power for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_voltage')) {
      await this.addCapability('measure_voltage').catch(this.error);
      console.log(`created capability measure_voltage for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_current')) {
      await this.addCapability('measure_current').catch(this.error);
      console.log(`created capability measure_current for ${this.getName()}`);
    }

    if (!this.hasCapability('measure_battery')) {
      await this.addCapability('measure_battery').catch(this.error);
      console.log(`created capability measure_battery for ${this.getName()}`);
    }

    if (!this.hasCapability('battery_charging_state')) {
      await this.addCapability('battery_charging_state').catch(this.error);
      console.log(`created capability battery_charging_state for ${this.getName()}`);
    }

    if (!this.hasCapability('cycles')) {
      await this.addCapability('cycles').catch(this.error);
      console.log(`created capability cycles for ${this.getName()}`);
    }

    if (!this.hasCapability('time_to_empty')) {
      await this.addCapability('time_to_empty').catch(this.error);
      console.log(`created capability time_to_empty for ${this.getName()}`);
    }

    if (!this.hasCapability('time_to_full')) {
      await this.addCapability('time_to_full').catch(this.error);
      console.log(`created capability time_to_full for ${this.getName()}`);
    }

    if (!this.hasCapability('rssi')) {
    await this.addCapability('rssi').catch(this.error);
    console.log(`created capability rssi for ${this.getName()}`);
    }

    if (!this.hasCapability('estimate_kwh')) {
        await this.addCapability('estimate_kwh').catch(this.error);
      console.log(`created capability estimate_kwh for ${this.getName()}`);
   }

    
  }

  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  async onPoll() {
    
    

    // URL may be undefined if the device is not available
    const settings = this.getSettings();

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      }
      else return;
    }

    let time_to_empty = null;
    let time_to_full  = null;
    const BATTERY_CAPACITY_WH = 2470;

    // Check if polling interval is running
      if (!this.onPollInterval) {
        this.log('Polling interval is not running, starting now...');
        // Clear any possible leftover interval just in case
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      }
          
      Promise.resolve().then(async () => {

      const data = await api.getMeasurement(this.url, this.token);
      const systemInfo = await api.getSystem(this.url, this.token);

      // Get the Group mode of the batteries
      const batteryId = this.getData().id;
      const batteryInfo = {
        id: batteryId,
        capacity_kwh: 2.8,
        cycles: data.cycles,
        power_w: data.power_w,
        soc_pct: data.state_of_charge_pct
      };

      let group = this.homey.settings.get('pluginBatteryGroup') || {};
      group[batteryId] = batteryInfo;
      this.homey.settings.set('pluginBatteryGroup', group);

      // energy_import_kwh
      await this.setCapabilityValue('meter_power.import', data.energy_import_kwh).catch(this.error);

      // energy_export_kwh
      await this.setCapabilityValue('meter_power.export', data.energy_export_kwh).catch(this.error);

      // power_w
      await this.setCapabilityValue('measure_power', data.power_w).catch(this.error);

      // voltage_l1_v
      await this.setCapabilityValue('measure_voltage', data.voltage_v).catch(this.error);

      // current_a  Amp's
      await this.setCapabilityValue('measure_current', data.current_a).catch(this.error);

      // measure_battery in percent
      await this.setCapabilityValue('measure_battery', data.state_of_charge_pct).catch(this.error);

      // Wifi RSSI
      await this.setCapabilityValue('rssi', systemInfo.wifi_rssi_db).catch(this.error);

      

      // battery_charging_state
      let chargingState;
      if (data.power_w > 10) {
        chargingState = 'charging';
      } else if (data.power_w < 0) {
        chargingState = 'discharging';
      } else {
        chargingState = 'idle';
      }
      await this.setCapabilityValue('battery_charging_state', chargingState).catch(this.error);


      // battery Cycles - custom metric needs to be added{
      await this.setCapabilityValue('cycles', data.cycles).catch(this.error);

      // Assumption battery has 2470Wh capacity, bruto 2688Wh, 8% reserved
      // Calculate when battery is full or empty pending on the load it has power_w
      // With load of 800W, 2470Wh / 800 = 3,08 * 60min = 185min till battery empty.
      // time_to_full time_to_empty
      // 2470Wh * (data.state_of_charge_pct / 100) = current Wh

      // Battery is charging
      if (data.power_w > 10) {
        let current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_full = (BATTERY_CAPACITY_WH - current_battery_capacity) / data.power_w * 60;
        await this.setCapabilityValue('time_to_full', Math.round(time_to_full) ).catch(this.error);
        // Set time_to_empty to 0 as we are charging
        await this.setCapabilityValue('time_to_empty', 0).catch(this.error);
      }

      // Battery is discharging
      if (data.power_w < -10) {
        let current_battery_capacity = BATTERY_CAPACITY_WH * (data.state_of_charge_pct / 100);
        time_to_empty = (current_battery_capacity / Math.abs(data.power_w)) * 60;
        await this.setCapabilityValue('time_to_empty', Math.round(time_to_empty)).catch(this.error);
        
        // Set time_to_full to 0 as we are discharging
        await this.setCapabilityValue('time_to_full', 0).catch(this.error);
      }

      // Triggers
      // Battery charging state change
      if (chargingState !== this.previousChargingState) {
        this.previousChargingState = chargingState;
        this.homey.flow
          .getDeviceTriggerCard('battery_state_changed')
          .trigger(this, { state: chargingState })
          .catch(this.error);
      }

      // Battery time-to-empty below threshold (e.g. 30 min)
      if (typeof time_to_empty === 'number' && time_to_empty < 30 && this.previousTimeToEmpty >= 30) {
        this.previousTimeToEmpty = time_to_empty;
        this.homey.flow
          .getDeviceTriggerCard('battery_low_runtime')
          .trigger(this, { minutes: Math.round(time_to_empty) })
          .catch(this.error);
      } else {
        this.previousTimeToEmpty = time_to_empty;
      }


      // Battery fully charged
      if (data.state_of_charge_pct === 100 && this.previousStateOfCharge < 100) {
        this.previousStateOfCharge = data.state_of_charge_pct;
        this.homey.flow
          .getDeviceTriggerCard('battery_full')
          .trigger(this)
          .catch(this.error);
      } else {
        this.previousStateOfCharge = data.state_of_charge_pct;
      }

      if (this.url != settings.url) {
            this.log("Plugin Battery - Updating settings url");
            await this.setSettings({
                  // Update url settings
                  url: this.url
                });
      }

      // Calculate inverter efficiency based on total energy in and out
      // This is a rough estimate as energy losses are not only in the inverter
      // but also in the battery and other components.
      // RTE (Round Trip Efficiency) = input energy / output energy 
      const inverterEfficiency = data.energy_import_kwh > 0
        ? data.energy_export_kwh / data.energy_import_kwh
        : 0.75; // fallback default

      // Estimate kWh left in battery based on state_of_charge_pct, cycles and inverter efficiency
      // Example: 2.768kWh nominal capacity, at 6000 cycles it is 80% capacity left
      // Linear degradation assumed
      const estimate_kwh = estimateBatteryKWh(data.state_of_charge_pct, data.cycles, inverterEfficiency);
      await this.setCapabilityValue('estimate_kwh', Math.round(estimate_kwh * 100) / 100).catch(this.error);


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

      // Trigger only when drift starts
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

      // Reset drift state when drift ends
      if (!driftResult.drift && this.driftActive) {
        this.driftActive = false;
        this.log(`✅ SoC drift resolved.`);
      }



      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }


  onSettings(MySettings) {
    this.log('Plugin Battery Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for Plugin Battery changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      
      //this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    // return true;
  }


};
