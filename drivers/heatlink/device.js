'use strict'

const Homey = require('homey')
const homewizard = require('./../../includes/homewizard.js')
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('heatlink');

let refreshIntervalId
const devices = {}
let temperature

class HomeWizardHeatlink extends Homey.Device {
  onInit () {
    console.log('HomeWizard Heatlink ' + this.getName() + ' has been inited')

    const devices = this.homey.drivers.getDriver('heatlink').getDevices() // or heatlink
    devices.forEach(function initdevice (device) {
      console.log('add device: ' + JSON.stringify(device.getName()))

      devices[device.getData().id] = device
      devices[device.getData().id].settings = device.getSettings()
    })

    this.startPolling()

    this.registerCapabilityListener('target_temperature', (temperature, opts) => {
      // Catch faulty trigger and max/min temp
      if (!temperature) {
        callback(true, temperature)
        return false
      } else if (temperature < 5) {
        temperature = 5
      } else if (temperature > 35) {
        temperature = 35
      }
      temperature = Math.round(temperature.toFixed(1) * 2) / 2

      return new Promise((resolve, reject) => {
        const url = '/hl/0/settarget/' + temperature
        console.log(url) // Console log url
        const homewizard_id = this.getSetting('homewizard_id')
			    homewizard.callnew(homewizard_id, '/hl/0/settarget/' + temperature, function (err, response) {
          if (err) {
            console.log('ERR settarget target_temperature -> returned false')
            return resolve(false)
          }
          console.log('settarget target_temperature - returned true')
          return resolve(true)
        })
      })
      return Promise.resolve()
    })
  }

  startPolling () {
    const me = this

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId)
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(function () {
      console.log('--Start Heatlink Polling-- ')

      me.getStatus()
    }, 1000 * 20)
  }

  getStatus () {
    const me = this

    if (this.getSetting('homewizard_id') !== undefined) {
      const homewizard_id = this.getSetting('homewizard_id')

      // me.log('Gather data');

      homewizard.getDeviceData(homewizard_id, 'heatlinks', async function (callback) {
        if (Object.keys(callback).length > 0) {
          try {
            me.setAvailable()
            if (callback[0].rte != null) {
              var rte = (callback[0].rte.toFixed(1) * 2) / 2
                		var rsp = (callback[0].rsp.toFixed(1) * 2) / 2
                		var tte = (callback[0].tte.toFixed(1) * 2) / 2
            }
            // Check current temperature
            if (me.getStoreValue('temperature') != rte) {
						  console.log('New RTE - ' + rte)
              await me.setCapabilityValue('measure_temperature', rte).catch(me.error)
              await me.setStoreValue('temperature', rte).catch(me.error)
            } else {
						  console.log('RTE: no change')
            }

            // Check thermostat temperature
            if (me.getStoreValue('thermTemperature') != rsp) {
						  console.log('New RSP - ' + rsp)
						  if (me.getStoreValue('setTemperature') === 0) {
							  await me.setCapabilityValue('target_temperature', rsp).catch(me.error)
						  }
              await me.setStoreValue('thermTemperature', rsp).catch(me.error)
            } else {
						  console.log('RSP: no change')
            }

            // Check heatlink set temperature
            if (me.getStoreValue('setTemperature') != tte) {
						  console.log('New TTE - ' + tte)
						  if (tte > 0) {
							  await me.setCapabilityValue('target_temperature', tte).catch(me.error)
						  } else {
							  await me.setCapabilityValue('target_temperature', me.getStoreValue('thermTemperature')).catch(me.error)
						  }
              await me.setStoreValue('setTemperature', tte).catch(me.error)
            } else {
						  console.log('TTE: no change')
            }
          } catch (err) {
            console.log('Heatlink data corrupt', err)
            me.setUnavailable()
          }
        } else {
          me.log('No data')
        }
      })
    } else {
      console.log('HW ID not found')
      if (Object.keys(devices).length === 1) {
        clearInterval(refreshIntervalId)
      }
    }
  }

  onDeleted () {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId)
      console.log('--Stopped Polling--')
    }

    console.log('deleted: ' + JSON.stringify(this))
  }
}

module.exports = HomeWizardHeatlink
