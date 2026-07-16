'use strict';

// Reorder re-sim phantom PV gain: the night-window re-simulation must use the
// same SoC physics as the forward pass. Forward only credits free PV charging
// on 'trickle' slots (and pvStoreWins/strong-preserve, which can't occur inside
// the window) — a 'standby' slot exports its surplus and gains nothing. The old
// re-sim credited ANY non-charge/discharge slot with pvCoverage > 0, inflating
// the simulated end SoC: the undershoot rollback guard could pass a reordered
// plan that really ends below dpEndTarget, and the rewritten trajectory showed
// a SoC rise across a standby slot that the runtime never delivers.

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

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

const H = 3_600_000;

// Night window t0..t3 (strong PV at t4/t5 ends it, tail t6 after the PV block):
//   t0 €0.30, t1 €0.35  — dischargeable, above the released peak → never floored
//   t2 €0.20 + 300W PV  — weak surplus (cov 0.1): store value (€0.10×RTE) loses
//                         from export €0.20 → forward action 'standby' (pvExportWins)
//   t3 €0.22            — floored, too pricey vs the PV-boundary gradient to charge
// refillConfidence 0.5 → reserve floor 25% on t2/t3 (price ≤ released peak €0.25).
// Start SoC 30%: forward (flatten active, pvKwhTomorrow 2 ≥ 0.6×cap) discharges
// t0 (Δ10%) then t1 (Δ30%, clamps to 0%) — misordered budget, so the reorder
// engages and assigns the whole budget to t1 (priciest), holding t0.
const base = new Date(Date.now() + 2 * H); base.setMinutes(0, 0, 0, 0);
const priceVals = [0.30, 0.35, 0.20, 0.22, 0.15, 0.15, 0.25];
const pvVals    = [0, 0, 300, 0, 2000, 2000, 0];
const consVals  = [200, 600, 200, 200, 200, 200, 200];
const prices = priceVals.map((p, t) => ({ timestamp: new Date(base.getTime() + t * H).toISOString(), price: p }));
const pv     = pvVals.map((w, t) => ({ timestamp: new Date(base.getTime() + t * H).toISOString(), pvPowerW: w }));

function run() {
  const eng = new OptimizationEngine({ battery_efficiency: 0.90, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 });
  // compute(prices, soc, capKwh, chargeW, dischargeW, pv, rte, cons, minDisch,
  //         margin, pvKwhTomorrow, terminalPvKwh, cloudFactor, refillConfidence)
  eng.compute(prices, 30, 2, 1000, 1000, pv, null, consVals, 0, 1.0, 2, 2, 1.0, 0.5);
  return eng._schedule.slots;
}

test('scenario sanity: reorder engaged and standby slot present', () => {
  const slots = run();
  assert.strictEqual(slots[2].action, 'standby',
    `expected standby (pvExportWins) at t2, got ${slots[2].action}`);
  assert.strictEqual(slots[1].action, 'discharge',
    `expected discharge at priciest slot t1, got ${slots[1].action}`);
  assert.strictEqual(slots[0].action, 'preserve',
    `expected reorder to hold t0 (budget moved to t1), got ${slots[0].action}`);
});

test('no phantom SoC rise across a standby slot', () => {
  const slots = run();
  assert.ok(slots[3].socProjected <= slots[2].socProjected,
    `standby slot must not gain SoC: t2=${slots[2].socProjected}% → t3=${slots[3].socProjected}%`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
