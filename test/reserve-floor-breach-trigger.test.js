'use strict';

// Reactive reserve-floor breach trigger (2026-06-13 same-hour discharge→charge churn).
// The overnight refill-reserve floor (_lastReserveFloorPct) is recomputed only at each
// full replan (~30min). zero_discharge_only's load-following discharge rate can overshoot
// that floor before the next replan catches it (observed: SoC 18%→11%, 3pts past a 14%
// floor), with no reactive check — causing a same-price discharge→charge churn that wastes
// RTE on energy charged the prior day at a higher price.
//
// device.js does `require('homey')`, so stub that module before loading the class. We only
// LOAD the class to reach its prototype methods — we never instantiate the Homey lifecycle.

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
  Promise.resolve()
    .then(fn)
    .then(() => { console.log(`  ✓ ${name}`); passed++; })
    .catch((e) => { console.error(`  ✗ ${name}: ${e.message}`); failed++; });
}

function makeDev({ floorPct, hwMode, lastTriggerTs }) {
  const dev = {
    _lastReserveFloorPct: floorPct,
    _lastFloorTriggerTs: lastTriggerTs,
    _ranPolicy: 0,
    p1Device: { getCapabilityValue: () => hwMode },
    log: () => {},
    error: () => {},
    _runPolicyCheck: async () => { dev._ranPolicy++; },
  };
  dev._checkReserveFloorTrigger = BatteryPolicyDevice.prototype._checkReserveFloorTrigger;
  return dev;
}

test('SoC below reserve floor during zero_discharge_only → reactive policy run', () => {
  const dev = makeDev({ floorPct: 14, hwMode: 'zero_discharge_only' });
  const fired = dev._checkReserveFloorTrigger(11);
  assert.strictEqual(fired, true, 'must report breach');
  assert.strictEqual(dev._ranPolicy, 1, 'must trigger _runPolicyCheck');
});

test('SoC above reserve floor → no trigger', () => {
  const dev = makeDev({ floorPct: 14, hwMode: 'zero_discharge_only' });
  const fired = dev._checkReserveFloorTrigger(18);
  assert.strictEqual(fired, false);
  assert.strictEqual(dev._ranPolicy, 0);
});

test('SoC below floor but not discharging (zero_charge_only) → no trigger', () => {
  const dev = makeDev({ floorPct: 14, hwMode: 'zero_charge_only' });
  const fired = dev._checkReserveFloorTrigger(11);
  assert.strictEqual(fired, false, 'no opportunity cost to react to outside discharge');
  assert.strictEqual(dev._ranPolicy, 0);
});

test('no reserve floor set (null) → no trigger even at low SoC', () => {
  const dev = makeDev({ floorPct: null, hwMode: 'zero_discharge_only' });
  const fired = dev._checkReserveFloorTrigger(2);
  assert.strictEqual(fired, false);
  assert.strictEqual(dev._ranPolicy, 0);
});

test('debounced: repeat breach within 2min does not re-trigger', () => {
  const dev = makeDev({ floorPct: 14, hwMode: 'zero_discharge_only', lastTriggerTs: Date.now() - 60_000 });
  const fired = dev._checkReserveFloorTrigger(11);
  assert.strictEqual(fired, false, 'within debounce window');
  assert.strictEqual(dev._ranPolicy, 0);
});

test('breach after debounce window (>2min) re-triggers', () => {
  const dev = makeDev({ floorPct: 14, hwMode: 'zero_discharge_only', lastTriggerTs: Date.now() - 3 * 60_000 });
  const fired = dev._checkReserveFloorTrigger(11);
  assert.strictEqual(fired, true);
  assert.strictEqual(dev._ranPolicy, 1);
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});
