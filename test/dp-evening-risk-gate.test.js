'use strict';

// Regression: the evening-coverage safety net must not permanently disable cheaperPvAhead.
//
// cheaperPvAhead defers storing PV when a meaningfully cheaper pvStrong slot follows, so the
// battery fills from the PV whose forgone export costs least. Its safety net is allowed to
// override that when waiting would leave too little energy for the evening:
//
//   eveningCoverageAtRisk = eveningNeedKwh > 0 && (currentKwh + futurePvHeadroomKwh) < eveningNeedKwh
//
// futurePvHeadroomKwh is already a min() against the remaining room, so the left side can never
// exceed usableSpanKwh. With an evening need larger than the battery — routine on a 2.7 kWh pack,
// measured at 2.57-3.25 kWh need vs 2.69 kWh span on 22 of 24 real dp-input dumps — the
// comparison is true at every slot and the deferral never survives (182 of 198 overridden).
//
// Invisible under saldering, where pvStoreBeatsExport blocks first (export == retail, so storing
// rarely beats exporting in the expensive morning). Under asymmetric_2027 export is cheap, that
// first gate opens, and cheaperPvAhead is the only remaining brake — a dead one. The battery then
// fills from expensive-export morning PV instead of the near-worthless midday surplus: same kWh
// stored, ~0.19 EUR/run more forgone export on the 08-07 dumps.
//
// Contract: when later pvStrong slots are cheaper AND carry enough PV to still fill the battery
// before the discharge window, the DP does not store in the expensive early slots.

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

const CAP = 2.688;      // real pack from the dumps
const CHARGE_W = 800;
const RTE = 0.73;

// 05:00 -> next 05:00, hourly. Morning PV is strong but its export is worth 0.18; the midday
// block is just as strong and worth 0.02. Evening has no PV and a load the battery cannot cover
// on its own (7 x 1200 W = 8.4 kWh vs a 2.688 kWh pack) — exactly the shape that pinned the net on.
function buildScenario() {
  const prices = [];
  const pvForecast = [];
  const consumptionWPerSlot = [];
  const t0 = Date.UTC(2026, 7, 8, 3, 0, 0); // 05:00 Europe/Amsterdam

  for (let h = 0; h < 24; h++) {
    const ts = new Date(t0 + h * 3600000).toISOString();
    const hour = 5 + h;
    let retail; let exportPrice; let pvW; let consW;

    if (hour >= 5 && hour < 9) {          // expensive-export morning PV
      retail = 0.32; exportPrice = 0.18; pvW = 2000; consW = 400;
    } else if (hour >= 9 && hour < 16) {  // cheap-export midday PV, same strength
      retail = 0.15; exportPrice = 0.02; pvW = 2500; consW = 400;
    } else if (hour >= 16 && hour < 23) { // evening peak, no PV
      retail = 0.35; exportPrice = 0.20; pvW = 0; consW = 1200;
    } else {                              // night
      retail = 0.25; exportPrice = 0.12; pvW = 0; consW = 400;
    }

    prices.push({ timestamp: ts, price: retail, exportPrice, hoursFromNow: h });
    pvForecast.push({ timestamp: ts, pvPowerW: pvW });
    consumptionWPerSlot.push(consW);
  }
  return { prices, pvForecast, consumptionWPerSlot };
}

function run(tariffModel) {
  const { prices, pvForecast, consumptionWPerSlot } = buildScenario();
  const eng = new OptimizationEngine({
    battery_efficiency: 0.90,
    cycle_cost_per_kwh: 0.075,
    tariff_model: tariffModel,
    min_soc: 0,
    max_soc: 100,
  });
  eng.compute(
    prices, 5, CAP, CHARGE_W, CHARGE_W, pvForecast, RTE, consumptionWPerSlot,
    0.22,   // minDischargePrice — evening qualifies, midday does not
    1.0,    // consumptionMargin
    0, 0, 1, 0.5, false,
    0.05,   // maxChargePrice — no grid charging, this test is about PV routing only
  );
  return eng._schedule.slots;
}

// SoC gained across a slot range, in percent points.
function socGain(slots, from, to, startSoc) {
  const before = from === 0 ? startSoc : slots[from - 1].socProjected;
  return slots[to].socProjected - before;
}

console.log('DP evening-coverage safety net\n');

test('asymmetric_2027: no storing in the expensive-export morning while cheaper PV follows', () => {
  const slots = run('asymmetric_2027');
  const morning = socGain(slots, 0, 3, 5);   // 05:00-08:00, export 0.18
  const midday = socGain(slots, 4, 10, 5);   // 09:00-15:00, export 0.02

  assert.ok(
    morning <= 0.5,
    `stored ${morning.toFixed(1)}%% SoC in the 0.18 EUR/kWh export block while a 0.02 EUR/kWh `
    + 'block follows — eveningCoverageAtRisk fired on a need larger than the pack and killed '
    + 'the cheaperPvAhead deferral',
  );
  assert.ok(
    midday > 20,
    `battery must still fill from the cheap block, gained only ${midday.toFixed(1)}%% there`,
  );
});

test('the deferral still yields when the remaining PV cannot fill the battery', () => {
  // Same shape, but the midday block is gone: nothing cheaper is reachable, so the DP must take
  // the expensive morning PV rather than arrive at the evening peak empty. Guards against
  // "fixed" meaning "gate now never fires".
  const { prices, pvForecast, consumptionWPerSlot } = buildScenario();
  for (let h = 4; h < 11; h++) pvForecast[h].pvPowerW = 0;

  const eng = new OptimizationEngine({
    battery_efficiency: 0.90,
    cycle_cost_per_kwh: 0.075,
    tariff_model: 'asymmetric_2027',
    min_soc: 0,
    max_soc: 100,
  });
  eng.compute(prices, 5, CAP, CHARGE_W, CHARGE_W, pvForecast, RTE, consumptionWPerSlot,
    0.22, 1.0, 0, 0, 1, 0.5, false, 0.05);
  const slots = eng._schedule.slots;

  const morning = socGain(slots, 0, 3, 5);
  assert.ok(morning > 5, `expected the morning PV to be stored when nothing cheaper follows, `
    + `gained ${morning.toFixed(1)}%%`);
});

test('saldering is unaffected', () => {
  const slots = run('saldering');
  assert.ok(slots.length === 24, `expected 24 slots, got ${slots.length}`);
  // Under saldering export == retail, so storing in the 0.32 morning never beats exporting it;
  // the morning stays flat for a different reason than above. Pinned so a future change to the
  // net cannot silently start charging here.
  const morning = socGain(slots, 0, 3, 5);
  assert.ok(morning <= 0.5, `saldering stored ${morning.toFixed(1)}%% in the morning block`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
