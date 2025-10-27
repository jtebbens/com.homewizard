'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const WebSocket = require('ws');
const https = require('https');

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
  if (value == null) {
    // No value, keep capability for now
    return;
  }

  // Add missing capability
  if (!device.hasCapability(capability)) {
    device.log(`➕ Capability "${capability}" missing — adding`);
    await device.addCapability(capability).catch(device.error);
  }

  // Update value if it has changed
  const current = device.getCapabilityValue(capability);
  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
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

async function applyMeasurementCapabilities(device,m) {
  try {
    const mappings = {
      // Generic
      'measure_power': m.power_w,
      'measure_voltage': m.voltage_v,
      'measure_current': m.current_a,
      'meter_power.consumed': m.energy_import_kwh,
      'meter_power.returned': m.energy_export_kwh,
      'tariff': m.tariff,
  
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
      'measure_power.montly_power_peak': m.monthly_power_peak_w,
  
    };
  
    for (const [capability, value] of Object.entries(mappings)) {
      await updateCapability(device, capability, value ?? null);
    }
  } catch (error) {
    device.error('Failed to apply measurement capabilities:', error);
    throw error;
  }
}

module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

  async onInit() {

    this.ws = null;
    this.wsActive = false;
    this.reconnecting = false; 
    this.pollingInterval = null;

    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;

    if (!this.hasCapability('connection_error')) {
        await this.addCapability('connection_error').catch(this.error);
    }
    await this.setCapabilityValue('connection_error', 'No errors');


    this.token = await this.getStoreValue('token');
    console.log('P1 Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = this.getSettings();
    this.log('Settings for P1 apiv2: ',settings.polling_interval);

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

    

    //Condition Card
    const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode')
    ConditionCardCheckBatteryMode.registerRunListener(async (args, state) => {
      //this.log('CheckBatteryModeCard');
        
      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.getMode(this.url, this.token); // NEEDS TESTING WITH P1 and BATTERY
  
          if (!response || typeof response.mode === 'undefined') {
            console.log('Invalid response, returning false');
            return resolve(false);
          }
  
          //console.log('Retrieved mode:', response.mode);
          return resolve(args.mode == response.mode); // Returns the mode value
          
        } catch (error) {
          console.log('Error retrieving mode:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });

    this.homey.flow.getActionCard('set-battery-to-zero-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Zero Mode');
      //this.log('This url:', this.url);
      //this.log('This token:', this.token);
       return new Promise(async (resolve, reject) => {
        try {
          const response = await api.setMode(this.url, this.token, 'zero'); 

          if (!response || typeof response.mode === 'undefined') {
            console.log('Invalid response, returning false');
            return resolve(false);
          }

          console.log('Set mode to zero:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          console.log('Error set mode to zero:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    })

    this.homey.flow.getActionCard('set-battery-to-full-charge-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Full Charge Mode');
      //this.log('This url:', this.url);
      //this.log('This token:', this.token);
      return new Promise(async (resolve, reject) => {
      try {
          const response = await api.setMode(this.url, this.token, 'to_full');

          if (!response || typeof response.mode === 'undefined') {
            console.log('Invalid response, returning false');
            return resolve(false);
          }

          console.log('Set mode to full charge:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          console.log('Error set mode to full charge:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
        });
    })

    this.homey.flow.getActionCard('set-battery-to-standby-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Standby Mode');
      //this.log('This url:', this.url);
      //this.log('This token:', this.token);
      return new Promise(async (resolve, reject) => {
      try {
          const response = await api.setMode(this.url, this.token, 'standby');

          if (!response || typeof response.mode === 'undefined') {
            this.log('set-battery-to-standby-mode : Invalid response, returning false');
            return resolve(false);
          }

          this.log('Set mode to standby:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          this.error('Error set mode to standby:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
        });
    })

    //this.flowTriggerBatteryMode
    
    this._flowTriggerBatteryMode = this.homey.flow.getDeviceTriggerCard('battery_mode_changed');
    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed_v2');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed_v2');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed_v2');


  
    this._triggerFlowPrevious = {};

    //this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
    
    if (settings.use_polling) {
      this.log('⚙️ Polling enabled via settings');
      this.startPolling();
    } else {
      this.startWebSocket();
    }

    
    
  }

  flowTriggerBatteryMode(device, tokens) {
    this._flowTriggerBatteryMode.trigger(device, tokens).catch(this.error);
  }


  flowTriggerTariff(device, value) {
  //this.log(`⚡ Triggering tariff change with value:`, value);
  this._flowTriggerTariff.trigger(device, { tariff: value }).catch(this.error);
  }

  flowTriggerImport(device, value) {
    //this.log(`📥 Triggering import change with value:`, value);
    this._flowTriggerImport.trigger(device, { import: value }).catch(this.error);
  }

  flowTriggerExport(device, value) {
    //this.log(`📤 Triggering export change with value:`, value);
    this._flowTriggerExport.trigger(device, { export: value }).catch(this.error);
  }




  async _handleExternalMeters(external) {
  const setCapabilityPromises = [];

  const latest = (type) =>
    external
      ?.filter(e => e.type === type && typeof e.value === 'number')
      .sort((a, b) => b.timestamp - a.timestamp)[0];

  const gas = latest('gas_meter');
  //this.log('📟 Gas meter data:', gas);

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

  return {gas, water}
}





async _handleMeasurement(m) {
  this.lastMeasurementAt = Date.now();

  //this.log('📊 Measurement data received:', m);
  //this.log(`📊 Raw import value:`, m.energy_import_kwh);

  // Power & voltage
  if (typeof m.power_w === 'number') {
  await updateCapability(this, 'measure_power', m.power_w);
  }
  //await updateCapability(this, 'measure_power', m.power_w ?? null);

  await applyMeasurementCapabilities(this, m);


  // await updateCapability(this, 'measure_voltage', m.voltage_v ?? null);
  // await updateCapability(this, 'measure_current', m.current_a ?? null);
  //await updateCapability(this, 'meter_power.consumed', m.energy_import_kwh ?? null);
  //await updateCapability(this, 'meter_power.returned', m.energy_export_kwh ?? null);
  //await updateCapability(this, 'tariff', m.tariff ?? null);



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
  if (m.energy_import_kwh !== undefined) {
    const net = m.energy_import_kwh - m.energy_export_kwh;
    if (this.getCapabilityValue('meter_power') !== net) {
      this.setCapabilityValue('meter_power', net);
    }
  }

  // External meters
  //this.log('🔍 External meter payload:', m.external);
let gas = null;
let water = null;

const previousExternal = await this.getStoreValue('external_last_payload');

if (JSON.stringify(previousExternal) === JSON.stringify(m.external)) {
  //this.log('⏸️ External meter payload unchanged — skipping capability updates');

  const lastResult = await this.getStoreValue('external_last_result');
  gas = lastResult?.gas ?? null;
  water = lastResult?.water ?? null;
} else {
  //this.log('🔄 External meter payload changed — updating capabilities');

  const result = await this._handleExternalMeters(m.external);
  gas = result.gas;
  water = result.water;

  await this.setStoreValue('external_last_payload', m.external).catch(this.error);
  await this.setStoreValue('external_last_result', result).catch(this.error);
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
  if (nowLocal.getMinutes() % 5 === 0) {
    if (!gas || typeof gas.value !== 'number') {
      //this.log('⚠️ Skipping gas update — reading not available or invalid');
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
          this.log(`📈 Gas delta: ${delta} m³`);
          await updateCapability(this, 'measure_gas', delta).catch(this.error);
        }
      } else {
        this.log('🆕 No previous gas reading — storing current value');
      }

      await this.setStoreValue('gasmeter_previous_reading', gas.value).catch(this.error);
      await this.setStoreValue('gasmeter_previous_reading_timestamp', gas.timestamp).catch(this.error);
    } else {
      //this.log(`⏸️ Skipping gas delta — timestamp unchanged (${gas.timestamp})`);
    }
  }

  // Daily usage
  const meterStart = await this.getStoreValue('meter_start_day');
  if (meterStart != null) {
    const dailyImport = m.energy_import_kwh - meterStart;
    await this.setCapabilityValue('meter_power.daily', dailyImport).catch(this.error);
  }

  const gasStart = await this.getStoreValue('gasmeter_start_day');
  const gasDiff = (gas?.value != null && gasStart != null) ? gas.value - gasStart : null;
  await updateCapability(this, 'meter_gas.daily', gasDiff).catch(this.error);

  // 🔋 Battery Group
  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  const now = Date.now();
  const batteries = Object.values(group).filter(b => now - b.updated_at < 60000);

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


async _handleBatteries(data) {
  //if (typeof data.mode === 'undefined') return;
  
  //this.log('🔋 Battery payload:', JSON.stringify(data));

  // Capability updates

  await updateCapability(this, 'measure_power.battery_group_power_w', data.power_w ?? null);

  //this.log('Target Power W: ', data.target_power_w);
  await updateCapability(this, 'measure_power.battery_group_target_power_w', data.target_power_w ?? null);
  await updateCapability(this, 'measure_power.battery_group_max_consumption_w', data.max_consumption_w ?? null);
  await updateCapability(this, 'measure_power.battery_group_max_production_w', data.max_production_w ?? null);

  const settings = this.getSettings();

  // Update settings if mode changed
  if (settings.mode !== data.mode) {
    this.log('Battery mode changed to:', data.mode);
    try {
      await this.setSettings({ mode: data.mode });
    } catch (err) {
      this.error('❌ Failed to update setting "mode":', err);
    }
  }

  // Trigger flow if mode changed
  if (this._triggerFlowPrevious.mode !== data.mode) {
    this._triggerFlowPrevious.mode = data.mode;
    this._flowTriggerBatteryMode.trigger(this, { mode: data.mode }).catch(this.error);
  }

  //trigger battery_mode_change
  
  const lastBatteryMode = await this.getStoreValue('last_battery_mode');
  if (data.mode !== lastBatteryMode) {
    this.flowTriggerBatteryMode(this, { battery_mode_changed: data.mode });
    await this.setStoreValue('last_battery_mode', data.mode).catch(this.error);
  }

  const group = this.homey.settings.get('pluginBatteryGroup') || {};
  const batteries = Object.values(group);

  const isGridReturn = data.power_w < -400;
  const batteriesPresent = batteries.length > 0;
  const shouldBeCharging = data.target_power_w > 0;
  const isNotStandby = data.mode !== 'standby';

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
          power: data.power_w,
          target: data.target_power_w,
          mode: data.mode,
          batteryCount: batteries.length
        })
        .catch(this.error);
    }
  } else {
    this.gridReturnStart = null;
    this.batteryErrorTriggered = false;
  }

}

_startHeartbeatMonitor() {
  if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  this.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - this.lastMeasurementAt > 60000) {
      this.log('💤 No measurement in 60s — reconnecting WebSocket');
      this._reconnectWebSocket();
    }
  }, 30000);
}

