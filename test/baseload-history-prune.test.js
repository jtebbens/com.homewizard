'use strict';

// Regression cover for the stored-history repair in baseloadMonitor:
//  - nights older than maxNightAgeDays are dropped on load (a monitor that stopped finalizing
//    keeps its history forever otherwise), with minNightsKept as a floor
//  - the nights we keep are thinned to historySampleIntervalMs and their timestamps normalised
//  - _hasWindowCoverage() reads ISO timestamps instead of silently failing on NaN
//  - malformed history does not take the load path down

const assert = require('assert');
const BaseloadMonitor = require('../includes/utils/baseloadMonitor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// The monitor only needs homey.settings for these paths.
function makeMonitor(state) {
  const store = { baseload_state: state };
  const homey = {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    __store: store,
  };
  const monitor = new BaseloadMonitor(homey);
  // Migrating schedules a debounced _save(); clear it so the test process can exit.
  monitor.__saveScheduled = !!monitor._saveTimer;
  if (monitor._saveTimer) clearTimeout(monitor._saveTimer);
  monitor._saveTimer = null;
  return monitor;
}

const DAY = 86400000;

function dateKey(daysAgo) {
  return new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
}

// A night as it was written before the downsample landed: ts as an ISO string, one sample every
// stepMs, spanning the whole 01:00-05:00 window so _hasWindowCoverage() can accept it.
function isoNight(daysAgo, stepMs = 2000, spanMs = 4 * 3600000) {
  const date = dateKey(daysAgo);
  const t0 = Date.parse(`${date}T01:00:00.000Z`);
  const samples = [];
  for (let t = 0; t <= spanMs; t += stepMs) {
    samples.push({ ts: new Date(t0 + t).toISOString(), power: 900 + ((t / stepMs) % 7) });
  }
  return { date, avg: null, invalid: true, samples };
}

// A night as _push() writes it today: numeric ts, already at 30 s.
function modernNight(daysAgo) {
  const date = dateKey(daysAgo);
  const t0 = Date.parse(`${date}T01:00:00.000Z`);
  const samples = [];
  for (let t = 0; t <= 4 * 3600000; t += 30000) samples.push({ ts: t0 + t, power: 220 });
  return { date, avg: 220, invalid: false, samples };
}

console.log('baseload history prune + migrate:');

test('drops a night older than maxNightAgeDays, keeps a recent one', () => {
  const m = makeMonitor({ nightHistory: [isoNight(200), modernNight(3), modernNight(2), modernNight(1)] });
  const dates = m.nightHistory.map((n) => n.date);
  assert.strictEqual(dates.length, 3);
  assert.ok(!dates.includes(dateKey(200)), `expected the 200-day-old night to be gone, got ${dates}`);
});

test('an all-stale history keeps exactly minNightsKept nights', () => {
  const nights = [];
  for (let i = 0; i < 12; i++) nights.push(isoNight(300 - i, 30000));
  const m = makeMonitor({ nightHistory: nights });
  assert.strictEqual(m.nightHistory.length, 3);
  // The floor keeps the NEWEST of them.
  assert.strictEqual(m.nightHistory[2].date, dateKey(289));
});

test('the kept stale nights are thinned to 30 s and carry numeric timestamps', () => {
  const nights = [];
  for (let i = 0; i < 4; i++) nights.push(isoNight(300 - i, 2000));
  const m = makeMonitor({ nightHistory: nights });
  assert.strictEqual(m.nightHistory.length, 3);
  for (const night of m.nightHistory) {
    assert.strictEqual(night.samples.length, 481, 'one sample per 30 s over a 4 h window');
    for (const s of night.samples) assert.strictEqual(typeof s.ts, 'number');
  }
});

test('_hasWindowCoverage accepts a normalised legacy night (was NaN -> false)', () => {
  const m = makeMonitor({ nightHistory: [isoNight(300), isoNight(299), isoNight(298)] });
  assert.ok(m._hasWindowCoverage(m.nightHistory[0].samples), 'kept legacy night must count again');
  // And the raw ISO shape is what used to fail, via Number(): keep that failure visible.
  assert.ok(Number.isNaN(Number('2026-01-05T01:00:00.000Z')));
});

test('a healthy history is left alone and schedules no save', () => {
  const nights = [];
  for (let i = 29; i >= 0; i--) nights.push(modernNight(i));
  const before = JSON.stringify(nights);
  const m = makeMonitor({ nightHistory: JSON.parse(before) });
  assert.strictEqual(m.nightHistory.length, 30);
  assert.strictEqual(JSON.stringify(m.nightHistory), before, 'no night may be touched');
  // Both repair steps must report "nothing changed", so _loadState() schedules no write of its
  // own. (The separate currentBaseload re-derive in _loadState() may still save; that is not
  // this migration's doing.)
  assert.strictEqual(m._pruneHistory(), false, 'prune must be inert on a healthy history');
  assert.strictEqual(m._migrateHistory(), false, 'migrate must be inert on a healthy history');
});

test('malformed history does not throw', () => {
  const m = makeMonitor({
    nightHistory: [
      null,
      { date: dateKey(3) },                                        // no samples key
      { date: dateKey(2), samples: [] },                           // empty
      { date: dateKey(1), samples: [null, { power: 3 }, { ts: 'not a date', power: 5 }] },
    ],
  });
  assert.strictEqual(m.nightHistory.length, 3, 'the null night is dropped');
  assert.deepStrictEqual(m.nightHistory[2].samples, [], 'unusable samples are dropped, not kept at epoch 0');
  // The readers must survive it too — these run on every load and every night.
  assert.doesNotThrow(() => m._computeSmartBaseload());
  assert.doesNotThrow(() => m._fallback());
});

test('thinning preserves the night median it is used for', () => {
  const date = dateKey(5);
  const t0 = Date.parse(`${date}T01:00:00.000Z`);
  const samples = [];
  for (let i = 0; i < 3000; i++) samples.push({ ts: t0 + i * 2000, power: 700 + (i % 200) });
  const median = (arr) => {
    const p = arr.map((s) => s.power).filter((x) => x >= 0 && x < 1000).sort((a, b) => a - b);
    const half = p.slice(0, Math.floor(p.length / 2));
    return half[Math.floor(half.length / 2)];
  };
  const before = median(samples);
  const m = makeMonitor({ nightHistory: [{ date, avg: 800, invalid: false, samples }] });
  const after = median(m.nightHistory[0].samples);
  assert.ok(Math.abs(after - before) <= 5, `median moved from ${before} to ${after}`);
});

console.log('\n══════════════════════════════');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('══════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
