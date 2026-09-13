'use strict';

// 75-min weather-fetch spike (2026-09-12, see HANDOFF/memory
// project_cpu_spike_75min_weather_quantization_0912).
//
// The 15-min policy tick is the only place the weather-age check runs. If the
// threshold sits exactly on a multiple of the tick grid (60min = 4 * 15min),
// the age at the 4th tick is EXACTLY 60min, and a strict `age > intervalMs`
// check never fires on equality — so the fetch defers to the 5th tick and the
// real interval quantizes up to 75min, every cycle, deterministically (no
// jitter/timing needed to reproduce it). Confirmed live via `Weather updated:`
// log lines at 00:45/02:00/03:15/04:30 UTC on 2026-09-12 — exactly 75min apart.
//
// Fix: threshold moved to 55min (off the 15-min grid) at
// drivers/battery-policy/device.js:2415 (_maybeRefreshWeatherOnly) and :5628
// (_gatherInputs) so the check fires on the first tick past the real target,
// landing in the 55-60min band instead of jumping a full extra tick.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const TICK_MS = 15 * 60_000;

// Mirrors the check in _maybeRefreshWeatherOnly / _gatherInputs: weather was
// fetched at t=0, then the 15-min tick polls age at each grid point and
// refetches on the first tick where age > intervalMs. Returns the resulting
// real-world interval between fetches.
function quantizedRefreshInterval(intervalMs) {
  let tick = 0;
  do {
    tick += TICK_MS;
  } while (tick <= intervalMs);
  return tick;
}

test('60min threshold (pre-fix) quantizes to 75min against the 15-min tick grid', () => {
  assert.strictEqual(quantizedRefreshInterval(60 * 60_000), 75 * 60_000);
});

test('55min threshold (fix) lands in the 55-60min band, not 75min', () => {
  const interval = quantizedRefreshInterval(55 * 60_000);
  assert.strictEqual(interval, 60 * 60_000);
  assert.ok(interval < 75 * 60_000, `expected <75min, got ${interval / 60_000}min`);
});

test('device.js still uses the 55min threshold in both call sites (no regression to 60min)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../drivers/battery-policy/device.js'),
    'utf8'
  );
  const matches = src.match(/age > intervalMs|Date\.now\(\) - this\.weatherData\.fetchedAt > 55 \* 60_000/g) || [];
  assert.ok(src.includes('const intervalMs = 55 * 60_000;'), '_maybeRefreshWeatherOnly threshold must be 55 * 60_000');
  assert.ok(src.includes('Date.now() - this.weatherData.fetchedAt > 55 * 60_000'), '_gatherInputs threshold must be 55 * 60_000');
  assert.ok(!src.includes('const intervalMs = 60 * 60_000;'), 'threshold must not be reverted to 60 * 60_000');
});

// Follow-up 2026-09-13: the 55min device threshold alone did not fix it live —
// fetches stayed 75min apart. The forecaster's own in-memory cache still lived
// 60min, so at the ~60min tick the device asked for weather, got the valid
// cache back ("Using cached weather forecast", fetchedAt unchanged) and the real
// fetch slipped to the next tick. Each cached hit still called
// optimizationEngine.updateSettings({}). Model both gates together.
const { CACHE_TTL_MS } = require('../lib/weather-forecaster');
const DEVICE_THRESHOLD_MS = 55 * 60_000;
const FETCH_DURATION_MS = 2_000; // fetchedAt/cacheExpiry are stamped when the fetch completes

// Ticks every 15min from t=0; the first fetch completes at FETCH_DURATION_MS.
// Returns { interval, cachedHits } for the first refresh cycle.
function refreshCycle(cacheTtlMs) {
  const fetchedAt = FETCH_DURATION_MS;
  const cacheExpiry = fetchedAt + cacheTtlMs;
  let cachedHits = 0;
  for (let tick = TICK_MS; tick <= 4 * 60 * 60_000; tick += TICK_MS) {
    if (tick - fetchedAt <= DEVICE_THRESHOLD_MS) continue;
    if (cacheExpiry > tick) { cachedHits++; continue; }
    return { interval: tick, cachedHits };
  }
  throw new Error('no refresh within 4h');
}

test('60min forecaster cache (pre-fix) keeps the real fetch at 75min with a wasted cached hit', () => {
  assert.deepStrictEqual(refreshCycle(60 * 60_000), { interval: 75 * 60_000, cachedHits: 1 });
});

test('forecaster CACHE_TTL_MS: real fetch at 60min, no cached hits in between', () => {
  assert.ok(Number.isFinite(CACHE_TTL_MS), 'weather-forecaster must export CACHE_TTL_MS');
  assert.ok(CACHE_TTL_MS <= DEVICE_THRESHOLD_MS, `cache TTL ${CACHE_TTL_MS / 60_000}min must not exceed device threshold 55min`);
  assert.deepStrictEqual(refreshCycle(CACHE_TTL_MS), { interval: 60 * 60_000, cachedHits: 0 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
