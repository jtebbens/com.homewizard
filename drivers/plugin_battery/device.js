'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

const POLL_INTERVAL = 1000 * 1; // 1 seconds

module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);
    this.token = this.getStoreValue('token');
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
  }

  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  onPoll() {

    // URL may be undefined if the device is not available
    if (!this.url) return;

    Promise.resolve().then(async () => {

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
      await this.setCapabilityValue('rssi', systemInfo.wifi_rssi_db).catch(this.error);

      

      // battery_charging_state
      if (data.power_w > 10) { // Add some tolerance for idle consumption
        await this.setCapabilityValue('battery_charging_state', 'charging').catch(this.error);
      } else if (data.power_w < 0) {
        await this.setCapabilityValue('battery_charging_state', 'discharging').catch(this.error);
      } else {
        await this.setCapabilityValue('battery_charging_state', 'idle').catch(this.error);
      }

      // battery Cycles - custom metric needs to be added{
      await this.setCapabilityValue('cycles', data.cycles).catch(this.error);

    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }

};
