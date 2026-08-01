'use strict';

// Night consumption bias correction.
//
// The consumption accuracy meter (built 07-17) was read on 08-01 against the raw pairs in
// tools/_hist-chunks-daychunks (07-17..07-24, 652 pairs with consumAvgW). Two different errors:
//
//   daytime h9-h16   mean +150..+293W, median +17..+87W, p90 485-1374W  -> tail (appliances)
//   night   h23-h06  mean -76W,        median -64W,      p90 ~0W        -> LEVEL error
//
// Night 23-06 (n=194): the learned profile predicts 479W where the house actually draws 403W,
// i.e. 19% too high, negative in 7/7 nights and in both sub-windows (W1 -47, W2 -91). On top of
// that the DP multiplies by consumptionMargin (~1.128 at night, CV is low) -> it plans on ~540W
// against a real 403W, +34%. The margin's own comment (optimization-engine.js:843-844) motivates
// the hedge with "dishwasher, cooking" -- a daytime argument, confirmed by the daytime tail above,
// but not applicable at night.
//
// The correction subtracts the measured night bias from the DP's consumption input, fed by
// consumption_accuracy_hourly[hour].emaBiasW so it tracks into winter instead of freezing a
// summer number. Downward only: correcting upward is consumptionMargin's job, and doing both is
// the double-count trap from feedback_single_correction_impl.
//
// Two traps this pins down:
//   1. FEEDBACK LOOP - the meter's forecast side used to come from
//      optimizationEngine._schedule.slots[].consumptionW, which IS consumptionWPerSlot[t]
//      (optimization-engine.js:407). Score the corrected array and emaBiasW walks to zero, the
//      correction disappears, the bias returns. The meter must read the raw stash instead.
//   2. BASELOAD FLOOR - device.js applies Math.max(v, baseloadW) after the forecast. The
//      correction has to land before it, or the floor eats it and stops being a floor.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const corrW = BatteryPolicyDevice._nightBiasCorrW;
const build = BatteryPolicyDevice._buildDpConsumption;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// A settled bucket: count well past the gate, bias in watts (actual - predicted).
const bucket = (emaBiasW, count = 40) => ({ emaBiasW, emaAbsErrW: Math.abs(emaBiasW), count });
const hourly = (hour, b) => ({ [hour]: b });

console.log('Night consumption bias correction:');

test('night hour with a settled negative bias lowers the slot by that bias', () => {
  assert.strictEqual(corrW(hourly(2, bucket(-76)), 2), -76);
  const out = build([479], [2], hourly(2, bucket(-76)), 0, true);
  assert.strictEqual(out[0], 403, 'expected 479 - 76 = 403W');
});

test('every hour in the measured night window 23-06 is corrected', () => {
  for (const h of [23, 0, 1, 2, 3, 4, 5, 6]) {
    assert.strictEqual(corrW(hourly(h, bucket(-76)), h), -76, `hour ${h} must be corrected`);
  }
});

test('daytime hour with the same negative bias is left alone', () => {
  // h8 (-106W) and h10 (-104W) are sign-consistent too, but they feed pvCoverage
  // (optimization-engine.js:234) and thus the PV charge plan. Out of scope by decision.
  for (const h of [7, 8, 9, 10, 12, 15, 16, 18, 22]) {
    assert.strictEqual(corrW(hourly(h, bucket(-106)), h), 0, `hour ${h} must not be corrected`);
  }
  assert.deepStrictEqual(build([700], [10], hourly(10, bucket(-104)), 0, true), [700]);
});

test('positive bias (under-forecast) is never applied - that is consumptionMargin\'s job', () => {
  assert.strictEqual(corrW(hourly(2, bucket(+120)), 2), 0);
  assert.deepStrictEqual(build([400], [2], hourly(2, bucket(+120)), 0, true), [400]);
});

test('correction is clamped at -150W', () => {
  assert.strictEqual(corrW(hourly(3, bucket(-400)), 3), -150);
  assert.strictEqual(corrW(hourly(3, bucket(-150)), 3), -150);
  assert.strictEqual(corrW(hourly(3, bucket(-149)), 3), -149);
});

test('thin bucket (count < 20) is not trusted', () => {
  assert.strictEqual(corrW(hourly(2, bucket(-76, 19)), 2), 0);
  assert.strictEqual(corrW(hourly(2, bucket(-76, 20)), 2), -76);
  assert.strictEqual(corrW({}, 2), 0, 'missing bucket');
  assert.strictEqual(corrW(undefined, 2), 0, 'missing container');
  assert.strictEqual(corrW(hourly(2, { count: 40 }), 2), 0, 'bucket without emaBiasW');
  assert.strictEqual(corrW(hourly(2, bucket(NaN)), 2), 0, 'NaN bias');
});

test('correction lands BEFORE the baseload floor, so the floor still binds', () => {
  // raw 330W, floor 314W, bias -76W -> 254W would breach the floor; the floor wins.
  assert.deepStrictEqual(build([330], [2], hourly(2, bucket(-76)), 314, true), [314]);
  // and without the floor the full correction shows, proving the floor is what clipped it.
  assert.deepStrictEqual(build([330], [2], hourly(2, bucket(-76)), 0, true), [254]);
});

test('flag off reproduces today\'s array exactly', () => {
  const raw = [479, 700, 330, 402];
  const hours = [2, 10, 3, 23];
  const h = { 2: bucket(-76), 3: bucket(-90), 23: bucket(-60), 10: bucket(-104) };
  assert.deepStrictEqual(build(raw, hours, h, 314, false), raw.map(v => Math.max(v, 314)));
});

test('WIRING: the accuracy meter reads the raw stash, not the corrected DP array', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../drivers/battery-policy/device.js'), 'utf8');

  assert.ok(!/_closedFc\s*=[\s\S]{0,200}_schedule\?\.slots/.test(src),
    'the meter must NOT take its forecast from _schedule.slots[].consumptionW -- that array '
    + 'carries the correction, so scoring it makes emaBiasW measure its own output');
  assert.ok(/_closedFc\s*=[\s\S]{0,200}_rawConsumptionSlots/.test(src),
    'the meter must read the stashed raw learned profile');
});

test('WIRING: the raw stash is filled from the uncorrected array', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../drivers/battery-policy/device.js'), 'utf8');

  const stashAt = src.indexOf('this._rawConsumptionSlots =');
  const dpAt    = src.indexOf('_buildDpConsumption(rawLearned');
  assert.ok(stashAt > 0, 'expected the raw stash assignment');
  assert.ok(dpAt > 0, 'expected the DP array to be built from rawLearned');
  const stashLine = src.slice(stashAt, src.indexOf('\n', stashAt));
  assert.ok(!stashLine.includes('dpConsumptionWPerSlot'),
    'the stash must not be built from the corrected array');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
