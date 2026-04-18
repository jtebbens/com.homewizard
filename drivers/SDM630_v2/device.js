'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

// const POLL_INTERVAL = 1000 * 1; // 1 seconds

function normalizeBatteryMode(data) {
  const knownModes = [
    'zero',
    'standby',
    'to_full',
    'zero_charge_only',
    'zero_discharge_only'
  ];

  let rawMode = data.mode;

  if (typeof rawMode === 'string') {
    rawMode = rawMode.trim();
    try { rawMode = JSON.parse(rawMode); }
    catch { rawMode = rawMode.replace(/^["']+|["']+$/g, ''); }
  }

  if (knownModes.includes(rawMode)) return rawMode;

  if (Array.isArray(data.permissions)) {
    const perms = [...data.permissions].sort().join(',');
    if (perms === '') return 'standby';
    if (perms === 'charge_allowed,discharge_allowed') return 'zero';
    if (perms === 'charge_allowed') return 'zero_charge_only';
    if (perms === 'discharge_allowed') return 'zero_discharge_only';
  }

  return 'standby';
}



module.exports = class HomeWizardEnergyDevice630V2 extends Homey.Device {

  async onInit() {
    this.homey.app.bumpDeviceCount?.('SDM630_v2');
    const _memS = (label) => { try { const h = require('v8').getHeapStatistics(); this.log(`[MEM][SDM630] ${label}: heap=${(h.used_heap_size/1048576).toFixed(1)}/${(h.total_heap_size/1048576).toFixed(1)}MB`); } catch(_){} };
    _memS('onInit-start');

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    this.token = await this.getStoreValue('token');
    //this.log('Token:', this.token);

    await this._updateCapabilities();
    _memS('after-updateCapabilities');
    await this._registerCapabilityListeners();
    _memS('after-registerCapabilityListeners');

    const settings = this.getSettings();
    this.log('Settings for SDM630 apiv2: ', settings.polling_interval);

    // Check if polling interval is set in settings else set default value
    if (settings.polling_interval === undefined) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    // Register flow card listeners only once (prevent "already registered" warnings)
    if (!this.homey.app._flowListenersRegistered_SDM630) {
      this.homey.app._flowListenersRegistered_SDM630 = true;

    // Condition Card
    const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode');
    ConditionCardCheckBatteryMode.registerRunListener(async (args, state) => {
      // this.log('CheckBatteryModeCard');
        
      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.getMode(this.url, this.token); // NEEDS TESTING WITH SDM230 and BATTERY
  
          if (!response) {
            this.log('Invalid response, returning false');
            return resolve(false);
          }
  
          this.log('Retrieved mode:', response.mode);
          const normalized = normalizeBatteryMode(response);
          return resolve(args.mode === normalized);

          
        } catch (error) {
          this.log('Error retrieving mode:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });

    //
    // ✅ SDM630 Battery Mode Action Cards
    //

    // Zero mode
    this.homey.flow.getActionCard('sdm630-set-battery-to-zero-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Zero Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'zero');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to zero:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to zero:', error);
          return false;
        }
      });


    // Standby mode
    this.homey.flow.getActionCard('sdm630-set-battery-to-standby-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Standby Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'standby');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to standby:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to standby:', error);
          return false;
        }
      });


    // Full charge mode
    this.homey.flow.getActionCard('sdm630-set-battery-to-full-charge-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Full Charge Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'to_full');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to full charge:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to full charge:', error);
          return false;
        }
      });


    // Zero charge only
    this.homey.flow.getActionCard('sdm630-set-battery-to-zero-charge-only-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Zero Charge Only Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'zero_charge_only');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to zero_charge_only:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to zero_charge_only:', error);
          return false;
        }
      });


    // Zero discharge only
    this.homey.flow.getActionCard('sdm630-set-battery-to-zero-discharge-only-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Zero Discharge Only Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'zero_discharge_only');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to zero_discharge_only:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to zero_discharge_only:', error);
          return false;
        }
      });


    // Predictive (HW Smart Charging)
    this.homey.flow.getActionCard('sdm630-set-battery-to-predictive-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Predictive (HW Smart Charging) Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'predictive');

          if (!response) {
            this.log('Invalid response, returning false');
            return false;
          }

          const normalized = normalizeBatteryMode(response);
          this.log('Set mode to predictive:', normalized);
          return normalized;

        } catch (error) {
          this.error('Error set mode to predictive:', error);
          return false;
        }
      });

    } // End of _flowListenersRegistered_SDM630 guard

    _memS('after-flowCards');
    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    this._triggerFlowPrevious = {};

    /*
    const ActionCardChangeBatteryMode = this.homey.flow.getActionCard('change-battery-mode')
    ActionCardChangeBatteryMode.registerRunListener(async (args, state) => {
      this.log('ChangeBatteryModeCard change to:', args);

      if (!this.url) {
        return false;
      }

      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.setMode(this.url, this.token, args.mode); // NEEDS TESTING WITH P1 and BATTERY
  
          if (!response || typeof response.mode === 'undefined') {
            this.log('Invalid response, returning false');
            return resolve(false);
          }
  
          this.log('Set mode:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          this.log('Error set mode:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });
    */

  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    if (this._settingsFlushTimer) {
      this.homey.clearTimeout(this._settingsFlushTimer);
      this._settingsFlushTimer = null;
    }
    if (this._settingsQueue) this._settingsQueue.clear();
  }

  // Batched settings persistence — homey.settings.set allocates ~30 MB V8 heap
  // per call. Spacing writes 8s apart lets GC reclaim the previous spike.
  _queueSettingsPersist(key, value) {
    if (!this._settingsQueue) this._settingsQueue = new Map();
    this._settingsQueue.set(key, value);
    if (this._settingsFlushTimer) return;
    this._settingsFlushTimer = this.homey.setTimeout(() => {
      this._settingsFlushTimer = null;
      this._flushSettingsQueue();
    }, 8000);
  }

  _flushSettingsQueue() {
    if (!this._settingsQueue || this._settingsQueue.size === 0) return;

    let heapMB = 0;
    try { heapMB = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
    if (heapMB > 40) {
      this._settingsFlushTimer = this.homey.setTimeout(() => {
        this._settingsFlushTimer = null;
        this._flushSettingsQueue();
      }, 8000);
      return;
    }

    const [key, value] = this._settingsQueue.entries().next().value;
    this._settingsQueue.delete(key);
    try {
      if (key === '__settings__') {
        this.setSettings(value).catch(err => this.error('Failed to persist settings:', err.message));
      } else {
        this.homey.settings.set(key, value);
      }
    } catch (e) {
      this.error(`Failed to persist ${key}:`, e.message);
    }
    if (this._settingsQueue.size > 0) {
      this._settingsFlushTimer = this.homey.setTimeout(() => {
        this._settingsFlushTimer = null;
        this._flushSettingsQueue();
      }, 8000);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  /**
   * Helper function to update capabilities configuration.
   * This function is called when the device is initialized.
   */
  async _updateCapabilities() {
    if (!this.hasCapability('identify')) {
      try {
        await this.addCapability('identify');
        this.log(`created capability identify for ${this.getName()}`);
      } catch (err) {
        if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
          this.log(`Capability already exists: identify — ignoring`);
        } else {
          this.error(err);
        }
      }
    }

    // Remove capabilities that are not needed
    if (this.hasCapability('measure_power.power_w')) {
      await this.removeCapability('measure_power.power_w').catch(this.error);
      this.log(`removed capability measure_power.power_w for ${this.getName()}`);
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
    if (value === undefined) return;

    if (!this.hasCapability(capability)) {
      try {
        await this.addCapability(capability);
      } catch (err) {
        if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
          this.log(`Capability already exists: ${capability} — ignoring`);
        } else {
          this.error(err);
        }
      }
    }

    // Skip write when value unchanged — avoids framework allocation + listener churn
    if (this.getCapabilityValue(capability) === value) return;

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

    // Ignore if value is undefined
    if (value === undefined) {
      return;
    }

    // Check if the value is undefined
    // If so, we assume this is the first time we are setting the value
    // We cannot trust the the 'trigger' function to be called with the correct value
    if (this._triggerFlowPrevious[flow_id] === undefined) {
      this._triggerFlowPrevious[flow_id] = value;
      return;
    }

    // Return of the value is the same as the previous value
    if (this._triggerFlowPrevious[flow_id] === value) {

      // We don't need to trigger the flow
      return;
    }

    // It is a bit 'costly' to get the flow card every time
    // But we can assume the trigger does not change often
    const flow = this.homey.flow.getDeviceTriggerCard(flow_id);
    if (flow === undefined) {
      this.error('Flow not found');
      return;
    }

    // Update value and trigger the flow
    this._triggerFlowPrevious[flow_id] = value;
    flow.trigger(this, { [flow_id]: value }).catch(this.error);
  }

async onPoll() {
  // Circuit breaker: skip poll during backoff window (after repeated timeouts)
  if (this._backoffUntil && Date.now() < this._backoffUntil) return;

  try {
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

    // 2. Sync settings if discovery changed the URL — batched, only on actual change
    if (this.url && this.url !== settings.url && this._lastPersistedUrl !== this.url) {
      this._lastPersistedUrl = this.url;
      this._queueSettingsPersist('__settings__', { url: this.url });
    }

    // Refresh token if missing
    if (!this.token) {
      this.token = await this.getStoreValue('token');
    }

    // --- Main API calls (parallel) ---
    const [data, batteryMode] = await Promise.all([
      api.getMeasurement(this.url, this.token),
      api.getMode(this.url, this.token).catch(() => undefined)
    ]);

    const setCapabilityPromises = [];

    // Power (total + per phase)
    setCapabilityPromises.push(this._setCapabilityValue('measure_power', data.power_w));
    setCapabilityPromises.push(this._setCapabilityValue('measure_power.l1', data.power_l1_w));
    setCapabilityPromises.push(this._setCapabilityValue('measure_power.l2', data.power_l2_w));
    setCapabilityPromises.push(this._setCapabilityValue('measure_power.l3', data.power_l3_w));

    // Import / Export
    setCapabilityPromises.push(this._setCapabilityValue('meter_power.import', data.energy_import_kwh));
    if (data.energy_export_kwh !== 0) {
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.export', data.energy_export_kwh));
    }

    // Aggregated meter_power
    if (!this.hasCapability('meter_power')) {
      await this.addCapability('meter_power').catch(this.error);
    }
    if (data.energy_import_kwh !== undefined) {
      const calcValue = data.energy_import_kwh - data.energy_export_kwh;
      if (this.getCapabilityValue('meter_power') !== calcValue) {
        setCapabilityPromises.push(this._setCapabilityValue('meter_power', calcValue));
      }
    }

    // Voltage per phase
    setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l1', data.voltage_l1_v));
    setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l2', data.voltage_l2_v));
    setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l3', data.voltage_l3_v));

    // Current (total + per phase)
    setCapabilityPromises.push(this._setCapabilityValue('measure_current', data.current_a));
    setCapabilityPromises.push(this._setCapabilityValue('measure_current.l1', data.current_l1_a));
    setCapabilityPromises.push(this._setCapabilityValue('measure_current.l2', data.current_l2_a));
    setCapabilityPromises.push(this._setCapabilityValue('measure_current.l3', data.current_l3_a));

    // Battery mode — batch capability updates, debounce settings persist
    if (batteryMode !== undefined) {
      const normalized = normalizeBatteryMode(batteryMode);

      if (this._liveMode !== normalized) {
        this._liveMode = normalized;
        if (settings.mode !== normalized) {
          this._queueSettingsPersist('__settings__', { mode: normalized });
        }
      }

      setCapabilityPromises.push(this._setCapabilityValue('measure_power.battery_group_power_w', batteryMode.power_w ?? null));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.battery_group_target_power_w', batteryMode.target_power_w ?? null));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.battery_group_max_consumption_w', batteryMode.max_consumption_w ?? null));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.battery_group_max_production_w', batteryMode.max_production_w ?? null));

      this._triggerFlowOnChange('battery_mode_changed_SDM630_v2', normalized);
    }

    await Promise.allSettled(setCapabilityPromises);

    // If everything succeeded
    this._consecutiveErrors = 0;
    this._backoffUntil = null;
    await this.setAvailable();

  } catch (err) {
    this.error('Polling failed:', err);
    await this.setUnavailable(err).catch(this.error);

    // Circuit breaker: after 3 consecutive timeouts, back off for 60s to prevent socket storms
    if (err.message === 'TIMEOUT') {
      this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
      if (this._consecutiveErrors >= 3) {
        this._backoffUntil = Date.now() + 60000;
        this._consecutiveErrors = 0;
        this.log(`⏸️ SDM630 circuit breaker: 3 timeouts, backing off 60s`);
      }
    } else {
      this._consecutiveErrors = 0;
    }
  }
}

  onSettings(MySettings) {
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
      this.log('Mode for Plugin Battery via SDM230 advanced settings changed to:', MySettings.newSettings.mode);
      api.setMode(this.url, this.token, MySettings.newSettings.mode);
    }
    // return true;
  }

};
