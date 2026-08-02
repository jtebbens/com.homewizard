'use strict';

// The PV-headroom regime gives every price slot its own discharge floor: day floor on PV-strong
// slots, an RTE-spread floor on weak-PV slots, night floor in the dark. That only works when the
// PV lookup actually resolves per slot.
//
// device.js used to call _getPvForSlot(pvForecast, p.timestamp) — the raw forecast (no `.ms`) and
// an ISO string instead of epoch ms. Every comparison in the binary search is `undefined <= "..."`
// = false, so leftIdx stays -1 and the lookup falls back to pvIndex[0].pvPowerW for EVERY slot.
// The whole horizon then lands on one regime, and the array flips wholesale between runs as
// pvForecast[0] crosses 50 W / 400 W at dawn (caught live 2026-08-02: 66 slots at €0 at 07:30,
// 65 slots at €0.22 at 07:45, on byte-identical prices).
//
// Covered here:
//   - the broken call shape returns a constant; the indexed call interpolates
//   - buildPerSlotDischargeFloors produces a genuinely per-slot array over a day/night profile
//   - each regime lands on its intended floor

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

let passed = 0;
const ok = (msg) => { console.log(`  ✓ ${msg}`); passed++; };

const eng = new OptimizationEngine({ battery_efficiency: 0.75, cycle_cost_per_kwh: 0.075 });

// Hourly PV over a summer day, starting 02:00Z: dark → dawn → peak → dusk → dark.
const PV_W = [0, 0, 40, 300, 900, 1800, 2400, 2600, 2400, 1700, 800, 250, 30, 0];
const pvForecast = PV_W.map((w, h) => ({
  timestamp: new Date(Date.UTC(2026, 7, 2, 2 + h)).toISOString(),
  pvPowerW: w
}));

// One price slot per PV hour, so every regime is exercised.
const prices = PV_W.map((_, h) => ({
  timestamp: new Date(Date.UTC(2026, 7, 2, 2 + h)).toISOString(),
  price: 0.30
}));

// --- the broken call shape collapses onto pvForecast[0] -----------------------------------------
{
  const broken = prices.map((p) => eng._getPvForSlot(pvForecast, p.timestamp));
  assert.ok(broken.every((w) => w === pvForecast[0].pvPowerW),
    `raw forecast + ISO string must return pvForecast[0] for every slot, got ${JSON.stringify(broken)}`);
  ok('raw forecast + ISO timestamp returns a constant (the bug)');

  const pvIdx = eng._buildPvIndex(pvForecast);
  const fixed = prices.map((p) => eng._getPvForSlot(pvIdx, new Date(p.timestamp).getTime()));
  assert.deepStrictEqual(fixed, PV_W, 'the indexed call resolves each slot to its own PV hour');
  ok('_buildPvIndex + epoch ms resolves per slot');
}

const OPTS = {
  dayFloor: 0.22,
  nightFloor: 0.00,
  weakPvFloorBase: 0.12,
  pvStrongW: 400,
  atMaxSoc: false,
  effectiveRte: 0.75
};

// --- the floor array is per-slot, not constant ---------------------------------------------------
{
  const floors = eng.buildPerSlotDischargeFloors(prices, pvForecast, OPTS);
  assert.strictEqual(floors.length, prices.length, 'one floor per price slot');
  assert.ok(new Set(floors).size > 1,
    `the floor array must vary across the horizon, got ${JSON.stringify(floors)}`);
  ok('floor array varies across a day/night profile');

  // Dark slots (0 W) → night floor.
  assert.strictEqual(floors[0], 0.00, 'slot at 0 W PV gets the night floor');
  assert.strictEqual(floors[1], 0.00, 'second dark slot gets the night floor');
  // 40 W is below the 50 W weak-PV threshold → still night.
  assert.strictEqual(floors[2], 0.00, '40 W PV is below the weak-PV threshold');
  // 300 W is weak PV (≥50, <400). No slot is priced below dayFloor here, so there is no refill
  // candidate ahead → rteFloor 0 → the base weak-PV floor stands.
  assert.strictEqual(floors[3], 0.12, '300 W PV gets the weak-PV base floor');
  // ≥400 W → day floor.
  assert.strictEqual(floors[4], 0.22, '900 W PV gets the day floor');
  assert.strictEqual(floors[7], 0.22, 'peak PV gets the day floor');
  // Dusk back through weak PV into the dark.
  assert.strictEqual(floors[11], 0.12, '250 W PV back on the weak-PV floor');
  assert.strictEqual(floors[13], 0.00, 'after sunset back on the night floor');
  ok('each PV regime lands on its intended floor');
}

// --- the RTE-spread guard lifts weak-PV slots above the base floor -------------------------------
{
  // A cheap slot late in the horizon (below dayFloor) is a real grid-recharge candidate, so an
  // earlier weak-PV slot may only discharge above refillAhead / rte = 0.18 / 0.75 = 0.24.
  const cheapTail = prices.map((p, i) => ({ ...p, price: i >= 10 ? 0.18 : 0.30 }));
  const floors = eng.buildPerSlotDischargeFloors(cheapTail, pvForecast, OPTS);
  assert.ok(Math.abs(floors[3] - 0.24) < 1e-9,
    `weak-PV slot ahead of a €0.18 refill slot must floor at 0.24, got ${floors[3]}`);
  assert.strictEqual(floors[4], 0.22, 'PV-strong slots keep the day floor regardless of refill');
  ok('RTE-spread guard lifts weak-PV slots ahead of a cheap refill slot');

  // With the cheap slots behind instead of ahead there is no rebuy risk left, so the guard
  // must not fire — a suffix minimum, not a horizon minimum.
  const cheapHead = prices.map((p, i) => ({ ...p, price: i <= 1 ? 0.18 : 0.30 }));
  const headFloors = eng.buildPerSlotDischargeFloors(cheapHead, pvForecast, OPTS);
  assert.strictEqual(headFloors[3], 0.12, 'weak-PV slot with no refill candidate ahead keeps the base floor');
  assert.strictEqual(headFloors[11], 0.12, 'later weak-PV slot likewise keeps the base floor');
  ok('the guard reads the suffix, not the whole horizon');
}

// --- at max_soc the PV opportunity cost disappears ------------------------------------------------
{
  const floors = eng.buildPerSlotDischargeFloors(prices, pvForecast, { ...OPTS, atMaxSoc: true });
  assert.strictEqual(floors[7], 0.12, 'at max_soc a PV-strong slot falls back to the weak-PV floor');
  assert.strictEqual(floors[0], 0.00, 'dark slots are unaffected by max_soc');
  ok('atMaxSoc moves PV-strong slots onto the weak-PV floor');
}

// --- degenerate inputs --------------------------------------------------------------------------
{
  const floors = eng.buildPerSlotDischargeFloors(prices, [], OPTS);
  assert.ok(floors.every((f) => f === 0.00), 'no PV data → night floor everywhere');
  assert.strictEqual(floors.length, prices.length, 'length is preserved without PV data');
  ok('empty pvForecast degrades to the night floor');
}

console.log(`\n${passed} passed`);
