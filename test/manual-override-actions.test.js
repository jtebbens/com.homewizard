'use strict';

// set_override/clear_override flow-cards (driver.js:97-106) called device.setManualOverride()/
// clearManualOverride() — neither method existed on BatteryPolicyDevice, so running either flow
// card in production threw "not a function" (confirmed present in .homeybuild too, i.e. also
// broken in the published build). The read side (_runPolicyCheck reading override_until,
// device.js~1598) worked fine; nothing ever wrote it. This test must FAIL before the fix and
// PASS after.
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

function makeDev() {
  const store = {};
  const triggered = [];
  const dev = {
    log: () => {},
    error: () => {},
    setStoreValue: async (k, v) => { store[k] = v; },
    getStoreValue: (k) => store[k],
    homey: {
      flow: {
        getDeviceTriggerCard: () => ({
          trigger: async (device, tokens) => { triggered.push(tokens); },
        }),
      },
    },
    _store: store,
    _triggered: triggered,
  };
  dev.setManualOverride = BatteryPolicyDevice.prototype.setManualOverride;
  dev.clearManualOverride = BatteryPolicyDevice.prototype.clearManualOverride;
  dev._triggerOverrideSet = BatteryPolicyDevice.prototype._triggerOverrideSet;
  return dev;
}

test('setManualOverride writes override_until in the future and fires trigger', async () => {
  const dev = makeDev();
  await dev.setManualOverride(30);
  const until = dev.getStoreValue('override_until');
  assert.ok(until, 'override_until must be set');
  assert.ok(new Date(until) > new Date(), 'override_until must be in the future');
  assert.strictEqual(dev._triggered.length, 1);
  assert.strictEqual(dev._triggered[0].duration, 30);
});

test('clearManualOverride resets override_until to null', async () => {
  const dev = makeDev();
  await dev.setManualOverride(30);
  await dev.clearManualOverride();
  assert.strictEqual(dev.getStoreValue('override_until'), null);
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});
