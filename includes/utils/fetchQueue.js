const fetch = require('node-fetch');

const queue = [];
let active = 0;

const MAX_CONCURRENT = 4;
const MIN_DELAY = 200;
const MAX_QUEUE = 100;

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
    console.error(`[fetchQueue] timeout: ${url}`);
  }, timeoutMs);

  fetch(url, { ...opts, signal: controller.signal })
    .then(resolve)
    .catch(err => {
      if (err.name === 'AbortError') {
        console.error(`[fetchQueue] timeout (abort): ${url}`);
      } else {
        console.error(`[fetchQueue] error on ${url}: ${err.message}`);
      }

      if (!retry) {
        console.log(`[fetchQueue] retrying once: ${url}`);

        setTimeout(() => {
          // Retry must respect MAX_QUEUE and duplicate rules
          const key = `${url}|${opts.method || 'GET'}`;

          if (queue.length >= MAX_QUEUE) {
            return reject(new Error(`Queue overflow during retry: ${key}`));
          }

          if (!queue.some(j => `${j.url}|${j.opts.method || 'GET'}` === key)) {
            queue.push({ url, opts, resolve, reject, retry: true });
          }

          setImmediate(processQueue);
        }, 1000);

      } else {
        console.error(`[fetchQueue] final fail: ${url}`);
        reject(err);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      active = Math.max(0, active - 1);

      // Always schedule next job with jitter
      setTimeout(() => {
        setImmediate(processQueue);
      }, MIN_DELAY + Math.floor(Math.random() * 100));
    });
}

function queuedFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const key = `${url}|${opts.method || 'GET'}`;

    // Duplicate suppression
    if (queue.some(job => `${job.url}|${job.opts.method || 'GET'}` === key)) {
      return reject(new Error(`Duplicate job dropped: ${key}`));
    }

    // Backpressure
    if (queue.length >= MAX_QUEUE) {
      return reject(new Error(`Queue overflow: ${queue.length} jobs`));
    }

    queue.push({ url, opts, resolve, reject, retry: false });

    // Always schedule processing on next tick to avoid starvation
    setImmediate(processQueue);
  });
}

queuedFetch.stats = () => ({
  active,
  pending: queue.length,
});

module.exports = queuedFetch;
