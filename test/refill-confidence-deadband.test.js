'use strict';

// refillConfidence deadband (2026-07-05 flip-flop incident). Open-Meteo refreshes its
// ensemble hourly even overnight, so pvSpreadTomorrow — and thus refillConfidence —
// churns on pure model disagreement with zero new PV observation to validate it at
// night. That churn moved the reserve floor enough to flip which slot the DP reorder
// picked for discharge vs. preserve at an unchanged price (raw refillConfidence
// 0.84→0.70 in 30min). _applyRefillConfidenceDeadband suppresses swings below
// REFILL_CONFIDENCE_DEADBAND, anchored against the last APPLIED value.
//
// device.js does `require('homey')`, so stub that module before loading the class. We
// only LOAD the class to reach its prototype method — we never instantiate the Homey
// lifecycle.

const assert = require('assert');
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'homey') return { Device: class {}, App: class {}, FlowCardTrigger: class {} };
  return _origLoad.call(this, req, ...a);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module._load = _origLoad;

let passed = 0, failed = 0;
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

function makeDev(initialLastApplied) {
  const dev = { _lastRefillConfidence: initialLastApplied };
  dev._applyRefillConfidenceDeadband = BatteryPolicyDevice.prototype._applyRefillConfidenceDeadband;
  return dev;
}

test('cold start: undefined _lastRefillConfidence never suppressed', () => {
  const dev = makeDev(undefined);
  const applied = dev._applyRefillConfidenceDeadband(0.75);
  assert.strictEqual(applied, 0.75);
});

test('noise below threshold suppressed, anchored against last APPLIED value', () => {
  const dev = makeDev(undefined);
  const raw = [0.80, 0.84, 0.76, 0.83];
  const applied = raw.map(r => {
    const a = dev._applyRefillConfidenceDeadband(r);
    dev._lastRefillConfidence = a;
    return a;
  });
  assert.deepStrictEqual(applied, [0.80, 0.80, 0.80, 0.80], 'all deltas vs. 0.80 stay under 0.05');
});

test('real change above threshold updates', () => {
  const dev = makeDev(0.80);
  const applied = dev._applyRefillConfidenceDeadband(0.86);
  assert.strictEqual(applied, 0.86, 'delta 0.06 exceeds deadband, must pass through');
});

test('delta exactly at threshold (0.05) still suppressed (strict <)', () => {
  const dev = makeDev(0.80);
  const applied = dev._applyRefillConfidenceDeadband(0.85);
  assert.strictEqual(applied, 0.80);
});

test('boundary crossing 1.0: small oscillation around 1.0 suppressed', () => {
  const dev = makeDev(0.96);
  const applied = dev._applyRefillConfidenceDeadband(1.0);
  assert.strictEqual(applied, 0.96, 'delta 0.04 stays under 0.05, no-floor branch not reached yet');
});

test('boundary crossing 1.0: real move (>0.05) does cross into no-floor branch', () => {
  const dev = makeDev(0.90);
  const applied = dev._applyRefillConfidenceDeadband(1.0);
  assert.strictEqual(applied, 1.0, 'delta 0.10 exceeds deadband, crossing is real');
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});
