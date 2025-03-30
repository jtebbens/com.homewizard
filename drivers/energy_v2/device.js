'use strict';

const Homey = require('homey');
const api = require('../../common/v2/Api');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

  async onInit() {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);

    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed');

    this.token = this.getStoreValue('token');

    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  flowTriggerTariff(device, tokens) {
    this._flowTriggerTariff.trigger(device, tokens).catch(this.error);
  }

  flowTriggerImport(device, tokens) {
    this._flowTriggerImport.trigger(device, tokens).catch(this.error);
  }

  flowTriggerExport(device, tokens) {
    this._flowTriggerExport.trigger(device, tokens).catch(this.error);
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

    // URL may be undefined if the device is not available
    if (!this.url) return;

    Promise.resolve().then(async () => {

      const data = await api.getMeasurement(this.url, this.token);

      // Capture all await promises
      const promises = [];

      // identify
      if (!this.hasCapability('identify')) {
        await this.addCapability('identify').catch(this.error);
      }

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_power')) {
        promises.push(this.addCapability('measure_power').catch(this.error));
      }

      //      if (!this.hasCapability('measure_current.l1') && (data.current_l1_a !== undefined)) {
      //        promises.push(this.addCapability('measure_current.l1').catch(this.error));
      //      }

      if (this.hasCapability('measure_power.power_w')) {
        promises.push(this.removeCapability('measure_power.power_w').catch(this.error));
      } // remove

      if (!this.hasCapability('meter_power.consumed.t1')) {
        promises.push(this.addCapability('meter_power.consumed.t1').catch(this.error));
        promises.push(this.addCapability('meter_power.consumed.t2').catch(this.error));
      }

      if (!this.hasCapability('meter_power.consumed')) {
        promises.push(this.addCapability('meter_power.consumed').catch(this.error));
      }

      // if (!this.hasCapability('rssi')) {
      //  promises.push(this.addCapability('rssi').catch(this.error));
      // }

      if (!this.hasCapability('tariff')) {
        promises.push(this.addCapability('tariff').catch(this.error));
      }

      // Update values
      if (this.getCapabilityValue('measure_power') != data.power_w)
      { promises.push(this.setCapabilityValue('measure_power', data.power_w).catch(this.error)); }
      // if (this.getCapabilityValue('measure_current.l1') != data.current_l1_a)
      // promises.push(this.setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error));
      if (this.getCapabilityValue('meter_power.consumed.t1') != data.energy_import_t1_kwh)
      { promises.push(this.setCapabilityValue('meter_power.consumed.t1', data.energy_import_t1_kwh).catch(this.error)); }
      if (this.getCapabilityValue('meter_power.consumed.t2') != data.energy_import_t2_kwh)
      { promises.push(this.setCapabilityValue('meter_power.consumed.t2', data.energy_import_t2_kwh).catch(this.error)); }
      // if (this.getCapabilityValue('rssi') != data.wifi_strength)
      // promises.push(this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error));
      if (this.getCapabilityValue('tariff') != data.tariff)
      { promises.push(this.setCapabilityValue('tariff', data.tariff).catch(this.error)); }
      if (this.getCapabilityValue('meter_power.consumed') != data.energy_import_kwh)
      { promises.push(this.setCapabilityValue('meter_power.consumed', data.energy_import_kwh).catch(this.error)); }

      // Trigger tariff
      if (data.tariff != this.getStoreValue('last_tariff')) {
        this.flowTriggerTariff(this, { tariff_changed: data.tariff });
        this.setStoreValue('last_tariff', data.tariff).catch(this.error);
      }

      if (data.current_l1_a !== undefined) {
        if (!this.hasCapability('measure_current.l1')) {
          promises.push(this.addCapability('measure_current.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_current.l1') != data.current_l1_a)
        { promises.push(this.setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error)); }
      }
      else if (data.current_l1_a == null) {
        // delete measure_current.l1 -> some meters dont have this property
        promises.push(this.removeCapability('measure_current.l1').catch(this.error));
      }

      // Not all users have a gas meter in their system (if NULL ignore creation or even delete from view)

      if (data.total_gas_m3 !== undefined) {
      								if (!this.hasCapability('meter_gas')) {
      									promises.push(this.addCapability('meter_gas').catch(this.error));
      								}
        if (this.getCapabilityValue('meter_gas') != data.total_gas_m3)
        { promises.push(this.setCapabilityValue('meter_gas', data.total_gas_m3).catch(this.error)); }
      							}
      							else if (data.total_gas_m3 == null) {
        // delete gas meter
      								promises.push(this.removeCapability('meter_gas').catch(this.error));
      }

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if ((data.energy_export_t1_kwh > 1) || (data.energy_export_t2_kwh > 1)) {
        if ((!this.hasCapability('meter_power.produced.t1')) || (!this.hasCapability('meter_power.returned'))) {
          // add production meters
          promises.push(this.addCapability('meter_power.produced.t1').catch(this.error));
          promises.push(this.addCapability('meter_power.produced.t2').catch(this.error));
          promises.push(this.addCapability('meter_power.returned').catch(this.error));
        }
        // update values for solar production
        if (this.getCapabilityValue('meter_power.produced.t1') != data.energy_export_t1_kwh)
        { promises.push(this.setCapabilityValue('meter_power.produced.t1', data.energy_export_t1_kwh).catch(this.error)); }
        if (this.getCapabilityValue('meter_power.produced.t2') != data.energy_export_t2_kwh)
        { promises.push(this.setCapabilityValue('meter_power.produced.t2', data.energy_export_t1_kwh).catch(this.error)); }
      }
      else if ((data.energy_export_t1_kwh < 1) || (data.energy_export_t2_kwh < 1)) {
        promises.push(this.removeCapability('meter_power.produced.t1').catch(this.error));
        promises.push(this.removeCapability('meter_power.produced.t2').catch(this.error));
      }

      // aggregated meter for Power by the hour support
      if (!this.hasCapability('meter_power')) {
        promises.push(this.addCapability('meter_power').catch(this.error));
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      // Pre P1 firmware 4.x
      if (data.energy_import_kwh === undefined) {
        if (this.getCapabilityValue('meter_power') != ((data.energy_import_t1_kwh + data.energy_import_t2_kwh) - (data.energy_export_t1_kwh + data.energy_export_t2_kwh)))
        { promises.push(this.setCapabilityValue('meter_power', ((data.energy_import_t1_kwh + data.energy_import_t2_kwh) - (data.energy_export_t1_kwh + data.energy_export_t2_kwh))).catch(this.error)); }
      }
      // P1 Firmwmare 4.x and later
      else if (data.energy_import_kwh !== undefined) {
        if (this.getCapabilityValue('meter_power') != (data.energy_import_kwh - data.energy_export_kwh))
        { promises.push(this.setCapabilityValue('meter_power', (data.energy_import_kwh - data.energy_export_kwh)).catch(this.error)); }
        if (this.getCapabilityValue('meter_power.returned') != data.energy_export_kwh)
        { promises.push(this.setCapabilityValue('meter_power.returned', data.energy_export_kwh).catch(this.error)); }
      }

      // Trigger import
      if (data.energy_import_kwh != this.getStoreValue('last_total_import_kwh')) {
        this.flowTriggerImport(this, { import_changed: data.energy_import_kwh });
        this.setStoreValue('last_total_import_kwh', data.energy_import_kwh).catch(this.error);
      }

      // Trigger export
      if (data.energy_export_kwh != this.getStoreValue('last_total_export_kwh')) {
        this.flowTriggerExport(this, { export_changed: data.energy_export_kwh });
        this.setStoreValue('last_total_export_kwh', data.energy_export_kwh).catch(this.error);
      }

      // Belgium
      if (data.montly_power_peak_w !== undefined) {
        if (!this.hasCapability('measure_power.montly_power_peak')) {
          promises.push(this.addCapability('measure_power.montly_power_peak').catch(this.error));
        }
        if (this.getCapabilityValue('measure_power.montly_power_peak') != data.montly_power_peak_w)
        { promises.push(this.setCapabilityValue('measure_power.montly_power_peak', data.montly_power_peak_w).catch(this.error)); }
      }
      else if ((data.montly_power_peak_w == undefined) && (this.hasCapability('measure_power.montly_power_peak'))) {
        promises.push(this.removeCapability('measure_power.montly_power_peak').catch(this.error));
      }

      // voltage_l1_v Some P1 meters do have voltage data
      if (data.voltage_l1_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l1')) {
          promises.push(this.addCapability('measure_voltage.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_voltage.l1') != data.voltage_l1_v)
        { promises.push(this.setCapabilityValue('measure_voltage.l1', data.voltage_l1_v).catch(this.error)); }
      }
      else if ((data.voltage_l1_v == undefined) && (this.hasCapability('measure_voltage.l1'))) {
        promises.push(this.removeCapability('measure_voltage.l1').catch(this.error));
      }

      // current_l1_a Some P1 meters do have amp data
      if (data.current_l1_a !== undefined) {
        if (!this.hasCapability('measure_current.l1')) {
          promises.push(this.addCapability('measure_current.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_current.l1') != data.current_l1_a)
        { promises.push(this.setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error)); }
      }
      else if ((data.current_l1_a == undefined) && (this.hasCapability('measure_current.l1'))) {
        promises.push(this.removeCapability('measure_current.l1').catch(this.error));
      }

      // Power failure count - long_power_fail_count
      if (data.long_power_fail_count !== undefined) {
        if (!this.hasCapability('long_power_fail_count')) {
          promises.push(this.addCapability('long_power_fail_count').catch(this.error));
        }
        if (this.getCapabilityValue('long_power_fail_count') != data.long_power_fail_count)
        { promises.push(this.setCapabilityValue('long_power_fail_count', data.long_power_fail_count).catch(this.error)); }
      }
      else if ((data.long_power_fail_count == undefined) && (this.hasCapability('long_power_fail_count'))) {
        promises.push(this.removeCapability('long_power_fail_count').catch(this.error));
      }

      // voltage_sag_l1_count - Net L1 dip
      if (data.voltage_sag_l1_count !== undefined) {
        if (!this.hasCapability('voltage_sag_l1')) {
          promises.push(this.addCapability('voltage_sag_l1').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_sag_l1') != data.voltage_sag_l1_count)
        { promises.push(this.setCapabilityValue('voltage_sag_l1', data.voltage_sag_l1_count).catch(this.error)); }
      }
      else if ((data.voltage_sag_l1_count == undefined) && (this.hasCapability('voltage_sag_l1'))) {
        promises.push(this.removeCapability('voltage_sag_l1').catch(this.error));
      }

      // voltage_sag_l2_count - Net L2 dip
      if (data.voltage_sag_l2_count !== undefined) {
        if (!this.hasCapability('voltage_sag_l2')) {
          promises.push(this.addCapability('voltage_sag_l2').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_sag_l2') != data.voltage_sag_l2_count)
        { promises.push(this.setCapabilityValue('voltage_sag_l2', data.voltage_sag_l2_count).catch(this.error)); }
      }
      else if ((data.voltage_sag_l2_count == undefined) && (this.hasCapability('voltage_sag_l2'))) {
        promises.push(this.removeCapability('voltage_sag_l2').catch(this.error));
      }

      // voltage_sag_l3_count - Net L3 dip
      if (data.voltage_sag_l3_count !== undefined) {
        if (!this.hasCapability('voltage_sag_l3')) {
          promises.push(this.addCapability('voltage_sag_l3').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_sag_l3') != data.voltage_sag_l3_count)
        { promises.push(this.setCapabilityValue('voltage_sag_l3', data.voltage_sag_l3_count).catch(this.error)); }
      }
      else if ((data.voltage_sag_l3_count == undefined) && (this.hasCapability('voltage_sag_l3'))) {
        promises.push(this.removeCapability('voltage_sag_l3').catch(this.error));
      }

      // voltage_swell_l1_count - Net L1 peak
      if (data.voltage_swell_l1_count !== undefined) {
        if (!this.hasCapability('voltage_swell_l1')) {
          promises.push(this.addCapability('voltage_swell_l1').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_swell_l1') != data.voltage_swell_l1_count)
        { promises.push(this.setCapabilityValue('voltage_swell_l1', data.voltage_swell_l1_count).catch(this.error)); }
      }
      else if ((data.voltage_swell_l1_count == undefined) && (this.hasCapability('voltage_swell_l1'))) {
        promises.push(this.removeCapability('voltage_swell_l1').catch(this.error));
      }

      // voltage_swell_l2_count - Net L2 peak
      if (data.voltage_swell_l2_count !== undefined) {
        if (!this.hasCapability('voltage_swell_l2')) {
          promises.push(this.addCapability('voltage_swell_l2').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_swell_l2') != data.voltage_swell_l2_count)
        { promises.push(this.setCapabilityValue('voltage_swell_l2', data.voltage_swell_l2_count).catch(this.error)); }
      }
      else if ((data.voltage_swell_l2_count == undefined) && (this.hasCapability('voltage_swell_l2'))) {
        promises.push(this.removeCapability('voltage_swell_l2').catch(this.error));
      }

      // voltage_swell_l3_count - Net L3 peak
      if (data.voltage_swell_l3_count !== undefined) {
        if (!this.hasCapability('voltage_swell_l3')) {
          promises.push(this.addCapability('voltage_swell_l3').catch(this.error));
        }
        if (this.getCapabilityValue('voltage_swell_l3') != data.voltage_swell_l3_count)
        { promises.push(this.setCapabilityValue('voltage_swell_l3', data.voltage_swell_l3_count).catch(this.error)); }
      }
      else if ((data.voltage_swell_l3_count == undefined) && (this.hasCapability('voltage_swell_l3'))) {
        promises.push(this.removeCapability('voltage_swell_l3').catch(this.error));
      }

      // Rewrite of L1/L2/L3 Voltage/Amp
      if (data.power_l1_w !== undefined) {
        if (!this.hasCapability('measure_power.l1')) {
          promises.push(this.addCapability('measure_power.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_power.l1') != data.power_l1_w)
        { promises.push(this.setCapabilityValue('measure_power.l1', data.power_l1_w).catch(this.error)); }
      }
      else if ((data.power_l1_w == undefined) && (this.hasCapability('measure_power.l1'))) {
        promises.push(this.removeCapability('measure_power.l1').catch(this.error));
      }

      if (data.power_l2_w !== undefined) {
        if (!this.hasCapability('measure_power.l2')) {
          promises.push(this.addCapability('measure_power.l2').catch(this.error));
        }
        if (this.getCapabilityValue('measure_power.l2') != data.power_l2_w)
        { promises.push(this.setCapabilityValue('measure_power.l2', data.power_l2_w).catch(this.error)); }
      }
      else if ((data.power_l2_w == undefined) && (this.hasCapability('measure_power.l2'))) {
        promises.push(this.removeCapability('measure_power.l2').catch(this.error));
      }

      if (data.power_l3_w !== undefined) {
        if (!this.hasCapability('measure_power.l3')) {
          promises.push(this.addCapability('measure_power.l3').catch(this.error));
        }
        if (this.getCapabilityValue('measure_power.l3') != data.power_l3_w)
        { promises.push(this.setCapabilityValue('measure_power.l3', data.power_l3_w).catch(this.error)); }
      }
      else if ((data.power_l3_w == undefined) && (this.hasCapability('measure_power.l3'))) {
        promises.push(this.removeCapability('measure_power.l3').catch(this.error));
      }

      if (data.voltage_l1_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l1')) {
          promises.push(this.addCapability('measure_voltage.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_voltage.l1') != data.voltage_l1_v)
        { promises.push(this.setCapabilityValue('measure_voltage.l1', data.voltage_l1_v).catch(this.error)); }
      }
      else if ((data.voltage_l1_v == undefined) && (this.hasCapability('measure_voltage.l1'))) {
        promises.push(this.removeCapability('measure_voltage.l1').catch(this.error));
      }

      if (data.voltage_l2_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l2')) {
          promises.push(this.addCapability('measure_voltage.l2').catch(this.error));
        }
        if (this.getCapabilityValue('measure_voltage.l2') != data.voltage_l2_v)
        { promises.push(this.setCapabilityValue('measure_voltage.l2', data.voltage_l2_v).catch(this.error)); }
      }
      else if ((data.voltage_l2_v == undefined) && (this.hasCapability('measure_voltage.l2'))) {
        promises.push(this.removeCapability('measure_voltage.l2').catch(this.error));
      }

      if (data.voltage_l3_v !== undefined) {
        if (!this.hasCapability('measure_voltage.l3')) {
          promises.push(this.addCapability('measure_voltage.l3').catch(this.error));
        }
        if (this.getCapabilityValue('measure_voltage.l3') != data.voltage_l3_v)
        { promises.push(this.setCapabilityValue('measure_voltage.l3', data.voltage_l3_v).catch(this.error)); }
      }
      else if ((data.voltage_l3_v == undefined) && (this.hasCapability('measure_voltage.l3'))) {
        promises.push(this.removeCapability('measure_voltage.l3').catch(this.error));
      }

      if (data.current_l1_a !== undefined) {
        if (!this.hasCapability('measure_current.l1')) {
          promises.push(this.addCapability('measure_current.l1').catch(this.error));
        }
        if (this.getCapabilityValue('measure_current.l1') != data.current_l1_a)
        { promises.push(this.setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error)); }
      }
      else if ((data.current_l1_a == undefined) && (this.hasCapability('measure_current.l1'))) {
        promises.push(this.removeCapability('measure_current.l1').catch(this.error));
      }

      if (data.current_l2_a !== undefined) {
        if (!this.hasCapability('measure_current.l2')) {
          promises.push(this.addCapability('measure_current.l2').catch(this.error));
        }
        if (this.getCapabilityValue('measure_current.l2') != data.current_l2_a)
        { promises.push(this.setCapabilityValue('measure_current.l2', data.current_l2_a).catch(this.error)); }
      }
      else if ((data.current_l2_a == undefined) && (this.hasCapability('measure_current.l2'))) {
        promises.push(this.removeCapability('measure_current.l2').catch(this.error));
      }

      if (data.current_l3_a !== undefined) {
        if (!this.hasCapability('measure_current.l3')) {
          promises.push(this.addCapability('measure_current.l3').catch(this.error));
        }
        if (this.getCapabilityValue('measure_current.l3') != data.current_l3_a)
        { promises.push(this.setCapabilityValue('measure_current.l3', data.current_l3_a).catch(this.error)); }
      }
      else if ((data.current_l3_a == undefined) && (this.hasCapability('measure_current.l3'))) {
        promises.push(this.removeCapability('measure_current.l3').catch(this.error));
      }

      // T3 meter request import and export
      if (data.total_power_import_t3_kwh !== undefined) {
        if (!this.hasCapability('meter_power.consumed.t3')) {
          promises.push(this.addCapability('meter_power.consumed.t3').catch(this.error));
        }
        if (this.getCapabilityValue('meter_power.consumed.t3') != data.total_power_import_t3_kwh)
        { promises.push(this.setCapabilityValue('meter_power.consumed.t3', data.total_power_import_t3_kwh).catch(this.error)); }
      }
      else if ((data.total_power_import_t3_kwh == undefined) && (this.hasCapability('meter_power.consumed.t3'))) {
        promises.push(this.removeCapability('meter_power.consumed.t3').catch(this.error));
      }

      if (data.total_power_export_t3_kwh !== undefined) {
        if (!this.hasCapability('meter_power.produced.t3')) {
          promises.push(this.addCapability('meter_power.produced.t3').catch(this.error));
        }
        if (this.getCapabilityValue('meter_power.produced.t3') != data.total_power_export_t3_kwh)
        { promises.push(this.setCapabilityValue('meter_power.produced.t3', data.total_power_export_t3_kwh).catch(this.error)); }
      }
      else if ((data.total_power_export_t3_kwh == undefined) && (this.hasCapability('meter_power.produced.t3'))) {
        promises.push(this.removeCapability('meter_power.produced.t3').catch(this.error));
      }

      // Accessing external data
      const externalData = data.external;

      // Belgium water meter using external source (P1)
      let latestWaterData = null;
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
      }

      if (latestWaterData) {
        // Access water data
        const waterValue = latestWaterData.value;

        if (!this.hasCapability('meter_water')) {
          promises.push(this.addCapability('meter_water').catch(this.error));
        }

        if (this.getCapabilityValue('meter_water') != waterValue)
        { promises.push(this.setCapabilityValue('meter_water', waterValue).catch(this.error)); }

      } else if (this.hasCapability('meter_water')) {
        promises.push(this.removeCapability('meter_water').catch(this.error));
        console.log('Removed meter as there is no water meter in P1.');
      }

      // Execute all promises concurrently using Promise.all()
      Promise.all(promises);

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
