'use strict';

const fetch = require('../../includes/utils/fetchQueue');
const https = require('https');

// Unified timeout wrapper — returns parsed JSON or text
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fetch timeout')), timeout);

    fetch(url, options)
      .then(async res => {
        clearTimeout(timer);

        const text = await res.text();
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
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

  // -------------------------
  // IDENTIFY
  // -------------------------
  api.identify = async function (url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const data = await fetchWithTimeout(`${url}/api/system/identify`, {
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
    } catch (err) {
      throw new Error(`identify failed: ${err.message}`);
    }
  };

  // -------------------------
  // MEASUREMENT
  // -------------------------
  api.getMeasurement = async function (url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const data = await fetchWithTimeout(`${url}/api/measurement`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent,
      });

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }

      return data;
    } catch (err) {
      throw new Error(`getMeasurement failed: ${err.message}`);
    }
  };

  // -------------------------
  // SYSTEM
  // -------------------------
  api.getSystem = async function (url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const data = await fetchWithTimeout(`${url}/api/system`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent,
      });

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }

      return data;
    } catch (err) {
      throw new Error(`getSystem failed: ${err.message}`);
    }
  };

  // -------------------------
  // INFO (still uses raw fetch)
  // -------------------------
  api.getInfo = async function (url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
    }).catch(err => {
      throw new Error(`Network error: ${err.message}`);
    });

    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  };

  // -------------------------
  // GET MODE
  // -------------------------
  api.getMode = async function (url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const data = await fetchWithTimeout(`${url}/api/batteries`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent,
      });

      if (!data || typeof data !== 'object') {
        throw new Error('Invalid response format');
      }

      // New firmware path
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

      // Legacy fallback
      return data.mode;
    } catch (err) {
      throw new Error(`getMode failed: ${err.message}`);
    }
  };

  // -------------------------
  // SET MODE
  // -------------------------
  api.setMode = async function (url, token, selectedMode) {
    const retries = 4;
    let lastError;

    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');
    if (!selectedMode) throw new Error('Mode is not defined');

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
        const data = await fetchWithTimeout(`${url}/api/batteries`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          agent: http_agent,
          body: JSON.stringify(body),
        }, 5000);

        if (!data || typeof data !== 'object') {
          throw new Error('Invalid response format');
        }

        return data;
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
        const data = await fetchWithTimeout(`${url}/api/system`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          agent: http_agent,
          body: JSON.stringify({ cloud_enabled: enabled }),
        }, 5000);

        if (!data || typeof data !== 'object') {
          throw new Error('Invalid response format');
        }

        return data;
      } catch (err) {
        lastError = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
  };

  return api;
}());
