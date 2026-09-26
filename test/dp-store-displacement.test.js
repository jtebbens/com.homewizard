'use strict';

// When the PV ahead fills the pack anyway (pvSaturatesAhead) and every slot up to that fill point
// is pvStrong, the reachPrice scan sees no price and left reachPrice at 0: storeValue collapsed to
// −cycleCost, so pvStoreBeatsExport read "export wins" in the cheapest midday hour — preserve
// projected no gain there and a charge was cancelled to standby — while the pack was then filled
// from dearer PV later. Storing a kWh now only changes WHICH strong-PV surplus is exported: it
// frees one kWh of later PV for export. So the store is worth the dearest disposal value among the
// strong slots up to the fill point (dp_store_displacement).
//
// Live 2026-09-20 10:30Z (dump dp-input-20260920T103010.831Z): reachPrice 0, store €-0.075 at a
// €0.128 export → standby. Live 2026-09-26 midday: same shape, sun and clouds at a low price.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Hourly slots, charge rate 800 W. t0..t3: midday, 200 W load, PV 1200 W → pvStrong. From 44%
// SoC the PV of t1+t2 fills the pack. t4..t11: evening, no PV, 500 W load.
const PV_W   = [1200, 1200, 1200, 1200, 0, 0, 0, 0, 0, 0, 0, 0];
const PRICES = [0.17, 0.18, 0.19, 0.20, 0.50, 0.50, 0.45, 0.30, 0.30, 0.30, 0.30, 0.30];

function runEngine(flag) {
  const oe = new OE({
    battery_efficiency: 0.73,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: 0.075,
    tariff_model: 'saldering',
    dp_store_displacement: flag,
  });
  // Fixed clock at the slot-0 boundary (slot0RemainingFrac reads Date.now()).
  const base = Date.UTC(2026, 8, 24, 10);
  const ps = PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = ps.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = ps.map((_, h) => (h < 4 ? 200 : 500));
  const realNow = Date.now;
  Date.now = () => base;
  try {
    oe.compute(ps, 44, 2.688, 800, 800, pvF, 0.73, cons, 0.276, 1.0, 4.0, 4.0, 1.0, 1.0, false, 0);
  } finally {
    Date.now = realNow;
  }
  return oe._schedule.slots;
}

test('flag on: store in the cheapest strong-PV hour is worth the dearest displaced export', () => {
  const s = runEngine(true);
  // Strong slots up to the fill point: t1 €0.18, t2 €0.19 → displacement value €0.19.
  assert.ok(Math.abs(s[0].pvStoreValue - 0.19) < 1e-9,
    `slot 0 pvStoreValue ${s[0].pvStoreValue}, expected 0.19`);
  assert.ok(s[1].socProjected > s[0].socProjected,
    `SoC must rise in the €0.17 hour: ${s[0].socProjected} → ${s[1].socProjected}`);
});

test('flag off: previous value is kept (zeroed reachPrice → −cycleCost)', () => {
  const s = runEngine(false);
  assert.ok(Math.abs(s[0].pvStoreValue - (-0.075)) < 1e-9,
    `slot 0 pvStoreValue ${s[0].pvStoreValue}, expected -0.075`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
