'use strict';

// F3 regression: the 🎯 Plan-accuracy diagnostic must compute MAE/bias per forecast source
// (OM/pvFcW, sat/satFcW, Solcast/scFcW, consumption) from policy_mode_history, so sat can be
// judged against SC on valid live data. Guards the field-name wiring + the ≥4-sample gate +
// the bias sign convention (bias = actual − forecast; positive = under-forecast). The stats
// helper is the single implementation shared by the diagnostic and this test.

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

const stats = hist => BatteryPolicyDevice.prototype._planAccuracyStats.call({}, hist);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\n_planAccuracyStats (sat/SC/OM sources):');

// Four slots carrying all four sources. Errors (actual − forecast):
//   pv  [+100,-100,+200,-200] → MAE 150, bias   0
//   sat [ +50, +50, +50, +50] → MAE  50, bias +50
//   sc  [ -30, -30, -30, -30] → MAE  30, bias -30
//   co  [ +10, +10, +10, +10] → MAE  10, bias +10
const full = [
  { pvW: 1100, pvFcW: 1000, satFcW: 1050, scFcW: 1130, consumW: 510, consumFcW: 500 },
  { pvW:  900, pvFcW: 1000, satFcW:  850, scFcW:  930, consumW: 510, consumFcW: 500 },
  { pvW: 1200, pvFcW: 1000, satFcW: 1150, scFcW: 1230, consumW: 510, consumFcW: 500 },
  { pvW:  800, pvFcW: 1000, satFcW:  750, scFcW:  830, consumW: 510, consumFcW: 500 },
];

test('computes MAE + bias per source with correct sign', () => {
  const s = stats(full);
  assert.deepStrictEqual(s.pv,  { n: 4, mae: 150, bias:   0 });
  assert.deepStrictEqual(s.sat, { n: 4, mae:  50, bias:  50 });
  assert.deepStrictEqual(s.sc,  { n: 4, mae:  30, bias: -30 });
  assert.deepStrictEqual(s.co,  { n: 4, mae:  10, bias:  10 });
});

test('sat/SC null when their fields absent (OM/consumption still computed)', () => {
  const noSat = full.map(e => ({ pvW: e.pvW, pvFcW: e.pvFcW, consumW: e.consumW, consumFcW: e.consumFcW }));
  const s = stats(noSat);
  assert.ok(s.pv && s.co, 'pv/co present');
  assert.strictEqual(s.sat, null, 'sat null when satFcW absent');
  assert.strictEqual(s.sc, null, 'sc null when scFcW absent');
});

test('source with < 4 paired samples returns null (sparse-safe)', () => {
  // Only 3 slots carry satFcW → sat below the 4-sample gate → null; SC has all 4 → non-null.
  const sparse = full.map((e, i) => (i === 0 ? { ...e, satFcW: null } : e));
  const s = stats(sparse);
  assert.strictEqual(s.sat, null, 'sat null with 3 samples');
  assert.ok(s.sc, 'sc non-null with 4 samples');
});

test('null forecast or actual in a slot is skipped, not treated as 0', () => {
  // A slot with satFcW present but pvW null must not count (would inject a huge bogus error).
  const withGap = [{ pvW: null, satFcW: 1050 }, ...full];
  const s = stats(withGap);
  assert.strictEqual(s.sat.n, 4, 'gap slot excluded from sat pairs');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
