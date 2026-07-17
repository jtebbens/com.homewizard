'use strict';

// Regression test: changing the polling interval in settings shortly after
// app/device init must not leave an orphaned interval running at the OLD
// value. onInit schedules the first poll (and the real setInterval) inside
// a setTimeout; if onSettings fires before that timeout fires, it must
// cancel the pending timeout — otherwise the timeout later overwrites
// onPollInterval with a NEW setInterval built from the stale closure value,
// orphaning the interval onSettings just created. Symptom reported:
// interval change only "takes effect" after an app restart.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};

const EnergyDevice = require('../drivers/energy/device.js');
const EnergySocketDevice = require('../drivers/energy_socket/device.js');

async function testEnergyClearsFirstPollTimeout() {
  let pendingFired = false;
  const stub = {
    log() {},
    error() {},
    onPoll: async () => {},
    // Simulates onInit's pending first-poll setTimeout, not yet fired.
    _firstPollTimeout: setTimeout(() => { pendingFired = true; }, 50),
    onPollInterval: null,
  };

  await EnergyDevice.prototype.onSettings.call(stub, {
    oldSettings: { polling_interval: 10 },
    newSettings: { polling_interval: 4 },
    changedKeys: ['polling_interval'],
  });

  assert.strictEqual(stub._firstPollTimeout, null, 'pending first-poll timeout must be cleared');
  clearInterval(stub.onPollInterval);

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(pendingFired, false, 'stale onInit timeout must never fire after settings change (would orphan the new interval)');
  console.log('✓ energy: onSettings cancels pending first-poll timeout');
}

async function testEnergySocketClearsFirstPollTimeout() {
  let pendingFired = false;
  const stub = {
    log() {},
    error() {},
    driver: { getDevices: () => [stub] },
    onPoll: async () => {},
    _firstPollTimeout: setTimeout(() => { pendingFired = true; }, 50),
    onPollInterval: null,
  };

  await EnergySocketDevice.prototype.onSettings.call(
    stub,
    { offset_polling: 10 },
    { offset_polling: 4 },
    ['offset_polling'],
  );

  assert.strictEqual(stub._firstPollTimeout, null, 'pending first-poll timeout must be cleared');
  clearInterval(stub.onPollInterval);

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(pendingFired, false, 'stale onInit timeout must never fire after settings change (would orphan the new interval)');
  console.log('✓ energy_socket: onSettings cancels pending first-poll timeout');
}

(async () => {
  await testEnergyClearsFirstPollTimeout();
  await testEnergySocketClearsFirstPollTimeout();
  console.log('All poll-interval-settings-race tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
