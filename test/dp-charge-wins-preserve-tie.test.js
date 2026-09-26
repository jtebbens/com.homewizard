'use strict';

// Regression: when PV covers the full charge power, "charge" and "preserve" reach the same SoC at
// the same cost under saldering (charging from PV forgoes the export, worth `price`), so the DP
// scores them exactly equal — and the strict `>` in the action pick kept preserve. preserve maps
// to zero_charge_only, which only charges from the ACTUAL surplus: one cloud and the battery sits
// idle in the cheapest hour while the plan counted the PV as certain.
//
// Live 2026-09-24 14:41 CEST: v[preserve=1.0146 charge=1.0146] → preserve at €0.179, SoC 56%,
// pvP1=304W under a cloud → batteryPower=0W. User decision: on a tie, charge.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

const RTE = 0.73;
const CYCLE = 0.075;

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Hourly slots, consumption 200 W, charge rate 800 W. t0..t3: cheap midday, PV 1200 W →
// pvCoverage (1200 − 200) / 800 ≥ 1, enough PV to fill the pack. t4..t6: evening peak, no PV.
const PV_W   = [1200, 1200, 1200, 1200, 0, 0, 0, 0, 0, 0, 0, 0];
const PRICES = [0.17, 0.18, 0.19, 0.20, 0.50, 0.50, 0.45, 0.30, 0.30, 0.30, 0.30, 0.30];

function runEngine() {
  const oe = new OE({
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
  });
  const base = Date.now();
  const ps = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = ps.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = ps.map(() => 200);
  oe.compute(ps, 44, 2.688, 800, 800, pvF, RTE, cons, 0.276, 1.0, 4.0, 4.0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

test('cheap slot, PV covers full charge power: charge wins the tie with preserve', () => {
  const s = runEngine();
  assert.strictEqual(s[0].action, 'charge',
    `expected charge at €${PRICES[0]} with full PV coverage, got '${s[0].action}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
