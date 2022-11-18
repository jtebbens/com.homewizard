'use strict'

const Homey = require('homey')
const fetch = require('node-fetch')

const POLL_INTERVAL = 1000 * 10 // 10 seconds

module.exports = class HomeWizardEnergyDevice extends Homey.Device {
  onInit () {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL)
  }

  onDeleted () {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval)
    }
  }

  async onDiscoveryAvailable (discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`
    this.log(`URL: ${this.url}`)
    this.onPoll()
  }

  onDiscoveryAddressChanged (discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`
    this.log(`URL: ${this.url}`)
    this.onPoll()
  }

  onPoll () {
    if (!this.url) return

    Promise.resolve().then(async () => {
      const res = await fetch(`${this.url}/data`)
      if (!res.ok) { throw new Error(res.statusText) }

      const data = await res.json()

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_power')) {
        await this.addCapability('measure_power').catch(this.error)
      }

      if (this.hasCapability('measure_power.active_power_w')) {
        await this.removeCapability('measure_power.active_power_w').catch(this.error)
      } // remove

      if (!this.hasCapability('meter_power.consumed.t1')) {
        await this.addCapability('meter_power.consumed.t1').catch(this.error)
        await this.addCapability('meter_power.consumed.t2').catch(this.error)
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error)
      }

      // Update values
      if (this.getCapabilityValue('measure_power') != data.active_power_w) { await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error) }
      if (this.getCapabilityValue('meter_power.consumed.t1') != data.total_power_import_t1_kwh) { await this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error) }
      if (this.getCapabilityValue('meter_power.consumed.t2') != data.total_power_import_t2_kwh) { await this.setCapabilityValue('meter_power.consumed.t2', data.total_power_import_t2_kwh).catch(this.error) }
      if (this.getCapabilityValue('rssi') != data.wifi_strength) { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error) }

      // Not all users have a gas meter in their system (if NULL ignore creation or even delete from view)
      if (data.total_gas_m3 !== null) {
        if (!this.hasCapability('meter_gas')) {
          await this.addCapability('meter_gas').catch(this.error)
        }
        if (this.getCapabilityValue('meter_gas') != data.total_gas_m3) { this.setCapabilityValue('meter_gas', data.total_gas_m3).catch(this.error) }
      } else if (data.total_gas_m3 == null) {
        // delete gas meter
        await this.removeCapability('meter_gas').catch(this.error)
      }

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if (data.total_power_export_t2_kwh > 1) {
        if (!this.hasCapability('meter_power.produced.t1')) {
          // add production meters
          await this.addCapability('meter_power.produced.t1').catch(this.error)
          await this.addCapability('meter_power.produced.t2').catch(this.error)
        }
        // update values for solar production
        if (this.getCapabilityValue('meter_power.produced.t1') != data.total_power_export_t1_kwh) { await this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error) }
        if (this.getCapabilityValue('meter_power.produced.t2') != data.total_power_export_t2_kwh) { await this.setCapabilityValue('meter_power.produced.t2', data.total_power_export_t2_kwh).catch(this.error) }
      } else if (data.total_power_export_t2_kwh < 1) {
        await this.removeCapability('meter_power.produced.t1').catch(this.error)
        await this.removeCapability('meter_power.produced.t2').catch(this.error)
      }

      // aggregated meter for Power by the hour support
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error)
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      if (data.total_power_import_kwh == null) {
        if (this.getCapabilityValue('meter_power') != ((data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh))) { this.setCapabilityValue('meter_power', ((data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh))).catch(this.error) }
      }
      // Sweden P1 has only total_power_import_kwh
      else if (data.total_power_import_kwh !== null) {
        if (this.getCapabilityValue('meter_power') != (data.total_power_import_kwh - data.total_power_export_t1_kwh)) { this.setCapabilityValue('meter_power', (data.total_power_import_kwh - data.total_power_export_t1_kwh)).catch(this.error) }
      }
      // Phase 3 support when meter has values active_power_l2_w will be valid else ignore ie the power grid is a Phase1 household connection
      if (data.active_power_l2_w !== null) {
        if (!this.hasCapability('measure_power.l2')) {
          await this.addCapability('measure_power.l1').catch(this.error)
          await this.addCapability('measure_power.l2').catch(this.error)
          await this.addCapability('measure_power.l3').catch(this.error)
        }
        if (this.getCapabilityValue('measure_power.l1') != data.active_power_l1_w) { this.setCapabilityValue('measure_power.l1', data.active_power_l1_w).catch(this.error) }
        if (this.getCapabilityValue('measure_power.l2') != data.active_power_l2_w) { this.setCapabilityValue('measure_power.l2', data.active_power_l2_w).catch(this.error) }
        if (this.getCapabilityValue('measure_power.l3') != data.active_power_l3_w) { this.setCapabilityValue('measure_power.l3', data.active_power_l3_w).catch(this.error) }
      } else if (data.active_power_l2_w == null) {
        if (this.hasCapability('measure_power.l2')) {
          await this.removeCapability('measure_power.l1').catch(this.error)
          await this.removeCapability('measure_power.l2').catch(this.error)
          await this.removeCapability('measure_power.l3').catch(this.error)
          await this.removeCapability('measure_power.active_power_w').catch(this.error)
        }
      }
    })
      .then(() => {
        this.setAvailable().catch(this.error)
      })
      .catch(err => {
        this.error(err)
        this.setUnavailable(err).catch(this.error)
      })
  }
}
