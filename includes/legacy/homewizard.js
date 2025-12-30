'use strict';

const Homey = require('homey');
const http = require('http');
// const fetch = require('../utils/fetchQueue');
const fetch = require('node-fetch');
// const cache = {}; // Cache object to store the callnew responses

const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

module.exports = (function() {
  const homewizard = {};
  const self = {};
  self.devices = [];
  self.polls = [];
  const debug = false;

  homewizard.setDevices = function(devices) {
    self.devices = devices;
  };

  homewizard.getRandom = function(min, max) {
    return Math.random() * (max - min) + min;
  };

  homewizard.getDevices = function(callback) {
    callback(self.devices);
  };

  homewizard.getDeviceData = function(device_id, data_part) {
    return new Promise((resolve, reject) => {
      if (
        typeof self.devices[device_id] === 'undefined'
        || typeof self.devices[device_id].polldata === 'undefined'
        || typeof self.devices[device_id].polldata[data_part] === 'undefined'
        || typeof self.devices[device_id] === undefined
        || typeof self.devices[device_id].polldata === undefined
        || typeof self.devices[device_id].polldata[data_part] === undefined
      ) {
        resolve([]);
      } else {
        resolve(self.devices[device_id].polldata[data_part]);
      }
    });
  };

  homewizard.callnew = async function(device_id, uri_part, callback) {
    const timeoutDuration = 8000; // Timeout duration in milliseconds
    try {
      if (debug) {
        console.log('Call device ', device_id, 'endpoint:', uri_part);
      }
      if (
        typeof self.devices[device_id] !== 'undefined'
          && 'settings' in self.devices[device_id]
          && 'homewizard_ip' in self.devices[device_id].settings
          && 'homewizard_pass' in self.devices[device_id].settings
      ) {
        const { homewizard_ip } = self.devices[device_id].settings;
        const { homewizard_pass } = self.devices[device_id].settings;

        const controller = new AbortController(); // Create an AbortController
        const { signal } = controller; // Get the AbortSignal from the controller

        // Set a timeout to abort the fetch request
        const timeout = setTimeout(() => {
          controller.abort(); // Abort the fetch request
          console.log('Fetch request timed out');
        }, timeoutDuration);

        const response = await fetch(`http://${homewizard_ip}/${homewizard_pass}${uri_part}`, {
          signal,
          follow: 0,
          redirect: 'error',
          headers: {
            'Content-Type': 'application/json'
          }
        });

        clearTimeout(timeout); // Clear the timeout since the fetch request completed

        if (response.status === 200) {
          const jsonData = await response.json();
          if (
            jsonData.status !== undefined
              && jsonData.status === 'ok'
          ) {
            if (typeof callback === 'function') {
              
              callback(null, jsonData.response);
            } else {
              console.log('Not typeof function');
            }
          } else {
            console.log('jsonData.status not ok');
            callback('Invalid data', []);
          }
        } else {
          console.log('Error: no clue what is going on here.');
          callback('Error', []);
        }
      } else {
        console.log(`Homewizard ${device_id}: settings not found!`);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Fetch request aborted');
      } else if (error.code === 'ECONNRESET') {
        console.log('Connection was reset');
      }

      console.error(`FETCH PROBLEM -> ${error}`);
      if (typeof callback === 'function') {
        callback(error, []);
      }

      return; 
    }

  };

  if (!Homey2023) {
    homewizard.ledring_pulse = function(device_id, colorName) {
      const { homewizard_ledring } = self.devices[device_id].settings;
      if (homewizard_ledring) {
        Homey.manager('ledring').animate(
          'pulse', // animation name (choose from loading, pulse, progress, solid)
          {
            color: colorName,
          },
          'INFORMATIVE', // priority
          3000, // duration
          (err) => { // callback
            if (err) return Homey.error(err);
            console.log(`Ledring pulsing ${colorName}`);
          },
        );
      }
    };
  }

homewizard.startpoll = function() {

  // Initial poll
  homewizard.poll();

  // Per-device custom polling
  for (const device_id in self.devices) {
    const intervalSec =
      self.devices[device_id]?.settings?.poll_interval || 30;

    if (self.polls[device_id]) {
      clearInterval(self.polls[device_id]);
    }

    self.polls[device_id] = setInterval(async () => {
      try {
        await homewizard.poll(device_id);
      } catch (error) {
        console.error(`Polling error for device ${device_id}:`, error);
      }
    }, intervalSec * 1000);
  }
};



  homewizard.poll = async function(device_id = null) {
  const list = device_id ? [device_id] : Object.keys(self.devices);

  for (const id of list) {
    if (!self.devices[id]) continue;

    if (!self.devices[id].polldata) {
      self.devices[id].polldata = [];
    }

    let response = await new Promise((resolve, reject) => {
      homewizard.callnew(id, '/get-sensors', (err, response) => {
        if (err == null) resolve(response);
        else reject(err);
      });
    });

    if (response) {
      self.devices[id].polldata.preset = response.preset;
      self.devices[id].polldata.heatlinks = response.heatlinks;
      self.devices[id].polldata.energylinks = response.energylinks;
      self.devices[id].polldata.energymeters = response.energymeters;
      self.devices[id].polldata.thermometers = response.thermometers;
      self.devices[id].polldata.rainmeters = response.rainmeters;
      self.devices[id].polldata.windmeters = response.windmeters;
      self.devices[id].polldata.kakusensors = response.kakusensors;

      if (Object.keys(response.energylinks).length !== 0) {
        let response2 = await new Promise((resolve, reject) => {
          homewizard.callnew(id, '/el/get/0/readings', (err2, response2) => {
            if (err2 == null) resolve(response2);
            else reject(err2);
          });
        });

        if (response2) {
          self.devices[id].polldata.energylink_el = response2;
        }
      }
    }
  }
};


  return homewizard;
}());
