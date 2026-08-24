'use strict';

// Regression: with a NEGATIVE export price the store-vs-export gate lost its ordering.
//
// `pvStoreBeatsExport` (optimization-engine.js) compares the store value against the
// slot's export value. When the trickle cap binds, the store value is clamped to
// (0 - cycleCost); post-2027 the export value can be negative (spot below the
// export addon). The comparison then reads "0 > -0.003" — true at EVERY slot of the
// PV block, so the gate can say "store" but never "store HERE rather than there".
// The forward pass therefore stored at the FIRST PV slot instead of the one where
// the export penalty is deepest, giving away the difference for the same end state.
//
// Scenario: 4 expensive PV slots, then 4 cheaper ones (deeper negative export),
// then an evening peak. The pack is small enough that the cheap half alone fills it,
// so nothing may be stored while the expensive half runs — exporting there is worth
// more (a smaller penalty) than exporting during the cheap half.
// Under saldering this cannot occur: export value == import price, always positive
// where the gate is allowed to fire.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function run() {
  const oe = new OE({ battery_efficiency: 0.70, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0, tariff_model: 'asymmetric_2027',
    dp_trickle_cap_saturation: true });
  const base = Date.now();
  const mk = (h, price, exportPrice) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price, exportPrice,
  });
  // Retail prices sit above zero; the underlying spot is negative, so export is too.
  // The cheap half carries the DEEPER penalty — that is where storing belongs.
  const prices = [
    mk(0, 0.130, -0.0028), mk(1, 0.130, -0.0028), mk(2, 0.130, -0.0028), mk(3, 0.130, -0.0028),
    mk(4, 0.115, -0.0165), mk(5, 0.115, -0.0165), mk(6, 0.115, -0.0165), mk(7, 0.115, -0.0165),
    mk(8, 0.386, 0.2296), mk(9, 0.100, -0.0200), mk(10, 0.100, -0.0200),
  ];
  const cons = prices.map(() => 200);
  // 1600 W over an 800 W charge rate and 200 W of load → pvCoverage 1.0 on the block.
  const pvW = [1600, 1600, 1600, 1600, 1600, 1600, 1600, 1600, 0, 0, 0];
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: pvW[h] }));
  // 0.96 kWh pack: one cheap-half slot (0.8 kWh at 800 W) very nearly fills it, and the
  // four of them together fill it several times over — deferring costs no volume.
  oe.compute(prices, 0, 0.96, 800, 800, pvF, 0.70, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

test('negative export: nothing is stored while the shallower penalty runs', () => {
  const slots = run();
  // socProjected[t] is the SoC entering slot t, so slot 4 shows what the expensive half stored.
  assert.ok(slots[4].socProjected <= 1.0,
    `SoC entering the cheap half should still be ~0, got ${slots[4].socProjected.toFixed(1)}% `
    + `(actions: ${slots.slice(0, 9).map(s => s.action).join(',')})`);
});

test('deferring costs no volume: the pack is full at the peak', () => {
  const slots = run();
  assert.ok(slots[8].socProjected >= 99,
    `SoC entering the evening peak should be ~100%, got ${slots[8].socProjected.toFixed(1)}%`);
});

console.log(`\ndp-asym-negative-export-store-ordering: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
