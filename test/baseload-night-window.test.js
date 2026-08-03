'use strict';

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

function makeMonitor() {
  const homey = {
    settings: { get: () => null, set: () => {} },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  return new BaseloadMonitor(homey);
}

console.log('\nBaseloadMonitor Amsterdam-local night window\n');

// ── _getAmsterdamHour: the core UTC-vs-local bug ────────────────────────────
test('summer (CEST, UTC+2): 04:43 UTC reads as Amsterdam hour 6, not 4', () => {
  const m = makeMonitor();
  const d = new Date('2026-07-09T04:43:48Z');
  assert.strictEqual(m._getAmsterdamHour(d), 6);
});

test('winter (CET, UTC+1): 04:43 UTC reads as Amsterdam hour 5, not 4', () => {
  const m = makeMonitor();
  const d = new Date('2026-01-09T04:43:48Z');
  assert.strictEqual(m._getAmsterdamHour(d), 5);
});

// ── _isInNightWindow: the reported incident, reproduced ─────────────────────
test('06:43:48 CEST (04:43:48 UTC) is OUTSIDE the 01:00-05:00 window (was: inside, the bug)', () => {
  const m = makeMonitor();
  const d = new Date('2026-07-09T04:43:48Z'); // 06:43:48 CEST
  assert.strictEqual(m._isInNightWindow(d), false);
});

test('02:00 CEST (00:00 UTC) is INSIDE the 01:00-05:00 window', () => {
  const m = makeMonitor();
  const d = new Date('2026-07-09T00:00:00Z'); // 02:00 CEST
  assert.strictEqual(m._isInNightWindow(d), true);
});

test('04:59 CEST (02:59 UTC) is INSIDE the window; 05:01 CEST (03:01 UTC) is not', () => {
  const m = makeMonitor();
  assert.strictEqual(m._isInNightWindow(new Date('2026-07-09T02:59:00Z')), true);
  assert.strictEqual(m._isInNightWindow(new Date('2026-07-09T03:01:00Z')), false);
});

// ── _getNextAmsterdamHourBoundary ────────────────────────────────────────────
test('boundary later today when target hour hasn\'t passed yet (Amsterdam-local)', () => {
  const m = makeMonitor();
  const now = new Date('2026-07-09T00:00:00Z'); // 02:00 CEST
  const next = m._getNextAmsterdamHourBoundary(5, now); // next 05:00 CEST
  assert.strictEqual(next.toISOString(), '2026-07-09T03:00:00.000Z'); // 05:00 CEST = 03:00 UTC
});

test('boundary rolls to tomorrow when target hour already passed today', () => {
  const m = makeMonitor();
  const now = new Date('2026-07-09T10:00:00Z'); // 12:00 CEST, well past 05:00
  const next = m._getNextAmsterdamHourBoundary(5, now);
  assert.strictEqual(next.toISOString(), '2026-07-10T03:00:00.000Z');
});

// ── _detectPVStartup: rawGridPower vs clamped power ─────────────────────────
test('fires on rawGridPower<0 even though power (clamped) is 0 — was dead code before', () => {
  const m = makeMonitor();
  m.currentNightSamples = [{ ts: new Date('2026-07-09T04:30:00Z'), power: 0, rawGridPower: -150, batteryPower: 0 }];
  m._detectPVStartup();
  assert.strictEqual(m.flags.sawPVStartup, true);
  assert.strictEqual(m.nightInvalid, true);
});

test('does not fire when rawGridPower is also >=0 (genuine low draw, not PV export)', () => {
  const m = makeMonitor();
  m.currentNightSamples = [{ ts: new Date('2026-07-09T04:30:00Z'), power: 50, rawGridPower: 50, batteryPower: 0 }];
  m._detectPVStartup();
  assert.strictEqual(m.flags.sawPVStartup, undefined);
  assert.strictEqual(m.nightInvalid, false);
});

test('does not fire outside the pvStartupEarliest-pvStartupLatest hour range', () => {
  const m = makeMonitor();
  m.currentNightSamples = [{ ts: new Date('2026-07-09T00:00:00Z'), power: 0, rawGridPower: -150, batteryPower: 0 }]; // 02:00 CEST
  m._detectPVStartup();
  assert.strictEqual(m.flags.sawPVStartup, undefined);
});

// ── _hasWindowCoverage: partially-measured nights ──────────────────────────
// Night history stores ts as epoch ms (see _downsampleSamples).
function night(date, { minutes, count, powers }) {
  const start = Date.UTC(2026, 6, 9, 0, 0, 0);
  const step = count > 1 ? (minutes * 60000) / (count - 1) : 0;
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push({ ts: start + Math.round(i * step), power: powers(i) });
  }
  return { date, avg: 300, invalid: false, samples };
}

