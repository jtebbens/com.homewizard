'use strict';

// Explainability must not re-decide store-vs-export on a slot the DP owns.
//
// With dp_weak_pv_in_dp on, the backward pass prices the weak PV band itself and policy-engine's
// mapper follows that decision (_computePvFlags sets _pvStoreWins from the DP action and marks the
// slot with _pvWeakOwnedByDp). _addPVReasons used to derive its own verdict from the export margin
// plus a low-SoC threshold — a third decider on the same question, so the explanation could claim
// "export is more profitable" on a slot the plan stores, and the other way round. That is the
// divergence the three-file rule (optimization-engine / policy-engine / explainability-engine)
// exists to stop.
//
// The scenario below is deliberately one where the margin verdict and the DP verdict disagree:
// export pays €0.260 against a store value of €0.200, so the margin says export — and the DP says
// store. The explanation has to follow the DP.

const assert = require('assert');
const ExplainabilityEngine = require('../lib/explainability-engine');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const eng = new ExplainabilityEngine({ log: () => {} });

// gridPower < -150 is what puts _addPVReasons on the surplus branch at all.
function pvReasons({ dpOwns, storeWins }) {
  const inputs = {
    p1: { resolved_gridPower: -900, battery_power: 0 },
    battery: { stateOfCharge: 60, power: 0 },
    effectivePrice: 0.260,
    effectiveRte: 0.75,
    // Store value below the export value, so the margin-based verdict says "export wins".
    _pvStoreValue: 0.200,
    tariff: { currentPrice: 0.260, next24Hours: [{ timestamp: new Date(Date.now() + 3600e3).toISOString(), price: 0.366 }] },
    settings: { tariff_model: 'saldering', export_price_ratio: 1.0, cycle_cost_per_kwh: 0.075 },
  };
  if (dpOwns) inputs._pvWeakOwnedByDp = true;
  if (storeWins != null) inputs._pvStoreWins = storeWins;
  const reasons = [];
  eng._addPVReasons(reasons, inputs);
  return reasons;
}

test('premise: on the margins alone this slot reads as "export wins"', () => {
  const r = pvReasons({ dpOwns: false });
  assert.ok(r.length, 'the surplus branch must produce a reason at all');
  assert.ok(/export naar net winstgevender/.test(r[0].text),
    `expected the margin verdict, got: ${r[0].text}`);
});

test('DP owns the slot and stores → explanation says storing, not exporting', () => {
  const r = pvReasons({ dpOwns: true, storeWins: true });
  assert.ok(/opslaan winstgevender/.test(r[0].text),
    `explanation must follow the DP, got: ${r[0].text}`);
  assert.ok(/DP-besluit/.test(r[0].text), `and name who decided, got: ${r[0].text}`);
  assert.strictEqual(r[0].supportedMode, 'charge');
});

test('DP owns the slot and exports → explanation says exporting', () => {
  const r = pvReasons({ dpOwns: true, storeWins: false });
  assert.ok(/export naar net winstgevender/.test(r[0].text),
    `explanation must follow the DP, got: ${r[0].text}`);
  assert.ok(/DP-besluit/.test(r[0].text), `and name who decided, got: ${r[0].text}`);
});

test('flag off: the low-SoC thin-margin branch is untouched', () => {
  // Margin €0.005 under the €0.02 low-SoC threshold → store, with the margin wording.
  const reasons = [];
  eng._addPVReasons(reasons, {
    p1: { resolved_gridPower: -900, battery_power: 0 },
    battery: { stateOfCharge: 40, power: 0 },
    effectivePrice: 0.260,
    effectiveRte: 0.75,
    _pvStoreValue: 0.255,
    tariff: { currentPrice: 0.260 },
    settings: { tariff_model: 'saldering', export_price_ratio: 1.0, cycle_cost_per_kwh: 0.075 },
  });
  assert.ok(/exportmarge/.test(reasons[0].text), `got: ${reasons[0].text}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
