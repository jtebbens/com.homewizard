// includes/utils/fetchQueue.js
const fetch = require('node-fetch');
const { URL } = require('url');

const MAX_CONCURRENT_PER_BUCKET = 2;      // per host/IP
const GLOBAL_MAX_PENDING         = 5000;  // safety net
const MAX_PENDING_PER_BUCKET     = 1000;

const DEFAULT_TIMEOUT_MS         = 5000;

const MAX_RETRIES                = 1;     // original + 1 retry
const BACKOFF_BASE_MS            = 1000;
const BACKOFF_FACTOR             = 2;
const BACKOFF_MAX_MS             = 15000;

const MAX_JOB_AGE_MS             = 10000; // drop jobs older than 10s

const JITTER_MIN_MS              = 100;
const JITTER_MAX_MS              = 250;

// bucketKey = hostname:port (derived from URL)
// bucket = { queue: Job[], active: number, backoffUntil: number }
const buckets = new Map();
let globalPending = 0;

const http = require('http');
const https = require('https');

const legacyHttpAgent  = new http.Agent({ keepAlive: false });
const legacyHttpsAgent = new https.Agent({ keepAlive: false });

function isLegacyHomeWizard(url) {
  return url.includes('/get-status') || url.includes('/get-sensors');
}



function now() {
  return Date.now();
}

function getBucketKeyFromUrl(url) {
  try {
    const u = new URL(url);
    // normalize: host:port (port may be empty for :80/:443)
    return u.host || u.hostname;
  } catch {
    return 'default';
  }
}

function getBucket(bucketKey) {
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = {
      queue: [],
      active: 0,
      backoffUntil: 0,
    };
    buckets.set(bucketKey, bucket);
  }
  return bucket;
}

function calcBackoffMs(retryCount) {
  const ms = BACKOFF_BASE_MS * Math.pow(BACKOFF_FACTOR, retryCount);
  return Math.min(ms, BACKOFF_MAX_MS);
}

function jitterDelay() {
  return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS));
}

function scheduleBucketProcess(bucketKey, delayMs = 0) {
  if (delayMs <= 0) {
    processBucket(bucketKey);
  } else {
    setTimeout(() => processBucket(bucketKey), delayMs);
  }
}

function processBucket(bucketKey) {
  const bucket = buckets.get(bucketKey);
  if (!bucket) return;

  const nowMs = now();

  // Backoff in effect?
  if (bucket.backoffUntil > nowMs) {
    const delay = bucket.backoffUntil - nowMs;
    scheduleBucketProcess(bucketKey, delay);
    return;
  }

  while (
    bucket.active < MAX_CONCURRENT_PER_BUCKET &&
    bucket.queue.length > 0
  ) {
    const job = bucket.queue.shift();
    globalPending = Math.max(0, globalPending - 1);

    // Drop stale jobs
    if (nowMs - job.createdAt > MAX_JOB_AGE_MS) {
      job.reject(new Error(`fetchQueue: job expired (${bucketKey})`));
      continue;
    }

    executeJob(bucketKey, bucket, job);
  }
}

function executeJob(bucketKey, bucket, job) {
  bucket.active++;

  const timeoutMs = job.timeoutMs || DEFAULT_TIMEOUT_MS;

  let timeoutId;

  // Build opts (agent injection stays the same)
  let opts = { ...job.opts };

  if (isLegacyHomeWizard(job.url)) {
    opts.agent = job.url.startsWith('https')
      ? legacyHttpsAgent
      : legacyHttpAgent;
  }

  // Timeout promise
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Timeout'));
    }, timeoutMs);
  });

  // Race fetch vs timeout
  Promise.race([
    fetch(job.url, opts),
    timeoutPromise
  ])
    .then(res => {
      bucket.backoffUntil = 0;
      job.resolve(res);
    })
    .catch(err => {
      const isTimeout = err.message === 'Timeout';

      console.error(
        `[fetchQueue] error on ${job.url} (bucket=${bucketKey}, retry=${job.retryCount}): ${err.message}`
      );

      if (job.retryCount < MAX_RETRIES && isTimeout) {
        job.retryCount++;
        const backoffMs = calcBackoffMs(job.retryCount);
        bucket.backoffUntil = now() + backoffMs;

        console.log(
          `[fetchQueue] retrying (bucket=${bucketKey}, in ${backoffMs}ms): ${job.url}`
        );

        setTimeout(() => enqueueExistingJob(bucketKey, job), backoffMs);
      } else {
        console.error(
          `[fetchQueue] final fail (bucket=${bucketKey}, retry=${job.retryCount}): ${job.url}`
        );
        job.reject(err);
      }
    })
    .finally(() => {
      clearTimeout(timeoutId);
      bucket.active = Math.max(0, bucket.active - 1);
      scheduleBucketProcess(bucketKey, jitterDelay());
    });
}


function enqueueExistingJob(bucketKey, job) {
  const bucket = getBucket(bucketKey);

  if (bucket.queue.length >= MAX_PENDING_PER_BUCKET) {
    job.reject(
      new Error(
        `fetchQueue: bucket overflow for '${bucketKey}' (${bucket.queue.length} jobs)`,
      ),
    );
    return;
  }

  bucket.queue.push(job);
  globalPending++;
  scheduleBucketProcess(bucketKey);
}

function queuedFetch(url, opts = {}) {
  const bucketKey = getBucketKeyFromUrl(url);

  if (globalPending >= GLOBAL_MAX_PENDING) {
    return Promise.reject(
      new Error(
        `fetchQueue: global overflow (${globalPending} jobs pending)`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const bucket = getBucket(bucketKey);

    if (bucket.queue.length >= MAX_PENDING_PER_BUCKET) {
      reject(
        new Error(
          `fetchQueue: bucket overflow for '${bucketKey}' (${bucket.queue.length} jobs)`,
        ),
      );
      return;
    }

    const job = {
      url,
      opts,
      resolve,
      reject,
      createdAt: now(),
      retryCount: 0,
      timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    };

    bucket.queue.push(job);
    globalPending++;

    scheduleBucketProcess(bucketKey);
  });
}

// Optional: simple stats helper, non-breaking
queuedFetch.stats = () => {
  const perBucket = {};
  for (const [key, bucket] of buckets.entries()) {
    perBucket[key] = {
      active: bucket.active,
      pending: bucket.queue.length,
      backoffUntil: bucket.backoffUntil,
    };
  }
  return {
    globalPending,
    buckets: perBucket,
  };
};

module.exports = queuedFetch;
