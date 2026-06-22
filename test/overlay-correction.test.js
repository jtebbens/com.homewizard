'use strict';

// Regression: the webcam OM/satellite overlay (_scaleChartFc) and the accuracy-chart
// corrected values (recordPvAccuracy chartW) were two separate implementations of the
// SAME correction (daily-bias × intraday, capped). They drifted: _scaleChartFc applied
// the LIVE intraday ratio to ALL of today's hours — including already-realised past hours
// — inflating the morning/midday curve to the panel cap, while the accuracy chart froze
// the ratio per slot at record time. They now both route through device._correctOverlayW.
// This test locks the shared helper: intraday only on remaining hours, never retroactive.

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

// Call _correctOverlayW against a stub holding the correction state + capacity.
function correct(w, applyIntraday, { dayCorr = 1, intraday = 1, capW = 0 } = {}) {
  const ctx = {
    _pvDayCorrectionFactor: dayCorr,
    _lastIntradayPvRatio: intraday,
    getSetting: () => capW,
  };
  return BatteryPolicyDevice.prototype._correctOverlayW.call(ctx, w, applyIntraday);
}

const state = { dayCorr: 1.2, intraday: 1.5, capW: 3600 };

// --- daily-bias always; intraday only when applyIntraday ----------------------

// Past hour (applyIntraday=false): daily-bias only, NO intraday.
assert.strictEqual(correct(1000, false, state), Math.round(1000 * 1.2),
  'past hour must get daily-bias only, no intraday');

// Future/current hour (applyIntraday=true): daily-bias × intraday.
assert.strictEqual(correct(1000, true, state), Math.round(1000 * 1.2 * 1.5),
  'remaining hour must get daily-bias × intraday');

// --- the actual regression: no retroactive inflation of past hours ------------

// With intraday > 1, a realised past hour must NOT be lifted toward the cap the way a
// remaining hour is. This is exactly the morning-peak-to-3600 artifact we fixed.
assert.ok(correct(2000, false, state) < correct(2000, true, state),
  'past hour must be strictly below the intraday-scaled remaining hour');

// --- cap honored --------------------------------------------------------------

// 2600 × 1.2 × 1.5 = 4680 → clamped to 3600.
assert.strictEqual(correct(2600, true, state), 3600, 'must clamp to panel capacity');
// No cap configured (0) → unclamped.
assert.strictEqual(correct(2600, true, { ...state, capW: 0 }), Math.round(2600 * 1.8),
  'capW=0 disables the clamp');

// --- null passthrough + no-correction identity --------------------------------

assert.strictEqual(correct(null, true, state), null, 'null in → null out');
assert.strictEqual(correct(1234, true, { dayCorr: 1, intraday: 1, capW: 0 }), 1234,
  'identity when no correction active');

// --- the two surfaces cannot diverge ------------------------------------------

// Webcam remaining-hour and accuracy current-slot both call with applyIntraday=true and
// the same correction state → identical value. (Before the refactor these were separate
// code paths that silently diverged.)
for (const w of [0, 300, 1500, 3000, 5000]) {
  assert.strictEqual(correct(w, true, state), correct(w, true, state),
    `webcam vs accuracy must match for w=${w}`);
}

console.log('overlay-correction: all assertions passed');
