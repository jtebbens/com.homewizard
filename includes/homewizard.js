'use strict'
// var tcpPortUsed = require('tcp-port-used');
const fetch = require('node-fetch')
const AbortController = require('abort-controller')
// const axios = require("axios");
// const getJson = require("axios-get-json-response");
// axios.defaults.timeout === 15000;
const Homey = require('homey')

module.exports = (function () {
  const homewizard = {}
  const self = {}
  self.devices = []
  self.polls = []
  const debug = false

  homewizard.setDevices = function (devices) {
    self.devices = devices
  }

  homewizard.getRandom = function (min, max) {
    return Math.random() * (max - min) + min
  }

  homewizard.getDevices = function (callback) {
    callback(self.devices)
  }

  homewizard.getDeviceData = function (deviceId, dataPart, callback) {
    if (typeof self.devices[deviceId] === 'undefined' || typeof self.devices[deviceId].polldata === 'undefined' || typeof self.devices[deviceId].polldata[dataPart] === 'undefined') {
      callback([])
    } else {
      callback(self.devices[deviceId].polldata[dataPart])
    }
  }

  class HTTPResponseError extends Error {
    constructor (response, ...args) {
      super(`HTTP Error Response: ${response.status} ${response.statusText}`, ...args)
      this.response = response
    }
  };

  const checkStatus = response => {
    if (response.ok) {
      // response.status >= 200 && response.status < 300
      return response
    } else {
      throw new HTTPResponseError(response)
    }
  }

  async function fetchWithTimeout (resource, options = {}) {
    const { timeout = 15000 } = options

    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeout)

    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    })
    clearTimeout(id)

    // return response;
    try {
      checkStatus(response)
    } catch (error) {
      console.error(error)

      const errorBody = await error.response.text()
      console.error(`Error body: ${errorBody}`)
    }
    return response
  }

  homewizard.callnew = async function (deviceId, uriPart, callback) {
    Promise.resolve().then(async () => {
      try {
        // var me = this;
        let status
        if (debug) { console.log('Call device ' + deviceId) }
        if ((typeof self.devices[deviceId] !== 'undefined') && ('settings' in self.devices[deviceId]) && ('homewizard_ip' in self.devices[deviceId].settings) && ('homewizard_pass' in self.devices[deviceId].settings)) {
          const homewizardIp = self.devices[deviceId].settings.homewizard_ip
          const homewizardPass = self.devices[deviceId].settings.homewizard_pass
          // const json = await fetch('http://' + homewizardIp + '/' + homewizard_pass + uriPart)

          await fetchWithTimeout('http://' + homewizardIp + '/' + homewizardPass + uriPart, { timeout: 15000 })
            .then(async (res) => {
              try {
                if (status !== 'undefined') {
                  status = res.status
                  return await res.json()
                } else {
                  console.log('Status undefined')
                }
              } catch (err) {
                console.error(err)
              }
            })
            .then((jsonData) => {
              try {
                if (status === 200) {
                  try {
                    if (jsonData.status !== undefined && jsonData.status === 'ok') {
                      if (typeof callback === 'function') {
                        callback(null, jsonData.response)
                      } else {
                        console.log('Not typeoffunction')
                      }
                    } else {
                      console.log('jsonData.status not ok')
                    }
                  } catch (exception) {
                    console.log('EXCEPTION JSON CAUGHT')
                    //                    // catch if undefined body else it complains ReferenceError: body is not defined
                    //                    if (!jsonData.body || jsonData.body !== undefined || body !== 'undefined' || body !== undefined)
                    //                    {
                    //                        console.log('EXCEPTION JSON CAUGHT');
                    //                    }
                    callback('Invalid data', [])
                  }
                } else {
                  if (typeof callback === 'function') {
                    callback('Error', [])
                  }
                  console.log('Error: no clue what is going on here.')
                }
              } catch (exception) {
                console.log('CONNECTION PROBLEM')
              }
            })
            .catch((err) => {
              console.error('FETCH PROBLEM: ' + err)
            })
        } else {
          console.log('Homewizard ' + deviceId + ': settings not found!')
        }
      } catch (error) {
        console.log(error, name === 'AbortError')
      }
    })
      .then(() => {
        //  this.setAvailable().catch(this.error);
      })
      .catch(err => {
        this.error(err)
        // this.setUnavailable(err).catch(this.error);
      })
  }

  homewizard.ledring_pulse = function (deviceId, colorName) {
    const homewizardLedring = self.devices[deviceId].settings.homewizard_ledring
    if (homewizardLedring) {
      Homey.manager('ledring').animate(
        'pulse', // animation name (choose from loading, pulse, progress, solid)
        {
          color: colorName
        },
        'INFORMATIVE', // priority
        3000, // duration
        function (err, success) { // callback
          if (err) return Homey.error(err)
          console.log('Ledring pulsing ' + colorName)
        }
      )
    }
  }

  homewizard.startpoll = async function () {
    await homewizard.poll()
    self.polls.deviceId = setInterval(async function () {
      await homewizard.poll()
    }, 1000 * 20)
  }

  homewizard.poll = async function () {
    await Object.keys(self.devices).forEach(async function (deviceId) {
      if (typeof self.devices[deviceId].polldata === 'undefined') {
        self.devices[deviceId].polldata = []
      }
      await homewizard.callnew(deviceId, '/get-sensors', function (err, response) {
        if (err === null) {
          self.devices[deviceId].polldata.preset = response.preset
          self.devices[deviceId].polldata.heatlinks = response.heatlinks
          self.devices[deviceId].polldata.energylinks = response.energylinks
          self.devices[deviceId].polldata.energymeters = response.energymeters
          self.devices[deviceId].polldata.thermometers = response.thermometers
          self.devices[deviceId].polldata.rainmeters = response.rainmeters
          self.devices[deviceId].polldata.windmeters = response.windmeters
          self.devices[deviceId].polldata.kakusensors = response.kakusensors

          if (Object.keys(response.energylinks).length !== 0) {
            homewizard.callnew(deviceId, '/el/get/0/readings', function (err, response2) {
              if (err == null) {
                self.devices[deviceId].polldata.energylink_el = response2
                if (debug) { console.log('HW-Data polled for slimme meter: ' + deviceId) }
              }
            })
          }
        }
      })
    })
  }

  return homewizard
})()
