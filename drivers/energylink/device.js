'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

const debug = false;

class HomeWizardEnergylink extends Homey.Device {

  async onInit() {

    this.startPolling();

    // Flow triggers
    this._flowTriggerPowerUsed = this.homey.flow.getDeviceTriggerCard('power_used_changed');
    this._flowTriggerPowerNetto = this.homey.flow.getDeviceTriggerCard('power_netto_changed');
    this._flowTriggerPowerS1 = this.homey.flow.getDeviceTriggerCard('power_s1_changed');
    this._flowTriggerMeterPowerS1 = this.homey.flow.getDeviceTriggerCard('meter_power_s1_changed');
    this._flowTriggerPowerS2 = this.homey.flow.getDeviceTriggerCard('power_s2_changed');
    this._flowTriggerMeterPowerS2 = this.homey.flow.getDeviceTriggerCard('meter_power_s2_changed');
    this._flowTriggerMeterPowerUsed = this.homey.flow.getDeviceTriggerCard('meter_power_used_changed');
    this._flowTriggerMeterPowerAggregated = this.homey.flow.getDeviceTriggerCard('meter_power_aggregated_changed');
    this._flowTriggerMeterReturnT1 = this.homey.flow.getDeviceTriggerCard('meter_return_t1_changed');
    this._flowTriggerMeterReturnT2 = this.homey.flow.getDeviceTriggerCard('meter_return_t2_changed');
  }

  startPolling() {

    // Clear previous intervals
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId);
    if (this.refreshIntervalIdReadings) clearInterval(this.refreshIntervalIdReadings);

    // Status polling every 20 seconds
    this.refreshIntervalId = setInterval(() => {
      if (debug) this.log('-- EnergyLink Status Polling --');

      if (this.getSetting('homewizard_id')) {
        this.getStatus();
      }
    }, 20 * 1000);

