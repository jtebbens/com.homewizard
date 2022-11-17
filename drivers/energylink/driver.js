'use strict'

const Homey = require('homey')

// const { ManagerDrivers } = require('homey');
// const driver = ManagerDrivers.getDriver('homewizard');

const homewizard = require('./../../includes/homewizard.js')
let homewizard_devices
const devices = {}

class HomeWizardEnergyLink extends Homey.Driver {
  onInit () {
    console.log('HomeWizard EnergyLink has been inited')
  }

  async onPair (socket) {
    // Show a specific view by ID
    await socket.showView('start')

    // Show the next view
    await socket.nextView()

    // Show the previous view
    await socket.prevView()

    // Close the pair session
    await socket.done()

    // Received when a view has changed
    socket.setHandler('showView', async function (viewId) {
      if (errorMsg) {
        Homey.app.log('[Driver] - Show errorMsg:', errorMsg)
        socket.emit('error_msg', errorMsg)
        errorMsg = false
      }
    })

    // socket.on('get_homewizards', function () {

    socket.setHandler('get_homewizards', () => {
      homewizard_devices = this.homey.drivers.getDriver('homewizard').getDevices()

      // homewizard_devices = driver.getDevices();

      homewizard.getDevices(function (homewizard_devices) {
        const hw_devices = {}

        Object.keys(homewizard_devices).forEach(function (key) {
          const energylinks = JSON.stringify(homewizard_devices[key].polldata.energylinks)

          hw_devices[key] = homewizard_devices[key]
          hw_devices[key].id = key
          hw_devices[key].polldata = {}
          hw_devices[key].energylinks = energylinks
        })

        socket.emit('hw_devices', hw_devices)
      })
    })

    socket.setHandler('manual_add', async function (device) {
      console.log(device.settings.homewizard_id)
      console.log(device.settings.homewizard_id.indexOf('HW_'))

      console.log(device.settings.homewizard_id)
      console.log(device.settings.homewizard_id.indexOf('HW'))

      if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
        // true
        console.log('Energylink added ' + device.data.id)

        devices[device.data.id] = {
          id: device.data.id,
          name: 'EnergyLink',
          settings: device.settings
        }
        // callback( null, devices );
        socket.emit('success', device)
        return devices
      } else {
        socket.emit('error', 'No valid HomeWizard found, re-pair if problem persists')
      }
    })

    socket.setHandler('disconnect', async function () {
      console.log('User aborted pairing, or pairing is finished')
    })
  }
}

module.exports = HomeWizardEnergyLink
