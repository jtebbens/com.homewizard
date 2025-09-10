'use strict';

const fetch = require('node-fetch');
const Homey = require('homey');
const AbortController = require('abort-controller');

const http = require('http');

//const cache = {}; // Cache object to store the callnew responses

const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5
});

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
  const timeoutDuration = 18000;

  const controller = new AbortController();
  const { signal } = controller;

  const timeout = setTimeout(() => {
    controller.abort();
    console.log('Homewizard Legacy - Fetch request timed out');
  }, timeoutDuration);

  try {
    if (debug) {
      console.log('Call device ', device_id, 'endpoint:', uri_part);
    }

    if (
      typeof self.devices[device_id] !== 'undefined' &&
      'settings' in self.devices[device_id] &&
      'homewizard_ip' in self.devices[device_id].settings &&
      'homewizard_pass' in self.devices[device_id].settings
    ) {
      const { homewizard_ip, homewizard_pass } = self.devices[device_id].settings;

      const response = await fetch(`http://${homewizard_ip}/${homewizard_pass}${uri_part}`, {
        agent,
        signal,
        follow: 0,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200) {
        const jsonData = await response.json();
        if (jsonData.status === 'ok') {
          if (typeof callback === 'function') {
            callback(null, jsonData.response);
          } else {
            console.log('Callback is not a function');
          }
        } else {
          console.log('jsonData.status not ok');
          if (typeof callback === 'function') {
            callback('Invalid data', []);
          }
        }
      } else {
        console.log('Error: unexpected response status');
        if (typeof callback === 'function') {
          callback('Error', []);
        }
      }
    } else {
      console.log(`Homewizard ${device_id}: settings not found!`);
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Homewizard Legacy - Fetch request aborted');
    } else if (error.code === 'ECONNRESET') {
      console.log('Homewizard Legacy - Connection was reset');
    } else {
      console.error(`Homewizard Legacy - FETCH PROBLEM -> ${error}`);
    }
  } finally {
    clearTimeout(timeout); // ✅ This ensures cleanup no matter what
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

  homewizard.startpoll = function () {
    // Clear any existing interval to avoid duplicates
    if (self.polls?.device_id) {
      clearInterval(self.polls.device_id);
    }

    // Initial poll
    homewizard.poll();

    // Set up recurring poll every 20 seconds
    self.polls.device_id = setInterval(async () => {
      try {
        await homewizard.poll();
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 20 * 1000);
  };

  homewizard.stoppoll = function () {
    if (self.polls?.device_id) {
      clearInterval(self.polls.device_id);
      delete self.polls.device_id;
      console.log('Polling stopped.');
    }
  };

  homewizard.poll = async function () {
  for (const device_id in self.devices) {
    const device = self.devices[device_id];

    if (typeof device.polldata === 'undefined') {
      device.polldata = {};
    }

    try {
      const response = await new Promise((resolve, reject) => {
        homewizard.callnew(device_id, '/get-sensors', (err, res) => {
          err ? reject(err) : resolve(res);
        });
      });

      Object.assign(device.polldata, {
        preset: response.preset,
        heatlinks: response.heatlinks,
        energylinks: response.energylinks,
        energymeters: response.energymeters,
        thermometers: response.thermometers,
        rainmeters: response.rainmeters,
        windmeters: response.windmeters,
        kakusensors: response.kakusensors,
      });

      if (Object.keys(response.energylinks).length !== 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const response2 = await new Promise((resolve, reject) => {
          homewizard.callnew(device_id, '/el/get/0/readings', (err2, res2) => {
            err2 ? reject(err2) : resolve(res2);
          });
        });

        device.polldata.energylink_el = response2;
      }
    } catch (error) {
      console.error(`Polling failed for device ${device_id}:`, error);
    }
  }
};


  return homewizard;
}());
