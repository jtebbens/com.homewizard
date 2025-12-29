'use strict';

// const fetch = require('node-fetch');
const fetch = require('../utils/fetchQueue');

const https = require('https');

// Unified timeout wrapper — returns Response
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fetch timeout')), timeout);

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

module.exports = (function () {
  const api = {};

  const http_agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 11000,
    rejectUnauthorized: false,
  });

  async function fetchJSON(url, opts, timeout = 5000) {
    const res = await fetchWithTimeout(url, opts, timeout);

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
      },
      agent: http_agent,
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
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
    });
  };

  // -------------------------
  // SYSTEM
  // -------------------------
  api.getSystem = async function (url, token) {
    return fetchJSON(`${url}/api/system`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
    });
  };

  // -------------------------
  // INFO
  // -------------------------
  api.getInfo = async function (url, token) {
    return fetchJSON(`${url}/api`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
    });
  };

  // -------------------------
  // GET MODE
  // -------------------------
  api.getMode = async function (url, token) {
    const data = await fetchJSON(`${url}/api/batteries`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
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
  // SET MODE
  // -------------------------
  api.setMode = async function (url, token, selectedMode) {
    const retries = 4;
    let lastError;

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

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fetchJSON(`${url}/api/batteries`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          agent: http_agent,
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 3000));
      }
    }

    throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
  };

  // -------------------------
  // CLOUD ON/OFF
  // -------------------------
  api.setCloudOn = async function (url, token) {
    return api._setCloud(url, token, true);
  };

  api.setCloudOff = async function (url, token) {
    return api._setCloud(url, token, false);
  };

  api._setCloud = async function (url, token, enabled) {
    const retries = 3;
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fetchJSON(`${url}/api/system`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          agent: http_agent,
          body: JSON.stringify({ cloud_enabled: enabled }),
        });
      } catch (err) {
        lastError = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
  };

  return api;
}());
