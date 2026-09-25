'use strict';

// Regression: the preserve-island pass lifted downstream SoC up to the per-slot reserve floor.
//
// When the island pass turns an isolated preserve into a discharge it subtracts that slot's drain
// from every later slot, clamped at the slot's own reserve floor:
//   socProjected = max(floor[u], socProjected - drop)
// The clamp is meant to LIMIT the drop. But a slot whose projected SoC already sat below its floor
// was RAISED to it — with a zero drop too — while neighbouring slots with a lower floor stayed put.
// The path then showed 18.3 → 48.5 across a standby slot (invariant 33, standby-never-gains-soc),
// a rise nothing in the plan produces.
//
// Input: the shrunk invariant-33 counterexample (seed 12345), which fails on the unfixed engine.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function run() {
  const pv = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 800, 800, 0, 800, 0, 0, 0, 800, 0, 800, 1];
  const pr = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01,
    0.02333575870394152, 0.01505724910013388, 0.01, 0.330065616926842, 0.01, 0.01, 0.01, 0.01, 0.01];
  const start = new Date();
  start.setMinutes(0, 0, 0, 0);
  start.setHours(start.getHours() + 2);
  const prices = pr.map((price, i) => ({ timestamp: new Date(start.getTime() + i * 3_600_000).toISOString(), price }));
  const pvForecast = prices.map((s, i) => ({ timestamp: s.timestamp, pvPowerW: pv[i], spreadFrac: 0 }));
  const eng = new OE({ battery_efficiency: 0.5, min_soc: 0, max_soc: 85, cycle_cost_per_kwh: 0, export_price_ratio: 1 });
  eng.compute(prices, 0, 1, 400, 400, pvForecast, null, Array(24).fill(400), 0, 1.0, 2, 2, 1.0, 0, false, 0);
  return eng._schedule.slots;
}

console.log('DP preserve-island pass — floor clamp never lifts SoC\n');

test('no standby slot gains SoC after the island pass', () => {
  const slots = run();
  assert.ok(slots.some((s) => s.actionSrc === 'I'), 'island pass did not fire — the scenario no longer reaches the bug');
  for (let t = 0; t + 1 < slots.length; t++) {
    if (slots[t].action !== 'standby') continue;
    assert.ok(
      slots[t + 1].socProjected <= slots[t].socProjected,
      `slot ${t} standby at ${slots[t].socProjected.toFixed(1)}% → ${slots[t + 1].socProjected.toFixed(1)}% next slot`,
    );
  }
});

console.log(`\ndp-island-floor-no-lift: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
