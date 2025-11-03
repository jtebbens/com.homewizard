'use strict';

//const fetch = require('node-fetch');
const https = require('https');

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${res.statusText} - ${body}`);
    }

    return res.json();
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
    keepAliveMsecs : 11000,
    rejectUnauthorized: false, // Ignore SSL errors
  });

  /**
   * Async function to perform an 'identify' request to the HomeWizard Energy device.
   *
   * @async
   * @param {string} url - The URL of the HomeWizard Energy device.
   * @param {string} token - The token for authentication.
   * @throws {Error} Throws an error if the URL or token is not defined.
   * @throws {Error} Throws an error if the response is not ok.
   *
   * @returns {Promise<void>} A promise that resolves when the request is successful.
   */
  api.identify = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api/system/identify`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      agent: http_agent, // Ignore SSL errors
    }).catch(((err) => {
      throw new Error(`Network error: ${err.message}`);
    }));

    // Check if the response is ok (status code 200-299)
    if (!res.ok) { throw new Error(res.statusText); }
  };


  /**  
    * Async function to get measurement data from the HomeWizard Energy device.
    * @async
    * @param {string} url - The URL of the HomeWizard Energy device.
    * @param {string} token - The token for authentication. 
  */
    api.getMeasurement = async function(url, token) {
      if (!url) throw new Error('URL is not defined');
      if (!token) throw new Error('Token is not defined');

      try {
        return await fetchWithTimeout(`${url}/api/measurement`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          agent: http_agent
        });
      } catch (err) {
        throw new Error(`getMeasurement failed: ${err.message}`);
      }
    };


/**
 * Async function to get System data from the HomeWizard Energy device.
 * @param {*} url 
 * @param {*} token 
 * @returns 
 */
    api.getSystem = async function(url, token) {
      if (!url) throw new Error('URL is not defined');
      if (!token) throw new Error('Token is not defined');

      try {
        return await fetchWithTimeout(`${url}/api/system`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          agent: http_agent
        });
      } catch (err) {
        throw new Error(`getSystem failed: ${err.message}`);
      }
    };


  api.getInfo = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      agent: http_agent, // Ignore SSL errors
    }).catch(((err) => {
      throw new Error(`Network error: ${err.message}`);
    }));

    // Check if the response is ok (status code 200-299)
    if (!res.ok) { throw new Error(res.statusText); }

    return res.json();
  };

  api.getMode = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    try {
      return await fetchWithTimeout(`${url}/api/batteries`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        agent: http_agent
      });
    } catch (err) {
      throw new Error(`getMode failed: ${err.message}`);
    }
  };

  api.setMode = async function(url, token, selectedMode) {
    let retries = 4;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');
    if (!selectedMode) throw new Error('Mode is not defined');

    console.log('api.setMode: This mode will be sent to P1apiv2:', selectedMode);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(`${url}/api/batteries`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${token}`,
              },
              agent: http_agent,
              body: JSON.stringify({ mode: selectedMode })
            }, 5000); // 5s timeout

            if (!res.ok) {
                const errorText = await res.text();
                throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
            }
            return res.json();
        } catch (err) {
            console.warn(`Attempt ${attempt} failed: ${err.message}`);

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000)); // Simple 3s delay before retry
            } else {
                throw new Error("Fetch failed: P1 Connection problem, max retries reached");
            }
        }
    }
};

api.setCloudOn = async function(url, token) {
    let retries = 3;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');
    //if (!selectedCloud) throw new Error('selectedCloud is not defined');

    console.log('api.setCloud: This cloudstate will be sent to: ON');

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(`${url}/api/system`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                agent: http_agent, // Ignore SSL errors
                body: JSON.stringify({ cloud_enabled: true })
            });

            if (!res.ok) {
                throw new Error(`HTTP error! Status: ${res.status}`);
            }

            return res.json();
        } catch (err) {
            console.warn(`Attempt ${attempt} failed: ${err.message}`);

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Simple 2s delay before retry
            } else {
                throw new Error("Fetch failed: P1 Connection problem, max retries reached");
            }
        }
    }
};

api.setCloudOff = async function(url, token) {
    let retries = 3;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');
    
    console.log('api.setCloud: This cloudstate will be sent to: OFF');

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(`${url}/api/system`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                agent: http_agent, // Ignore SSL errors
                body: JSON.stringify({ cloud_enabled: false })
            });

            if (!res.ok) {
                throw new Error(`HTTP error! Status: ${res.status}`);
            }

            return res.json();
        } catch (err) {
            console.warn(`Attempt ${attempt} failed: ${err.message}`);

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Simple 2s delay before retry
            } else {
                throw new Error("Fetch failed: P1 Connection problem, max retries reached");
            }
        }
    }
};

  return api;
}());
