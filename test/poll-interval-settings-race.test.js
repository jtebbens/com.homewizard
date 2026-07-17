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
const ThermometerDevice = require('../drivers/thermometer/device.js');

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

  assert.ok(stub.onPollInterval, 'offset_polling branch must actually run and create the new interval');
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

  // Homey SDK 3 calls onSettings with a SINGLE event object, not 3 positional
  // args (that's SDK 2). Calling it this way is what caught the real bug:
  // energy_socket's onSettings used the old positional signature, so its
  // changedKeys parameter always fell back to its default `[]` — the settings
  // handler silently never ran, for any setting, ever. Fixed by switching to
  // the destructured event-object signature (matches the energy/P1 driver).
  await EnergySocketDevice.prototype.onSettings.call(stub, {
    oldSettings: { offset_polling: 10 },
    newSettings: { offset_polling: 4 },
    changedKeys: ['offset_polling'],
  });

  assert.ok(stub.onPollInterval, 'offset_polling branch must actually run and create the new interval (this is what SDK-2-style positional args broke: changedKeys silently defaulted to [], the branch never ran, offset_polling never took effect)');
  assert.strictEqual(stub._firstPollTimeout, null, 'pending first-poll timeout must be cleared');
  clearInterval(stub.onPollInterval);

  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(pendingFired, false, 'stale onInit timeout must never fire after settings change (would orphan the new interval)');
  console.log('✓ energy_socket: onSettings cancels pending first-poll timeout');
}

async function testThermometerOffsetApplies() {
  const stub = {
    log() {},
    error() {},
    values: { measure_temperature: 20 },
    getCapabilityValue(cap) { return this.values[cap]; },
    setCapabilityValue(cap, value) { this.values[cap] = value; return Promise.resolve(); },
  };

  // Same SDK-2-vs-3 signature bug as energy_socket: this driver's onSettings
  // used bare positional params (oldSettings, newSettings, changedKeys), with
  // no default on changedKeys. Under SDK 3's single-object call, changedKeys
  // is undefined -> the pre-existing `!Array.isArray` guard silently returned
  // -> offset_temperature never applied, ever, misdiagnosed as "Homey geeft
  // soms geen array terug" instead of the real signature mismatch.
  await ThermometerDevice.prototype.onSettings.call(stub, {
    oldSettings: { offset_temperature: 0 },
    newSettings: { offset_temperature: 1.5 },
    changedKeys: ['offset_temperature'],
  });

  assert.strictEqual(stub.values.measure_temperature, 21.5, 'offset must actually be applied to the capability value');
  console.log('✓ thermometer: onSettings applies offset_temperature (SDK-3 event-object call)');
}

(async () => {
  await testEnergyClearsFirstPollTimeout();
  await testEnergySocketClearsFirstPollTimeout();
  await testThermometerOffsetApplies();
  console.log('All poll-interval-settings-race tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
