'use strict'

const Homey = require('homey')
const homewizard = require('./../../includes/homewizard.js')
// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('kakusensors');
const debug = false

let refreshIntervalId
const devices = {}
const thermometers = {}

class HomeWizardKakusensors extends Homey.Device {
  onInit () {
    if (debug) { console.log('HomeWizard Kakusensors ' + this.getName() + ' has been inited') }

    const devices = this.homey.drivers.getDriver('homewizard').getDevices()

    devices.forEach(function initdevice (device) {
      if (debug) { console.log('add device: ' + JSON.stringify(device.getName())) }

      devices[device.getData().id] = device
      devices[device.getData().id].settings = device.getSettings()
    })

    if (Object.keys(devices).length > 0) {
		  this.startPolling(devices)
    }
  }

  startPolling (devices) {
    const me = this

    // Clear interval
    if (refreshIntervalId) {
      clearInterval(refreshIntervalId)
    }

    // Start polling for thermometer
    refreshIntervalId = setInterval(function () {
      if (debug) { console.log('--Start Kakusensors Polling-- ') }

      me.getStatus(devices)
    }, 1000 * 20)
  }

  getStatus (devices) {
    if (debug) { console.log('Start Polling') }
    const me = this
    let sensor_status = null
    let lowBattery_status = null

    for (var index in devices) {
      if (devices[index].settings.homewizard_id !== undefined) {
        const homewizard_id = devices[index].settings.homewizard_id
        var kakusensor_id = devices[index].settings.kakusensor_id
        homewizard.getDeviceData(homewizard_id, 'kakusensors', function (result) {
					 if (Object.keys(result).length > 0) {
					 try {
              for (const index2 in result) {
                if (result[index2].id == kakusensor_id) {
                  // BEGIN
                  const sensor_status_temp = result[index2].status // READ STATUS OF kakusensor_id
                  if (sensor_status_temp == 'yes') {
                    sensor_status = true
                  } else { sensor_status = false }
                  if (result[index2].type == 'motion') {
                    // MOTION SENSOR 	alarm_motion
                    // me.removeCapability('alarm_smoke');
                    if (!devices[index].hasCapability('alarm_motion')) {
        							devices[index].addCapability('alarm_motion').catch(me.error)
      							}

                    if (devices[index].getCapabilityValue('alarm_motion') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_motion', sensor_status).catch(me.error)
                    }
                  }

                  if (result[index2].type == 'smoke868') {
                    // MOTION SENSOR 	alarm_smoke
                    if (!devices[index].hasCapability('alarm_smoke')) {
                      devices[index].addCapability('alarm_smoke').catch(me.error)
                    }
                    if (devices[index].getCapabilityValue('alarm_smoke') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_smoke', sensor_status).catch(me.error)
                    }

                    try {
                      if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
                        if (debug) { console.log(result[index2].lowBattery) }
                        if (!devices[index].hasCapability('alarm_battery')) {
                          devices[index].addCapability('alarm_battery').catch(me.error)
                        }

                        var lowBattery_temp = result[index2].lowBattery
                        if (lowBattery_temp == 'yes') {
                          lowBattery_status = true
                        } else {
                          lowBattery_status = false
												 }
												 if (devices[index].getCapabilityValue('alarm_battery') != lowBattery_status) {
                          console.log('New status - ' + lowBattery_status)
                          devices[index].setCapabilityValue('alarm_battery', lowBattery_status).catch(me.error)
                        }
                      }
                    } catch (e) {
                      console.log(e)
                    }
                  }

                  if (result[index2].type == 'leakage') {
                    // MOTION SENSOR 	alarm_water
                    if (!devices[index].hasCapability('alarm_water')) {
                      devices[index].addCapability('alarm_water').catch(me.error)
                    }
                    if (devices[index].getCapabilityValue('alarm_water') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_water', sensor_status).catch(me.error)
                    }

                    try {
                      if (result[index2].lowBattery != undefined && result[index2].lowBattery != null) {
                        if (debug) { console.log(result[index2].lowBattery) }
                        if (!devices[index].hasCapability('alarm_battery')) {
                          devices[index].addCapability('alarm_battery').catch(me.error)
                        }

                        var lowBattery_temp = result[index2].lowBattery
                        if (lowBattery_temp == 'yes') {
                          lowBattery_status = true
                        } else {
                          lowBattery_status = false
												 }
												 if (devices[index].getCapabilityValue('alarm_battery') != lowBattery_status) {
                          console.log('New status - ' + lowBattery_status)
                          devices[index].setCapabilityValue('alarm_battery', lowBattery_status).catch(me.error)
                        }
                      }
                    } catch (e) {
                      console.log(e)
                    }
                  }

                  if (result[index2].type == 'smoke') {
                    // MOTION SENSOR 	alarm_smoke
                    if (!devices[index].hasCapability('alarm_smoke')) {
                      devices[index].addCapability('alarm_smoke').catch(me.error)
                    }
                    if (devices[index].hasCapability('alarm_battery')) {
                      devices[index].removeCapability('alarm_battery').catch(me.error)
                    }

                    if (devices[index].getCapabilityValue('alarm_smoke') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_smoke', sensor_status).catch(me.error)
                    }
                  }

                  if (result[index2].type == 'contact') {
                    // MOTION SENSOR 	alarm_smoke
                    if (!devices[index].hasCapability('alarm_contact')) {
                      devices[index].addCapability('alarm_contact').catch(me.error)
                    }
                    if (devices[index].getCapabilityValue('alarm_contact') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_contact', sensor_status).catch(me.error)
                    }
                  }

                  if (result[index2].type == 'doorbell') {
                    // MOTION SENSOR 	alarm_smoke
                    if (!devices[index].hasCapability('alarm_generic')) {
                      devices[index].addCapability('alarm_generic').catch(me.error)
                    }
                    if (devices[index].getCapabilityValue('alarm_generic') != sensor_status) {
                      if (debug) { console.log('New status - ' + sensor_status) }
                      devices[index].setCapabilityValue('alarm_generic', sensor_status).catch(me.error)
                    }
                  }
                }
              }
            } catch (err) {
              console.log(err)
              console.log('Kakusensors data corrupt')
            }
          }
        })
      }
    }
  }

  onDeleted () {
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId)
      if (debug) { console.log('--Stopped Polling--') }
    }

    console.log('deleted: ' + JSON.stringify(this))
  }
}

module.exports = HomeWizardKakusensors
