'use strict';

// Regression test: overlapping getStatus() invocations must not stack.
// Bug: startPolling's 20s setInterval fired this.getStatus() un-awaited.
// A slow/unreachable HW unit made each /get-status linger 8-20s, so the
// fixed interval kept spawning getStatus bodies that piled up (bursts of
// concurrent /get-status seen in the log). Guard must cap concurrency at 1.

const assert = require('assert');
const Module = require('module');

// Stub the 'homey' module so device.js can be required outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};

const HWDevice = require('../drivers/homewizard/device.js');
const getStatus = HWDevice.prototype.getStatus;

function makeDevice() {
  return {
    getData: () => ({ id: 'dev1' }),
    getName: () => 'HW',
    getStoreValue: async () => 1,
    setStoreValue: async () => {},
    setCapabilityValue: async () => {},
  };
}

// callnewAsyncBound throws TIMEOUT → stays on the per-device catch path,
// avoiding the module-level homeWizard_devices global on the success path.
function makeStub(onCall) {
  return {
    _polling: false,
    homey: { i18n: { getLanguage: () => 'en' } },
    callnewAsyncBound: onCall,
    setAvailable: async () => {},
    setUnavailable: async () => {},
    syncLegacyDebugToSettings: () => {},
    log() {},
    error() {},
  };
}

async function testNoPileup() {
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((r) => { release = r; });

  const stub = makeStub(async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;          // simulate a slow / hanging /get-status (down device)
    active--;
    throw new Error('TIMEOUT');
  });
  const device = makeDevice();

  // Simulate 5 interval ticks firing while the first poll still hangs.
  for (let i = 0; i < 5; i++) getStatus.call(stub, [device]);

  await new Promise((r) => setImmediate(r)); // let bodies reach callnewAsyncBound

  assert.strictEqual(peak, 1, `concurrent getStatus polls must be 1, got ${peak}`);

  release();
  await new Promise((r) => setImmediate(r));
  console.log('✓ no pileup: getStatus concurrency capped at 1');
}

async function testGuardReleases() {
  let calls = 0;
  const stub = makeStub(async () => { calls++; throw new Error('TIMEOUT'); });
  const device = makeDevice();

  // First poll completes (guard releases in .finally).
  getStatus.call(stub, [device]);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(stub._polling, false, 'guard must release after poll completes');

  // Next tick must proceed, not be stuck skipping forever.
  getStatus.call(stub, [device]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls, 2, `second tick must poll after release, got calls=${calls}`);
  console.log('✓ guard releases: subsequent tick polls again');
}

(async () => {
  await testNoPileup();
  await testGuardReleases();
  console.log('All homewizard-poll-reentrancy tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
