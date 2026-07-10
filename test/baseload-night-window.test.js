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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
