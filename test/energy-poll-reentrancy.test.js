'use strict';

// Regression test: overlapping onPoll invocations must not stack.
// Bug: interval fired onPoll() un-awaited ("zonder lock") while a down
// device made each invocation linger → invocations piled up → memory
// ceiling → app crash loop. Guard must cap concurrency at 1.

const assert = require('assert');
const Module = require('module');

// Stub the 'homey' module so device.js can be required outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};

const EnergyDevice = require('../drivers/energy/device.js');
const onPoll = EnergyDevice.prototype.onPoll;

function makeStub(fetchImpl) {
  return {
    _deleted: false,
    _pollErrorCount: 0,
    getSettings: () => ({}),
    _prepareUrl: async () => true,
    _getLocalTimeAndLang: () => ({ nowLocal: new Date(), homeyLang: 'en' }),
    _fetchData: fetchImpl,
    _onPollImpl: EnergyDevice.prototype._onPollImpl,
    _handlePollError() {},
    log() {},
    error() {},
    _debugLog() {},
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
    await gate;          // simulate a slow / hanging request (down device)
    active--;
    throw new Error('TIMEOUT');
  });

  // Simulate 5 interval ticks firing while the first request still hangs.
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(onPoll.call(stub));

  await new Promise((r) => setImmediate(r)); // let invocations reach _fetchData

  assert.strictEqual(peak, 1, `concurrent onPoll bodies must be 1, got ${peak}`);

  release();
  await Promise.allSettled(runs);
  console.log('✓ no pileup: concurrency capped at 1');
}

async function testTickSkipBackoff() {
  let fetchCalls = 0;
  const stub = makeStub(async () => { fetchCalls++; throw new Error('TIMEOUT'); });
  stub._pollErrorCount = 3; // backoff active

  // First tick under backoff should be skipped, not fetch.
  await onPoll.call(stub);
  assert.strictEqual(fetchCalls, 0, 'tick under backoff must skip fetch (no in-function sleep)');
  console.log('✓ tick-skip: fetch skipped while backoff active');
}

(async () => {
  await testNoPileup();
  await testTickSkipBackoff();
  console.log('All energy-poll-reentrancy tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
