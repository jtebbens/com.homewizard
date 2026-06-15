'use strict';

// Property suite for BatteryPolicyDevice._knmiAwareCloudGate (device.js ~_estimatePvProduction).
//
// The intraday PV corrector damps its UPWARD ratio as OM cloud cover rises above 70%
// (a clear-morning ratio shouldn't re-inflate PV the model lowered for a cloudy afternoon).
// But OM cloud% can be a false-overcast: on 2026-06-14 a real ~900W noon production was
// recorded while OM reported high cloud, and the gate (0.42–0.79) damped a legitimate upward
// correction. KNMI's measured clearness index (kt) cross-checks: kt ≥ 0.65 = clear → the OM
// cloud reading is untrusted → the gate is released. This must ONLY ever relax the gate.

const assert = require('assert');
const fc = require('fast-check');
const Module = require('module');

// Stub 'homey' + heavy device-deps so battery-policy/device.js loads outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const gate = BatteryPolicyDevice._knmiAwareCloudGate.bind(BatteryPolicyDevice);

// Baseline = the OM-only gate this change improves on (KNMI cross-check absent).
function omOnlyGate(ratio, cloud) {
  return (ratio > 1.0 && cloud != null && cloud > 70)
    ? Math.max(0, 1 - (cloud - 70) / 30)
    : 1.0;
}

const ratioArb = fc.double({ min: 0.2, max: 2.5, noNaN: true });
const cloudArb = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 100, noNaN: true }));
const ktArb    = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1, noNaN: true }));

// 1. Bounds: gate is always a factor in [0,1].
fc.assert(fc.property(ratioArb, cloudArb, ktArb, (r, c, k) => {
  const g = gate(r, c, k);
  return g >= 0 && g <= 1;
}));

// 2. Monotonic relaxation: the KNMI-aware gate NEVER tightens below the OM-only gate.
//    (The economic-dominance invariant: the cross-check can only ever preserve more of an
//     upward PV correction, never suppress one the OM-only gate would have allowed.)
fc.assert(fc.property(ratioArb, cloudArb, ktArb, (r, c, k) => {
  return gate(r, c, k) >= omOnlyGate(r, c) - 1e-9;
}));

// 3. KNMI-clear release: when kt ≥ 0.65 the gate is fully open regardless of OM cloud.
fc.assert(fc.property(ratioArb, cloudArb, fc.double({ min: 0.65, max: 1, noNaN: true }), (r, c, k) => {
  return gate(r, c, k) === 1.0;
}));

// 4. Downward correction is never gated (ratio ≤ 1 → gate 1.0).
fc.assert(fc.property(fc.double({ min: 0.2, max: 1.0, noNaN: true }), cloudArb, ktArb, (r, c, k) => {
  return gate(r, c, k) === 1.0;
}));

// 5. Without a KNMI signal (kt null), behaviour is identical to the OM-only gate — no
//    silent change when KNMI data is unavailable.
fc.assert(fc.property(ratioArb, cloudArb, (r, c) => {
  return gate(r, c, null) === omOnlyGate(r, c);
}));

// 6. The 2026-06-14 false-overcast scenario: high OM cloud + real-clear KNMI + under-forecast
//    ratio → the legitimate upward correction is fully preserved (gate 1.0), where the OM-only
//    gate would have damped it.
{
  const ratio = 1.40, cloud = 85, kt = 0.72;
  assert.strictEqual(gate(ratio, cloud, kt), 1.0, 'KNMI-clear must release the false-overcast gate');
  assert.ok(omOnlyGate(ratio, cloud) < 1.0, 'baseline OM-only gate would have damped (sanity)');
}

console.log('cloudgate-knmi.test.js: all properties hold');
