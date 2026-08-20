'use strict';

// Regression: the "cheaper PV ahead" deferral must only look at PV slots that arrive
// BEFORE the peak the stored energy is meant to serve.
//
// Live bug (2026-08-14, Amsterdam): battery sat at 85% SoC through five midday quarters
// (15:15–16:15 CEST) exporting 1.3–1.6 kW of PV surplus while prices climbed 0.197 → 0.262,
// then discharged into a €0.496 evening peak. The DP itself returned standby — the runtime
// heuristic overruled nothing (_pvStoreWins stayed true the whole window).
//
// Cause: cheaperPvAhead compared the current price against minFuturePvStrongPrice, a
// suffix-min over the ENTIRE horizon. On a 32-hour horizon the cheapest PV-strong slot is
// TOMORROW midday (verified from policy_all_prices_15min: 15-08 ran €0.135–0.161), so the
// gate concluded "the battery refills for free later, export now" — while tonight's peak
// sits in between and empties the battery first. Tomorrow's free PV cannot serve tonight.
//
// The eveningCoverageAtRisk safety net cannot catch this: it asks whether the battery ever
// gets FULL, not whether it is full IN TIME, so at high SoC it never fires.
//
// STATUS 2026-08-20: this shape does NOT reproduce the export on HEAD. cheaperPvAhead still
// suppresses the pvStoreWins branch, but the weak-PV trickle branch 30 lines down catches the
// slot (pvStoreValue2 > exportValue) and stores the surplus anyway: SoC 85% -> 100% across the
// slot, then discharged into the €0.496 peak. So the assertions below pin the OUTCOME (was the
// surplus stored) instead of WHICH branch stored it -- an earlier revision asserted
// action === 'preserve' and went red purely on branch identity while the battery filled.
//
// Storing actions are 'preserve' and 'trickle'; 'standby' is the export decision. The negative
// control below returns 'standby' with a flat SoC, so the two cases stay distinguishable.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const RTE = 0.732;
const CYCLE = 0.075;
// storeVal(p) = p * RTE - CYCLE. Boundary slot must satisfy storeVal(p) > price[test slot],
// i.e. p > (price + CYCLE) / RTE — €0.372 for the €0.197 slot below, €0.512 for the €0.30 one.

function build(rows, soc) {
  const oe = new OE({ battery_efficiency: RTE, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, export_price_ratio: 1.0 });
  // Anchored to now: slot 0 is a spent partial slot (slot0RemainingFrac), so the slot under
  // test is index 1 — index 0 is deliberately filler.
  const base = Date.now();
  const ts = h => new Date(base + h * 3600e3).toISOString();
  const prices = rows.map((r, h) => ({ timestamp: ts(h), price: r.price }));
  const pvF    = rows.map((r, h) => ({ timestamp: ts(h), pvPowerW: r.pv }));
  const cons   = rows.map(r => r.cons);
  oe.compute(prices, soc, 2.69, 800, 800, pvF, RTE, cons, 0.22, 1.2, 7.1, 7.1, 1.0, 1.0);
  return oe;
}

// 2026-08-14 shape: PV-strong now at €0.197, evening peak €0.496 in between, and only THEN
// tomorrow's cheap PV window at €0.135. Deferring to tomorrow strands tonight's peak.
const DEFER_PAST_PEAK = [
  { price: 0.200, pv: 0,    cons: 400 }, // 0 filler (spent partial slot)
  { price: 0.197, pv: 2600, cons: 300 }, // 1 SLOT UNDER TEST — PV strong
  { price: 0.280, pv: 0,    cons: 500 }, // 2
  { price: 0.496, pv: 0,    cons: 600 }, // 3 evening peak — worth a round trip
  { price: 0.300, pv: 0,    cons: 400 }, // 4
  { price: 0.135, pv: 2600, cons: 300 }, // 5 TOMORROW's cheap PV — unreachable in time
  { price: 0.140, pv: 2600, cons: 300 }, // 6
  { price: 0.350, pv: 0,    cons: 400 }, // 7
];

// Negative control — the legitimate deferral this gate exists for (live 2026-07-01 duck
// curve): the cheaper PV slot arrives BEFORE any peak worth serving, so exporting now and
// charging for free at t2 really is better. The fix must not break this.
const DEFER_BEFORE_PEAK = [
  { price: 0.200, pv: 0,    cons: 400 }, // 0 filler
  { price: 0.300, pv: 2600, cons: 300 }, // 1 SLOT UNDER TEST — PV strong
  { price: 0.100, pv: 2600, cons: 300 }, // 2 cheaper PV, reachable, nothing costly in between
  { price: 0.350, pv: 0,    cons: 500 }, // 3
  { price: 0.600, pv: 0,    cons: 600 }, // 4 peak, but only AFTER the free refill
  { price: 0.300, pv: 0,    cons: 400 }, // 5
];

console.log('\nOptimizationEngine — cheaper-PV deferral must not reach past the peak it saves for\n');

// SoC at the START of each slot, so a gain across slot 1 shows up at slot 2.
function socGain(slots) {
  return slots[2].socProjected - slots[1].socProjected;
}

test('does not defer to tomorrow PV when tonight peak sits in between', () => {
  const slots = build(DEFER_PAST_PEAK, 85)._schedule.slots;
  const gain = socGain(slots);
  assert.ok(gain > 0,
    `expected the PV surplus to be stored, got action=${slots[1].action} with SoC flat at `
    + `${slots[1].socProjected}% (deferred past the €0.496 peak)`);
  assert.ok(slots[1].action === 'preserve' || slots[1].action === 'trickle',
    `SoC rose ${gain}pp but action=${slots[1].action} is not a storing action`);
});

test('still defers when the cheaper PV slot arrives before any peak worth serving', () => {
  const slots = build(DEFER_BEFORE_PEAK, 85)._schedule.slots;
  assert.strictEqual(socGain(slots), 0,
    `expected the deferral to survive, got action=${slots[1].action} storing `
    + `${socGain(slots)}pp (gate now over-fires)`);
  assert.ok(socGain(slots.slice(1)) > 0,
    'expected the cheaper PV slot at index 2 to do the refill instead');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
