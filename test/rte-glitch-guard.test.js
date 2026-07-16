'use strict';

// A WebSocket re-init on the battery device briefly reports SoC=0% while the real SoC is
// high (observed 88%→0% and 97%→0% within one sample, 2026-07-15). The SoC=0% branch in
// EfficiencyEstimator.update() (`soc === 0 && lastSoc > 2`) fired on those glitches and
// CLEARED the charge/discharge session counters — wiping the real charge accumulation, so
// the next genuine discharge→charge cycle saw pendingCharge≈0 and never booked an RTE
// sample. The battery floors at ~1% in normal use and never reaches a genuine 0%, so the
// only thing that ever hit this branch was the glitch. Guard: only treat SoC=0% as a real
// drain when it is approached gradually from a low, non-zero SoC — never from a sudden
// collapse (glitch) and never re-firing once already at 0 (debounce).
// See project_battery_rte_power_season.

const assert = require('assert');
const EfficiencyEstimator = require('../lib/efficiency-estimator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEstimator() {
  const store = {};
  const homey = { settings: { get: k => store[k], set: (k, v) => { store[k] = v; } }, log: () => {} };
  return new EfficiencyEstimator(homey);
}

// Poll with an explicit SoC + prior SoC; power>100 avoids the standby early-return.
function pollAt(est, { power, soc, lastSoc, dtH = 0.1 }) {
  est.state.lastTimestamp = Date.now() - dtH * 3600000;
  if (lastSoc !== undefined) est.state.lastSoc = lastSoc;
  est.update({}, { battery_power: power, stateOfCharge: soc }, 'zero_charge_only');
}

// A valid cycle-in-progress: a charge session has completed (pending) and a discharge is running.
function armInProgressCycle(est) {
  est.state.lastPowerDirection = 'discharge'; // no direction transition on the next poll
  est.state.pendingChargeKwh = 0.5;
  est.state.sessionDischargeKwh = 0.4;
  est.state.cycles = [];
}

console.log('\nRTE SoC=0 glitch guard:');

test('glitch (SoC 90→0 in one sample) must NOT wipe the charge counter or book a phantom cycle', () => {
  const est = makeEstimator();
  armInProgressCycle(est);
  pollAt(est, { power: -500, soc: 0, lastSoc: 90 });
  assert.strictEqual(est.state.pendingChargeKwh, 0.5, 'pendingCharge wiped by glitch');
  assert.strictEqual((est.state.cycles || []).length, 0, 'phantom cycle booked from glitch');
});

test('genuine gradual drain to 0 (from a low SoC) still books a cycle', () => {
  const est = makeEstimator();
  armInProgressCycle(est);
  pollAt(est, { power: -500, soc: 0, lastSoc: 3 });
  assert.strictEqual((est.state.cycles || []).length, 1, 'gradual drain-to-0 did not book');
});

test('debounce: a second SoC=0 poll (already at 0) does not re-book', () => {
  const est = makeEstimator();
  armInProgressCycle(est);
  pollAt(est, { power: -500, soc: 0, lastSoc: 3 });   // books once (lastSoc now 0)
  est.state.pendingChargeKwh = 0.5;                    // pretend counters refilled
  est.state.sessionDischargeKwh = 0.4;
  pollAt(est, { power: -500, soc: 0, lastSoc: 0 });    // still at 0 → must not re-fire
  assert.strictEqual((est.state.cycles || []).length, 1, 'double-booked at 0');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
