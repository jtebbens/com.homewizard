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
        ) {
          resolve([]);
        } else {
          resolve(self.devices[device_id].polldata[data_part]);
        }
    });
  };

  function fetchWithConnectTimeout(url, options = {}, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('connect_timeout'));
    }, timeoutMs);

    fetch(url, options)
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}


  function initCircuitBreaker(device) {
  if (!device.circuit) {
    device.circuit = {
      failures: 0,
      lastFailure: 0,
      openUntil: 0,
      threshold: 3,      
      cooldownMs: 120000 // 2 min cooldown
    };
  }
}

function circuitBreakerAllows(device) {
  initCircuitBreaker(device);

  const now = Date.now();

  // Breaker open?
  if (device.circuit.openUntil > now) {
    return false;
  }

  return true;
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

  // Reset bij succes
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

  if (!avg) {
    // Geen data → veilige default
    return 8000;
  }

  // Adaptive timeout:
  // - 3x avarage response
  // - never below 3s
  // - never above 8s
  return Math.min(Math.max(avg * 3, 3000), 8000);
}



  homewizard.callnew = async function(device_id, uri_part, callback) {
  let timeout = null;
  let controller = null;

  const device = self.devices[device_id];
  if (!device || !device.settings) {
    return callback('settings_missing', []);
  }

  const { homewizard_ip, homewizard_pass } = device.settings;
  const url = `http://${homewizard_ip}/${homewizard_pass}${uri_part}`;

  // Circuit breaker check
  if (!circuitBreakerAllows(device)) {
    if (debug) console.log(`Circuit breaker BLOCKED fetch for ${url}`);
    return callback('circuit_open', []);
  }
  
  // Adaptive timeout op basis van gemeten performance
  const timeoutDuration = getAdaptiveTimeout(device);

  const start = Date.now(); // START TIMER

  try {
    controller = new AbortController();
    const { signal } = controller;

    timeout = setTimeout(() => {
      controller.abort();
      if (debug) console.log(`Timeout (${timeoutDuration}ms) on ${url}`);
    }, timeoutDuration);

    const response = await fetchWithConnectTimeout(url, {
      signal,
      follow: 0,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' }
    }, 2000); // 2s connect timeout


    clearTimeout(timeout);

    const duration = Date.now() - start;
    recordResponseTime(device, duration);

    circuitBreakerSuccess(device);

    if (debug) {
      const avg = getAverageResponseTime(device);
      console.log(`Fetch ${url} took ${duration}ms (avg ${avg}ms, timeout ${timeoutDuration}ms)`);
    }

    if (response.status !== 200) {
      return callback('http_error', []);
    }

    const jsonData = await response.json();

    if (jsonData.status === 'ok') {
      return callback(null, jsonData.response);
    } else {
      return callback('invalid_data', []);
    }

  } catch (error) {
    clearTimeout(timeout);

    const duration = Date.now() - start;
    recordResponseTime(device, duration);

    circuitBreakerFail(device);

    if (debug) {
      const avg = getAverageResponseTime(device);
      console.log(`Fetch failed after ${duration}ms (avg ${avg}ms, timeout ${timeoutDuration}ms)`);
    }

    if (error.name === 'AbortError') {
      return callback('timeout', []);
    }

    return callback(error, []);
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
  homewizard.poll().catch((error) => {
    if (error === 'circuit_open') return;

    const msg = typeof error === 'string' ? error : error?.message;
    const code = typeof error === 'object' ? error?.code : null;

    if (msg === 'connect_timeout' || msg === 'timeout' || code === 'ECONNRESET') {
      if (debug) console.log('Initial polling warning:', msg || code);
      return;
    }

    console.error('Initial polling error:', error);
  });
  
  // Per-device custom polling
  for (const device_id in self.devices) {
    const device = self.devices[device_id];
    if (!device) continue;

    // User-defined interval or default
    const userIntervalSec = device?.settings?.poll_interval || 30;

    // Adaptive timeout for this device
    const adaptiveTimeoutMs = getAdaptiveTimeout(device);

    // Minimum safe polling interval (timeout + 1s buffer)
    const minPollSec = Math.ceil((adaptiveTimeoutMs + 1000) / 1000);

    // Effective interval = max(user interval, minimum safe interval)
    const effectivePollSec = Math.max(userIntervalSec, minPollSec);

    if (debug && effectivePollSec !== userIntervalSec) {
      console.log(
        `Polling interval for device ${device_id} adjusted from ${userIntervalSec}s to ${effectivePollSec}s (adaptive timeout ${adaptiveTimeoutMs}ms)`
      );
    }

    // Clear existing interval if present
    if (self.polls[device_id]) {
      clearInterval(self.polls[device_id]);
    }

    // Start safe polling interval
    // Start safe polling interval
self.polls[device_id] = setInterval(async () => {
      try {
        await homewizard.poll(device_id);
      } catch (error) {

        // 1. Circuit breaker open
        if (error === 'circuit_open') {
          return;
        }

        // 2. Timeout
        const msg = typeof error === 'string' ? error : error?.message;
        const code = typeof error === 'object' ? error?.code : null;

        if (msg === 'connect_timeout' || msg === 'timeout' || code === 'ECONNRESET') {
          if (debug) console.log(`Polling warning for ${device_id}:`, msg || code);
          return;
        }

        // 3. Log real errors
        console.error(`Polling error for device ${device_id}:`, error);
      }
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
    } catch (err) {
      // zelfde classificatie als in startpoll
      if (err === 'circuit_open') {
        if (debug) console.log(`Polling blocked by circuit breaker for device ${id}`);
        continue;
      }

      const msg = typeof err === 'string' ? err : err?.message;
      const code = typeof err === 'object' ? err?.code : null;

      if (msg === 'connect_timeout' || msg === 'timeout' || code === 'ECONNRESET') {
        if (debug) console.log(`Polling warning for device ${id}:`, msg || code);
        continue;
      }

      console.error(`Polling error for device ${id}:`, err);
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
      let response2;
      try {
        response2 = await new Promise((resolve, reject) => {
          homewizard.callnew(id, '/el/get/0/readings', (err2, response2) => {
            if (err2 == null) resolve(response2);
            else reject(err2);
          });
        });
      } catch (err2) {
        const msg2 = typeof err2 === 'string' ? err2 : err2?.message;
        const code2 = typeof err2 === 'object' ? err2?.code : null;

        if (msg2 === 'connect_timeout' || msg2 === 'timeout' || code2 === 'ECONNRESET') {
          if (debug) console.log(`Polling warning (energylink) for device ${id}:`, msg2 || code2);
          continue;
        }

        console.error(`Polling error (energylink) for device ${id}:`, err2);
        continue;
      }

      if (response2) {
        self.devices[id].polldata.energylink_el = response2;
      }
    }
  }
};



  return homewizard;
}());
