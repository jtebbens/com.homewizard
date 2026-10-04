'use strict';

// dp_pv_store_dp_owned: on a strong-PV slot the backward DP alone decides store vs export.
//
// Before, three places answered that one question: the backward DP (vPreserve pays wear plus the
// forgone export), the forward-pass pvStoreWins override (flips a DP standby to preserve on a
// suffix-max rule of thumb) and, at runtime, policy-engine's own store-vs-export test. The
// override made the plan store PV the DP's dp[] never valued, so a DP-side fill penalty paid for
// kWh the shipped plan already stored (property 65, 2026-09-25). And the SoC projection repeated
// the store-vs-export test on a DP preserve: slot 2 below is preserve at €0.058 with full
// coverage, yet the projected SoC did not move.
//
// Case: first hit of a 3000-scenario random search in which pvStoreWins fires (1062/3000).

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const { ACTION_SRC } = OE;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const PRICES = [0.319, 0.171, 0.058, 0.23, 0.341, 0.217, 0.128, 0.396, 0.151, 0.389, 0.278, 0.292,
  0.424, 0.233, 0.183, 0.305, 0.118, 0.268, 0.431, 0.208, 0.116, 0.228, 0.096, 0.385];
const PV = [1095, 1621, 2363, 1248, 849, 1208, 754, 1255, 1541, 450, 102, 591,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function run(flag) {
  const oe = new OE({ battery_efficiency: 0.72, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0, dp_pv_store_dp_owned: flag });
  const base = new Date('2026-06-01T08:00:00.000Z').getTime();
  const ts = t => new Date(base + t * 900e3).toISOString();
  const prices = PRICES.map((price, t) => ({ timestamp: ts(t), price }));
  const pvF = PV.map((pvPowerW, t) => ({ timestamp: ts(t), pvPowerW }));
  oe.compute(prices, 85, 2.688, 800, 800, pvF, 0.72, new Array(24).fill(300), 0.10, 1.0, 0, 0, 1.0, 1.0);
  return oe._schedule.slots;
}

const strongCov = OE.PV_STRONG_SURPLUS_W / 800;
const step = (s, t) => s[t + 1].socProjected - s[t].socProjected;

console.log('\nOptimizationEngine — dp_pv_store_dp_owned: DP alone decides strong-PV store vs export\n');

test('flag off: pvStoreWins still overrides the DP (baseline unchanged)', () => {
  const s = run(false);
  assert.strictEqual(s[8].actionSrc, ACTION_SRC.PV_STORE, `slot 8 src ${s[8].actionSrc}`);
  assert.strictEqual(s[8].action, 'preserve');
});

test('flag on: no store/trickle override on any strong-PV slot', () => {
  const s = run(true);
  const bad = s.filter(x => x.pvCoverage >= strongCov
    && (x.actionSrc === ACTION_SRC.PV_STORE || x.actionSrc === ACTION_SRC.TRICKLE));
  assert.deepStrictEqual(bad.map(x => x.actionSrc), []);
});

test('flag on: slot 8 follows the DP standby, SoC does not move', () => {
  const s = run(true);
  assert.strictEqual(s[8].action, 'standby');
  assert.strictEqual(s[8].actionSrc, ACTION_SRC.DP);
  assert.ok(Math.abs(step(s, 8)) < 1e-9, `SoC step ${step(s, 8)}`);
});

test('flag on: a DP preserve on strong PV is credited in the projection', () => {
  const s = run(true);
  assert.strictEqual(s[2].action, 'preserve');
  assert.ok(step(s, 2) > 1, `slot 2 SoC step ${step(s, 2).toFixed(2)} pp — DP stored, plan must show it`);
});

test('flag on: strong-PV slots are marked DP-owned for the runtime mapper', () => {
  const s = run(true);
  const strong = s.filter(x => x.pvCoverage >= strongCov);
  assert.ok(strong.length > 0);
  assert.ok(strong.every(x => x.pvWeakOwnedByDp === true),
    `not owned: ${strong.filter(x => !x.pvWeakOwnedByDp).map(x => x.timestamp).join(',')}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
