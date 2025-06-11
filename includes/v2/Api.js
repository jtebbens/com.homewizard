'use strict';

const fetch = require('node-fetch');
const https = require('https');

module.exports = (function() {

  const api = {};

  const http_agent = new https.Agent({
    rejectUnauthorized: false,
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
   * Async function to perform an 'identify' request to the HomeWizard Energy device.
   *
   * @async
   * @param {string} url - The URL of the HomeWizard Energy device.
   * @param {string} token - The token for authentication.
   * @throws {Error} Throws an error if the URL or token is not defined.
   * @throws {Error} Throws an error if the response is not ok.
   *
   * @returns {Promise<data>} A promise that resolves with the response data when the request is successful.
   */
  api.getMeasurement = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api/measurement`, {
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

  api.getSystem = async function(url, token) {
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');

    const res = await fetch(`${url}/api/system`, {
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

    const res = await fetch(`${url}/api/batteries`, {
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

api.setMode = async function(url, token, selectedMode) {
    let retries = 3;
    if (!url) throw new Error('URL is not defined');
    if (!token) throw new Error('Token is not defined');
    if (!selectedMode) throw new Error('Mode is not defined');

    console.log('api.setMode: This mode will be sent to P1apiv2:', selectedMode);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(`${url}/api/batteries`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                agent: http_agent, // Ignore SSL errors
                body: JSON.stringify({ mode: selectedMode })
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
