'use strict';

// Flatten refill-threshold cliff (project_dp_flatten_refill_threshold_cliff, traced 2026-07-31).
//
// The per-SoC flatten in _runBackwardDP asks a binary question — "can the remaining PV refill
// from this level back to maxSoc?" — and lifts every level that passes to dpMax. Levels just
// below the threshold keep their raw value, so the value function gains a cliff. From an empty
// battery, discharge is floor-blocked and standby needs PV, leaving preserve vs charge: the DP
// buys grid power purely to step over the cliff, at a price where the round trip loses money.
//
// Live instance 2026-07-31 08:45Z: dp[0]=0.6420 vs dp[32..1000]=1.3084 — €0.666 across 0.086 kWh
// (€6.7/kWh) — DP planned charge at €0.2593/kWh while the round trip was worth −€0.059/kWh.
//
// dp_flatten_pv_shift replaces the clamp with a shift: PV lifts every level by the same amount,
// so a level that PV cannot fully refill is worth what the level PV actually reaches is worth.
// Above the old threshold the two are identical; below it the cliff becomes the real gradient.

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

const SETTINGS = {
  battery_efficiency: 0.733,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  tariff_model: 'saldering',
};

const CAP = 2.69;   // kWh, matches the live pack
const POWER = 800;  // W charge and discharge

// Slot 0 starts exactly now so slot0RemainingFrac === 1.0 and the DP models a full-size charge
// step at the decision slot. With a fixed past timestamp the step collapses to 1% of a slot,
// which is too small to cross the threshold — the cliff would not be reachable at all.
const T0 = Date.now();
const H = 3_600_000;

