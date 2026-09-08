'use strict';

// Regression: the overnight refill-reserve waives its floor on any slot whose own price beats
// the best price after the last strong-PV slot (optimization-engine.js:1382-1392, comment
// :1378-1381 — "otherwise the reserve sacrifices the horizon's most expensive slot ... to insure
// a cheaper one"). The post-DP reorder then puts that floor back: effFloorG takes
// Math.max(reserveFloorG[t], dpEndTargetG), and dpEndTargetG inherits the floor of the LAST slot
// in the window — a morning slot that is floored. Every waived evening slot therefore gets the
// morning floor as its budget bottom.
//
// Live 2026-09-08, plan of 20:15 (18:15:05.687Z): `flatten-gate ... floor0=0%` (the per-slot floor
// on t=0 was waived) but `reorder win=[0..50) startSoC=29% floor0=21% ... trace=0@€0.454✓ 1@€0.44✓`
// — 29% − 21% = 8pp ≈ 0.21 kWh ≈ exactly the two slots that fired. €0.428, €0.416 and €0.399 then
// stood still while the peak they were being saved for was €0.385.
//
// Scenario: five evening slots priced ABOVE tomorrow's evening peak, a floored night/morning
// stretch, strong PV at midday and the €0.385 peak after it.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

const RTE = 0.7315;
const CYCLE = 0.075;
const CAP_KWH = 2.688;
const CONS_W = 200;      // → 0.2 kWh per hourly slot ≈ 7.44 pp of SoC
const START_SOC = 35;    // 35 − 21 = 14 pp of budget under the floor ≈ 2 slots (the live shape)

// t0..t4  evening, every price above the €0.385 released peak → floor waived per-slot
// t5..t11 night, cheap
// t12..t14 morning, at/under the released peak and with strong PV ahead → floored
// t15..t19 strong PV (the refill the reserve insures)
// t20..t23 tomorrow evening — t20 = €0.385 is the released peak
const PRICES = [
  0.454, 0.440, 0.428, 0.416, 0.399,
  0.300, 0.300, 0.300, 0.300, 0.300, 0.300, 0.300,
  0.360, 0.370, 0.370,
  0.200, 0.200, 0.200, 0.200, 0.200,
  0.385, 0.380, 0.375, 0.370,
];
const PV_W = PRICES.map((_, h) => (h >= 15 && h <= 19 ? 1000 : 0)); // cov = (1000−200)/800 = 1.0

const EVENING = [0, 1, 2, 3, 4];

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function run({ waiver, refillConfidence = 0.58 }) {
  const oe = new OE({
    battery_efficiency: RTE, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering',
    dp_reserve_waiver_reorder: waiver,
  });
  const base = Date.now();
  const prices = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = prices.map(() => CONS_W);
  oe.compute(prices, START_SOC, CAP_KWH, 800, 800, pvF, RTE, cons, 0, 1.0, 0, 0, 1.0,
    refillConfidence, false, 0);
  return oe._schedule.slots;
}

const dischargedEvening = (slots) => EVENING.filter(t => slots[t].action === 'discharge');

test('reserve is active: the floor sits at 21% of the usable span', () => {
  const slots = run({ waiver: false });
  assert.ok(slots.length >= 20, `expected the full horizon, got ${slots.length} slots`);
  // (1 − 0.58) × 0.5 × 100 pp = 21 pp — the level the live run logged.
  const nightMin = Math.min(...slots.slice(5, 15).map(s => s.socProjected));
  assert.ok(nightMin >= 20.5,
    `the reserve must hold the night above 21%, got ${nightMin.toFixed(1)}%`);
});

test('waiver OFF reproduces the bug: the window floor cuts the waived slots off', () => {
  const slots = run({ waiver: false });
  const fired = dischargedEvening(slots);
  assert.ok(fired.length <= 2,
    `expected the budget to run out after ~2 slots, got ${fired.length} (${fired.join(',')})`);
  const idle = EVENING.filter(t => !fired.includes(t));
  assert.ok(idle.length > 0, 'the bug needs at least one idle evening slot');
  // The idle slots are all dearer than the €0.385 peak the reserve is insuring — the exact
  // trade the waiver at :1389 exists to prevent.
  for (const t of idle) {
    assert.ok(PRICES[t] > 0.385,
      `slot ${t} (€${PRICES[t]}) should be above the released peak`);
  }
});

test('waiver ON: every evening slot above the released peak discharges', () => {
  const slots = run({ waiver: true });
  const fired = dischargedEvening(slots);
  assert.strictEqual(fired.length, EVENING.length,
    `all ${EVENING.length} slots above the released peak must fire, got ${fired.join(',')}`);
  const socAfter = slots[5].socProjected;
  assert.ok(socAfter < 20.5,
    `the waived slots must be free to drain through the 21% level, ended at ${socAfter.toFixed(1)}%`);
});

test('waiver ON does not touch the floored slots: the morning still holds its reserve', () => {
  // Same day, but the evening is CHEAPER than the released peak → nothing is waived and the
  // reserve must behave exactly as before.
  const cheapEvening = PRICES.slice();
  for (const t of EVENING) cheapEvening[t] = 0.330;
  const runCheap = (waiver) => {
    const oe = new OE({
      battery_efficiency: RTE, min_soc: 0, max_soc: 100,
      cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering',
      dp_reserve_waiver_reorder: waiver,
    });
    const base = Date.now();
    const prices = cheapEvening.map((price, h) => ({
      timestamp: new Date(base + h * 3600e3).toISOString(), price,
    }));
    const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
    oe.compute(prices, START_SOC, CAP_KWH, 800, 800, pvF, RTE, prices.map(() => CONS_W),
      0, 1.0, 0, 0, 1.0, 0.58, false, 0);
    return oe._schedule.slots.map(s => s.action).join(',');
  };
  assert.strictEqual(runCheap(true), runCheap(false),
    'with nothing waived the plan must be identical with and without the flag');
});

test('reserve inactive (confidence 1.0): flag makes no difference', () => {
  const on = run({ waiver: true, refillConfidence: 1.0 }).map(s => s.action).join(',');
  const off = run({ waiver: false, refillConfidence: 1.0 }).map(s => s.action).join(',');
  assert.strictEqual(on, off, 'without a reserve floor the flag must be a no-op');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
