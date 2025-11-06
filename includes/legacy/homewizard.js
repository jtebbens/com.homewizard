'use strict';

//const fetch = require('node-fetch');
const Homey = require('homey');
//const AbortController = require('abort-controller');

const http = require('http');


let fetch;
try {
  fetch = global.fetch || require('node-fetch');
} catch (e) {
  console.error('Fetch is not available. Please install node-fetch.');
}


const cache = {}; // Cache object to store the callnew responses

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
    const cacheKey = `${device_id}${uri_part}`;
    const cachedResponse = cache[cacheKey]; // Check if cached response exists
    const currentTime = Date.now();
    const timeoutDuration = 18000; // Timeout duration in milliseconds

    if (cachedResponse && currentTime - cachedResponse.timestamp < 20000) {
      if (debug) { console.log('Using cached response for device:', device_id, 'endpoint:', uri_part); }
      callback(null, cachedResponse.response); // Use the cached response
      return; // Return early
    }

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

  //      const response = await fetch(`http://${homewizard_ip}/${homewizard_pass}${uri_part}`, { signal, follow: 0, redirect: 'error' });

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
              // Cache the response with timestamp
              cache[cacheKey] = {
                response: jsonData.response,
                timestamp: currentTime,
              };

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
        return; // Return early if fetch request was aborted
      }
      if (error.code === 'ECONNRESET') {
        console.log('Connection was reset');
      }
      console.error(`FETCH PROBLEM -> ${error}`);
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
    homewizard.poll(); // Initial poll

    self.polls.device_id = setInterval(async () => {
      try {
        await homewizard.poll();
      } catch (error) {
        console.error('Error occurred during polling:', error);
      }
    }, 1000 * 20);
  };

  homewizard.poll = async function() {
    for (const device_id in self.devices) {
      if (
        typeof self.devices[device_id].polldata === 'undefined'
          || typeof self.devices[device_id].polldata == 'undefined'
          || typeof self.devices[device_id].polldata == undefined
      ) {
        self.devices[device_id].polldata = [];
      }

      const response = await new Promise((resolve, reject) => {
        homewizard.callnew(device_id, '/get-sensors', (err, response) => {
          if (err === null || err == null) {
            resolve(response);
          } else {
            reject(err);
          }
        });
      });

      if (response) {
        self.devices[device_id].polldata.preset = response.preset;
        self.devices[device_id].polldata.heatlinks = response.heatlinks;
        self.devices[device_id].polldata.energylinks = response.energylinks;
        self.devices[device_id].polldata.energymeters = response.energymeters;
        self.devices[device_id].polldata.thermometers = response.thermometers;
        self.devices[device_id].polldata.rainmeters = response.rainmeters;
        self.devices[device_id].polldata.windmeters = response.windmeters;
        self.devices[device_id].polldata.kakusensors = response.kakusensors;

        if (Object.keys(response.energylinks).length !== 0) {
          const response2 = await new Promise((resolve, reject) => {
            new Promise((resolve) => setTimeout(resolve, 1000));
            homewizard.callnew(device_id, '/el/get/0/readings', (err2, response2) => {
              if (err2 === null || err2 == null) {
                // self.devices[device_id].polldata.energylink_el = response2;
                resolve(response2);
              } else {
                reject(err2);
              }
            });
          });
          if (response2) {
            self.devices[device_id].polldata.energylink_el = response2;
          }
        }
      }
    }
  };

  return homewizard;
}());