_reconnectWebSocket() {
  if (this.ws) {
    this.ws.removeAllListeners();

    const state = this.ws.readyState;
    this.log(`🔄 Reconnecting WebSocket — current state: ${state}`);

    try {
      if (state === WebSocket.CONNECTING && this.ws.readyState === WebSocket.CONNECTING) {
        this.log(`🕓 WebSocket still connecting — skipping close()`);
        // Optionally wait or retry later
      } else if (state === WebSocket.OPEN || state === WebSocket.CLOSING) {
        this.log(`❌ Terminating WebSocket`);
        this.ws.terminate();
      }

    } catch (err) {
      this.error(`⚠️ Error during WebSocket cleanup:`, err);
    }

    this.ws = null;
  }

  this.wsActive = false;

  // Optional: add delay to avoid hammering
  setTimeout(() => {
    this.startWebSocket();
  }, 2000);
}




  startWebSocket() {
    if (this.ws) {
      try {
        switch (this.ws.readyState) {
          case this.ws.OPEN:
            this.ws.terminate();
            break;
          case this.ws.CONNECTING:
            this.log('⚠️ WebSocket still connecting — skipping termination');
            return;
          case this.ws.CLOSING:
          case this.ws.CLOSED:
            this.ws.close(); // safe fallback
            break;
        }
      } catch (err) {
        this.error('❌ Failed to clean up WebSocket:', err);
      }

      this.ws = null;
      this.wsActive = false;
    }



    //if (this.wsActive) return;

    const settingsUrl = this.getSetting('url');
    if (!this.url && settingsUrl) {
      this.url = settingsUrl;
    }


    if (!this.token || !this.url) {
      this.error('❌ Missing token or URL — cannot start WebSocket');
      return;
    }

    const agent = new (require('https')).Agent({ rejectUnauthorized: false });
    //const wsUrl = this.url.replace('https://', 'wss://') + '/api/ws';
    const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';
    this.ws = new (require('ws'))(wsUrl, { agent });

    this.ws.on('open', () => {
      this.wsActive = true;
      this.lastMeasurementAt = Date.now();
      this._startHeartbeatMonitor();
      this.log('🔌 WebSocket opened — waiting to authorize...');

      const maxRetries = 30;
      let retries = 0;
      let retryTimer;

      const tryAuthorize = () => {
        if (!this.ws) return;

        if (this.ws.readyState === this.ws.OPEN) {
          this.log('🔐 Sending WebSocket authorization');
          this.ws.send(JSON.stringify({ type: 'authorization', data: this.token }));
          clearTimeout(retryTimer);
        } else if (retries < maxRetries) {
          retries++;
          retryTimer = setTimeout(tryAuthorize, 100);
        } else {
          this.error('❌ WebSocket failed to open after timeout — falling back to polling');
          this.ws.terminate();
          this.wsActive = false;
          this.startPolling();
        }
      };

      tryAuthorize();
    });


    this.ws.on('message', (msg) => {

      //const data = JSON.parse(msg.toString());
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (err) {
        this.error('❌ Failed to parse WebSocket message:', err);
        return;
      }

      if (data.type === 'authorization_requested') {
        //this.log('🔐 Press the button on your HomeWizard device to authorize WebSocket access');
      } else if (data.type === 'authorized') {
        //this.log('✅ Authorized — subscribing to system, measurement, and batteries');
        ['system', 'measurement', 'batteries'].forEach(topic => {
          this.ws.send(JSON.stringify({ type: 'subscribe', data: topic }));
        });
        this.wsActive = true;
      } else if (data.type === 'measurement') {
         //this.log('📊 Measurement data received:', data.data);
        this._handleMeasurement(data.data);
      } else if (data.type === 'system') {
      //  this.log('⚙️ System update:', data.data);
        this._handleSystem(data.data);
      } else if (data.type === 'batteries') {
        //this.log('🔋 Battery update:', data.data);
        this._handleBatteries(data.data);
      } else {
        //this.log('ℹ️ Other message:', data);
      }
    });

    this.ws.on('error', (err) => {
      if (this.reconnecting) return;
      this.reconnecting = true;

      this.error('❌ WebSocket error:', err);
      this.wsActive = false;

      setTimeout(() => {
        this.reconnecting = false;
        this._reconnectWebSocket();
      }, 5000);
    });

    this.ws.on('close', () => {
      if (this.reconnecting) return;
      this.reconnecting = true;

      this.log('🔌 WebSocket closed — retrying in 5s');
      this.wsActive = false;

      setTimeout(() => {
        this.reconnecting = false;
        this._reconnectWebSocket();
      }, 5000);
    });
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

      if (this.ws) {
        this.ws.close();
        this.ws = null;
        this.wsActive = false;
      }
    }


    _resetWebSocket() {
  if (this.ws) {
    try {
      if (this.ws.readyState === this.ws.CONNECTING || this.ws.readyState === this.ws.OPEN) {
        this.ws.terminate();
      } else {
        this.ws.close();
      }
    } catch (err) {
      this.error('❌ Failed to reset WebSocket:', err);
    }
    this.ws = null;
    this.wsActive = false;
  }
}


