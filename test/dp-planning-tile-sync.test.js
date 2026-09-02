'use strict';

// Regression: the planning tile / widget chart must show the DP's own SoC curve.
//
// buildPlanningSchedule() used to discard slot.socProjected and re-simulate the
// whole curve from pvW/consumptionW, writing the simulation back under the same
// field name. That is a second implementation of a quantity the DP already
// computes (optimization-engine.js:437-444 charges socG by pvCoverage[t] *
// slotDeltaG on preserve slots), fed from a different PV array, and it feeds
// back into the mapper's SoC gates — so a small drift amplified. Measured
// 2026-07-30: DP max 100%, tile 44%.
//
// Contract now: where the planning mapper follows the DP action, the DP curve is
// passed through verbatim. Only where the mapper overrides the DP action (no DP
// delta exists for what the mapper decided) does the re-simulation still apply,
// and that slot is flagged.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

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

const homey = { log() {} };
const SETTINGS = {
  tariff_type: 'dynamic',
  battery_efficiency: 0.7415781214938163,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  respect_minmax: true,
  policy_mode: 'balanced',
};

const makeEngine = () => new PolicyEngine(homey, { ...SETTINGS });

const CAP_KWH  = 5.376;
const CHARGE_W = 1600;

console.log('\nPlanning tile — DP socProjected passthrough\n');

test('mapper follows DP → tile curve equals DP curve verbatim', () => {
  const engine = makeEngine();
  // 12:00 Amsterdam (CEST) so _getPvWForTimestamp stays inside its daylight window.
  const start = new Date('2026-05-12T10:00:00.000Z');
  const hour  = 3_600_000;

  // Realistic DP output: preserve slots on strong PV, where the DP has ALREADY
  // advanced socG itself. The old re-sim recomputed +29.8pp/slot from pvW and
  // produced 10 → 39.8 → 69.5 instead.
  const dpCurve = [10, 30, 50];
  const slots = dpCurve.map((soc, i) => ({
    timestamp: new Date(start.getTime() + i * hour).toISOString(),
    action: 'preserve',
    price: 0.21,
    socProjected: soc,
    consumptionW: 0,
  }));
  const pvForecast = slots.map(s => ({ timestamp: s.timestamp, pvPowerW: CHARGE_W }));

  const schedule = engine.buildPlanningSchedule(
    slots, pvForecast, null, CHARGE_W, 0.175, CAP_KWH
  );

  // Guard the premise: this only tests passthrough if the mapper really agreed.
  schedule.forEach((s, i) => {
    assert.strictEqual(s.hwMode, 'zero_charge_only',
      `slot ${i}: expected mapper to follow the DP (zero_charge_only), got ${s.hwMode} (${s.reason})`);
    assert.strictEqual(s.socOverride, false,
      `slot ${i}: mapper agreed with the DP, so this slot must not be flagged as an override`);
  });

  assert.deepStrictEqual(schedule.map(s => s.socProjected), dpCurve,
    `tile curve must equal the DP curve, got ${JSON.stringify(schedule.map(s => s.socProjected))}`);
});

test('mapper overrides DP (low-SoC grid top-up) → re-sim delta applies and slot is flagged', () => {
  const engine = makeEngine();
  // 03:00 Amsterdam — no PV, so the top-up branch is reachable.
  const start = new Date('2026-05-12T01:00:00.000Z');
  const hour  = 3_600_000;

  // DP says standby (pvExportWins) and projects a flat SoC, but flags the slot as a forced
  // top-up. The mapper follows that flag and grid-charges, so there is no DP delta describing
  // the energy it moves. (topupForced is the DP's own decision — the mapper stopped
  // re-deriving it 2026-09-02, see test/planning-topup-dp-source.test.js.)
  const slots = [0, 1].map(i => ({
    timestamp: new Date(start.getTime() + i * hour).toISOString(),
    action: 'standby',
    price: 0.10,
    socProjected: 10,
    consumptionW: 0,
    topupForced: true,
  }));

  const schedule = engine.buildPlanningSchedule(
    slots, null, null, CHARGE_W, 0.175, CAP_KWH
  );

  assert.strictEqual(schedule[0].hwMode, 'to_full',
    `expected low-SoC top-up override, got ${schedule[0].hwMode} (${schedule[0].reason})`);
  assert.strictEqual(schedule[0].socOverride, true,
    'a mapper override must be flagged so the divergence can be counted');

  // 1600W over 1h on 5.376kWh = +29.8pp. The flat DP value (10) must NOT win here.
  assert.ok(schedule[1].socProjected > 39 && schedule[1].socProjected < 41,
    `expected re-sim ~39.8% on the override slot, got ${schedule[1].socProjected}%`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