const fullNight = (date, w) => night(date, { minutes: 239, count: 240, powers: () => w });
// The 2026-07-09 incident: 39 samples over 32 minutes, 18 of them at 0 W once PV covered the house.
const truncatedNight = night('2026-07-09', { minutes: 32, count: 39, powers: (i) => (i >= 21 ? 0 : 300) });

test('coverage: a full 239-minute night passes', () => {
  const m = makeMonitor();
  assert.strictEqual(m._hasWindowCoverage(fullNight('2026-08-03', 250).samples), true);
});

test('coverage: the 32-minute night of 2026-07-09 is rejected', () => {
  const m = makeMonitor();
  assert.strictEqual(m._hasWindowCoverage(truncatedNight.samples), false);
});

test('coverage: 173 minutes (the real 2026-07-05 night) still passes — threshold is not too strict', () => {
  const m = makeMonitor();
  const n = night('2026-07-05', { minutes: 173, count: 209, powers: () => 259 });
  assert.strictEqual(m._hasWindowCoverage(n.samples), true);
});

test('coverage: span alone is not enough — 2 samples 4h apart still fail the >=10 sample check', () => {
  const m = makeMonitor();
  const sparse = night('2026-08-01', { minutes: 240, count: 2, powers: () => 250 });
  assert.strictEqual(m._hasWindowCoverage(sparse.samples), true);
  m.nightHistory = [sparse];
  // No night survives the sample-count check, so smart filtering yields nothing and _compute() runs.
  assert.strictEqual(m._computeSmartBaseload(), 300); // _compute() averages the stored avg
});

test('smart baseload ignores the truncated night (was: dragged down to 170 W by its 0 W median)', () => {
  const m = makeMonitor();
  m.nightHistory = [
    fullNight('2026-08-01', 250),
    fullNight('2026-08-02', 260),
    fullNight('2026-08-03', 270),
    truncatedNight,
  ];
  assert.strictEqual(m._computeSmartBaseload(), 260); // avg of 250, 260, 270
});

test('fallback ignores the truncated night too', () => {
  const m = makeMonitor();
  m.nightHistory = [fullNight('2026-08-01', 250), truncatedNight];
  assert.strictEqual(m._fallback(), 250);
});

test('_loadState re-derives currentBaseload, so a stale stored value does not survive a restart', () => {
  const stored = {
    currentBaseload: 170, // what the old filter produced, including the truncated night
    nightHistory: [
      fullNight('2026-08-01', 250),
      fullNight('2026-08-02', 260),
      fullNight('2026-08-03', 270),
      truncatedNight,
    ],
  };
  const m = new BaseloadMonitor({
    settings: { get: (k) => (k === 'baseload_state' ? stored : null), set: () => {} },
    setTimeout, clearTimeout,
  });
  m.stateDir = '/nonexistent'; // samples come from the inline history, not from disk
  m._loadState();
  assert.strictEqual(m.currentBaseload, 260);
  assert.ok(m._saveTimer, 'must schedule a write, or the settings page keeps rendering the old value');
  clearTimeout(m._saveTimer);
});

test('_loadState does not schedule a write when the stored value already agrees', () => {
  const stored = {
    currentBaseload: 260,
    nightHistory: [fullNight('2026-08-01', 250), fullNight('2026-08-02', 260), fullNight('2026-08-03', 270)],
  };
  const m = new BaseloadMonitor({
    settings: { get: (k) => (k === 'baseload_state' ? stored : null), set: () => {} },
    setTimeout, clearTimeout,
  });
  m.stateDir = '/nonexistent';
  m._loadState();
  assert.ok(!m._saveTimer);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
