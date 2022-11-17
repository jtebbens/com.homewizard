'use strict'

const Homey = require('homey')
// const { ManagerDrivers } = require('homey');
// const drivers = ManagerDrivers.getDriver('homewizard');
// const { ManagerI18n } = require('homey');

const homewizard = require('./../../includes/homewizard.js')
let refreshIntervalId
const homeWizard_devices = {}

let preset_text = ''
const preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie']
const preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday']

const debug = false

class HomeWizardDevice extends Homey.Device {
  onInit () {
    if (debug) { console.log('HomeWizard Appliance has been inited') }

    const devices = this.homey.drivers.getDriver('homewizard').getDevices()

    devices.forEach(function initdevice (device) {
      console.log('add device: ' + JSON.stringify(device.getName()))

      homeWizard_devices[device.getData().id] = {}
      homeWizard_devices[device.getData().id].name = device.getName()
      homeWizard_devices[device.getData().id].settings = device.getSettings()
    })

    homewizard.setDevices(homeWizard_devices)
    homewizard.startpoll()

    if (Object.keys(homeWizard_devices).length > 0) {
      this.startPolling(devices)
    }

    // Init flow triggers
    this._flowTriggerPresetChanged = this.homey.flow.getDeviceTriggerCard('preset_changed')
  }

  flowTriggerPresetChanged (device, tokens) {
    this._flowTriggerPresetChanged.trigger(device, tokens).catch(this.error)
  }

  startPolling (devices) {
    const me = this

    if (refreshIntervalId) {
      clearInterval(refreshIntervalId)
    }
    refreshIntervalId = setInterval(function () {
      if (debug) { me.log('--Start HomeWizard Polling-- ') }
      if (debug) { console.log('--Start HomeWizard Polling-- ') }

      me.getStatus(devices)
    }, 1000 * 20)
  }

  getStatus (devices) {
    Promise.resolve().then(async () => {
      // var me = this;

      const homey_lang = this.homey.i18n.getLanguage()

      for (var index in devices) {
        homewizard.getDeviceData(devices[index].getData().id, 'preset', async function (callback) { // async added
          try {
            if (devices[index].getStoreValue('preset') === null) {
              if (debug) { this.log('Preset was set to ' + callback) }

              devices[index].getStoreValue('preset', callback)
            }

            if (devices[index].getStoreValue('preset') != callback) {
              await devices[index].setStoreValue('preset', callback).catch(this.error)

              if (debug) { this.log('Flow call! -> ' + callback) }

              if (homey_lang == 'nl') {
                preset_text = preset_text_nl[callback]
              } else {
                preset_text = preset_text_en[callback]
              }
              this.flowTriggerPresetChanged(devices[index], { preset: callback, preset_text })

              if (debug) { this.log('Preset was changed! ->' + preset_text) }
            }
          } catch (err) {
            console.log('HomeWizard data corrupt')
            console.log(err)
          }
        })
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

module.exports = HomeWizardDevice
