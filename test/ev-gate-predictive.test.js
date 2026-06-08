'use strict';

// EV discharge-gate in predictive / policy-disabled mode (community bug 2026-06-08).
// When "EV laden gestart" fires while the battery is in predictive (policy_enabled=false),
// the policy run is skipped and the mapper EV gate never applies → the EV drains the home
// battery via nul-op-de-meter. _enforceEvGate must take the battery OUT of predictive into
// standby directly, and restore the pre-gate mode on release.
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

// Minimal mock `this` for the device. `hwMode` is the live battery_group_charge_mode.
function makeDev({ policyEnabled, hwMode }) {
  const store = {};
  const dev = {
    _modeCalls: [],
    _ranPolicy: false,
    _evPreGateMode: null,
    p1Device: {
      getCapabilityValue: () => hwMode,
      setBatteryGroupMode: (m) => { dev._modeCalls.push(m); hwMode = m; return true; },
    },
    getCapabilityValue: (cap) => (cap === 'policy_enabled' ? policyEnabled : null),
    getSetting: () => 55,
    homey: { settings: { get: (k) => store[k] ?? null, set: (k, v) => { store[k] = v; } } },
    log: () => {},
    error: () => {},
    _triggerModeApplied: async () => {},
    _runPolicyCheck: async () => { dev._ranPolicy = true; },
  };
  dev._enforceEvGate = BatteryPolicyDevice.prototype._enforceEvGate;
  dev._applyRecommendation = BatteryPolicyDevice.prototype._applyRecommendation;
  return dev;
}

// ── Predictive + policy disabled: EV start forces standby, saves pre-gate ──────
test('EV start in predictive (policy off) → standby, no policy run', async () => {
  const dev = makeDev({ policyEnabled: false, hwMode: 'predictive' });
  await dev._enforceEvGate(true);
  assert.deepStrictEqual(dev._modeCalls, ['standby'],
    `expected standby applied, got [${dev._modeCalls}]`);
  assert.strictEqual(dev._ranPolicy, false, 'must not route to policy run when disabled');
  assert.strictEqual(dev._evPreGateMode, 'predictive', 'pre-gate mode must be saved for restore');
});

// ── Release restores the pre-gate (predictive) ────────────────────────────────
test('EV stop in predictive (policy off) → restores predictive', async () => {
  const dev = makeDev({ policyEnabled: false, hwMode: 'standby' });
  dev._evPreGateMode = 'predictive';
  await dev._enforceEvGate(false);
  assert.deepStrictEqual(dev._modeCalls, ['predictive'],
    `expected predictive restored, got [${dev._modeCalls}]`);
});

// ── Release after restart (in-memory lost) restores from persisted setting ─────
test('EV stop after restart restores pre-gate from settings fallback', async () => {
  const dev = makeDev({ policyEnabled: false, hwMode: 'standby' });
  dev._evPreGateMode = null;                 // lost on restart
  dev.homey.settings.set('ev_pregate_mode', 'predictive');
  await dev._enforceEvGate(false);
  assert.deepStrictEqual(dev._modeCalls, ['predictive'],
    `expected predictive restored from settings, got [${dev._modeCalls}]`);
});

// ── Policy enabled: route to normal policy run, no direct override ─────────────
test('EV start with policy enabled → routes to policy run, no forced mode', async () => {
  const dev = makeDev({ policyEnabled: true, hwMode: 'zero_discharge_only' });
  await dev._enforceEvGate(true);
  assert.strictEqual(dev._ranPolicy, true, 'must run policy when enabled');
  assert.deepStrictEqual(dev._modeCalls, [], 'must not force a mode when policy enabled');
});

// ── _applyRecommendation: force bypasses the predictive guard ──────────────────
test('force=true overrides predictive guard; force=false respects it', async () => {
  const guarded = makeDev({ policyEnabled: false, hwMode: 'predictive' });
  await guarded._applyRecommendation('standby', 100, { force: false });
  assert.deepStrictEqual(guarded._modeCalls, [], 'force=false must not override predictive');

  const forced = makeDev({ policyEnabled: false, hwMode: 'predictive' });
  await forced._applyRecommendation('standby', 100, { force: true });
  assert.deepStrictEqual(forced._modeCalls, ['standby'], 'force=true must override predictive');
});

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
});
