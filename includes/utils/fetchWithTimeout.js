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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  }
}

module.exports = fetchWithTimeout;
