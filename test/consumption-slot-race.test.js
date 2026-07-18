'use strict';

// Regression: the consumption accuracy meter was starved by a race between the 15s poll
// and the policy run.
//
// The 15-min load slot is frozen (mean + sample count handed to _loadPrev*) when a poll
// observes that the slot boundary was crossed. But the poll only runs every 15s, while the
// policy run fires at :00:00.5 — so for the first ~15s of every slot the freeze had not
// happened yet, and _loadPrevSlotMs still pointed at the slot that closed 30 minutes ago.
// Both consumers (consumAvgW in policy_mode_history, and recordConsumptionAccuracy) guard on
// `now - _loadPrevSlotMs < 30 min`, so they rejected it — every single scheduled run.
//
// Live evidence (2026-07-18): of 415 history entries, only 21 carried consumAvgW, and every
// one of those came from an off-schedule run that fired 97-411s into its slot. All 43 runs
// after the app settled into a clean :00/:15/:30/:45 cadence were null, and the hourly
// accuracy EMA had collected 5 samples total since being built.
//
// Fix: _rollLoadSlot() is idempotent and called from BOTH the poll and the policy run.

const assert = require('assert');
const Module = require('module');

// device.js pulls in the Homey SDK and the engines; none are touched by _rollLoadSlot, which
// only manipulates this._load* scratch state. Stub them so the module can be loaded at all.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const rollLoadSlot = BatteryPolicyDevice.prototype._rollLoadSlot;

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

const SLOT = 15 * 60_000;
const FRESH_MS = 30 * 60_000; // the guard both consumers apply

// Mirrors the guard in the policy run: is the frozen slot recent enough to score against?
function guardPasses(ctx, nowMs) {
  return ctx._loadPrevSlotMs != null && nowMs - ctx._loadPrevSlotMs < FRESH_MS;
}

// A device whose poll has been accumulating samples into the slot starting at slotStart.
function deviceMidSlot(slotStart, samples = 60, meanW = 500) {
  return {
    _loadSlotMs: slotStart,
    _loadSlotSum: samples * meanW,
    _loadSlotCount: samples,
    _loadPrevSlotMs: slotStart - SLOT, // the slot before it, frozen at the last rollover
    _loadPrevMeanW: 400,
    _loadPrevCount: 60,
  };
}

console.log('Consumption slot-freeze race:');

test('policy run at :00:00.5 sees the slot that JUST closed, not the one before it', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT); // some slot boundary
  const ctx = deviceMidSlot(s1);
  const policyRunMs = s1 + SLOT + 500; // :00:00.5 of the next slot, poll has not run yet

  rollLoadSlot.call(ctx, policyRunMs);

  assert.strictEqual(ctx._loadPrevSlotMs, s1,
    'must freeze the slot that just closed (s1), not leave the older one in place');
  assert.strictEqual(ctx._loadPrevMeanW, 500, 'frozen mean must be s1\'s mean');
  assert.strictEqual(ctx._loadPrevCount, 60, 'frozen count must be s1\'s sample count');
});

test('without the roll, the freshness guard rejects — with it, it passes', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const policyRunMs = s1 + SLOT + 500;

  // The pre-fix situation: policy run reads _loadPrev* before any poll has frozen s1.
  const stale = deviceMidSlot(s1);
  assert.strictEqual(guardPasses(stale, policyRunMs), false,
    'pre-fix: slot-before-previous is 30min+0.5s old, so the guard rejects it');

  // Post-fix: the policy run rolls first.
  const rolled = deviceMidSlot(s1);
  rollLoadSlot.call(rolled, policyRunMs);
  assert.strictEqual(guardPasses(rolled, policyRunMs), true,
    'post-fix: the just-closed slot is 0.5s old, so the guard passes');
});

test('idempotent — the poll calling it right after the policy run is a no-op', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1);
  const policyRunMs = s1 + SLOT + 500;

  rollLoadSlot.call(ctx, policyRunMs);
  const afterPolicy = { ...ctx };

  rollLoadSlot.call(ctx, policyRunMs + 3_000); // the poll, 3s later, same slot
  assert.deepStrictEqual(ctx, afterPolicy,
    'a second call within the same slot must not re-freeze or reset the accumulator');
});

test('the new slot starts empty so the poll accumulates from zero', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1);

  rollLoadSlot.call(ctx, s1 + SLOT + 500);
  assert.strictEqual(ctx._loadSlotMs, s1 + SLOT, 'current slot advances');
  assert.strictEqual(ctx._loadSlotSum, 0);
  assert.strictEqual(ctx._loadSlotCount, 0);
});

test('an empty slot is not frozen (nothing to average)', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1, 0, 0); // slot rolled with zero samples (e.g. poll gap)
  ctx._loadSlotSum = 0;
  const prevBefore = ctx._loadPrevSlotMs;

  rollLoadSlot.call(ctx, s1 + SLOT + 500);
  assert.strictEqual(ctx._loadPrevSlotMs, prevBefore,
    'must not overwrite the last good frozen slot with an empty one (would divide by zero)');
});

test('first call after a restart has nothing to freeze but still arms the current slot', () => {
  const ctx = {}; // fresh device, no _load* state at all
  const nowMs = 1_800_000_000_000 + 4_000;

  rollLoadSlot.call(ctx, nowMs);
  assert.strictEqual(ctx._loadPrevSlotMs, undefined, 'nothing to freeze on the very first call');
  assert.strictEqual(ctx._loadSlotMs, nowMs - (nowMs % SLOT), 'current slot armed');
  assert.strictEqual(ctx._loadSlotCount, 0);
});

test('a run late in the slot (the only case that used to work) still works', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1);
  const lateRunMs = s1 + SLOT + 300_000; // 5 min in — a reactive/off-schedule run

  rollLoadSlot.call(ctx, lateRunMs);
  assert.strictEqual(ctx._loadPrevSlotMs, s1);
  assert.strictEqual(guardPasses(ctx, lateRunMs), true);
});

// The kernel above can be perfectly correct while the meter still collects nothing — that is
// exactly how this bug survived: 17 learning-engine tests were green throughout. What actually
// broke was the WIRING, so pin the call sites too (cf. recordModelAccuracy sitting dead for
// 3.7 weeks while three commits tuned it blind).
test('WIRING: the policy run rolls the slot before reading it', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../drivers/battery-policy/device.js'), 'utf8');

  const rollAt = src.indexOf('this._rollLoadSlot(nowTs.getTime())');
  const entryAt = src.indexOf('consumAvgW:');
  assert.ok(rollAt > 0, 'the policy run must call _rollLoadSlot before building the entry');
  assert.ok(entryAt > 0, 'expected consumAvgW to still be written in the history entry');
  assert.ok(rollAt < entryAt,
    'the roll must happen BEFORE consumAvgW is read, or the freshness guard rejects it');
});

test('WIRING: the 15s poll still rolls the slot before accumulating', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../drivers/battery-policy/device.js'), 'utf8');

  const rollAt = src.indexOf('this._rollLoadSlot();');
  const accAt = src.indexOf('this._loadSlotSum += houseConsumptionW;');
  assert.ok(rollAt > 0, 'the poll must call _rollLoadSlot');
  assert.ok(rollAt < accAt, 'the poll must roll before accumulating into the slot');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
