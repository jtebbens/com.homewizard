'use strict';

const Homey = require('homey');
const http = require('http');
const FetchLegacyDebug = require('./fetchLegacyDebug');
const fetch = require('node-fetch');

const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

module.exports = (function() {
  const homewizard = {};
  const self = {};
  // self.devices = [];
  self.devices = {};
  self.polls = [];
  const debug = false;

  homewizard.setDevices = function(devices) {
    self.devices = devices;

    for (const id in self.devices) {
      const device = self.devices[id];
      if (!device) continue;

      if (!device.fetchLegacyDebug) {
        device.fetchLegacyDebug = new FetchLegacyDebug(device, 100);
      }
    }
  };

  homewizard.getRandom = function(min, max) {
    return Math.random() * (max - min) + min;
  };

  homewizard.getDevices = function(callback) {
    callback(self.devices);
  };

  homewizard.getDeviceData = function(device_id, data_part) {
    return new Promise((resolve) => {
      if (
        typeof self.devices[device_id] === 'undefined' ||
        typeof self.devices[device_id].polldata === 'undefined' ||
        typeof self.devices[device_id].polldata[data_part] === 'undefined'
      ) {
        resolve([]);
      } else {
        resolve(self.devices[device_id].polldata[data_part]);
      }
    });
  };

  function initCircuitBreaker(device) {
    if (!device.circuit) {
      device.circuit = {
        failures: 0,
        lastFailure: 0,
        openUntil: 0,
        threshold: 3,
        cooldownMs: 120000
      };
    }
  }

  function circuitBreakerAllows(device) {
    initCircuitBreaker(device);
    const now = Date.now();
    return device.circuit.openUntil <= now;
  }

  function circuitBreakerFail(device) {
    initCircuitBreaker(device);
    const now = Date.now();
    const c = device.circuit;

    c.failures++;
    c.lastFailure = now;

    if (c.failures >= c.threshold) {
      c.openUntil = now + c.cooldownMs;
      if (debug) console.log(`Circuit breaker OPEN for device (cooldown ${c.cooldownMs}ms)`);
    }
  }

  function circuitBreakerSuccess(device) {
    initCircuitBreaker(device);
    const c = device.circuit;
    c.failures = 0;
    c.openUntil = 0;
  }

  function recordResponseTime(device, durationMs) {
    if (!device.responseStats) {
      device.responseStats = { samples: [], maxSamples: 20 };
    }

    const stats = device.responseStats;
    stats.samples.push(durationMs);

    if (stats.samples.length > stats.maxSamples) {
      stats.samples.shift();
    }
  }

  function getAverageResponseTime(device) {
    if (!device.responseStats || device.responseStats.samples.length === 0) {
      return null;
    }

    const arr = device.responseStats.samples;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

    function getAdaptiveTimeout(device) {
      const avg = getAverageResponseTime(device);

      if (!avg) return 6000;

      // Adaptive timeout: 2.5 × avg
      const adaptive = avg * 2.5;

      // Hard min/max
      return Math.min(Math.max(adaptive, 5000), 8000);
    }


    homewizard.setDeviceInstance = function(device_id, deviceInstance) {
    if (!self.devices[device_id]) {
      // optioneel: in debug zien dat er iets mis is
      if (debug) console.log(`[homewizard.setDeviceInstance] Unknown device_id: ${device_id}`);
      return;
    }

    self.devices[device_id].deviceInstance = deviceInstance;
  };



  // ---------------------------------------------------------------------------
  // 🟩 LEGACY PARSER
  // ---------------------------------------------------------------------------

  homewizard.callnew = async function(device_id, uri_part, callback) {
  let timeout = null;
  let controller = null;

  const device = self.devices[device_id];
  if (!device || !device.settings) {
    try {
      device?.fetchLegacyDebug?.log({
        type: 'settings_missing',
        url: null
      });
    } catch (_) {}
    return callback('settings_missing', []);
  }

  if (!device.fetchLegacyDebug) {
    device.fetchLegacyDebug = new FetchLegacyDebug(device, 100);
  }

  const { homewizard_ip, homewizard_pass } = device.settings;
  const url = `http://${homewizard_ip}/${homewizard_pass}${uri_part}`;

  if (!circuitBreakerAllows(device)) {
    try {
      device.fetchLegacyDebug.log({
        type: 'circuit_open',
        url,
        openUntil: device.circuit.openUntil
      });
    } catch (_) {}
    return callback('circuit_open', []);
  }

  const timeoutDuration = getAdaptiveTimeout(device);
  const start = Date.now();

  try {
    controller = new AbortController();
    const { signal } = controller;

    timeout = setTimeout(() => {
      controller.abort();
    }, timeoutDuration);

    const response = await fetch(url, {
      signal,
      follow: 0,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' }
    });

    clearTimeout(timeout);

    const duration = Date.now() - start;
    recordResponseTime(device, duration);
    circuitBreakerSuccess(device);

    if (response.status !== 200) {
      device.fetchLegacyDebug.log({
        type: 'http_error',
        url,
        ms: duration,
        status: response.status
      });
      return callback('http_error', []);
    }

    const text = await response.text();

    // Alleen nog bij debug=true, niet in productie
    if (debug) {
      device.fetchLegacyDebug.log({
        type: 'raw_response',
        url,
        ms: duration,
        status: response.status,
        body: text.slice(0, 300)
      });
    }


    let jsonData;
    try {
      jsonData = JSON.parse(text);
    } catch (e) {
      device.fetchLegacyDebug.log({
        type: 'json_parse_error',
        url,
        ms: duration,
        error: e.message,
        bodySnippet: text.slice(0, 300)
      });
      return callback('json_parse_error', []);
    }

    if (jsonData.status === 'ok') {
      return callback(null, jsonData.response);
    }

    device.fetchLegacyDebug.log({
      type: 'invalid_data',
      url,
      ms: duration,
      payload: jsonData
    });
    return callback('invalid_data', []);

  } catch (error) {
    clearTimeout(timeout);

    const duration = Date.now() - start;
    recordResponseTime(device, duration);
    circuitBreakerFail(device);

    if (error.name === 'AbortError') {
      device.fetchLegacyDebug.log({
        type: 'timeout',
        url,
        ms: duration,
        timeout: timeoutDuration
      });
      // geen "user aborted" log, geen dubbele entry
      return callback('timeout', []);
    }

    device.fetchLegacyDebug.log({
      type: 'error',
      url,
      ms: duration,
      error: error.message || error,
      code: error.code || null
    });

    return callback(error, []);
  }
};


  // ---------------------------------------------------------------------------

  if (!Homey2023) {
    homewizard.ledring_pulse = function(device_id, colorName) {
      const { homewizard_ledring } = self.devices[device_id].settings;
      if (homewizard_ledring) {
        Homey.manager('ledring').animate(
          'pulse',
          { color: colorName },
          'INFORMATIVE',
          3000,
          (err) => {
            if (err) return Homey.error(err);
            console.log(`Ledring pulsing ${colorName}`);
          }
        );
      }
    };
  }

  homewizard.startpoll = function() {
    homewizard.poll().catch(() => {});

    for (const device_id in self.devices) {
      const device = self.devices[device_id];
      if (!device) continue;

      const userIntervalSec = device?.settings?.poll_interval || 30;
      const adaptiveTimeoutMs = getAdaptiveTimeout(device);
      const minPollSec = Math.ceil((adaptiveTimeoutMs + 1000) / 1000);
      const effectivePollSec = Math.max(userIntervalSec, minPollSec);

      if (self.polls[device_id]) {
        clearInterval(self.polls[device_id]);
      }

      self.polls[device_id] = setInterval(async () => {
        try {
          await homewizard.poll(device_id);
        } catch (_) {}
      }, effectivePollSec * 1000);
    }
  };

  homewizard.poll = async function(device_id = null) {
    const list = device_id ? [device_id] : Object.keys(self.devices);

    for (const id of list) {
      if (!self.devices[id]) continue;

      if (!self.devices[id].polldata) {
        self.devices[id].polldata = [];
      }

      let response;
      try {
        response = await new Promise((resolve, reject) => {
          homewizard.callnew(id, '/get-sensors', (err, response) => {
            if (err == null) resolve(response);
            else reject(err);
          });
        });
      } catch (_) {
        continue;
      }

      if (!response) continue;

      self.devices[id].polldata.preset = response.preset;
      self.devices[id].polldata.heatlinks = response.heatlinks;
      self.devices[id].polldata.energylinks = response.energylinks;
      self.devices[id].polldata.energymeters = response.energymeters;
      self.devices[id].polldata.thermometers = response.thermometers;
      self.devices[id].polldata.rainmeters = response.rainmeters;
      self.devices[id].polldata.windmeters = response.windmeters;
      self.devices[id].polldata.kakusensors = response.kakusensors;

      if (Object.keys(response.energylinks).length !== 0) {
        try {
          const response2 = await new Promise((resolve, reject) => {
            homewizard.callnew(id, '/el/get/0/readings', (err2, response2) => {
              if (err2 == null) resolve(response2);
              else reject(err2);
            });
          });

          if (response2) {
            self.devices[id].polldata.energylink_el = response2;
          }
        } catch (_) {}
      }
    }
  };

  homewizard.self = self;
  return homewizard;
}());
