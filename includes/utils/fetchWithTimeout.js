'use strict';

const fetch = require('node-fetch');

/**
 * fetch() with a hard timeout.
 *
 * Returns a Response (same as fetch), but rejects with Error('TIMEOUT')
 * if the request has not resolved within `timeoutMs` milliseconds.
 *
 * @param {string} url
 * @param {object} [options={}]  node-fetch options (headers, method, body, agent, …)
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Response>}
 */
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

module.exports = fetchWithTimeout;
