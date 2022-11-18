'use strict'

const Homey = require('homey')
const fetch = require('node-fetch')

const POLL_INTERVAL = 1000 * 2 // 2 seconds
const POLL_STATE_INTERVAL = 1000 * 5 // 5 seconds

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {
  onInit () {
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL)
    this.onPollStateInterval = setInterval(this.onPollState.bind(this), POLL_STATE_INTERVAL)

    if (this.getClass() == 'sensor') {
      this.setClass('socket')
    };

    this.registerCapabilityListener('onoff', async (value) => {
      if (this.getCapabilityValue('locked')) { throw new Error('Device is locked') }

      await this.onRequest({ power_on: value })
    })

    this.registerCapabilityListener('dim', async (value) => {
      await this.onRequest({ brightness: (255 * value) })
    })

    this.registerCapabilityListener('locked', async (value) => {
      await this.onRequest({ switch_lock: value })
    })
  }

  onDeleted () {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval)
    }
    if (this.onPollStateInterval) {
      clearInterval(this.onPollStateInterval)
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

  async onRequest (body) {
    if (!this.url) return

    const res = await fetch(`${this.url}/state`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    }).catch(this.error)

    if (!res.ok) { throw new Error(res.statusText) }
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
      }

      if (!this.hasCapability('measure_power.l1')) {
        await this.addCapability('measure_power.l1').catch(this.error)
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error)
      }

      // Update values
      if (this.getCapabilityValue('measure_power') != data.active_power_w) { await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error) }
      if (this.getCapabilityValue('meter_power.consumed.t1') != data.total_power_import_t1_kwh) { await this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error) }
      if (this.getCapabilityValue('measure_power.l1') != data.active_power_l1_w) { await this.setCapabilityValue('measure_power.l1', data.active_power_l1_w).catch(this.error) }
      if (this.getCapabilityValue('rssi') != data.wifi_strength) { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error) }

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if (data.total_power_export_t1_kwh > 1) {
        if (!this.hasCapability('meter_power.produced.t1')) {
          // add production meters
          await this.addCapability('meter_power.produced.t1').catch(this.error)
        }
        // update values for solar production
        if (this.getCapabilityValue('meter_power.produced.t1') != data.total_power_export_t1_kwh) { await this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error) }
      } else if (data.total_power_export_t1_kwh < 1) {
        await this.removeCapability('meter_power.produced.t1').catch(this.error)
      }

      // aggregated meter for Power by the hour support
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error)
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      if (this.getCapabilityValue('meter_power') != (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh)) { this.setCapabilityValue('meter_power', (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh)).catch(this.error) }
    })
      .then(() => {
        this.setAvailable().catch(this.error)
      })
      .catch(err => {
        this.error(err)
        this.setUnavailable(err).catch(this.error)
      })
  }

  onPollState () {
    if (!this.url) return

    Promise.resolve().then(async () => {
      const res = await fetch(`${this.url}/state`).catch(this.error) // Error: Not Found
      if (!res.ok) { throw new Error(res.statusText) }

      const data = await res.json()

      if (!this.hasCapability('onoff')) {
        await this.addCapability('onoff').catch(this.error)
      }

      if (!this.hasCapability('dim')) {
        await this.addCapability('dim').catch(this.error)
      }

      if (!this.hasCapability('locked')) {
        await this.addCapability('locked').catch(this.error)
      }

      // Update values
      if (this.getCapabilityValue('onoff') != data.power_on) { await this.setCapabilityValue('onoff', data.power_on).catch(this.error) }
      if (this.getCapabilityValue('dim') != data.brightness) { await this.setCapabilityValue('dim', data.brightness * (1 / 255)).catch(this.error) }
      if (this.getCapabilityValue('locked') != data.switch_lock) { await this.setCapabilityValue('locked', data.switch_lock).catch(this.error) }
    })
      .catch(err => {
        this.error(err)
      })
  }
}
