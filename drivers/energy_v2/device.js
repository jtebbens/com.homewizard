'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

//const POLL_INTERVAL = 1000 * 1; // 1 seconds

async function updateCapability(device, capability, value) {
        if (value === null || value === undefined) {
          if (device.hasCapability(capability)) {
            await device.removeCapability(capability).catch(device.error);
          }
          return;
        }

        if (!device.hasCapability(capability)) {
          await device.addCapability(capability).catch(device.error);
        }

        const current = device.getCapabilityValue(capability);
        if (current !== value) {
          await device.setCapabilityValue(capability, value).catch(device.error);
        }
}

async function getWifiQuality(strength) {
  if (strength >= -30) return 'Excellent';  // Strongest signal
  if (strength >= -60) return 'Strong';     // Strong
  if (strength >= -70) return 'Moderate';  // Good to Fair
  if (strength >= -80) return 'Weak';     // Fair to Weak
  if (strength >= -90) return 'Poor'; // Weak to Unusable
  return 'Unusable';                      // Very poor signal
}

module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

  async onInit() {

    if (!this.hasCapability('connection_error')) {
        await this.addCapability('connection_error').catch(this.error);
    }
    await this.setCapabilityValue('connection_error', 'No errors');


    this.token = await this.getStoreValue('token');
    this.log('Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = await this.getSettings();
    console.log('Settings for P1 apiv2: ',settings.polling_interval);

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
      this.log('CheckBatteryModeCard');
        
      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.getMode(this.url, this.token); // NEEDS TESTING WITH P1 and BATTERY
  
          if (!response || typeof response.mode === 'undefined') {
            console.log('Invalid response, returning false');
            return resolve(false);
          }
  
          console.log('Retrieved mode:', response.mode);
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
            console.log('Invalid response, returning false');
            return resolve(false);
          }

          console.log('Set mode to standby:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          console.log('Error set mode to standby:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
        });
    })

    //this.flowTriggerBatteryMode
    
    this._flowTriggerBatteryMode = this.homey.flow.getDeviceTriggerCard('battery_mode_changed');

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    this._triggerFlowPrevious = {};

    
  }

  flowTriggerBatteryMode(device, tokens) {
    this._flowTriggerBatteryMode.trigger(device, tokens).catch(this.error);
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
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

  onPoll() {
    
    // URL may be undefined if the device is not available
    if (!this.url) return;
    
    const now = new Date();
    const tz = this.homey.clock.getTimezone();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));

    const settings = this.getSettings();

    // Check if polling interval is running)
    if (!this.onPollInterval) {
      this.log('Polling interval is not running, starting now...');
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

    Promise.resolve().then(async () => {

      if(!this.token) { 
        this.token = await this.getStoreValue('token');
      }

      const data = await api.getMeasurement(this.url, this.token);
      await new Promise((resolve) => setTimeout(resolve, 500)); // wait 500ms for next fetch (P1) as 2 calls might affect P1 query response
      const systemInfo = await api.getSystem(this.url, this.token);

      const setCapabilityPromises = [];
      const triggerFlowPromises = [];

      // Accessing external data
      const externalData = data.external;

      // Values
      /// / Power
      await updateCapability(this, 'measure_power',  data.power_w);
      await updateCapability(this, 'measure_power.l1', data.power_l1_w);
      await updateCapability(this, 'measure_power.l2', data.power_l2_w);
      await updateCapability(this, 'measure_power.l3', data.power_l3_w);


      /// / Tariff
      await updateCapability(this, 'tariff', data.tariff);

      /// / Total consumption
      await updateCapability(this, 'meter_power.consumed', data.energy_import_kwh);
      await updateCapability(this, 'meter_power.consumed.t1', data.energy_import_t1_kwh);
      await updateCapability(this, 'meter_power.consumed.t2', data.energy_import_t2_kwh);
      await updateCapability(this, 'meter_power.consumed.t3', data.energy_import_t3_kwh);
      await updateCapability(this, 'meter_power.consumed.t4', data.energy_import_t4_kwh);

      /// / Total production
      // if energy_export_kwh == 0, we assume the device does not produce energy
      // We ignore this case
      if (data.energy_export_kwh != 0) {
        await updateCapability(this, 'meter_power.returned', data.energy_export_kwh);
        await updateCapability(this, 'meter_power.produced.t1', data.energy_export_t1_kwh);
        await updateCapability(this, 'meter_power.produced.t2', data.energy_export_t2_kwh);
        await updateCapability(this, 'meter_power.produced.t3', data.energy_export_t3_kwh);
        await updateCapability(this, 'meter_power.produced.t4', data.energy_export_t4_kwh);
      }

      // Aggregated meter for Power by the hour support 
      if (!this.hasCapability('meter_power')) {
        setCapabilityPromises.push(this.addCapability('meter_power').catch(this.error));
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      if (data.energy_import_kwh !== undefined) {
        if (this.getCapabilityValue('meter_power') != (data.energy_import_kwh - data.energy_export_kwh))
        { 
          await updateCapability(this, 'meter_power', (data.energy_import_kwh - data.energy_export_kwh));
        }
      }

      /// / Voltage
      await updateCapability(this, 'measure_voltage', data.voltage_v);
      await updateCapability(this, 'measure_voltage.l1', data.voltage_l1_v);
      await updateCapability(this, 'measure_voltage.l2', data.voltage_l2_v);
      await updateCapability(this, 'measure_voltage.l3', data.voltage_l3_v);

      /// / Current
      await updateCapability(this, 'measure_current', data.current_a);
      await updateCapability(this, 'measure_current.l1', data.current_l1_a);
      await updateCapability(this, 'measure_current.l2', data.current_l2_a);
      await updateCapability(this, 'measure_current.l3', data.current_l3_a);

      /// / Voltage sags and swells
      await updateCapability(this, 'voltage_sag_l1', data.voltage_sag_l1_count);
      await updateCapability(this, 'voltage_sag_l2', data.voltage_sag_l2_count);
      await updateCapability(this, 'voltage_sag_l3', data.voltage_sag_l3_count);

      await updateCapability(this, 'voltage_swell_l1', data.voltage_swell_l1_count);
      await updateCapability(this, 'voltage_swell_l2', data.voltage_swell_l2_count);
      await updateCapability(this, 'voltage_swell_l3', data.voltage_swell_l3_count);

      /// / Power failures
      await updateCapability(this, 'long_power_fail_count', data.long_power_fail_count);

      /// / Belgium
      await updateCapability(this, 'measure_power.montly_power_peak', data.montly_power_peak_w);

      // Trigger flows
      triggerFlowPromises.push(this._triggerFlowOnChange('tariff_changed', data.tariff).catch(this.error));
      triggerFlowPromises.push(this._triggerFlowOnChange('import_changed', data.energy_import_kwh).catch(this.error));
      triggerFlowPromises.push(this._triggerFlowOnChange('export_changed', data.energy_export_kwh).catch(this.error));

      // Wifi RSSI / dBm
      await updateCapability(this, 'rssi', systemInfo.wifi_rssi_db);


      //const wifiStrength = data.wifi_strength; // e.g., -65
      const wifiQuality = await getWifiQuality(systemInfo.wifi_rssi_db);
      await updateCapability(this, 'wifi_quality', wifiQuality);
      //console.log(`Wi-Fi Quality: ${wifiQuality}`);


      // Belgium water meter using external source (P1)
      let latestWaterData = null;
      let latestGasData = null;

      if (externalData && externalData.length > 0) {

        // Find the water data with the latest timestamp
      latestWaterData = externalData.reduce((prev, current) => {
          if (current.type === 'water_meter') {
            if (!prev || current.timestamp > prev.timestamp) {
              return current;
            }
          }
          return prev;
        }, null);

      latestGasData = externalData.reduce((prev, current) => {
          if (current.type === 'gas_meter') {
            if (!prev || current.timestamp > prev.timestamp) {
              return current;
            }
          }
          return prev;
        }, null);

      }

      if (latestWaterData) {
        // Access water data
        const waterValue = latestWaterData.value;

        if (!this.hasCapability('meter_water')) {
          setCapabilityPromises.push(this.addCapability('meter_water').catch(this.error));
        }

        if (this.getCapabilityValue('meter_water') != waterValue) { setCapabilityPromises.push(this.setCapabilityValue('meter_water', waterValue).catch(this.error)); }

      } else if (this.hasCapability('meter_water')) {
        setCapabilityPromises.push(this.removeCapability('meter_water').catch(this.error));
        console.log('Removed meter as there is no water meter in P1.');
      }

      if (latestGasData) {
        // Access Gas data
        const gasValue = latestGasData.value;

        if (!this.hasCapability('meter_gas')) {
          setCapabilityPromises.push(this.addCapability('meter_gas').catch(this.error));
        }

        if (this.getCapabilityValue('meter_gas') != gasValue) { setCapabilityPromises.push(this.setCapabilityValue('meter_gas', gasValue).catch(this.error)); }

      } else if (this.hasCapability('meter_gas')) {
        setCapabilityPromises.push(this.removeCapability('meter_gas').catch(this.error));
        console.log('Removed meter as there is no gas meter in P1.');
      }

      // At exactly midnight
      if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
        if (data.energy_import_kwh !== undefined) {
          this.setStoreValue('meter_start_day', data.energy_import_kwh).catch(this.error);
        }
        // if (latestGasData.value !== undefined) {
        //  this.setStoreValue('gasmeter_start_day', latestGasData.value).catch(this.error);
        //}
      } else {
        // First-time setup fallback
        if (!this.getStoreValue('meter_start_day') && data.energy_import_kwh !== undefined) {
          this.setStoreValue('meter_start_day', data.energy_import_kwh).catch(this.error);
        }
        //if (!this.getStoreValue('gasmeter_start_day') && latestGasData.value !== undefined) {
        //  this.setStoreValue('gasmeter_start_day', latestGasData.value).catch(this.error);
        //}
      }

      // Check if it is 5 minutes
      /*
      if (nowLocal.getMinutes() % 5 === 0) {
        const prevReadingTimeStamp = await this.getStoreValue('gasmeter_previous_reading_timestamp');
        
        if (prevReadingTimeStamp == null) {
          await this.setStoreValue('gasmeter_previous_reading_timestamp', latestGasData.timestamp);
        }

        if (latestGasData.value != null && prevReadingTimeStamp !== latestGasData.timestamp) {
          const prevReading = await this.getStoreValue('gasmeter_previous_reading');

          if (prevReading != null) {
            const gasDelta = latestGasData.value - prevReading;
            if (gasDelta >= 0) {
              await updateCapability(this, 'measure_gas', gasDelta);
            }
          }

          await this.setStoreValue('gasmeter_previous_reading', latestGasData.value).catch(this.error);
          await this.setStoreValue('gasmeter_previous_reading_timestamp', latestGasData.timestamp).catch(this.error);
        }
      }
      

          // Update the capability meter_gas.daily
          const gasStart = await this.getStoreValue('gasmeter_start_day');
          const gasDiff = (latestGasData.value != null && gasStart != null)
            ? latestGasData.value - gasStart
            : null;

          await updateCapability(this, 'meter_gas.daily', gasDiff);

     */

      // Update the capability meter_power.daily
      const meterStart = await this.getStoreValue('meter_start_day');
          if (meterStart != null && data.energy_import_kwh != null) {
            const dailyImport = data.energy_import_kwh - meterStart;
            await updateCapability(this, 'meter_power.daily', dailyImport);
      }

      // Execute all promises concurrently using Promise.all()
      Promise.all(setCapabilityPromises);
      Promise.all(triggerFlowPromises);

      /*
      // Function to check version
      function isVersionGreater(v1, v2) {
      const toParts = v => v.split('.').map(Number);
      const parts1 = toParts(v1);
      const parts2 = toParts(v2);
      const maxLen = Math.max(parts1.length, parts2.length);

      for (let i = 0; i < maxLen; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        if (num1 > num2) return true;
        if (num1 < num2) return false;
      }
        return false;
      }
      */


      //let result = await api.getInfo(this.url, this.token); // this.url is empty
      //console.log('getInfo Result:', result);

      //if (result && isVersionGreater(result.firmware_version, "6.0203")) {
        // Battery mode here?
        await new Promise((resolve) => setTimeout(resolve, 500)); // wait 500ms
        const batteryMode = await api.getMode(this.url, this.token);
        
        if (settings.mode !== batteryMode.mode) {
          this.log('Battery mode changed to:', batteryMode.mode);
          await this.setSettings({
            mode: batteryMode.mode,
          });
        }

         //trigger battery_mode_change
       
        if (batteryMode.mode != this.getStoreValue('last_battery_mode')) {
          this.flowTriggerBatteryMode(this, { battery_mode_changed: batteryMode.mode });
          this.setStoreValue('last_battery_mode', batteryMode.mode).catch(this.error);
        }


        if (batteryMode.power_w) {
          //this.log('Battery power:', batteryMode.power_w);
          await this._setCapabilityValue('measure_power.battery_group_power_w', batteryMode.power_w).catch(this.error);
        }
        if (batteryMode.target_power_w) {
          //this.log('Battery target power:', batteryMode.target_power_w);
          await this._setCapabilityValue('measure_power.battery_group_target_power_w', batteryMode.target_power_w).catch(this.error);
        }
        if (batteryMode.max_consumption_w) {
          //this.log('Battery max consumption:', batteryMode.max_consumption_w);
          await this._setCapabilityValue('measure_power.battery_group_max_consumption_w', batteryMode.max_consumption_w).catch(this.error);
        }
        if (batteryMode.max_production_w) {
          //this.log('Battery max production:', batteryMode.max_production_w);
          await this._setCapabilityValue('measure_power.battery_group_max_production_w', batteryMode.max_production_w).catch(this.error);
        }
        
        if (!batteryMode.power_w) {
          // If power_w is not available, we assume the battery is not connected
          // Remove the capabilities
          if (this.hasCapability('measure_power.battery_group_power_w')) {
            await this.removeCapability('measure_power.battery_group_power_w').catch(this.error);
          }
          if (this.hasCapability('measure_power.battery_group_target_power_w')) {
            await this.removeCapability('measure_power.battery_group_target_power_w').catch(this.error);
          }
          if (this.hasCapability('measure_power.battery_group_max_consumption_w')) {
            await this.removeCapability('measure_power.battery_group_max_consumption_w').catch(this.error);
          }
          if (this.hasCapability('measure_power.battery_group_max_production_w')) {
            await this.removeCapability('measure_power.battery_group_max_production_w').catch(this.error);
          }
        }

      //}


    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
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

    
    return true;
  }

};
