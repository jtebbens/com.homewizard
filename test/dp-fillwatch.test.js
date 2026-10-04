'use strict';

// [FILLWATCH] answers, once per policy run, a question the DP never asks itself: is the peak SoC
// this plan still promises for today actually REACHABLE from here, inside the slots that are still
// cheap enough to charge in?
//
// project_plan_soc_promise_vs_realized_0822 measured the gap this closes: on 22-08 the plan
// promised 100% for 13h45 and only gave that promise up at 14:15, by which time the cheap midday
// slots were spent. Nothing compares socProjected against the measured SoC, so the slip was
// invisible until it was too late to correct. device.js's [SoC] drift line reports the CURRENT
// slot only, and _shouldForceReoptimize's triggers are current-slot too.
//
// Contract covered here (log-only stage: this computes and records, it decides nothing):
//   - null rather than a half record when the plan cannot be judged
//   - the promise is today's highest projected SoC at/after now, with its slot time
//   - runway counts only slots that are BOTH before the promise and at/below maxChargePrice
//   - reachable compares the energy still needed against what that runway can physically deliver
//   - slot length is derived from the plan, so 15-min and hourly horizons both score correctly
//   - a promise already met is reachable regardless of runway

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const fillWatch = BatteryPolicyDevice.prototype._fillWatch;
assert.strictEqual(typeof fillWatch, 'function', '_fillWatch must exist on the prototype');

const CAP_KWH = 2.688;   // the live battery
const MAX_W   = 800;     // the live charge power
const call = (slots, soc, maxChP, now, cap = CAP_KWH, w = MAX_W) =>
  fillWatch.call({}, slots, soc, maxChP, cap, w, now);

// One full-power 15-min slot moves 800W * 0.25h = 0.2 kWh = 7.44pp of 2.688 kWh.
const PP_PER_SLOT = (MAX_W * 0.25 / 1000) / CAP_KWH * 100;

