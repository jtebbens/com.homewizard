'use strict';

const Homey = require('homey');
const fetch = require('../utils/fetchQueue');
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

homewizard.callnew = async function(device_id, uri_part) {
  if (
    typeof self.devices[device_id] === 'undefined' ||
    !self.devices[device_id].settings ||
    !self.devices[device_id].settings.homewizard_ip ||
    !self.devices[device_id].settings.homewizard_pass
  ) {
    throw new Error(`HomeWizard ${device_id}: settings not found`);
  }

  const { homewizard_ip, homewizard_pass } = self.devices[device_id].settings;

  const response = await fetch(`http://${homewizard_ip}/${homewizard_pass}${uri_part}`, {
    follow: 0,
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' }
  });

  if (response.status !== 200) {
    throw new Error(`HTTP error ${response.status}`);
  }

  const json = await response.json();

  if (!json || json.status !== 'ok') {
    throw new Error('Invalid data');
  }

  return json.response;
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
    }, 1000 * 30);
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

      let response;
      try {
        response = await homewizard.callnew(device_id, '/get-sensors');
      } catch (err) {
        console.error(`Poll error for device ${device_id}:`, err);
        continue; // skip this device, do not crash poll loop
      }

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
          await new Promise(resolve => setTimeout(resolve, 2000));
          let response2;
          try {
            response2 = await homewizard.callnew(device_id, '/el/get/0/readings');
          } catch (err) {
            console.error(`EL readings error for device ${device_id}:`, err);
            // do NOT continue; energylink_el is optional
          }

          if (response2) {
            self.devices[device_id].polldata.energylink_el = response2;
          }
        }
      }
    }
  };

  return homewizard;
}());
