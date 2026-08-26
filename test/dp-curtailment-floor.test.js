'use strict';

/**
 * Chunk 6 sub-chunk 2 — curtailment floor on the DP's forgone-export terms.
 *
 * Post-saldering a slot's export value can go negative. The DP books export only
 * as FORGONE revenue (effectiveChargeCost at optimization-engine.js:1532 and
 * vPreserve at :1561), so a negative export value reads as a bonus: charging is
 * priced as if the grid pays you to take the PV away. It does not — curtailing
 * the inverter dodges the same negative price for free, without filling the cell
 * the evening peak still needs.
 *
 * With `pv_curtailment_enabled` the forgone-export terms are floored at 0, which
 * is exactly the value of the disposal alternative.
 *
 * Scenario: 6 hourly slots, PV surplus only in slot 2 (1200 W against 300 W load
 * → pvCoverage = 1.0). Slot 2 is the priciest slot (0.30) and carries a deeply
 * negative export price (−0.30), so effectiveChargeCost = 0.30×(1−1.0) + (−0.30)×1.0
 * = −0.30 — a phantom payment to charge.
 */

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

// Slots start 2h from now on a whole hour so slot0RemainingFrac = 1.0.
const start = new Date();
start.setMinutes(0, 0, 0, 0);
start.setHours(start.getHours() + 2);
const ts = i => new Date(start.getTime() + i * 3_600_000).toISOString();

const makePrices = exportAtDecision => [0.05, 0.05, 0.30, 0.05, 0.05, 0.05].map((price, i) => ({
  timestamp: ts(i), price, exportPrice: i === 2 ? exportAtDecision : 0.01,
}));

const pvForecast = makePrices(0).map((p, i) => ({
  timestamp: p.timestamp, pvPowerW: i === 2 ? 1200 : 0, spreadFrac: 0,
}));

const baseSettings = {
  battery_efficiency: 0.9, min_soc: 0, max_soc: 95, cycle_cost_per_kwh: 0.075,
};

function runSlots({ model = 'asymmetric_2027', curtailment = false, exportAtDecision }) {
  const eng = new OptimizationEngine({
    ...baseSettings, tariff_model: model, pv_curtailment_enabled: curtailment,
  });
  eng.compute(makePrices(exportAtDecision), 40, 5.0, 800, 800, pvForecast,
    null, [300, 300, 300, 300, 300, 300], 0, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return eng._schedule.slots;
}

const actions = slots => slots.map(s => s.action);
const socPath = slots => slots.map(s => Math.round(s.socProjected * 100) / 100);

// ── Test A: without the floor, the negative export price buys a phantom charge ──
{
  const slots = runSlots({ curtailment: false, exportAtDecision: -0.30 });
  assert.strictEqual(slots[2].action, 'charge',
    `baseline: negative export should make the DP charge at the priciest slot, got ${slots[2].action}`);
  console.log('Test A (phantom charge reproduced without the floor): PASSED');
}

// ── Test B: with the floor, that slot is no longer worth charging ──
{
  const floored = runSlots({ curtailment: true,  exportAtDecision: -0.30 });
  const atZero  = runSlots({ curtailment: false, exportAtDecision: 0 });
  assert.strictEqual(floored[2].action, 'preserve',
    `floored: slot 2 should store its own PV instead of charging, got ${floored[2].action}`);
  // Flooring at 0 must be indistinguishable from an export price that is already 0.
  assert.deepStrictEqual(actions(floored), actions(atZero),
    'floored plan must equal the plan for an export price of exactly 0');
  assert.deepStrictEqual(socPath(floored), socPath(atZero),
    'floored SoC path must equal the SoC path for an export price of exactly 0');
  console.log('Test B (floor removes the phantom charge): PASSED');
}

// ── Test C: no-op when no export value is negative ──
{
  const off = runSlots({ curtailment: false, exportAtDecision: 0.02 });
  const on  = runSlots({ curtailment: true,  exportAtDecision: 0.02 });
  assert.deepStrictEqual(actions(on), actions(off),
    'with every export value >= 0 the floor must not change a single action');
  assert.deepStrictEqual(socPath(on), socPath(off),
    'with every export value >= 0 the floor must not change the SoC path');
  console.log('Test C (no-op above zero): PASSED');
}

// ── Test D: saldering is untouched — export equals the retail import price there ──
{
  const off = runSlots({ model: 'saldering', curtailment: false, exportAtDecision: -0.30 });
  const on  = runSlots({ model: 'saldering', curtailment: true,  exportAtDecision: -0.30 });
  assert.deepStrictEqual(actions(on), actions(off),
    'saldering plan must be identical with and without the curtailment flag');
  assert.deepStrictEqual(socPath(on), socPath(off),
    'saldering SoC path must be identical with and without the curtailment flag');
  console.log('Test D (saldering unaffected): PASSED');
}

console.log('\nAll curtailment-floor tests passed.');
