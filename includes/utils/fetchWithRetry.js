'use strict';

const fetchWithTimeout = require('./fetchWithTimeout');

/**
 * fetchWithTimeout() with a single retry on transient errors (TIMEOUT, 5xx).
 * Open-Meteo overloads at peak; a 4xx is never retried.
 *
 * @param {string} url
 * @param {object} options        node-fetch options
 * @param {number} timeoutMs      per-attempt timeout
 * @param {number} [retryDelayMs=3000]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, timeoutMs, retryDelayMs = 3000) {
  try {
    const res = await fetchWithTimeout(url, options, timeoutMs);
    if (res.ok || res.status < 500) return res;
    // 5xx → retry
    await new Promise(r => setTimeout(r, retryDelayMs));
    return fetchWithTimeout(url, options, timeoutMs);
  } catch (err) {
    if (err.message !== 'TIMEOUT') throw err;
    await new Promise(r => setTimeout(r, retryDelayMs));
    return fetchWithTimeout(url, options, timeoutMs);
  }
}

module.exports = fetchWithRetry;
