'use strict';

const fetch = require('node-fetch');
const debug = require('./fetchQueueDebug'); // <-- jouw debug module

const queue = [];
let active = 0;

const MAX_CONCURRENT = 4;
const MIN_DELAY = 200;
const MAX_QUEUE = 100;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(ts, '[fetchQueue]', ...args);
}

function processQueue() {
  if (active >= MAX_CONCURRENT) return;
  if (queue.length === 0) return;

  const job = queue.shift();
  const { url, opts, resolve, reject, retry } = job;

  active++;

  const controller = new AbortController();
  const timeoutMs = opts.timeout || 5000;

  const timeout = setTimeout(() => {
    controller.abort();
    log(`timeout: ${url}`);
    debug.log('timeout', url, `Timeout after ${timeoutMs}ms`);
  }, timeoutMs);

  fetch(url, { ...opts, signal: controller.signal })
    .then(resolve)
    .catch(err => {
      if (err.name === 'AbortError') {
        log(`timeout (abort): ${url}`);
        debug.log('abort', url, 'AbortError');
      } else {
        log(`error on ${url}: ${err.message}`);
        debug.log('network', url, err.message);
      }

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
});

module.exports = queuedFetch;
