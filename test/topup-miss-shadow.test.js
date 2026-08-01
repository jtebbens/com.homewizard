'use strict';

// Top-up-miss shadow metric (project_dp_daytime_pv_timing_no_hedge). On overcast days the PV
// surplus dries up before the battery is full, and the DP declines midday grid charging via
// preserve:pv_strong / trickle:pv_weak — betting on free PV that never arrives. 2026-07-30 peaked
// at 44% while midday cost €0.144 and the evening peak was €0.396.
//
// _topupMissMetrics quantifies, per policy run, what buying that headroom would have been worth.
// It is log-only: nothing in the DP changes.
//
// CRITICAL — anti-tautology (feedback_metric_must_allow_negative): a metric that can only come out
// positive proves nothing. marginPerKwh charges the FULL cycleCostPerKwh (the DP books *0.5 on
// charge AND *0.5 on discharge, optimization-engine.js:904/946), and valueEur is NOT clamped, so a
// low evening peak or an expensive midday must produce a NEGATIVE number. The low-peak case below
// is the one that proves the metric is two-sided.
//
// device.js does require('homey'), so stub that module before loading the class to reach its
// prototype method. We never instantiate the Homey lifecycle. The method touches no `this`, so it
// is called with a null receiver.

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
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const metrics = (slots, cap = CAP, rte = RTE, cyc = CYC, maxSoc = 100) =>
  BatteryPolicyDevice.prototype._topupMissMetrics.call(null, slots, cap, rte, cyc, maxSoc);

const CAP = 2.69;                    // live battery, 1 unit
const RTE = 0.7334741586138482;      // live learned RTE 2026-07-30
const CYC = 0.075;                   // engine default cycle_cost_per_kwh
const H = 3_600_000;
const T0 = Date.parse('2026-07-30T08:00:00.000Z');

// Slot shape mirrors optimization-engine.js:401-410 (only the fields the metric reads).
function slot(i, { price, pvCoverage = 0, soc = 44, pv = 700, cons = 500 }) {
  return {
    timestamp: new Date(T0 + i * H / 4).toISOString(),
    price, pvCoverage, socProjected: soc, pvForecastW: pv, consumptionW: cons,
  };
}

// The 2026-07-30 shape: PV surplus through index 3, then a cheap midday slot, then the evening
// peak. Cheapest pre-peak slot = €0.144 @ idx 4, evening peak = €0.396 @ idx 6.
function overcastDay({ soc = 44, eveMax = 0.396, buy = 0.144 } = {}) {
  return [
    slot(0, { price: 0.30, pvCoverage: 0.5, soc: 10 }),
    slot(1, { price: 0.30, pvCoverage: 0.5, soc: 25 }),
    slot(2, { price: 0.30, pvCoverage: 0.4, soc: 35 }),
    slot(3, { price: 0.30, pvCoverage: 0.2, soc }),      // last slot with PV surplus
    // Neighbours are derived from buy/eveMax so those two stay the genuine min/max of their
    // windows whatever the caller passes — a fixed 0.35 tail silently became the peak instead.
    slot(4, { price: buy, soc, pv: 400 }),
    slot(5, { price: buy + 0.05, soc, pv: 100 }),
    slot(6, { price: eveMax, soc, pv: 0 }),               // evening peak
    slot(7, { price: eveMax - 0.05, soc, pv: 0 }),
  ];
}

console.log('\ntopup-miss shadow metric');

test('overcast day reproduces the 2026-07-30 numbers', () => {
  const m = metrics(overcastDay());
  assert.ok(m, 'expected a sample, got null');
  // headroom = 2.69 * (100 - 44) / 100
  assert.ok(Math.abs(m.headroomKwh - 1.5064) < 1e-6, `headroom ${m.headroomKwh}`);
  assert.strictEqual(m.buy, 0.144);
  assert.strictEqual(m.eveMax, 0.396);
  // margin = 0.396 * 0.73347... - 0.144 - 0.075 = +0.07146
  const expMargin = 0.396 * RTE - 0.144 - CYC;
  assert.ok(Math.abs(m.marginPerKwh - expMargin) < 1e-9, `margin ${m.marginPerKwh}`);
  assert.ok(Math.abs(m.marginPerKwh - 0.07146) < 1e-4, `margin ${m.marginPerKwh} not ~+0.0715`);
  // value = 1.5064 * 0.07146 = +0.1077
  assert.ok(Math.abs(m.valueEur - 0.10765) < 1e-3, `value ${m.valueEur} not ~+0.108`);
  assert.ok(m.valueEur > 0, 'expected a positive value on this day');
});

