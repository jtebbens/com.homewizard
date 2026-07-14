'use strict';

// Segment-level RTE bucketing.
//
// The old RTE-by-power buckets used a whole-session AVERAGE power per cycle, so a short
// high-power discharge burst (a ~800W house/oven spike at the inverter ceiling) inside an
// otherwise-gentle multi-hour discharge averaged into the `mid` bucket and never surfaced
// as `high`. This pins the replacement: `update()` accumulates a per-cycle ENERGY histogram
// by instantaneous power (low<300W / mid 300–600W / high>600W), stored on the completed
// cycle as chargeKwhByBucket / dischargeKwhByBucket, and getEfficiencyInsights() groups
// *cycles* by their high-power energy fraction into a burst-vs-gentle composition metric.
// See project_battery_rte_power_season.

const assert = require('assert');
const EfficiencyEstimator = require('../lib/efficiency-estimator');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEstimator() {
  const store = {};
  const homey = {
    settings: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    log: () => {},
  };
  return new EfficiencyEstimator(homey);
}

// Feed one poll with controlled dt by rewinding lastTimestamp before the call.
function poll(est, powerW, dtH) {
  est.state.lastTimestamp = Date.now() - dtH * 3600000;
  est.update({}, { battery_power: powerW, stateOfCharge: 50 }, 'zero_charge_only');
}

// A charge session (3×700W = high charge, 0.525 kWh) followed by a discharge session.
// gentle: 7×250W@0.25h = 0.4375 kWh, RTE 0.833, all low bucket.
// burst:  4×250W@0.25h (0.25) + 1×800W@0.25h (0.2) = 0.45 kWh, RTE 0.857, high frac 0.44.
function chargeSession(est) {
  for (let i = 0; i < 3; i++) poll(est, 700, 0.25);
}
function gentleDischarge(est) {
  for (let i = 0; i < 7; i++) poll(est, -250, 0.25);
}
function burstDischarge(est) {
  for (let i = 0; i < 4; i++) poll(est, -250, 0.25);
  poll(est, -800, 0.25);
}

// Build 8 completed cycles: 4 gentle, 4 burst. A cycle completes on the discharge→charge
// transition, so the NEXT charge session closes the previous cycle; a trailing charge poll
// closes the last one.
function buildCycles(est) {
  const kinds = ['g', 'g', 'g', 'g', 'b', 'b', 'b', 'b'];
  for (const k of kinds) {
    chargeSession(est);
    if (k === 'g') gentleDischarge(est); else burstDischarge(est);
  }
  poll(est, 700, 0.25); // close the final cycle
}

test('completed cycles carry a per-bucket energy histogram', () => {
  const est = makeEstimator();
  buildCycles(est);
  assert.strictEqual(est.state.cycles.length, 8, `got ${est.state.cycles.length} cycles`);
  for (const c of est.state.cycles) {
    assert.ok(c.dischargeKwhByBucket, 'cycle missing dischargeKwhByBucket');
    assert.ok(c.chargeKwhByBucket, 'cycle missing chargeKwhByBucket');
  }
});

test('burst discharge lands energy in the high bucket, gentle does not', () => {
  const est = makeEstimator();
  buildCycles(est);
  const burst = est.state.cycles.filter(c => (c.dischargeKwhByBucket.high || 0) > 0);
  const gentle = est.state.cycles.filter(c => (c.dischargeKwhByBucket.high || 0) === 0);
  assert.strictEqual(burst.length, 4, `burst cycles ${burst.length}`);
  assert.strictEqual(gentle.length, 4, `gentle cycles ${gentle.length}`);
});

test('charge energy (all 700W) lands in the high charge bucket', () => {
  const est = makeEstimator();
  buildCycles(est);
  for (const c of est.state.cycles) {
    assert.ok((c.chargeKwhByBucket.high || 0) > 0, 'charge high bucket empty');
    assert.strictEqual(c.chargeKwhByBucket.low || 0, 0, 'unexpected low charge energy');
  }
});

test('getEfficiencyInsights splits cycles into burst vs gentle composition', () => {
  const est = makeEstimator();
  buildCycles(est);
  const ins = est.getEfficiencyInsights();
  assert.ok(ins, 'insights null (need ≥5 cycles)');
  const d = ins.rteByDischargeComposition;
  assert.ok(d, 'rteByDischargeComposition missing');
  assert.strictEqual(d.burst.n, 4, `burst n=${d.burst && d.burst.n}`);
  assert.strictEqual(d.gentle.n, 4, `gentle n=${d.gentle && d.gentle.n}`);
  // All charge was 700W → every cycle is a charge "burst".
  assert.strictEqual(ins.rteByChargeComposition.burst.n, 8, 'charge burst n');
});

test('old cycles without a histogram are skipped, not crashed', () => {
  const est = makeEstimator();
  buildCycles(est);
  // Simulate a legacy cycle stored before this feature existed.
  est.state.cycles.push({ rte: 0.75, avgChargePower: 700, avgDischargePower: 400, month: 7 });
  const ins = est.getEfficiencyInsights();
  assert.ok(ins, 'insights null');
  // Composition still counts only the 8 histogram-bearing cycles.
  assert.strictEqual(ins.rteByDischargeComposition.burst.n + ins.rteByDischargeComposition.gentle.n, 8);
});

console.log(`\nrte-segment-bucketing: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
