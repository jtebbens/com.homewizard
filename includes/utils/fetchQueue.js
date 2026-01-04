'use strict';

const fetch = require('node-fetch');
const debug = require('./fetchQueueDebug');

const queue = [];
let active = 0;

// Runtime-only, deletion-safe state per device
const deviceState = {};

const MAX_CONCURRENT = 4;
const MIN_DELAY = 200;
const MAX_QUEUE = 100;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(ts, '[fetchQueue]', ...args);
}

function getDeviceIdFromUrl(url) {
  const m = url.match(/:\/\/([^/]+)/);
  return m ? m[1] : url; // IP:port as device ID
}

function processQueue() {
  if (active >= MAX_CONCURRENT) return;
  if (queue.length === 0) return;

  const job = queue.shift();
  const { url, opts, resolve, reject, retry } = job;

  const deviceId = getDeviceIdFromUrl(url);

  // Init per-device state
  if (!deviceState[deviceId]) {
    deviceState[deviceId] = {
      errorCount: 0,
      cooldownUntil: 0,
      lastErrorAt: 0,
      lastFetch: 0,
    };
  }

  const state = deviceState[deviceId];

  // ⏸️ Cooldown active → skip fetch
  if (Date.now() < state.cooldownUntil) {
    const remaining = Math.round((state.cooldownUntil - Date.now()) / 1000);
    log(`⏸️ cooldown active for ${deviceId} (${remaining}s left)`);
    debug.log('cooldown', url, `${remaining}s remaining`);
    setImmediate(processQueue);
    return;
  }

  active++;

  const controller = new AbortController();
  const timeoutMs = opts.timeout || 5000;

  const timeout = setTimeout(() => {
    controller.abort();
    log(`timeout: ${url}`);
    debug.log('timeout', url, `Timeout after ${timeoutMs}ms`);
  }, timeoutMs);

  fetch(url, { ...opts, signal: controller.signal })
    .then(result => {
      // Reset error state on success
      state.errorCount = 0;
      state.cooldownUntil = 0;
      state.lastFetch = Date.now();
      resolve(result);
    })
    .catch(err => {
      // Update error state
      state.errorCount++;
      state.lastErrorAt = Date.now();

      if (err.name === 'AbortError') {
        log(`timeout (abort): ${url}`);
        debug.log('abort', url, 'AbortError');
      } else {
        log(`error on ${url}: ${err.message}`);
        debug.log('network', url, err.message);
      }

      // ❄️ Enter cooldown after 3 consecutive errors
      if (state.errorCount >= 3) {
        state.cooldownUntil = Date.now() + 60000; // 60s cooldown
        log(`❄️ entering cooldown for ${deviceId} (60s)`);
        debug.log('cooldown_start', url, '60s');

        // géén active-- hier: finally doet dat altijd
        setImmediate(processQueue);
        return;
      }

      // Retry once
      if (!retry) {
        log(`retrying once: ${url}`);
        debug.log('retry', url, 'Retrying once');

        setTimeout(() => {
          const key = `${url}|${opts.method || 'GET'}`;

          if (queue.length >= MAX_QUEUE) {
            debug.log('overflow', url, `Queue overflow during retry`);
            return reject(new Error(`Queue overflow during retry: ${key}`));
          }

          if (!queue.some(j => `${j.url}|${j.opts.method || 'GET'}` === key)) {
            queue.push({ url, opts, resolve, reject, retry: true });
          }

          setImmediate(processQueue);
        }, 1000);

      } else {
        log(`final fail: ${url}`);
        debug.log('final_fail', url, err.message);
        reject(err);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      active = Math.max(0, active - 1);

      setTimeout(() => {
        setImmediate(processQueue);
      }, MIN_DELAY + Math.floor(Math.random() * 100));
    });
}

function queuedFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = `${url}|${opts.method || 'GET'}`;

    if (queue.some(job => `${job.url}|${job.opts.method || 'GET'}` === key)) {
      debug.log('duplicate', url, 'Duplicate request suppressed');
      return reject(new Error(`Duplicate request suppressed`));
    }

    if (queue.length >= MAX_QUEUE) {
      debug.log('overflow', url, `Queue overflow: ${queue.length}`);
      return reject(new Error(`Queue overflow: ${queue.length} jobs`));
    }

    queue.push({ url, opts, resolve, reject, retry: false });

    setImmediate(processQueue);
  });
}

queuedFetch.stats = () => ({
  active,
  pending: queue.length,
  deviceState,
});

module.exports = queuedFetch;