test('buy price is the cheapest slot BEFORE the peak, not the global minimum', () => {
  // A cheaper slot AFTER the peak must not be picked: you cannot buy at 22:00 to sell at 20:45.
  const s = overcastDay();
  s[7].price = 0.01;
  const m = metrics(s);
  assert.strictEqual(m.buy, 0.144, `picked ${m.buy}, expected the pre-peak minimum`);
});

test('NEGATIVE when the evening peak cannot cover RTE + cycle cost', () => {
  // 0.20 * 0.7334 - 0.144 - 0.075 = -0.0723/kWh. This is the anti-tautology case: without it the
  // metric could only ever agree with the hypothesis that prompted it.
  const m = metrics(overcastDay({ eveMax: 0.20 }));
  assert.ok(m, 'expected a sample, got null');
  assert.ok(m.marginPerKwh < 0, `margin ${m.marginPerKwh} should be negative`);
  assert.ok(m.valueEur < 0, `value ${m.valueEur} should be negative`);
  assert.ok(Math.abs(m.valueEur - 1.5064 * (0.20 * RTE - 0.144 - CYC)) < 1e-9);
});

test('NEGATIVE when midday is expensive relative to the peak', () => {
  const m = metrics(overcastDay({ buy: 0.28 }));
  assert.ok(m.valueEur < 0, `value ${m.valueEur} should be negative`);
});

test('sunny day: battery full on PV alone → null (nothing to buy)', () => {
  // soc 99% → headroom 0.027 kWh, below the 0.2 kWh floor. This is why dp-regret gave an invalid
  // answer: 9 of 10 days in history.json reached peakSoC 100% on PV alone.
  assert.strictEqual(metrics(overcastDay({ soc: 99 })), null);
});

test('no PV surplus anywhere in the horizon → null', () => {
  const s = overcastDay().map(x => ({ ...x, pvCoverage: 0 }));
  assert.strictEqual(metrics(s), null);
});

test('PV surplus runs to the last slot → null (nothing left to sell into)', () => {
  const s = overcastDay().map(x => ({ ...x, pvCoverage: 0.5 }));
  assert.strictEqual(metrics(s), null);
});

test('reports input coverage instead of assuming it', () => {
  const s = overcastDay();
  s[5].consumptionW = null;
  s[6].pvForecastW = null;
  const m = metrics(s);
  assert.strictEqual(m.nSlots, 8);
  assert.strictEqual(m.covCons, 7);
  assert.strictEqual(m.covPv, 7);
});

// ── NaN / non-finite guards (c4acba6 stored NaN prices and made every sample unusable) ──────────

test('NaN socProjected at the PV end → null', () => {
  const s = overcastDay();
  s[3].socProjected = NaN;
  assert.strictEqual(metrics(s), null);
});

test('all post-PV prices non-finite → null', () => {
  const s = overcastDay();
  for (let i = 4; i < s.length; i++) s[i].price = NaN;
  assert.strictEqual(metrics(s), null);
});

test('a single NaN price is skipped, never propagated into the output', () => {
  // Deviation from the plan, which said one NaN price should void the whole sample: skipping the
  // bad slot keeps a usable day instead of discarding it, and the assertions below prove no NaN
  // reaches the ring either way — which is what the guard is actually for.
  const s = overcastDay();
  s[5].price = NaN;
  const m = metrics(s);
  assert.ok(m, 'a single bad slot should not void the sample');
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is ${v}`);
  }
  assert.strictEqual(m.buy, 0.144);
  assert.strictEqual(m.eveMax, 0.396);
});

test('non-finite capacity / rte / cycle cost / maxSoc → null', () => {
  assert.strictEqual(metrics(overcastDay(), NaN), null);
  assert.strictEqual(metrics(overcastDay(), 0), null);
  assert.strictEqual(metrics(overcastDay(), CAP, NaN), null);
  assert.strictEqual(metrics(overcastDay(), CAP, RTE, NaN), null);
  assert.strictEqual(metrics(overcastDay(), CAP, RTE, CYC, NaN), null);
});

test('empty / missing slot array → null', () => {
  assert.strictEqual(metrics([]), null);
  assert.strictEqual(metrics(null), null);
  assert.strictEqual(metrics(undefined), null);
});

test('maxSoc below 100 shrinks the headroom accordingly', () => {
  const m = metrics(overcastDay(), CAP, RTE, CYC, 90);
  assert.ok(Math.abs(m.headroomKwh - CAP * 46 / 100) < 1e-9, `headroom ${m.headroomKwh}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
