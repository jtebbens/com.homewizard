const fetch = require('node-fetch');

const queue = [];
let active = 0;
const MAX_CONCURRENT = 4;
const MIN_DELAY = 200; // ms between jobs

function processQueue() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  const { url, opts, resolve, reject, retry } = queue.shift();
  active++;
  //console.log(`[fetchQueue] start: active=${active}, pending=${queue.length}, url=${url}`);  

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
    console.error(`[fetchQueue] timeout: ${url}`);
  }, opts.timeout || 5000); // default 5s

  fetch(url, { ...opts, signal: controller.signal })
    .then(resolve)
    .catch(err => {
      console.error(`[fetchQueue] error on ${url}: ${err.message}`);
      if (!retry) {
        console.log(`[fetchQueue] retrying once: ${url}`);
        setTimeout(() => {
          queue.push({ url, opts, resolve, reject, retry: true });
          processQueue();
        }, 1000); // 1s backoff
      } else {
        console.error(`[fetchQueue] final fail: ${url}`);
        reject(err);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      active = Math.max(0, active - 1);
      if (queue.length > MAX_CONCURRENT) {
        console.log(`[fetchQueue] done: active=${active}, pending=${queue.length}`);
      }
      setTimeout(processQueue, MIN_DELAY);
    });
}

function queuedFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ url, opts, resolve, reject, retry: false });
    //console.log(`[fetchQueue] enqueued: active=${active}, 
    processQueue();
  });
}

module.exports = queuedFetch;
