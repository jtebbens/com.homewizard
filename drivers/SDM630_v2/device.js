'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

//const POLL_INTERVAL = 1000 * 1; // 1 seconds

module.exports = class HomeWizardEnergyDevice630V2 extends Homey.Device {

  async onInit() {

    this.token = await this.getStoreValue('token');
    this.log('Token:', this.token);

    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = await this.getSettings();
    console.log('Settings for SDM630 apiv2: ',settings.polling_interval);

    // Check if polling interval is set in settings else set default value
    if (settings.polling_interval === undefined) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    //Condition Card
    const ConditionCardCheckBatteryMode = this.homey.flow.getConditionCard('check-battery-mode')
    ConditionCardCheckBatteryMode.registerRunListener(async (args, state) => {
      this.log('CheckBatteryModeCard');
        
      return new Promise(async (resolve, reject) => {
        try {
          const response = await api.getMode(this.url, this.token); // NEEDS TESTING WITH SDM230 and BATTERY
  
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

    this.homey.flow.getActionCard('sdm630-set-battery-to-zero-mode')
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

    this.homey.flow.getActionCard('sdm630-set-battery-to-full-charge-mode')
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

    this.homey.flow.getActionCard('sdm630-set-battery-to-standby-mode')
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
            console.log('Invalid response, returning false');
            return resolve(false);
          }
  
          console.log('Set mode:', response.mode);
          return resolve(response.mode); // Returns the mode value
        } catch (error) {
          console.log('Error set mode:', error);
          return resolve(false); // Or reject(error), depending on your error-handling approach
        }
      });
    });
    */

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
      const systemInfo = await api.getSystem(this.url, this.token);

      const setCapabilityPromises = [];
      const triggerFlowPromises = [];

       // Values
      /// / Power
      setCapabilityPromises.push(this._setCapabilityValue('measure_power', data.power_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l1', data.power_l1_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l2', data.power_l2_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l3', data.power_l3_w).catch(this.error));
      /// / Total consumption
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.import', data.energy_import_kwh).catch(this.error));

      /// / Total production
      // if energy_export_kwh == 0, we assume the device does not produce energy
      // We ignore this case
      if (data.energy_export_kwh != 0) {
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.export', data.energy_export_kwh).catch(this.error));
      }

      // Aggregated meter for Power by the hour support 
      if (!this.hasCapability('meter_power')) {
        setCapabilityPromises.push(this.addCapability('meter_power').catch(this.error));
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      if (data.energy_import_kwh !== undefined) {
        if (this.getCapabilityValue('meter_power') != (data.energy_import_kwh - data.energy_export_kwh))
        { setCapabilityPromises.push(this._setCapabilityValue('meter_power', (data.energy_import_kwh - data.energy_export_kwh)).catch(this.error)); }
      }

      /// / Voltage
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l1', data.voltage_l1_v).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l2', data.voltage_l2_v).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l3', data.voltage_l3_v).catch(this.error));

      /// / Current
      setCapabilityPromises.push(this._setCapabilityValue('measure_current', data.current_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l2', data.current_l2_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l3', data.current_l3_a).catch(this.error));
      
      // Execute all promises concurrently using Promise.all()
      Promise.all(setCapabilityPromises);
      Promise.all(triggerFlowPromises);

      let result = await api.getInfo(this.url, this.token); // this.url is empty
      //console.log('getInfo Result:', result);

      if (result && (result.firmware_version === "5.0005")) {
        // Battery mode here?
        const batteryMode = await api.getMode(this.url, this.token);
        if (batteryMode !== undefined) {
                //console.log('Battery mode:', batteryMode);
        }
        if (settings.mode !== batteryMode.mode) {
          this.log('Battery mode changed to:', batteryMode.mode);
          await this.setSettings({
            mode: batteryMode.mode,
          });
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
      this.log('Mode for Plugin Battery via SDM230 advanced settings changed to:', MySettings.newSettings.mode);
      api.setMode(this.url, this.token, MySettings.newSettings.mode);
    }
    // return true;
  }

};
