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

module.exports = class HomeWizardEnergyDevice230V2 extends Homey.Device {

  async onInit() {

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    this.token = await this.getStoreValue('token');
    this.log('Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = this.getSettings();
    console.log('Settings for SDM230 apiv2: ', settings.polling_interval);

    // Check if polling interval is set in settings else set default value
    if (settings.polling_interval === undefined) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    // Condition Card
    const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode');
    ConditionCardCheckBatteryMode.registerRunListener(async (args, state) => {
      // this.log('CheckBatteryModeCard');
        
      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.getMode(this.url, this.token); // NEEDS TESTING WITH SDM230 and BATTERY
  
          if (!response) {
            return resolve(false);
          }

          const normalized = normalizeBatteryMode(response);
          return resolve(args.mode === normalized);

          
        } catch (error) {
          console.log('Error retrieving mode:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });

    this.homey.flow.getActionCard('sdm230-set-battery-to-zero-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Zero Mode');
      // this.log('This url:', this.url);
      // this.log('This token:', this.token);
        return new Promise(async (resolve, reject) => {
        try {
          const response = await api.setMode(this.url, this.token, 'zero'); 

          if (!response) return resolve(false);

          const normalized = normalizeBatteryMode(response);
          return resolve(normalized);

        } catch (error) {
          console.log('Error set mode to zero:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });

    this.homey.flow.getActionCard('sdm230-set-battery-to-full-charge-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Full Charge Mode');
      // this.log('This url:', this.url);
      // this.log('This token:', this.token);
      return new Promise(async (resolve, reject) => {
      try {
          const response = await api.setMode(this.url, this.token, 'to_full');

          if (!response) return resolve(false);

          const normalized = normalizeBatteryMode(response);
          return resolve(normalized);

        } catch (error) {
          console.log('Error set mode to full charge:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
        });
    });

    this.homey.flow.getActionCard('sdm230-set-battery-to-standby-mode')
    .registerRunListener(async () => {
      this.log('ActionCard: Set Battery to Standby Mode');
      // this.log('This url:', this.url);
      // this.log('This token:', this.token);
      return new Promise(async (resolve, reject) => {
      try {
          const response = await api.setMode(this.url, this.token, 'standby');

          if (!response) return resolve(false);

          const normalized = normalizeBatteryMode(response);
          return resolve(normalized);

        } catch (error) {
          console.log('Error set mode to standby:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
        });
    });

    // Zero Charge Only
    this.homey.flow.getActionCard('sdm230-set-battery-to-zero-charge-only-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Zero Charge Only Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'zero_charge_only');
          if (!response) return false;

          const normalized = normalizeBatteryMode(response);
          return normalized;

        } catch (error) {
          this.error('Error set mode to zero_charge_only:', error);
          return false;
        }
      });

    // Zero Discharge Only
    this.homey.flow.getActionCard('sdm230-set-battery-to-zero-discharge-only-mode')
      .registerRunListener(async () => {
        this.log('ActionCard: Set Battery to Zero Discharge Only Mode');

        try {
          const response = await api.setMode(this.url, this.token, 'zero_discharge_only');
          if (!response) return false;

          const normalized = normalizeBatteryMode(response);
          return normalized;

        } catch (error) {
          this.error('Error set mode to zero_discharge_only:', error);
          return false;
        }
      });


    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    this._triggerFlowPrevious = {};
    

  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
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
      await this.addCapability('identify').catch(this.error);
      console.log(`created capability identify for ${this.getName()}`);
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
    try {
      const settings = this.getSettings();

      // Ensure URL is set
      if (!this.url) {
        if (settings.url) {
          this.url = settings.url;
          this.log(`ℹ️ Restored URL from settings: ${this.url}`);
        } else {
          this.error('❌ this.url is empty and no fallback settings.url found — aborting poll');
          await this.setUnavailable().catch(this.error);
          return;
        }
      }

      // Refresh token if missing
      if (!this.token) {
        this.token = await this.getStoreValue('token');
      }

      // --- Main API calls ---
      const data = await api.getMeasurement(this.url, this.token);

      const setCapabilityPromises = [];

      // Power
      setCapabilityPromises.push(this._setCapabilityValue('measure_power', data.power_w));

      // Import
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.import', data.energy_import_kwh));

      // Export (only if non-zero)
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

      // Voltage & Current
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage', data.voltage_v));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current', data.current_a));

      await Promise.allSettled(setCapabilityPromises);

      // --- Battery mode handling ---
      const batteryMode = await api.getMode(this.url, this.token);

      if (batteryMode) {
        const normalized = normalizeBatteryMode(batteryMode);

        // Update settings if changed
        if (settings.mode !== normalized) {
          await this.setSettings({ mode: normalized });
        }

        // Update capabilities
        await this._setCapabilityValue('measure_power.battery_group_power_w', batteryMode.power_w ?? null);
        await this._setCapabilityValue('measure_power.battery_group_target_power_w', batteryMode.target_power_w ?? null);
        await this._setCapabilityValue('measure_power.battery_group_max_consumption_w', batteryMode.max_consumption_w ?? null);
        await this._setCapabilityValue('measure_power.battery_group_max_production_w', batteryMode.max_production_w ?? null);

        // Flow triggers
        await this._triggerFlowOnChange('battery_mode', normalized);
        await this._triggerFlowOnChange('measure_power.battery_group_power_w', batteryMode.power_w ?? null);
      }

    

      // Trigger flows when values change
      await this._triggerFlowOnChange('measure_power', data.power_w);
      await this._triggerFlowOnChange('meter_power.import', data.energy_import_kwh);
      await this._triggerFlowOnChange('meter_power.export', data.energy_export_kwh);
      await this._triggerFlowOnChange('measure_voltage', data.voltage_v);
      await this._triggerFlowOnChange('measure_current', data.current_a);

      // If everything succeeded
      await this.setAvailable();

    } catch (err) {
      this.error('Polling failed:', err);
      await this.setUnavailable(err).catch(this.error);
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
