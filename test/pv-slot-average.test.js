'use strict';

// PV slot averaging — the missing half of the replay harness inputs.
//
// policy_mode_history stores pvW as a single instantaneous reading taken at the moment of the
// policy run. The 2026-07-19 replay calibration showed that is not reconstructable: the
// firmware regulates continuously on zero-on-meter for the whole 15 minutes, so one sample at
// the start of the slot cannot explain the energy that actually moved. Charge slots were the
// worst offenders — e.g. pv=1137 cons=914 (surplus 223 W) while the pack actually took on
// ~797 W, because PV had climbed steeply during the slot and the opening sample missed it.
//
// consumAvgW already solves exactly this problem for the load side (commit 2eb8892, plus the
// race fix in consumption-slot-race.test.js). This mirrors it for PV: same 15s poll, same
// slot boundary, same freeze-on-rollover, so the two averages are drawn from an identical
// sample set and can be paired honestly.
//
// Regression intent: pvAvgW must freeze together with the load slot, never be derived from a
// different sample population, and never divide by zero when a slot collected no samples.

const assert = require('assert');
const Module = require('module');
const fs = require('fs');
const path = require('path');

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

function deviceMidSlot(slotStart, { samples = 60, meanW = 500, pvMeanW = 1200 } = {}) {
  return {
    _loadSlotMs: slotStart,
    _loadSlotSum: samples * meanW,
    _loadSlotCount: samples,
    _pvSlotSum: samples * pvMeanW,
    _pvSlotCount: samples,
    _loadPrevSlotMs: null,
    _loadPrevMeanW: null,
    _loadPrevCount: 0,
    _pvPrevMeanW: null,
    _pvPrevCount: 0,
  };
}

console.log('PV slot averaging:');

test('rolling the slot freezes the PV mean alongside the load mean', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1, { samples: 60, meanW: 500, pvMeanW: 1200 });

  rollLoadSlot.call(ctx, s1 + SLOT + 500);

  assert.strictEqual(ctx._loadPrevMeanW, 500, 'load mean frozen');
  assert.strictEqual(ctx._pvPrevMeanW, 1200, 'PV mean frozen');
  assert.strictEqual(ctx._pvPrevCount, 60, 'PV sample count frozen');
});

test('PV and load means come from the same sample population', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1, { samples: 47, meanW: 800, pvMeanW: 300 });

  rollLoadSlot.call(ctx, s1 + SLOT + 500);

  assert.strictEqual(ctx._pvPrevCount, ctx._loadPrevCount,
    'PV and load must be averaged over the same samples, otherwise pairing them is dishonest');
});

test('the accumulators reset for the new slot', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1);

  rollLoadSlot.call(ctx, s1 + SLOT + 500);

  assert.strictEqual(ctx._pvSlotSum, 0, 'PV sum reset');
  assert.strictEqual(ctx._pvSlotCount, 0, 'PV count reset');
});

test('a slot that collected no samples does not produce a NaN mean', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1, { samples: 0 });
  ctx._loadSlotSum = 0;
  ctx._pvSlotSum = 0;

  rollLoadSlot.call(ctx, s1 + SLOT + 500);

  assert.ok(!Number.isNaN(ctx._pvPrevMeanW), 'PV mean must not be NaN');
  assert.strictEqual(ctx._pvPrevMeanW, null, 'an empty slot leaves the previous mean untouched');
});

test('rolling twice within the same slot is a no-op (idempotent)', () => {
  const s1 = 1_800_000_000_000 - (1_800_000_000_000 % SLOT);
  const ctx = deviceMidSlot(s1, { pvMeanW: 900 });
  const at = s1 + SLOT + 500;

  rollLoadSlot.call(ctx, at);
  ctx._pvSlotSum = 5 * 100;
  ctx._pvSlotCount = 5;
  rollLoadSlot.call(ctx, at + 1000);

  assert.strictEqual(ctx._pvPrevMeanW, 900, 'second call must not overwrite the frozen mean');
});

// ── WIRING ────────────────────────────────────────────────────────────────────────────────
// The kernel above can be perfectly correct while nothing ever feeds it — that is exactly how
// the consumption meter sat dead for 5 days and recordModelAccuracy for 3.7 weeks. These read
// the source and assert the accumulation and the read-back are actually present.

const deviceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'drivers', 'battery-policy', 'device.js'), 'utf8'
);

test('WIRING: the 15s poll accumulates pvW into the slot', () => {
  assert.ok(/_pvSlotSum\s*\+=/.test(deviceSrc),
    'no accumulation into _pvSlotSum found — the averager would never collect anything');
  assert.ok(/_pvSlotCount\+\+|_pvSlotCount\s*\+=/.test(deviceSrc),
    'no _pvSlotCount increment found');
});

test('WIRING: PV accumulates under the same guard as consumption', () => {
  // Both must sit inside the same `if (houseConsumptionW >= 0 && !batteryPowerLag)` block, so
  // a rejected poll drops both or neither. Divergence here silently biases one against the
  // other and the paired means stop being comparable.
  const guard = deviceSrc.indexOf('!batteryPowerLag');
  assert.ok(guard > 0, 'guard not found');
  const loadIdx = deviceSrc.indexOf('_loadSlotSum +=', guard);
  const pvIdx = deviceSrc.indexOf('_pvSlotSum +=', guard);
  assert.ok(pvIdx > 0, '_pvSlotSum accumulation not found after the guard');
  assert.ok(pvIdx > loadIdx, 'expected the PV accumulation after the load accumulation');
  // Directly assert "same block" rather than proxying it with character distance: nothing
  // between the two may close a scope, so no branch can accept one and skip the other.
  const between = deviceSrc.slice(loadIdx, pvIdx).replace(/\/\/[^\n]*/g, '');
  assert.ok(!between.includes('}'),
    'a block closes between the load and PV accumulation — they are no longer guarded together');
});

test('WIRING: the history entry exposes pvAvgW with the same freshness guard as consumAvgW', () => {
  assert.ok(/pvAvgW:/.test(deviceSrc), 'pvAvgW not written to the history entry');
  const entryIdx = deviceSrc.indexOf('pvAvgW:');
  const window = deviceSrc.slice(entryIdx, entryIdx + 300);
  assert.ok(/_loadPrevSlotMs/.test(window) && /30 \* 60_000/.test(window),
    'pvAvgW must reuse the 30-min freshness guard, like consumAvgW');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