let pass = 0;
const ok = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok ${name}`);
};

// Build a 15-min plan starting at `startMs`. `spec` is one entry per slot: [socProjected, price].
function plan(startMs, spec, stepMs = 900000) {
  return spec.map(([socProjected, price], i) => ({
    timestamp: new Date(startMs + i * stepMs).toISOString(),
    socProjected,
    price,
  }));
}

// A fixed "now" mid-morning Amsterdam so the day-boundary logic is exercised deterministically.
const NOW = Date.parse('2026-09-20T09:30:00.000Z'); // 11:30 Amsterdam

console.log('[FILLWATCH] pure scoring');

ok('null on absent or empty plan', () => {
  assert.strictEqual(call(null, 20, 0.30, NOW), null);
  assert.strictEqual(call([], 20, 0.30, NOW), null);
  assert.strictEqual(call(plan(NOW, [[20, 0.1]]), null, 0.30, NOW), null);
});

ok('null when no charge-price cap is known', () => {
  // The static max_charge_price fallback (€0.12 live) sits below a normal cheap midday price, so
  // scoring against it reported runway=0 / reachable=false on a plan that was perfectly reachable.
  // Without the dynamic cap there is no honest verdict — emit nothing rather than a wrong one.
  const p = plan(NOW, [[20, 0.10], [90, 0.10]]);
  assert.strictEqual(call(p, 20, null, NOW), null);
});

ok('null when no slot carries a projected SoC', () => {
  const p = plan(NOW, [[null, 0.1], [null, 0.1]]);
  assert.strictEqual(call(p, 20, 0.30, NOW), null);
});

ok('promise is the highest projected SoC at/after now, with its slot time', () => {
  const p = plan(NOW, [[20, 0.1], [50, 0.1], [90, 0.1], [70, 0.1]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.promise, 90);
  assert.strictEqual(r.at, p[2].timestamp);
});

ok('slots before now are ignored when picking the promise', () => {
  // The 100 sits one slot BEFORE now, so it is history, not a promise.
  const p = plan(NOW - 900000, [[100, 0.1], [40, 0.1], [60, 0.1]]);
  const r = call(p, 40, 0.30, NOW);
  assert.strictEqual(r.promise, 60, 'must not promise a peak that already passed');
});

ok('runway counts only affordable slots strictly before the promise', () => {
  // 4 slots to the promise: two cheap, one over the cap, one cheap. The slot AT the promise and
  // the slots after it cannot charge toward it.
  const p = plan(NOW, [[20, 0.10], [20, 0.10], [20, 0.99], [20, 0.10], [90, 0.10], [90, 0.10]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.promise, 90);
  assert.strictEqual(r.runway, 3, 'the €0.99 slot is over the cap and must not count');
});

ok('reachable is true when the runway can physically deliver the shortfall', () => {
  // Need 2 slots' worth; give 3 cheap ones.
  const target = Math.round(20 + 2 * PP_PER_SLOT);
  const p = plan(NOW, [[20, 0.10], [20, 0.10], [20, 0.10], [target, 0.10]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.runway, 3);
  assert.ok(r.needKwh > 0, 'a shortfall must register as positive energy');
  assert.strictEqual(r.reachable, true);
});

ok('reachable is FALSE when the promise outruns the affordable slots', () => {
  // This is the 22-08 failure shape: the plan still promises 100%, but only one cheap slot is
  // left and one slot moves ~7.4pp, so the last ~72pp cannot happen.
  const p = plan(NOW, [[20, 0.10], [100, 0.10], [100, 0.10]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.runway, 1);
  assert.ok(r.needKwh > r.runwayKwh, 'need must exceed what one slot can deliver');
  assert.strictEqual(r.reachable, false);
});

ok('an expensive runway is unreachable even with many slots left', () => {
  const p = plan(NOW, [[20, 0.99], [20, 0.99], [20, 0.99], [20, 0.99], [100, 0.10]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.runway, 0);
  assert.strictEqual(r.runwayKwh, 0);
  assert.strictEqual(r.reachable, false);
});

ok('a promise already met is reachable with zero runway', () => {
  const p = plan(NOW, [[100, 0.99], [100, 0.99]]);
  const r = call(p, 100, 0.30, NOW);
  assert.strictEqual(r.needKwh, 0);
  assert.strictEqual(r.reachable, true, 'nothing to do is not a failure');
});

ok('hourly plans score on hourly energy, not 15-min energy', () => {
  // Same two-slot runway, but each slot is 4x longer, so 4x the energy fits.
  const need15 = plan(NOW, [[20, 0.10], [20, 0.10], [50, 0.10]]);
  const need60 = plan(NOW, [[20, 0.10], [20, 0.10], [50, 0.10]], 3600000);
  assert.strictEqual(call(need15, 20, 0.30, NOW).reachable, false);
  assert.strictEqual(call(need60, 20, 0.30, NOW).reachable, true);
});

ok('the promise never reaches past the end of the Amsterdam day', () => {
  // A 100% peak tomorrow must not be read as a promise for today.
  const lateToday = Date.parse('2026-09-20T21:30:00.000Z'); // 23:30 Amsterdam
  const p = plan(lateToday, [[30, 0.10], [30, 0.10], [100, 0.10], [100, 0.10]]);
  const r = call(p, 30, 0.30, lateToday);
  assert.strictEqual(r.promise, 30, 'slots past midnight Amsterdam belong to the next day');
});

ok('slots missing a price are not counted as affordable runway', () => {
  const p = plan(NOW, [[20, null], [20, undefined], [90, 0.10]]);
  const r = call(p, 20, 0.30, NOW);
  assert.strictEqual(r.runway, 0);
});

ok('a battery stack charges its own shortfall, not a single unit\'s', () => {
  // Two units: 2x the capacity to fill, but also 2x the charge power, so the same runway of slots
  // still delivers it. Scoring a stack at one unit's 800 W would call this unreachable.
  const two = { cap: 2 * CAP_KWH, w: 2 * MAX_W };
  const p = plan(NOW, [[20, 0.10], [20, 0.10], [20, 0.10], [50, 0.10]]);
  const one = call(p, 20, 0.30, NOW);
  const stack = call(p, 20, 0.30, NOW, two.cap, two.w);
  assert.strictEqual(one.runway, stack.runway, 'the runway in slots is the same either way');
  assert.ok(stack.needKwh > one.needKwh, 'a bigger stack needs more energy for the same pp');
  assert.ok(stack.runwayKwh > one.runwayKwh, 'and can also deliver more');
  assert.strictEqual(stack.reachable, one.reachable, 'so reachability must not change with size');
});

ok('PolicyEngine.batteryChargePowerW is the single source for stack power', () => {
  const PolicyEngine = require('../lib/policy-engine');
  assert.strictEqual(typeof PolicyEngine.batteryChargePowerW, 'function');
  assert.strictEqual(PolicyEngine.batteryChargePowerW({ maxChargePowerW: 2400 }), 2400, 'measured wins');
  assert.strictEqual(PolicyEngine.batteryChargePowerW({ totalCapacityKwh: 2.688 }), 800, '1 unit');
  assert.strictEqual(PolicyEngine.batteryChargePowerW({ totalCapacityKwh: 8.064 }), 2400, '3 units');
  assert.strictEqual(PolicyEngine.batteryChargePowerW(null), 800, 'unknown stack falls back to one unit');
});

console.log(`\n[FILLWATCH] ${pass} passed`);
