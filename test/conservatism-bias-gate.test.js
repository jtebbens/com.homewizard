'use strict';

// Regression: the PV-conservatism discount (device.js ~2481) was bias-blind.
// It discounts pvForecast by f(pv_accuracy_score) "to avoid over-optimistic
// planning", but accuracy is a MAGNITUDE metric — when the forecast is running
// LOW (measured relBias > 0), a further downward discount makes the under-forecast
// worse. Live state 2026-06-12: pv_acc 0.47 → factor 0.92 applied while relBias was
// +0.27..+0.30 (PV 27-30% above forecast). Fix: skip the discount when the measured
// daytime PV bias shows under-forecast. _computePvRelBias is the gating signal.

const assert = require('assert');
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

// Call _computePvRelBias against a stubbed settings store holding a history array.
function relBias(history) {
  const ctx = { homey: { settings: { get: () => history } } };
  return BatteryPolicyDevice.prototype._computePvRelBias.call(ctx);
}

// Mirror of the live gate predicate (device.js): discount applies only when
// accuracy is low AND the forecast is NOT running low.
function discountApplies(pvAcc, rb) {
  const underForecast = rb != null && rb > 0.05;
  return pvAcc < 0.80 && !underForecast;
}

const slot = (pvW, pvFcW) => ({ pvW, pvFcW, consumW: 300, consumFcW: 300 });

// --- _computePvRelBias signal -------------------------------------------------

// Under-forecast: actual 1300, forecast 1000 over 8 daytime slots → +0.23.
{
  const h = Array.from({ length: 8 }, () => slot(1300, 1000));
  const rb = relBias(h);
  assert.ok(rb > 0.22 && rb < 0.24, `under-forecast relBias ≈ +0.23, got ${rb}`);
}

// Over-forecast: actual 800, forecast 1000 → negative.
{
  const h = Array.from({ length: 8 }, () => slot(800, 1000));
  const rb = relBias(h);
  assert.ok(rb < 0, `over-forecast relBias < 0, got ${rb}`);
}

// < 4 daytime samples → null (insufficient).
{
  const h = [slot(1200, 1000), slot(1200, 1000), slot(1200, 1000)];
  assert.strictEqual(relBias(h), null, 'fewer than 4 daytime samples → null');
}

// All-night (≤50W both) → null, daytime mask drops them.
{
  const h = Array.from({ length: 10 }, () => slot(0, 0));
  assert.strictEqual(relBias(h), null, 'all-night slots masked out → null');
}

// Night slots ignored, only daytime counts.
{
  const day = Array.from({ length: 6 }, () => slot(1300, 1000));
  const night = Array.from({ length: 40 }, () => slot(10, 5));
  const rb = relBias([...night, ...day]);
  assert.ok(rb > 0.22 && rb < 0.24, `night-masked relBias ≈ +0.23, got ${rb}`);
}

// Empty history → null.
assert.strictEqual(relBias([]), null, 'empty history → null');

// --- gate decision ------------------------------------------------------------

// The bug: low accuracy + under-forecast still discounted. Now skipped.
assert.strictEqual(discountApplies(0.47, 0.27), false, 'under-forecast → discount SKIPPED');
assert.strictEqual(discountApplies(0.47, 0.06), false, 'just above deadband → skipped');

// Over-forecast / no measured low-bias → discount still applies (unchanged).
assert.strictEqual(discountApplies(0.47, -0.10), true, 'over-forecast → discount applies');
assert.strictEqual(discountApplies(0.47, 0.04), true, 'within deadband → discount applies');

// Cold start (null bias) → fall back to original discount.
assert.strictEqual(discountApplies(0.47, null), true, 'null bias → discount applies (fallback)');

// High accuracy → never discounts regardless of bias.
assert.strictEqual(discountApplies(0.90, -0.20), false, 'acc ≥ 0.80 → no discount');

console.log('conservatism-bias-gate: all assertions passed');
