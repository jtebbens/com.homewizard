'use strict';

// Property suite for BatteryPolicyDevice._pvCloudUncertaintyFactor (device.js, next to
// _knmiAwareCloudGate).
//
// The DP's pvCoverage projection discounts up to 40% when OM reports >70% cloud cover (don't
// rely on uncertain PV recharge). But OM cloud% can be a false-overcast (2026-07-06: OM
// cloud=81-88% while KNMI kt did not classify the day as overcast). KNMI's measured clearness
// index (kt) cross-checks: kt ≥ 0.65 = clear → the OM cloud reading is untrusted → the discount
// is released. Same KNMI-clear bar as _knmiAwareCloudGate (device.js:3837, tested in
// cloudgate-knmi.test.js). This must ONLY ever relax the discount, never tighten it.

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

const factor = BatteryPolicyDevice._pvCloudUncertaintyFactor.bind(BatteryPolicyDevice);

// Baseline = the OM-only discount this change improves on (KNMI cross-check absent).
function omOnlyFactor(cloud) {
  return (cloud != null && cloud > 70)
    ? Math.max(0.6, 1.0 - 0.5 * Math.min(1, (cloud - 70) / 30))
    : 1.0;
}

const cloudArb = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 100, noNaN: true }));
const ktArb    = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1, noNaN: true }));

// 1. Bounds: factor is always in [0.6, 1].
fc.assert(fc.property(cloudArb, ktArb, (c, k) => {
  const f = factor(c, k);
  return f >= 0.6 && f <= 1;
}));

// 2. Monotonic relaxation: the KNMI-aware factor NEVER goes below the OM-only factor.
//    (Economic-dominance: the cross-check can only ever preserve more pvCoverage than the
//     OM-only discount would have allowed, never suppress more.)
fc.assert(fc.property(cloudArb, ktArb, (c, k) => {
  return factor(c, k) >= omOnlyFactor(c) - 1e-9;
}));

// 3. KNMI-clear release: when kt ≥ 0.65 the factor is fully open regardless of OM cloud.
fc.assert(fc.property(cloudArb, fc.double({ min: 0.65, max: 1, noNaN: true }), (c, k) => {
  return factor(c, k) === 1.0;
}));

// 4. Without a KNMI signal (kt null), behaviour is identical to the OM-only factor — no
//    silent change when KNMI data is unavailable.
fc.assert(fc.property(cloudArb, (c) => {
  return factor(c, null) === omOnlyFactor(c);
}));

// 5. The 2026-07-06 false-overcast scenario: high OM cloud + real-clear KNMI → the discount is
//    fully released (factor 1.0), where the OM-only discount would have applied ~0.75.
{
  const cloud = 85, kt = 0.72;
  assert.strictEqual(factor(cloud, kt), 1.0, 'KNMI-clear must release the false-overcast discount');
  assert.ok(omOnlyFactor(cloud) < 1.0, 'baseline OM-only factor would have discounted (sanity)');
}

// --- measured cloud cover (okta) as a second release route -------------------------------
// kt needs ≥4 qualifying daylight hours, so it is null all morning and the KNMI-clear release
// cannot fire before ~09:00 UTC no matter how clear the sky is. Measured okta is available from
// the first fetch. It may only ever RELEASE the discount, never tighten it — a point measurement
// 18km away is not trusted to overrule the forecast downward.
const oktaArb = fc.oneof(fc.constant(null), fc.double({ min: 0, max: 1, noNaN: true }));

// 6. Passing no okta leaves the existing behaviour bit-for-bit unchanged.
fc.assert(fc.property(cloudArb, ktArb, (c, k) => {
  return factor(c, k, null) === factor(c, k);
}));

// 7. Okta only ever relaxes: adding a measured-cover reading never lowers the factor.
fc.assert(fc.property(cloudArb, ktArb, oktaArb, (c, k, o) => {
  return factor(c, k, o) >= factor(c, k, null) - 1e-9;
}));

// 8. Bounds hold with okta in play.
fc.assert(fc.property(cloudArb, ktArb, oktaArb, (c, k, o) => {
  const f = factor(c, k, o);
  return f >= 0.6 && f <= 1;
}));

// 9. Measured-clear release: ground says ≤2 okta while OM claims overcast → no discount.
{
  const cloud = 85;
  assert.strictEqual(factor(cloud, null, 0.25), 1.0, 'measured-clear must release the discount');
  assert.ok(factor(cloud, null, null) < 1.0, 'baseline without okta would have discounted (sanity)');
  // Measured overcast must NOT deepen the discount beyond what OM alone produced.
  assert.strictEqual(factor(cloud, null, 1.0), omOnlyFactor(cloud),
    'measured overcast must not tighten beyond the OM-only discount');
}

console.log('pv-cloud-knmi-gate.test.js: all properties hold');