// Slot 0 is the trap: a consumption spike above PV drives pvCoverage to 0 between PV slots,
// which is exactly what opens the flatten gate (needs pvCoverage[0] and [1] below the 400 W
// pvStrong threshold = 0.5 coverage at 800 W charge power).
//   idx 0  pv 250  cons 2119 → coverage 0.000   ← gate opens here, and only here
//   idx 1  pv 400  cons  100 → coverage 0.375
//   idx 2  pv 1000 cons  100 → coverage 1.000   (closes the gate at idx 1)
//   idx 3  pv 1000 cons  100 → coverage 1.000
//   idx 4  pv  500 cons  100 → coverage 0.500   (last PV slot; gate needs PV ahead → closed)
// The flatten counts only PV the preserve branch will actually store (coverage >= 0.5), so
// idx 1 (0.375) contributes nothing. Storable PV from slot 1 = (1 + 1 + 0.5) × 0.8 = 2.0 kWh
// of the 2.69 kWh pack, so PV alone refills any level at or above 25.6% — the cliff sits there,
// and an empty battery is below it. That is the same 2.0 kWh / 25.6% this scenario always used;
// idx 4 was 200 W (coverage 0.125) back when sub-threshold PV was counted too. With it excluded
// the total fell to 1.6 kWh, moving the plateau beyond a single charge step so the cliff stopped
// being reachable at all. Assertions are unchanged — only the PV shape that reaches 2.0 kWh is.
const PV_W   = [250, 400, 1000, 1000, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const CONS_W = [2119, 100, 100, 100, 100, 300, 300, 300, 800, 800, 800, 800, 300, 300];
// Slot 0 at €0.26 is above the round-trip break-even: the best price ahead is €0.376, so
// 0.376 × 0.733 − 0.075 = €0.2006/kWh is the most a stored kWh can be bought for. Charging
// here loses money — only the cliff can make it look profitable.
const PRICE  = [0.26, 0.20, 0.15, 0.15, 0.15, 0.20, 0.20, 0.20, 0.376, 0.376, 0.376, 0.30, 0.30, 0.30];

const prices    = PRICE.map((p, i) => ({ timestamp: new Date(T0 + i * H).toISOString(), price: p }));
const pvForecast = PV_W.map((w, i) => ({ timestamp: new Date(T0 + i * H).toISOString(), pvPowerW: w }));

function run(shiftOn) {
  const eng = new OptimizationEngine({ ...SETTINGS, dp_flatten_pv_shift: shiftOn });
  eng.compute(prices, 0 /* SoC 0% */, CAP, POWER, POWER, pvForecast, 0.733, CONS_W,
    0 /* minDischargePrice */, 1.0 /* consumptionMargin */, 4.0 /* pvKwhTomorrow */,
    4.0 /* terminalPvKwh */, 1.0 /* pvCloudFactor */, 1.0 /* refillConfidence */,
    false /* pvTimingRobust */, 0 /* maxChargePrice → no forced top-up */);
  return { slots: eng._schedule.slots, debug: eng._flattenDebug, schedule: eng._schedule };
}

// Grid kWh bought and battery kWh discharged over the whole plan. pvCoverage is the PV-funded
// fraction of a charge slot, so the grid pays for the rest. netEur nets the whole round trip:
// discharge revenue minus what the grid charge cost minus half-cycle wear on everything moved.
function tally(slots) {
  let gridKwh = 0, gridCost = 0, dischargeKwh = 0, revenue = 0, throughputKwh = 0;
  for (const s of slots) {
    if (s.action === 'charge') {
      const kwh = (s.actionKwh ?? 0) * (1 - (s.pvCoverage ?? 0));
      gridKwh  += kwh;
      gridCost += kwh * s.price;
      throughputKwh += s.actionKwh ?? 0;
    } else if (s.action === 'discharge') {
      dischargeKwh  += s.actionKwh ?? 0;
      revenue       += s.price * (s.actionKwh ?? 0) * SETTINGS.battery_efficiency;
      throughputKwh += s.actionKwh ?? 0;
    }
  }
  const wear = SETTINGS.cycle_cost_per_kwh * 0.5 * throughputKwh;
  return {
    gridKwh, gridCost, dischargeKwh, revenue,
    netEur: revenue - gridCost - wear,
    endSoc: slots[slots.length - 1].socProjected,
  };
}

// ── 1. Reproduction: the cliff makes the DP buy grid power above break-even ──
test('cliff reproduces — flatten clamp makes the DP charge at €0.26 from an empty battery', () => {
  const { slots, debug } = run(false);
  assert.strictEqual(debug.flattenGateOpen, true,
    'flatten gate must be open at slot 0, otherwise the scenario does not exercise the cliff');
  assert.strictEqual(debug.chosenAction, 'charge',
    `expected the DP to pick charge at slot 0, got ${debug.chosenAction} `
    + `(vPreserve=${debug.vPreserve} vCharge=${debug.vCharge})`);
  assert.strictEqual(slots[0].action, 'charge',
    `expected the plan path to charge at slot 0, got ${slots[0].action}`);
  assert.ok(debug.flatMaxCliffEur > 0.20,
    `expected a large manufactured cliff, got €${debug.flatMaxCliffEur}`);
});

// ── 2. Fix: the shift removes the cliff, so the losing purchase disappears ───
test('shift on → no grid charge at slot 0, cliff collapses', () => {
  const { slots, debug } = run(true);
  assert.strictEqual(debug.flattenGateOpen, true,
    'the gate must still open — the fix changes what the flatten writes, not when it fires');
  assert.notStrictEqual(debug.chosenAction, 'charge',
    `expected the DP to stop charging at slot 0, got ${debug.chosenAction} `
    + `(vPreserve=${debug.vPreserve} vCharge=${debug.vCharge})`);
  assert.strictEqual(slots[0].action !== 'charge', true,
    `expected the plan path not to charge at slot 0, got ${slots[0].action}`);
  assert.ok(debug.flatMaxCliffEur < 0.02,
    `expected the cliff to collapse to roughly the real gradient, got €${debug.flatMaxCliffEur}`);
});

// ── 3. Economic dominance: the shift plan is worth more end to end ──────────
// projectedProfit is not comparable across the two branches — the clamp inflates its own
// value function, which is the defect. Compare what the plans physically earn instead.
// Net, not grid spend alone: the clamp buys grid and then delivers that energy too, so a
// bare "spends less" reads as a win when it is only a smaller round trip. Equal delivered
// energy held in this scenario by coincidence and is not a property either branch owes.
test('shift plan is not worse — same end SoC, strictly higher net value', () => {
  const off = tally(run(false).slots);
  const on  = tally(run(true).slots);

  assert.ok(Math.abs(on.endSoc - off.endSoc) <= 1.0,
    `plans must end at the same SoC to be comparable, got ${on.endSoc}% vs ${off.endSoc}%`);
  assert.ok(on.netEur > off.netEur,
    `expected the shift plan to be worth more, got €${on.netEur.toFixed(4)} vs `
    + `€${off.netEur.toFixed(4)} (revenue €${on.revenue.toFixed(4)}/€${off.revenue.toFixed(4)}, `
    + `grid €${on.gridCost.toFixed(4)}/€${off.gridCost.toFixed(4)}, `
    + `discharged ${on.dischargeKwh.toFixed(3)}/${off.dischargeKwh.toFixed(3)} kWh)`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
