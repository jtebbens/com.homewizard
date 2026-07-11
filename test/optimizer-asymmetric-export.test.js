'use strict';

/**
 * Chunk 2 — asymmetric import/export pricing in the DP cost function.
 *
 * Under saldering (net metering, default) exporting PV offsets import 1:1, so
 * export is valued at the retail price. Post-2027 (tariff_model:'asymmetric_2027')
 * export earns a separate, lower per-slot price (prices[t].exportPrice), so the DP
 * should prefer STORING marginal PV over exporting it — the pv_export_wins flip.
 *
 * Scenario: 6 hourly slots, only slot 2 has PV surplus. Retail price at slot 2 is
 * high (0.20) but its export price is low (0.05). A downstream evening peak (0.15)
 * makes storeValue ≈ 0.15 × RTE(0.9) = 0.135, which sits strictly between the two:
 *   saldering  → exportValue 0.20 > store 0.135 → EXPORT (standby)
 *   asymmetric → exportValue 0.05 < store 0.135 → STORE  (preserve)
 */

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

// Slots start 2h from now on a whole hour so slot0RemainingFrac = 1.0.
const start = new Date();
start.setMinutes(0, 0, 0, 0);
start.setHours(start.getHours() + 2);
const ts = i => new Date(start.getTime() + i * 3_600_000).toISOString();

function makePrices(withExport) {
  return [
    { timestamp: ts(0), price: 0.10 },
    { timestamp: ts(1), price: 0.10 },
    { timestamp: ts(2), price: 0.20 }, // midday PV-surplus decision slot
    { timestamp: ts(3), price: 0.10 },
    { timestamp: ts(4), price: 0.10 },
    { timestamp: ts(5), price: 0.15 }, // evening peak (store target)
  ].map((p, i) => withExport ? { ...p, exportPrice: 0.05 } : p);
}

const pvForecast = makePrices(false).map((p, i) => ({
  timestamp: p.timestamp, pvPowerW: i === 2 ? 2500 : 0, spreadFrac: 0,
}));

const baseSettings = { battery_efficiency: 0.9, min_soc: 0, max_soc: 95, cycle_cost_per_kwh: 0.0 };

function runSlots(model, prices) {
  const eng = new OptimizationEngine({ ...baseSettings, tariff_model: model });
  eng.compute(prices, 40, 5.0, 800, 800, pvForecast,
    null, [300, 300, 300, 300, 300, 300], 0, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return eng._schedule.slots;
}

// ── Test A: saldering (default) exports the midday PV surplus ──
{
  const slots = runSlots('saldering', makePrices(true));
  assert.strictEqual(slots[2].action, 'standby', `saldering slot2 should export (standby), got ${slots[2].action}`);
  assert.strictEqual(slots[2].pvExportWins, true, 'saldering slot2 pvExportWins should be true');
  console.log('Test A (saldering exports midday PV): PASSED');
}

// ── Test B: asymmetric_2027 stores the midday PV surplus instead (the flip) ──
{
  const slots = runSlots('asymmetric_2027', makePrices(true));
  assert.strictEqual(slots[2].action, 'preserve', `asymmetric slot2 should store (preserve), got ${slots[2].action}`);
  assert.strictEqual(slots[2].pvExportWins, false, 'asymmetric slot2 pvExportWins should be false');
  assert.ok(slots[2].socProjected > slots[1].socProjected,
    `asymmetric slot2 should raise SoC (store PV): ${slots[1].socProjected} -> ${slots[2].socProjected}`);
  console.log('Test B (asymmetric stores midday PV — the flip): PASSED');
}

// ── Test C: no regression — saldering ignores exportPrice (toggle off is neutral) ──
{
  const withField    = runSlots('saldering', makePrices(true)).map(s => s.action);
  const withoutField = runSlots('saldering', makePrices(false)).map(s => s.action);
  assert.deepStrictEqual(withField, withoutField,
    'saldering schedule must be identical whether or not exportPrice is present on the slots');
  console.log('Test C (saldering ignores exportPrice field): PASSED');
}

console.log('\nAll asymmetric-export tests passed.');
