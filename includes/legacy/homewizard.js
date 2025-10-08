'use strict';

const fetch = require('node-fetch');
const Homey = require('homey');
const AbortController = require('abort-controller');

const http = require('http');

//const cache = {}; // Cache object to store the callnew responses

const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

module.exports = (function() {
  const homewizard = {};
  homewizard.devices = [];
  homewizard.polls = [];
  const debug = false;

  homewizard.setDevices = function(devices) {
  homewizard.devices = devices;
  };

  homewizard.getRandom = function(min, max) {
    return Math.random() * (max - min) + min;
  };

  homewizard.getDevices = function(callback) {
  callback(homewizard.devices);
  };

  homewizard.getDevicesAsync = () =>
  new Promise((resolve) => homewizard.getDevices(resolve));

  homewizard.getDeviceData = async function(device_id, data_part) {
    const device = homewizard.devices[device_id];
    const data = device?.polldata?.[data_part];
    return typeof data === 'undefined' ? [] : data;
  };

  homewizard.callnewAsync = async function(device_id, uri_part) {
    return new Promise((resolve, reject) => {
      homewizard.callnew(device_id, uri_part, (err, res) => {
        err ? reject(err) : resolve(res);
      });
    });
  };

  homewizard.callnew = async function (device_id, uri_part, callback) {
  const timeoutDuration = 21000;
  const maxRetries = 2;
  let attempt = 0;

  const device = homewizard.devices[device_id];
  const { homewizard_ip, homewizard_pass } = device?.settings ?? {};

  if (!homewizard_ip || !homewizard_pass) {
    console.log(`Homewizard ${device_id}: settings not found!`);
    return;
  }

  while (attempt < maxRetries) {
    const controller = new AbortController();
    const { signal } = controller;
    const timeout = setTimeout(() => {
      controller.abort();
      console.log('Homewizard Legacy - Fetch request timed out');
    }, timeoutDuration);

    try {
      if (homewizard.debug) {
        console.log(`Call device ${device_id}, endpoint: ${uri_part}`);
      }

      const response = await fetch(`http://${homewizard_ip}/${homewizard_pass}${uri_part}`, {
        signal,
        follow: 0,
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 200) {
        let jsonData;
        try {
          jsonData = await response.json();
        } catch (err) {
          console.log('Failed to parse JSON:', err);
          callback?.('Invalid JSON', []);
          return;
        }

        if (jsonData.status === 'ok') {
          callback?.(null, jsonData.response);
        } else {
          console.log('jsonData.status not ok');
          callback?.('Invalid data', []);
        }
        return; // success, exit loop
      } else {
        console.log(`Unexpected response status: ${response.status}`);
        callback?.('Error', []);
        return;
      }

    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Homewizard Legacy - Fetch request aborted');
      } else if (error.code === 'ECONNRESET') {
        console.log('Homewizard Legacy - Connection was reset');
      } else if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code)) {
        console.log(`Homewizard Legacy - Network error: ${error.code}`);
      } else {
        console.error(`Homewizard Legacy - FETCH PROBLEM -> ${error}`);
      }

      attempt++;
      if (attempt < maxRetries) {
        console.log(`Homewizard Legacy - Retrying fetch (${attempt}/${maxRetries})...`);
        await new Promise(res => setTimeout(res, 1000)); // brief backoff
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // If we reach here, all attempts failed
  callback?.('Fetch failed after retries', []);
};




  if (!Homey2023) {
  homewizard.ledring_pulse = function(device_id, colorName) {
    const device = homewizard.devices[device_id];
    const { homewizard_ledring } = device?.settings ?? {};

    if (homewizard_ledring) {
      Homey.manager('ledring').animate(
        'pulse', // animation name
        { color: colorName },
        'INFORMATIVE', // priority
        3000, // duration
        (err) => {
          if (err) return Homey.error(err);
          console.log(`Ledring pulsing ${colorName}`);
        }
      );
    }
  };
}


  homewizard.startpoll = function () {
    // Clear any existing interval to avoid duplicates
    if (homewizard.polls?.device_id) {
      clearInterval(homewizard.polls.device_id);
    }

    // Initial poll
    homewizard.poll();

    // Set up recurring poll every 20 seconds
    homewizard.polls.device_id = setInterval(async () => {
      try {
        await homewizard.poll();
      } catch (error) {
        console.error('Polling error:', error);
      }
    }, 20 * 1000);
  };

  homewizard.stoppoll = function () {
    if (homewizard.polls?.device_id) {
      clearInterval(homewizard.polls.device_id);
      delete homewizard.polls.device_id;
      console.log('Polling stopped.');
    }
  };

  homewizard.poll = async function () {
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    await Promise.all(Object.entries(homewizard.devices).map(async ([device_id, device]) => {
      if (!device.polldata) {
        device.polldata = {};
      }

      try {
        const response = await homewizard.callnewAsync(device_id, '/get-sensors');

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
          await delay(2000);
          const response2 = await homewizard.callnewAsync(device_id, '/el/get/0/readings');
          device.polldata.energylink_el = response2;
        }
      } catch (error) {
        console.error(`Polling failed for device ${device_id}:`, error);
      }
    }));
  };




  return homewizard;
}());
