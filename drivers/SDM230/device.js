'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergyDevice230 extends Homey.Device {
  async onInit() {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);
    if (this.getClass() == 'sensor') {
      this.setClass('socket');
      console.log('Changed sensor to socket.');
    }
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  onPoll() {
    if (!this.url) return;

    Promise.resolve()
      .then(async () => {
        let res = await fetch(`${this.url}/data`);

        if (!res || !res.ok) {
          await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s to avoid false reports due to bad wifi from users
          // try again
          res = await fetch(`${this.url}/data`);
          if (!res || !res.ok) {
            throw new Error(res ? res.statusText : 'Unknown error during fetch');
          }
        }

        const data = await res.json();

        // OLD CODE / REPLACED BY SOCKET METHOD
        // if (((data.active_power_w < 0) || (data.active_power_l1_w < 0)) && (this.getClass() == 'sensor')) {
        //   if (this.getClass() != 'solarpanel') {
        //     await this.setClass('solarpanel').catch(this.error);
        //   }
        // }

        // Save export data check if capabilities are present first
        if (!this.hasCapability('measure_power')) {
          await this.addCapability('measure_power').catch(this.error);
        }

        if (this.hasCapability('measure_power.active_power_w')) {
          await this.removeCapability('measure_power.active_power_w').catch(this.error);
        } // remove

        if (!this.hasCapability('meter_power.consumed.t1')) {
          await this.addCapability('meter_power.consumed.t1').catch(this.error);
          // await this.addCapability('meter_power.consumed.t2').catch(this.error);
        }

        if (!this.hasCapability('measure_power.l1')) {
          await this.addCapability('measure_power.l1').catch(this.error);
        }

        if (!this.hasCapability('rssi')) {
          await this.addCapability('rssi').catch(this.error);
        }

        if (this.getCapabilityValue('rssi') != data.wifi_strength) {
          await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error);
        }

        // Update values 3phase kwh
        // KWH 1 fase
        // total_power_import_t1_kwh *
        // total_power_export_t1_kwh *
        // active_power_w
        // active_power_l1_w

        // {“wifi_ssid”:“xxxxx”,“wifi_strength”:68,“total_power_import_t1_kwh”:8.468,“total_power_export_t1_kwh”:764.34,“active_power_w”:-803.989,“active_power_l1_w”:-803.989}

        // First we need to check if the kwh active_power_w is negative (solar)

        //      if ((data.active_power_w < 0) || (data.active_power_l1_w < 0) || (this.getClass() != 'socket')) {
        //        if (this.getClass() != 'solarpanel') {
        //          await this.setClass('solarpanel').catch(this.error);
        //        }
        //      }

        // There are old paired SDM230 devices that still have the old sensor and show negative values that needs to be inverted
        if (this.getClass() == 'solarpanel') {
          await this.setCapabilityValue('measure_power', data.active_power_w * -1).catch(this.error);
        } else {
          await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error);
        }

        // await this.setCapabilityValue('measure_power.active_power_w', data.active_power_w).catch(this.error);
        await this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);

        // There are old paired SDM230 devices that still have the old sensor and show negative values that needs to be inverted
        if (this.getClass() == 'solarpanel') {
          await this.setCapabilityValue('measure_power.l1', data.active_power_l1_w * -1).catch(this.error);
        } else {
          await this.setCapabilityValue('measure_power.l1', data.active_power_l1_w).catch(this.error);
        }
        // await this.setCapabilityValue('meter_power.consumed.t2', data.total_power_import_t2_kwh).catch(this.error);

        // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
        if (data.total_power_export_t1_kwh > 1) {
          if (!this.hasCapability('meter_power.produced.t1')) {
            // add production meters
            await this.addCapability('meter_power.produced.t1').catch(this.error);
          }
          // update values for solar production
          await this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error);
        } else if (data.total_power_export_t1_kwh < 1) {
          await this.removeCapability('meter_power.produced.t1').catch(this.error);
        }

        // aggregated meter for Power by the hour support
        if (!this.hasCapability('meter_power')) {
          await this.addCapability('meter_power').catch(this.error);
        }
        // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
        await this.setCapabilityValue('meter_power', data.total_power_import_t1_kwh - data.total_power_export_t1_kwh).catch(this.error);

        // active_voltage_l1_v
        if (data.active_voltage_v !== undefined) {
          if (!this.hasCapability('measure_voltage')) {
            await this.addCapability('measure_voltage').catch(this.error);
          }
          if (this.getCapabilityValue('measure_voltage') != data.active_voltage_v) {
            await this.setCapabilityValue('measure_voltage', data.active_voltage_v).catch(this.error);
          }
        } else if (data.active_voltage_v == undefined && this.hasCapability('measure_voltage')) {
          await this.removeCapability('measure_voltage').catch(this.error);
        }

        // active_current_a  Amp's
        if (data.active_current_a !== undefined) {
          if (!this.hasCapability('measure_current')) {
            await this.addCapability('measure_current').catch(this.error);
          }
          if (this.getCapabilityValue('measure_current') != data.active_current_a) {
            await this.setCapabilityValue('measure_current', data.active_current_a).catch(this.error);
          }
        } else if (data.active_current_a == undefined && this.hasCapability('measure_current')) {
          await this.removeCapability('measure_current').catch(this.error);
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
