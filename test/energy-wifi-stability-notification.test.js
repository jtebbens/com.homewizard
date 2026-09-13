'use strict';

// Regression test: flaky wifi (fail/success/fail/success) never sustains
// _pollErrorCount, since that resets to 0 on a single success. So a device
// with genuinely bad wifi never surfaces anything to the user beyond silent
// alarm_connectivity flips. _trackWifiStability tracks a rolling fail-rate
// over real poll attempts and fires one timeline notification when it's bad.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};

const EnergyDevice = require('../drivers/energy/device.js');
const trackWifiStability = EnergyDevice.prototype._trackWifiStability;

function makeStub() {
  const notifications = [];
  return {
    _pollHistory: [],
    _pollSuccessStreak: 0,
    _wifiWarnNotified: false,
    _wifiWarnCooldownUntil: 0,
    getName: () => 'Test Energy Socket',
    homey: {
      notifications: {
        createNotification: (opts) => { notifications.push(opts); return Promise.resolve(); },
      },
    },
    error() {},
    notifications,
  };
}

function testSustainedFailuresNotifyOnce() {
  const stub = makeStub();
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, true, 'nl');

  assert.strictEqual(stub.notifications.length, 1, 'expected exactly one notification');
  assert.ok(stub.notifications[0].excerpt.includes('wifi-verbinding lijkt instabiel'), 'expected NL wifi-instability text');

  // Further failures within cooldown must not notify again.
  for (let i = 0; i < 20; i++) trackWifiStability.call(stub, true, 'nl');
  assert.strictEqual(stub.notifications.length, 1, 'cooldown must suppress repeat notifications');
  console.log('✓ sustained failures notify exactly once, cooldown suppresses repeats');
}

function testEnglishText() {
  const stub = makeStub();
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, true, 'en');
  assert.strictEqual(stub.notifications.length, 1);
  assert.ok(stub.notifications[0].excerpt.includes('wifi connection seems unstable'), 'expected EN wifi-instability text');
  console.log('✓ english text used when lang=en');
}

function testRecoveryResetsWarnFlag() {
  const stub = makeStub();
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, true, 'nl');
  assert.strictEqual(stub.notifications.length, 1);

  // Recover: 10 consecutive successes should re-arm the warning.
  for (let i = 0; i < 10; i++) trackWifiStability.call(stub, false, 'nl');
  assert.strictEqual(stub._wifiWarnNotified, false, 'warn flag must reset after recovery streak');

  // But the cooldown (24h) still blocks a new notification even after rearm.
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, true, 'nl');
  assert.strictEqual(stub.notifications.length, 1, 'cooldown still active, no second notification yet');

  // Simulate cooldown expiry.
  stub._wifiWarnCooldownUntil = 0;
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, true, 'nl');
  assert.strictEqual(stub.notifications.length, 2, 'after cooldown expiry and recovery, a renewed bad streak notifies again');
  console.log('✓ recovery streak re-arms warning, cooldown still gates the next notification');
}

function testFlappingBelowThresholdNeverNotifies() {
  const stub = makeStub();
  // 40 attempts, alternating fail/success/success (fail rate ~33%, below 50%).
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, i % 3 === 0, 'nl');
  assert.strictEqual(stub.notifications.length, 0, 'fail rate below threshold must never notify');
  console.log('✓ fail rate below 50% threshold never notifies');
}

function testFlappingAtThresholdNotifies() {
  const stub = makeStub();
  // The exact scenario this feature targets: fail, success, fail, success...
  // _pollErrorCount would reset to 0 every other attempt, but the real
  // fail-rate here is 50% — must still notify.
  for (let i = 0; i < 40; i++) trackWifiStability.call(stub, i % 2 === 0, 'nl');
  assert.strictEqual(stub.notifications.length, 1, 'alternating fail/success at 50% must notify');
  console.log('✓ alternating fail/success (the flaky-wifi case) notifies');
}

testSustainedFailuresNotifyOnce();
testEnglishText();
testRecoveryResetsWarnFlag();
testFlappingBelowThresholdNeverNotifies();
testFlappingAtThresholdNotifies();
console.log('All energy-wifi-stability-notification tests passed');
