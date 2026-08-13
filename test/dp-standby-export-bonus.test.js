'use strict';

// Regression: the standby branch must not out-value discharge by booking PV export
// revenue that discharging does not forgo.
//
// Live bug (2026-08-13 04:45 UTC / 06:45 Amsterdam): battery sat at 2% SoC with price
// €0.345 (well above min_discharge_price €0.22) and stopped discharging. The DP returned
// standby, and policy-engine logged "Standby: pvExportWins — export more profitable than
// storing, no override".
//
// Cause: vStandby added `pvCoverage[t] * effKwhFull * exportVal` on top of dp[socG], while
// vDischarge carries no PV export term at all. Physically the two are not exclusive —
// hwMode zero_discharge_only discharges the battery into the house load WHILE PV exports
// the surplus independently (see policy-engine.js _mapPolicyToHwMode, discharge branch).
// So the export revenue is common to both actions and must cancel, not tip the scale.
//
// At low SoC the discharge margin is small (little energy left to sell), so the spurious
// bonus flips the decision — 18 live fires between 2026-07-17 and 2026-08-13 had live
// PV=false, of which 11x soc=0%, 5x soc=2%, 3x soc=3%.

const assert = require('assert');
const OE = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// The slot must sit in the narrow band where BOTH options are physically real:
//   consumptionW < pvForecastW < consumptionW * consumptionMargin
// Below that band pvCoverage is 0 and standby cannot fire; above it the zero-on-the-meter
// discharge cap (effectiveDischargePowerW = max(0, cons*margin - pv)) is 0 and discharge
// does not exist. Only inside the band do standby and discharge actually compete — which is
// exactly the regime the live miss happened in (consumptionMargin ran 1.141–1.35).
function run() {
  const oe = new OE({ battery_efficiency: 0.732, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 });
  // Anchored to now: slot 0 is otherwise treated as a spent partial slot
  // (slot0RemainingFrac clamps to 0.01) and every t0 action becomes negligible.
  const base = Date.now();
  const mk = (h, price) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), price });
  // t0/t1: PV just above load, still inside the discharge band. Price already above
  // min_discharge_price. t2..t4 strong PV refills the battery for free. t6 evening peak.
  const prices = [mk(0, 0.345), mk(1, 0.352), mk(2, 0.30), mk(3, 0.28),
    mk(4, 0.29), mk(5, 0.35), mk(6, 0.721), mk(7, 0.30)];
  const cons = [1000, 1000, 300, 300, 300, 400, 500, 400];
  const pv   = [1100, 1150, 2600, 2900, 2900, 1200, 0, 0];
  const pvF = pv.map((w, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: w }));
  // soc=2%, 2.69 kWh, 800W both ways, min_discharge_price €0.22, consumptionMargin 1.2
  oe.compute(prices, 2, 2.69, 800, 800, pvF, 0.732, cons, 0.22, 1.2, 7.1, 7.1, 1.0, 1.0);
  return oe;
}

console.log('\nOptimizationEngine — standby must not win on a PV export bonus discharge also earns\n');

test('PV surplus at 2% SoC does not flip discharge to standby', () => {
  const oe = run();
  const t0 = oe._schedule.slots[0];
  const fd = oe._flattenDebug;

  // Preconditions reproducing the live trap.
  assert.ok(t0.pvCoverage > 0,
    `precondition: PV surplus present so standby is reachable, got cov=${t0.pvCoverage}`);
  assert.ok(t0.price >= 0.22,
    `precondition: price at/above min_discharge_price, got €${t0.price}`);
  assert.ok(fd.vDischarge != null,
    'precondition: inside the band, so discharge is a real option (zero-on-meter cap > 0)');
  // Discharge already out-values holding on its own merits — only the export bonus beat it.
  assert.ok(fd.vDischarge > fd.vPreserve,
    `precondition: discharge beats preserve on value, got vDischarge=${fd.vDischarge} vPreserve=${fd.vPreserve}`);

  // THE BUG: standby books PV export revenue that discharging does not give up.
  assert.strictEqual(t0.pvExportWins, false,
    `Expected NOT pvExportWins at 2% SoC with price €${t0.price} — discharging keeps exporting the same PV`);
  assert.strictEqual(t0.action, 'discharge',
    `Expected the battery to keep discharging, got action=${t0.action} → drained battery idles at 2%`);
});

test('negative-price slots keep their idle option (standby unaffected by the fix)', () => {
  const oe = new OE({ battery_efficiency: 0.732, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 });
  const base = new Date('2026-08-13T10:00:00.000Z').getTime();
  const mk = (h, price) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), price });
  // Midday PV surplus at negative prices: the DP must not be forced to charge here — it
  // should stay idle and save room for the deeper negative slot at t2.
  const prices = [mk(0, -0.05), mk(1, -0.02), mk(2, -0.12), mk(3, 0.30), mk(4, 0.45)];
  const pv   = [2600, 2600, 2600, 800, 0];
  const cons = [300, 300, 300, 400, 500];
  const pvF = pv.map((w, h) => ({ timestamp: new Date(base + h * 3600e3).toISOString(), pvPowerW: w }));
  oe.compute(prices, 50, 2.69, 800, 800, pvF, 0.732, cons, 0.22, 1.0, 7.1, 7.1, 1.0, 1.0);
  const slots = oe._schedule.slots;

  // Standby is guarded by `price > 0`, so it is never selected at a negative price —
  // the idle option there comes from preserve (pvSocGainG suppressed). Both before and
  // after the fix. This pins that the fix did not move negative-price behaviour.
  for (let t = 0; t < 3; t++) {
    assert.notStrictEqual(slots[t].action, 'standby',
      `slot ${t} (€${slots[t].price}) must not be standby at a negative price, got ${slots[t].action}`);
    assert.strictEqual(slots[t].pvExportWins, false,
      `slot ${t} (€${slots[t].price}) must not be flagged pvExportWins at a negative price`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
