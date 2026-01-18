'use strict';

const fetch = require('node-fetch');
const https = require('https');

module.exports = (function () {
  const api = {};

  const http_agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 11000,
    rejectUnauthorized: false,
  });

  async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('TIMEOUT'));
      }
    }, timeoutMs);

    fetch(url, options)
      .then(res => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch(err => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}


  /**
   * Pure fetch → always returns parsed JSON or throws
   */
  async function fetchJSON(url, opts = {}) {
    const res = await fetchWithTimeout(url, { agent: http_agent, ...opts });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // -------------------------
  // IDENTIFY
  // -------------------------
  api.identify = async function (url, token) {
    const data = await fetchJSON(`${url}/api/system/identify`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      }
    });

    if (typeof data !== 'object') {
      throw new Error('Invalid response format');
    }
  };

  // -------------------------
  // MEASUREMENT
  // -------------------------
  api.getMeasurement = async function (url, token) {
    return fetchJSON(`${url}/api/measurement`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  };

  // -------------------------
  // SYSTEM
  // -------------------------
  api.getSystem = async function (url, token) {
    return fetchJSON(`${url}/api/system`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  };

  // -------------------------
  // INFO
  // -------------------------
  api.getInfo = async function (url, token) {
    return fetchJSON(`${url}/api`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  };

  // -------------------------
  // GET MODE
  // -------------------------
  api.getMode = async function (url, token) {
    const data = await fetchJSON(`${url}/api/batteries`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (Array.isArray(data.permissions)) {
      const perms = [...data.permissions].sort().join(',');

      if (data.mode === 'to_full') return 'to_full';

      switch (perms) {
        case '':
          return 'standby';
        case 'charge_allowed,discharge_allowed':
          return 'zero';
        case 'charge_allowed':
          return 'zero_charge_only';
        case 'discharge_allowed':
          return 'zero_discharge_only';
        default:
          throw new Error(`Unknown permissions combination: ${JSON.stringify(data.permissions)}`);
      }
    }

    return data.mode;
  };

  // -------------------------
  // SET MODE (no retries)
  // -------------------------
  api.setMode = async function (url, token, selectedMode) {
    let body;

    switch (selectedMode) {
      case 'standby':
        body = { mode: 'standby', permissions: [] };
        break;
      case 'zero':
        body = { mode: 'zero', permissions: ['charge_allowed', 'discharge_allowed'] };
        break;
      case 'zero_charge_only':
        body = { mode: 'zero', permissions: ['charge_allowed'] };
        break;
      case 'zero_discharge_only':
        body = { mode: 'zero', permissions: ['discharge_allowed'] };
        break;
      case 'to_full':
        body = { mode: 'to_full' };
        break;
      default:
        body = { mode: selectedMode };
    }

    return fetchJSON(`${url}/api/batteries`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });
  };

  // -------------------------
  // CLOUD ON/OFF (no retries)
  // -------------------------
  api.setCloudOn = async function (url, token) {
    return api._setCloud(url, token, true);
  };

  api.setCloudOff = async function (url, token) {
    return api._setCloud(url, token, false);
  };

  api._setCloud = async function (url, token, enabled) {
    return fetchJSON(`${url}/api/system`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cloud_enabled: enabled })
    });
  };

  // GET LED BRIGHTNESS
api.getLedBrightness = async function (url, token) {
  const data = await fetchJSON(`${url}/api/system`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (typeof data.status_led_brightness_pct === 'number') {
    return data.status_led_brightness_pct / 100; // Homey expects 0–1
  }

  throw new Error('LED brightness not present in system response');
};



  // SET LED BRIGHTNESS
api.setLedBrightness = async function (url, token, brightnessPct) {
  return fetchJSON(`${url}/api/system`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      status_led_brightness_pct: brightnessPct
    })
  });
};




  return api;
}());
