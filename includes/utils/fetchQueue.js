const fetch = require('node-fetch');

const queue = [];
let active = 0;
const MAX_CONCURRENT = 4;
const MIN_DELAY = 200;
const MAX_QUEUE = 100;

function processQueue() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const { url, opts, resolve, reject, retry } = queue.shift();
  active++;

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.error(`[fetchQueue] timeout: ${url}`);
  }, opts.timeout || 5000);

  fetch(url, { ...opts, signal: controller.signal })
    .then(resolve)
    .catch(err => {
      console.error(`[fetchQueue] error on ${url}: ${err.message}`);
      if (!retry) {
        console.log(`[fetchQueue] retrying once: ${url}`);
        setTimeout(() => {
          queue.push({ url, opts, resolve, reject, retry: true });
          processQueue();
        }, 1000);
      } else {
        console.error(`[fetchQueue] final fail: ${url}`);
        reject(err);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      active = Math.max(0, active - 1);
      //console.log(`[fetchQueue] done: active=${active}, pending=${queue.length}`);
      setTimeout(processQueue, MIN_DELAY + Math.floor(Math.random() * 100));
    });
}

function queuedFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = `${url}|${opts.method || 'GET'}`;

    // Drop if identical job already queued
    if (queue.some(job => `${job.url}|${job.opts.method || 'GET'}` === key)) {
      return reject(new Error(`Duplicate job dropped: ${key}`));
    }

    if (queue.length > MAX_QUEUE) {
      return reject(new Error(`Queue overflow: ${queue.length} jobs`));
    }

    queue.push({ url, opts, resolve, reject, retry: false });
    processQueue();
  });
}


queuedFetch.stats = () => ({ active, pending: queue.length });

module.exports = queuedFetch;
