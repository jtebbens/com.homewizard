'use strict';

// Regression: battery discharge must never be valued at exportVal, in any tariff model.
//
// P1 firmware enforces "nul op de meter" — the battery never actively exports to the
// grid; export is exclusively PV surplus. The discharge branch under asymmetric_2027
// used to split kwh into coveredKwh (local offset, priced at `price`) and exportKwh
// (kwh above the *raw* consumption forecast, priced at `exportVal`). That split used a
// different consumption basis than the discharge cap itself (effectiveDischargePowerW,
// optimization-engine.js:925-933, which inflates consumption by consumptionMargin before
// capping discharge power) — so the "export" slice was always fictitious: either it's
// real consumption the margin correctly anticipated (belongs in coveredKwh), or it
// exceeds even that and the firmware clips the physical discharge in real time (no
// energy ever leaves the house). Either way `exportVal` is never the right price.
//
// Scenario: attractive price (€0.40) with a deeply negative exportPrice (penalty
// tariff regime) and a consumption forecast comfortably below the margin-inflated
// discharge cap — precisely the band where exportKwh > 0 used to fire. With the bug,
// dischargeValue is dragged toward (or below) zero by the negative exportVal term,
// suppressing discharge despite the high price. Fixed, dischargeValue = price * kwh *
// RTE and the battery discharges normally.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function run() {
  const oe = new OE({ battery_efficiency: 0.9, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.0, tariff_model: 'asymmetric_2027' });
  const base = Date.now();
  const mk = (h, price, exportPrice) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price, exportPrice,
  });
  // t0: attractive price, deeply negative export price (post-2027 penalty regime).
  // t1..t5: flat, unattractive — nothing else should pull the DP away from t0 discharge.
  const prices = [mk(0, 0.40, -0.50), mk(1, 0.10, -0.50), mk(2, 0.10, -0.50),
    mk(3, 0.10, -0.50), mk(4, 0.10, -0.50), mk(5, 0.10, -0.50)];
  // Low consumption forecast, no PV — well below the margin-inflated discharge cap
  // (consumptionMargin 2.0 -> cap = 200W*2.0 = 400W, raw consumption = 200W).
  const cons = [200, 200, 200, 200, 200, 200];
  const pvF = cons.map((_, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: 0 }));
  // soc=60%, 5 kWh capacity, 800W both ways, min_discharge_price 0, consumptionMargin 2.0.
  oe.compute(prices, 60, 5.0, 800, 800, pvF, null, cons, 0, 2.0, 0, 0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

test('discharge at attractive price is not suppressed by negative exportVal on the margin slice', () => {
  const slots = run();
  assert.strictEqual(slots[0].action, 'discharge',
    `slot0 should discharge at price 0.40, got ${slots[0].action}`);
  assert.ok(slots[0].actionKwh > 0,
    `slot0 actionKwh should be positive, got ${slots[0].actionKwh}`);
  // socProjected[t] is the SoC entering slot t; slot0's discharge shows up in slot1.
  assert.ok(slots[1].socProjected < 60,
    `slot1 socProjected should drop below the 60% start after slot0 discharges, got ${slots[1].socProjected}`);
});

console.log(`\ndp-asymmetric-discharge-no-phantom-export: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
