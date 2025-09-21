'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

//const POLL_INTERVAL = 1000 * 10; // 1 seconds

module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    this.previousChargingState = null;
    this.previousTimeToEmpty = null;
    this.previousStateOfCharge = null;

    this.token = await this.getStoreValue('token');
    console.log('PIB Token:', this.token);

    let settings = await this.getSettings();
    this.log('Settings for Plugin Battery: ', settings.polling_interval);


    if ((settings.polling_interval === undefined) || (settings.polling_interval === null)) {
      await this.setSettings({ polling_interval: 10 });
      settings.polling_interval = 10; // update local variable
    }

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    
    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

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

    
  }

  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  async onPoll() {
    
    try {

    // URL may be undefined if the device is not available
    const settings = await this.getSettings();

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
          

      const data = await api.getMeasurement(this.url, this.token);
      const systemInfo = await api.getSystem(this.url, this.token);

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
         
      if (!this.hasCapability('rssi')) {
      await this.addCapability('rssi').catch(this.error);
      }
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

      this.setAvailable().catch(this.error);
    } catch (err) {
      this.error(err);
      this.setUnavailable(err).catch(this.error);
    }
  }

  async onSettings(MySettings) {
    this.log('Plugin Battery Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for Plugin Battery changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      //this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    // return true;
  }


};