    // Readings polling every 60 seconds
    this.refreshIntervalIdReadings = setInterval(() => {
      if (debug) this.log('-- EnergyLink Readings Polling --');

      if (this.getSetting('homewizard_id')) {
        this.getReadings();
      }
    }, 60 * 1000);
  }

  // -----------------------------
  // STATUS POLLING
  // -----------------------------
  async getStatus() {

    const homewizard_id = this.getSetting('homewizard_id');
    if (!homewizard_id) return;

    try {
      const callback = await homewizard.getDeviceData(homewizard_id, 'energylinks');

      // Safe guard: must be array with at least 1 entry
      if (!Array.isArray(callback) || callback.length === 0) {
        this.setUnavailable('No EnergyLink data available');
        return;
      }

      const entry = callback[0];
      if (!entry) return;

      this.setAvailable().catch(this.error);

      const promises = [];

      // -----------------------------
      // BASIC VALUES
      // -----------------------------
      const value_s1 = entry.t1;
      const value_s2 = entry.t2;

      const energy_current_cons = entry.used?.po ?? 0;
      const energy_daytotal_cons = entry.used?.dayTotal ?? 0;
      const energy_daytotal_aggr = entry.aggregate?.dayTotal ?? 0;
      const energy_current_netto = entry.aggregate?.po ?? 0;

      // -----------------------------
      // GAS (optional)
      // -----------------------------
      try {
        const gas_daytotal_cons = entry.gas?.dayTotal;
        if (gas_daytotal_cons != null) {
          promises.push(this.setCapabilityValue('meter_gas.today', gas_daytotal_cons).catch(this.error));
        }
      } catch (_) {
        this.log('No gas information available');
      }

      // -----------------------------
      // ELECTRICITY (common)
      // -----------------------------
      promises.push(this.setCapabilityValue('measure_power.used', energy_current_cons).catch(this.error));
      promises.push(this.setCapabilityValue('measure_power', energy_current_netto).catch(this.error));
      promises.push(this.setCapabilityValue('measure_power.netto', energy_current_netto).catch(this.error));
      promises.push(this.setCapabilityValue('meter_power.used', energy_daytotal_cons).catch(this.error));
      promises.push(this.setCapabilityValue('meter_power.aggr', energy_daytotal_aggr).catch(this.error));

      // -----------------------------
      // SOLAR / WATER / OTHER / CAR
      // -----------------------------
      let solar_current_prod = 0;
      let solar_daytotal_prod = 0;

      let water_current_cons = 0;
      let water_daytotal_cons = 0;

      // S1 solar
      if (value_s1 === 'solar') {
        const po = entry.s1?.po ?? 0;
        const dt = entry.s1?.dayTotal ?? 0;

        solar_current_prod += po;
        solar_daytotal_prod += dt;

        if (this.hasCapability('meter_power.s1other')) {
          promises.push(this.removeCapability('meter_power.s1other').catch(this.error));
          promises.push(this.removeCapability('measure_power.s1other').catch(this.error));
        }
      }

      // S2 solar
      if (value_s2 === 'solar') {
        const po = entry.s2?.po ?? 0;
        const dt = entry.s2?.dayTotal ?? 0;

        if (!this.hasCapability('measure_power.s2')) {
          await this.addCapability('measure_power.s2').catch(this.error);
          await this.addCapability('meter_power.s2').catch(this.error);
        }

        promises.push(this.setCapabilityValue('measure_power.s2', po).catch(this.error));
        promises.push(this.setCapabilityValue('meter_power.s2', dt).catch(this.error));

        solar_current_prod += po;
        solar_daytotal_prod += dt;

        if (this.hasCapability('meter_power.s2other')) {
          promises.push(this.removeCapability('meter_power.s2other').catch(this.error));
          promises.push(this.removeCapability('measure_power.s2other').catch(this.error));
        }
      }

      // Apply solar totals
      if (value_s1 === 'solar' || value_s2 === 'solar') {
        promises.push(this.setCapabilityValue('measure_power.s1', solar_current_prod).catch(this.error));
        promises.push(this.setCapabilityValue('meter_power.s1', solar_daytotal_prod).catch(this.error));
      }

      // S1 water
      if (value_s1 === 'water') {
        water_current_cons = entry.s1?.po ?? 0;
        water_daytotal_cons = (entry.s1?.dayTotal ?? 0) / 1000;

        promises.push(this.setCapabilityValue('meter_water', water_daytotal_cons).catch(this.error));
        promises.push(this.setCapabilityValue('measure_water', water_current_cons).catch(this.error));
      }

      // S2 water
      if (value_s2 === 'water') {
        water_current_cons = entry.s2?.po ?? 0;
        water_daytotal_cons = (entry.s2?.dayTotal ?? 0) / 1000;

        promises.push(this.setCapabilityOptions('meter_water', { decimals: 3 }).catch(this.error));
        promises.push(this.setCapabilityValue('meter_water', water_daytotal_cons).catch(this.error));
        promises.push(this.setCapabilityValue('measure_water', water_current_cons).catch(this.error));
      }

      // S1 other/car
      if (value_s1 === 'other' || value_s1 === 'car') {
        const po = entry.s1?.po ?? 0;
        const dt = entry.s1?.dayTotal ?? 0;

        promises.push(this.setCapabilityValue('meter_power.s1other', dt).catch(this.error));
        promises.push(this.setCapabilityValue('measure_power.s1other', po).catch(this.error));
      }

      // S2 other/car
      if (value_s2 === 'other' || value_s2 === 'car') {
        const po = entry.s2?.po ?? 0;
        const dt = entry.s2?.dayTotal ?? 0;

        promises.push(this.setCapabilityValue('meter_power.s2other', dt).catch(this.error));
        promises.push(this.setCapabilityValue('measure_power.s2other', po).catch(this.error));
      }

      // -----------------------------
      // FLOW TRIGGERS (safe)
      // -----------------------------
      if (energy_current_cons != null &&
          energy_current_cons !== this.getStoreValue('last_measure_power_used')) {

        promises.push(this._flowTriggerPowerUsed.trigger(this, { power_used: energy_current_cons }));
        this.setStoreValue('last_measure_power_used', energy_current_cons);
      }

      if (energy_current_netto != null &&
          energy_current_netto !== this.getStoreValue('last_measure_power_netto')) {

        promises.push(this._flowTriggerPowerNetto.trigger(this, { netto_power_used: energy_current_netto }));
        this.setStoreValue('last_measure_power_netto', energy_current_netto);
      }

      // Execute all updates
      await Promise.allSettled(promises);

      this.setAvailable().catch(this.error);

    } catch (err) {
      this.log('ERROR EnergyLink getStatus', err);
      this.setUnavailable(err);
    }
  }

  // -----------------------------
  // READINGS POLLING
  // -----------------------------
  async getReadings() {

    const homewizard_id = this.getSetting('homewizard_id');
    if (!homewizard_id) return;

    try {
      const callback = await homewizard.getDeviceData(homewizard_id, 'energylink_el');

      // Must have at least 3 entries
      if (!Array.isArray(callback) || callback.length < 3) {
        return;
      }

      this.setAvailable().catch(this.error);

      const gas = callback[2]?.consumed ?? 0;
      const cons_t1 = callback[0]?.consumed ?? 0;
      const prod_t1 = callback[0]?.produced ?? 0;
      const cons_t2 = callback[1]?.consumed ?? 0;
      let prod_t2 = callback[1]?.produced ?? 0;

      if (prod_t2 < 0) prod_t2 = -prod_t2;

      const aggregated = (cons_t1 + cons_t2) - (prod_t1 + prod_t2);

      // Ensure capabilities exist
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error);
      }
      if (!this.hasCapability('meter_gas')) {
        await this.addCapability('meter_gas').catch(this.error);
      }

      // Update values
      this.setCapabilityValue('meter_gas.reading', gas).catch(this.error);
      this.setCapabilityValue('meter_gas', gas).catch(this.error);
      this.setCapabilityValue('meter_power', aggregated).catch(this.error);
      this.setCapabilityValue('meter_power.consumed.t1', cons_t1).catch(this.error);
      this.setCapabilityValue('meter_power.produced.t1', prod_t1).catch(this.error);
      this.setCapabilityValue('meter_power.consumed.t2', cons_t2).catch(this.error);
      this.setCapabilityValue('meter_power.produced.t2', prod_t2).catch(this.error);

      // Flow triggers
      if (prod_t1 != null && prod_t1 !== this.getStoreValue('last_meter_return_t1')) {
        this._flowTriggerMeterReturnT1.trigger(this, { meter_power_produced_t1: prod_t1 });
        this.setStoreValue('last_meter_return_t1', prod_t1);
      }

      if (prod_t2 != null && prod_t2 !== this.getStoreValue('last_meter_return_t2')) {
        this._flowTriggerMeterReturnT2.trigger(this, { meter_power_produced_t2: prod_t2 });
        this.setStoreValue('last_meter_return_t2', prod_t2);
      }

    } catch (err) {
      this.log('ERROR EnergyLink getReadings', err);
      this.setUnavailable(err);
    }
  }

  onDeleted() {
    const deviceId = this.getData().id;
    homewizard.removeDevice(deviceId);
    
    clearInterval(this.refreshIntervalId);
    clearInterval(this.refreshIntervalIdReadings);
    this.log('-- EnergyLink Polling Stopped --');
  }
}

module.exports = HomeWizardEnergylink;
