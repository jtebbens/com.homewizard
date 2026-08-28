'use strict';

// The knijp-flow (standard flow 29cf0c40) sets max_steca_limit (c16ef280) to the DP
// target alongside setLimit, so the droop's own +100 recovery walks up to that
// ceiling instead of the physical 3400W. But _publishCurtailmentTarget only ever
// fired a trigger on the transition INTO curtailment — on the falling edge
// (shouldCurtail true -> false) it silently reset _curtailmentActive and returned,
// so nothing ever told the user's flow to lift the ceiling again. This must FAIL
// before the pv_curtailment_released trigger existed and PASS after.
// See memory project_pv_limit_cap.md §"Twee schrijvers op één actuator".

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
  const caps = {};
  const triggered = { target: [], released: [] };
  const dev = {
    log: () => {},
    error: () => {},
    hasCapability: () => true,
    getCapabilityValue: (k) => (k in caps ? caps[k] : null),
    setCapabilityValue: async (k, v) => { caps[k] = v; },
    homey: {
      flow: {
        getDeviceTriggerCard: (id) => ({
          trigger: async (device, tokens) => {
            if (id === 'pv_curtailment_target') triggered.target.push(tokens);
            if (id === 'pv_curtailment_released') triggered.released.push(tokens);
          },
        }),
      },
    },
    _triggered: triggered,
  };
  dev._publishCurtailmentTarget = BatteryPolicyDevice.prototype._publishCurtailmentTarget;
  return dev;
}

test('falling edge fires pv_curtailment_released exactly once', async () => {
  const dev = makeDev();
  await dev._publishCurtailmentTarget({ shouldCurtail: true, targetW: 1000, exportValue: -0.03, houseLoadW: 800 });
  assert.strictEqual(dev._triggered.target.length, 1, 'target trigger must fire on activation');
  assert.strictEqual(dev._triggered.released.length, 0, 'released must not fire while still active');

  await dev._publishCurtailmentTarget({ shouldCurtail: false, targetW: null, exportValue: 0.14, houseLoadW: 800 });
  assert.strictEqual(dev._triggered.released.length, 1, 'released must fire on the true->false transition');
});

test('released does not re-fire while curtailment stays inactive', async () => {
  const dev = makeDev();
  await dev._publishCurtailmentTarget({ shouldCurtail: true, targetW: 1000, exportValue: -0.03, houseLoadW: 800 });
  await dev._publishCurtailmentTarget({ shouldCurtail: false, targetW: null, exportValue: 0.14, houseLoadW: 800 });
  await dev._publishCurtailmentTarget({ shouldCurtail: false, targetW: null, exportValue: 0.14, houseLoadW: 800 });
  assert.strictEqual(dev._triggered.released.length, 1, 'released must fire once per edge, not per run');
});

test('never-activated curtailment never fires released', async () => {
  const dev = makeDev();
  await dev._publishCurtailmentTarget({ shouldCurtail: false, targetW: null, exportValue: 0.14, houseLoadW: 800 });
  assert.strictEqual(dev._triggered.released.length, 0, 'no phantom release without a prior activation');
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});
