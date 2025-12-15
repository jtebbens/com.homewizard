'use strict';

const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');
const https = require('https');

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return res; // ✅ return raw Response
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = (function() {
  const api = {};

  const http_agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 11000,
    rejectUnauthorized: false, // Ignore SSL errors
  });

  // Identify
  api.identify = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api/system/identify`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      agent: http_agent,
    }).catch((err) => {
      throw new Error(`Network error: ${err.message}`);
    });

    if (!res.ok) throw new Error(res.statusText);
  };

  // Measurement
  api.getMeasurement = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const res = await fetchWithTimeout(`${url}/api/measurement`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
      }
      return res.json();
    } catch (err) {
      throw new Error(`getMeasurement failed: ${err.message}`);
    }
  };

  // System
  api.getSystem = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const res = await fetchWithTimeout(`${url}/api/system`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
      }
      return res.json();
    } catch (err) {
      throw new Error(`getSystem failed: ${err.message}`);
    }
  };

  // Info
  api.getInfo = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: http_agent,
    }).catch((err) => {
      throw new Error(`Network error: ${err.message}`);
    });

    if (!res.ok) throw new Error(res.statusText);
    return res.json();
  };

  // getMode
  api.getMode = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      const res = await fetchWithTimeout(`${url}/api/batteries`, {
        headers: { Authorization: `Bearer ${token}` },
        agent: http_agent
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
      }

      const data = await res.json();
      // console.log ('getMode: ', data, 'url: ', url);

      // --- New firmware path ---
      if (Array.isArray(data.permissions)) {
        const perms = [...data.permissions].sort().join(',');
        if (data.mode === 'to_full') {
          return 'to_full';
        }
        switch (perms) {
          case '': return 'standby';
          case 'charge_allowed,discharge_allowed': return 'zero';
          case 'charge_allowed': return 'zero_charge_only';
          case 'discharge_allowed': return 'zero_discharge_only';
          default:
            // Defensive: unknown combo
            throw new Error(`Unknown permissions combination: ${JSON.stringify(data.permissions)}`);
        }
      }

      // --- Legacy fallback path ---
      // If permissions not present at all, just return the mode string
      return data.mode;

    } catch (err) {
      throw new Error(`getMode failed: ${err.message}`);
    }
  };


  // Set Mode with improved retry
  api.setMode = async function(url, token, selectedMode) {
  const retries = 4;
  let lastError;
  if (!url) throw new Error('URL is not defined');
  if (!token) throw new Error('Token is not defined');
  if (!selectedMode) throw new Error('Mode is not defined');

  console.log('api.setMode: Sending mode:', selectedMode);

  // Map selectedMode to payload + method
  let body;
  const method = 'PUT';

  switch (selectedMode) {
    case 'standby':
      body = {
        mode: "standby",
        permissions: []
      };
      break;

    case 'zero':
      body = {
        mode: "zero",
        permissions: ["charge_allowed", "discharge_allowed"]
      };
      break;

    case 'zero_charge_only':
      body = {
        mode: "zero",
        permissions: ["charge_allowed"]
      };
      break;

    case 'zero_discharge_only':
      body = {
        mode: "zero",
        permissions: ["discharge_allowed"]
      };
      break;

    case 'to_full':
      body = { mode: "to_full" };
      break;

    default:
      body = { mode: selectedMode };
      break;
  }



  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(`${url}/api/batteries`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        agent: http_agent,
        body: JSON.stringify(body)
      }, 5000);

      console.log('setMode body sent: ', body);

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
      }
      return res.json();
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
};


  // Cloud On
  api.setCloudOn = async function(url, token) {
    const retries = 3;
    let lastError;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    console.log('api.setCloud: This cloudstate will be sent to: ON');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(`${url}/api/system`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          agent: http_agent,
          body: JSON.stringify({ cloud_enabled: true })
        }, 5000);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
        }
        return res.json();
      } catch (err) {
        lastError = err;
        console.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
  };

  // Cloud Off
  api.setCloudOff = async function(url, token) {
    const retries = 3;
    let lastError;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    console.log('api.setCloud: This cloudstate will be sent to: OFF');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetchWithTimeout(`${url}/api/system`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          agent: http_agent,
          body: JSON.stringify({ cloud_enabled: false })
        }, 5000);

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
        }
        return res.json();
      } catch (err) {
        lastError = err;
        console.warn(`Attempt ${attempt} failed: ${err.message}`);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
    throw new Error(`Fetch failed after ${retries} attempts: ${lastError.message}`);
  };

  return api;
}());
