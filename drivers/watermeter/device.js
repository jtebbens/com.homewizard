'use strict'

const Homey = require('homey')
const fetch = require('node-fetch')

const POLL_INTERVAL = 1000 * 10 // 10 seconds

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {
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

      const offset_water_m3 = this.getSetting('offset_water')

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_water')) {
        await this.addCapability('measure_water').catch(this.error)
      }

      if (!this.hasCapability('meter_water')) {
        await this.addCapability('meter_water').catch(this.error)
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error)
      }

      const temp_total_liter_m3 = data.total_liter_m3 + offset_water_m3

      // Update values
      if (this.getCapabilityValue('measure_water') != data.active_liter_lpm) { await this.setCapabilityValue('measure_water', data.active_liter_lpm).catch(this.error) }
      if (this.getCapabilityValue('meter_water') != temp_total_liter_m3) { await this.setCapabilityValue('meter_water', temp_total_liter_m3).catch(this.error) }
      if (this.getCapabilityValue('rssi') != data.wifi_strength) { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error) }
    })
      .then(() => {
        this.setAvailable().catch(this.error)
      })
      .catch(err => {
        this.error(err)
        this.setUnavailable(err).catch(this.error)
      })
  }

  // Catch offset updates
  onSettings (oldSettings, newSettings, changedKeys) {
    this.log('Settings updated')
    // Update display values if offset has changed
    for (const k in changedKeys) {
      const key = changedKeys[k]
      if (key.slice(0, 7) === 'offset_') {
        const cap = 'meter_' + key.slice(7)
        const value = this.getCapabilityValue(cap)
        const delta = newSettings[key] - oldSettings[key]
        this.log('Updating value of', cap, 'from', value, 'to', value + delta)
        this.setCapabilityValue(cap, value + delta)
          .catch(err => this.error(err))
      }
    }
    // return true;
  }

  updateValue (cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value)
    const cap_offset = cap.replace('meter', 'offset')
    const offset = this.getSetting(cap_offset)
    this.log(cap_offset, offset)
    if (offset != null) {
      value += offset
    }
    this.setCapabilityValue(cap, value)
      .catch(err => this.error(err))
  }
}