async onDiscoveryAvailable(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Discovery available — URL set to: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  // Optional: debounce reconnects to avoid hammering
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!this.getSettings().use_polling) {
      this.startWebSocket();
    } else {
      this.log('🔁 Discovery: polling is active, skipping WebSocket reconnect');
    }
  }, 500);

}

  async onDiscoveryAddressChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`🌐 Address changed — new URL: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);

  // Optional: debounce reconnects
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!this.getSettings().use_polling) {
      this._resetWebSocket();
      this.startWebSocket();
    } else {
      this.log('🔁 Address change: polling is active, skipping WebSocket reconnect');
    }
  }, 500);

}

 async onDiscoveryLastSeenChanged(discoveryResult) {
  this.url = `https://${discoveryResult.address}`;
  this.log(`📡 Device seen again — URL refreshed: ${this.url}`);
  await this.setSettings({ url: this.url }).catch(this.error);
  this.setAvailable();

  // Debounce reconnect to avoid race conditions
  if (this._wsReconnectTimeout) clearTimeout(this._wsReconnectTimeout);
  this._wsReconnectTimeout = setTimeout(() => {
    if (!this.getSettings().use_polling) {
      this._resetWebSocket();
      this.startWebSocket();
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
    if (value === undefined || typeof value !== 'number' || isNaN(value)) {
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

      // Reuse websocket based battery capabilities code
      if (batteries) {
        await this._handleBatteries(batteries);
      }

    } catch (err) {
      this.error('Polling error:', err.message || err);
    }
  }

  async onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if ('polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for P1 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      //this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    if ('mode' in MySettings.oldSettings &&
      MySettings.oldSettings.mode !== MySettings.newSettings.mode
    ) {
      this.log('Mode for Plugin Battery via P1 advanced settings changed to:', MySettings.newSettings.mode);
      try {
        await api.setMode(this.url, this.token, MySettings.newSettings.mode);
      } catch (err) {
        this.log('Failed to set mode:', err.message);
      }
    }

    if ('cloud' in MySettings.oldSettings &&
      MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
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
        this._resetWebSocket?.();
        this.startPolling();
      } else {
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
        this.startWebSocket();
      }
    }


    
    return true;
  }

};
