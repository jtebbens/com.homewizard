'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const https = require('https');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardPluginBattery extends Homey.Device {

  async onInit() {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);
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

  onPoll() {

    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    if (!this.url) return;

    const token2 = this.getData().token;
    const token = this.getStoreValue('token');

    if (!token) {
      token = token2;
    }

    // console.log('Token: ', token);
    // console.log('Token2: ', token2);

    Promise.resolve().then(async () => {

      const res = await fetch(`${this.url}/api/measurement`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        agent: new (require('https').Agent)({ rejectUnauthorized: false }), // Ignore SSL errors
      });

      if (!res || !res.ok)
      { throw new Error(res ? res.statusText : 'Unknown error during fetch'); }

      const data = await res.json();

      // energy_import_kwh	Number	The energy usage meter reading in kWh.
      // energy_export_kwh	Number	The energy feed-in meter reading in kWh.
      // power_w	Number	The total active usage in watt.
      // voltage_l1_v	Number	The active voltage in volt.
      // current_a	Number	The active current in ampere.
      // frequency_hz	Number	Line frequency in hertz.
      // state_of_charge_pct	Number	The current state of charge in percent.
      // cycles	Number	Number of battery cycles.

      // Save export data check if capabilities are present first

      // energy_import_kwh
      if (data.energy_import_kwh !== undefined) {
        if (!this.hasCapability('meter_power.import')) {
          await this.addCapability('meter_power.import').catch(this.error);
        }
        if (this.getCapabilityValue('meter_power.import') != data.energy_import_kwh)
        { await this.setCapabilityValue('meter_power.import', data.energy_import_kwh).catch(this.error); }
      }
      else if ((data.energy_import_kwh == undefined) && (this.hasCapability('meter_power.import'))) {
        await this.removeCapability('meter_power.import').catch(this.error);
      }

      // energy_export_kwh
      if (data.energy_export_kwh !== undefined) {
        if (!this.hasCapability('meter_power.export')) {
          await this.addCapability('meter_power.export').catch(this.error);
        }
        if (this.getCapabilityValue('meter_power.export') != data.energy_export_kwh)
        { await this.setCapabilityValue('meter_power.export', data.energy_export_kwh).catch(this.error); }
      }
      else if ((data.energy_export_kwh == undefined) && (this.hasCapability('meter_power.export'))) {
        await this.removeCapability('meter_power.export').catch(this.error);
      }

      // power_w
      if (data.power_w !== undefined) {
        if (!this.hasCapability('measure_power')) {
          await this.addCapability('measure_power').catch(this.error);
        }
        if (this.getCapabilityValue('measure_power') != data.power_w)
        { await this.setCapabilityValue('measure_power', data.power_w).catch(this.error); }
      }
      else if ((data.power_w == undefined) && (this.hasCapability('measure_power'))) {
        await this.removeCapability('measure_power').catch(this.error);
      }

      // voltage_l1_v
      if (data.voltage_l1_v !== undefined) {
        if (!this.hasCapability('measure_voltage')) {
          await this.addCapability('measure_voltage').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage') != data.voltage_l1_v)
        { await this.setCapabilityValue('measure_voltage', data.voltage_l1_v).catch(this.error); }
      }
      else if ((data.voltage_l1_v == undefined) && (this.hasCapability('measure_voltage'))) {
        await this.removeCapability('measure_voltage').catch(this.error);
      }

      // current_a  Amp's
      if (data.current_a !== undefined) {
        if (!this.hasCapability('measure_current')) {
          await this.addCapability('measure_current').catch(this.error);
        }
        if (this.getCapabilityValue('measure_current') != data.current_a)
        { await this.setCapabilityValue('measure_current', data.current_a).catch(this.error); }
      }
      else if ((data.current_a == undefined) && (this.hasCapability('measure_current'))) {
        await this.removeCapability('measure_current').catch(this.error);
      }

      // measure_battery
      if (data.state_of_charge_pct !== undefined) {
        if (!this.hasCapability('measure_battery')) {
          await this.addCapability('measure_battery').catch(this.error);
        }
        if (this.getCapabilityValue('measure_battery') != data.state_of_charge_pct)
        { await this.setCapabilityValue('measure_battery', data.state_of_charge_pct).catch(this.error); }
      }
      else if ((data.state_of_charge_pct == undefined) && (this.hasCapability('measure_battery'))) {
        await this.removeCapability('measure_battery').catch(this.error);
      }

      // Round Trup Efficiency energy_export_kwh / energy_import_kwh * 100

      // battery_charging_state - not support by HW battery
      if (data.power_w > 0) {
        await this.setCapabilityValue('battery_charging_state', 'charging').catch(this.error);

      } else if (data.power_w < 0) {
        await this.setCapabilityValue('battery_charging_state', 'discharging').catch(this.error);

      } else {
        await this.setCapabilityValue('battery_charging_state', 'idle').catch(this.error);
      }

      // battery Cycles - custom metric needs to be added

      if (data.cycles !== undefined) {
        if (!this.hasCapability('cycles')) {
          await this.addCapability('cycles').catch(this.error);
        }
        if (this.getCapabilityValue('cycles') != data.cycles)
        { await this.setCapabilityValue('cycles', data.cycles).catch(this.error); }
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

};
