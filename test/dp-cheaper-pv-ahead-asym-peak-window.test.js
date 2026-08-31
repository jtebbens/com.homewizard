'use strict';

// Regression: cheaperPvAhead deferred storing across the evening peak.
//
// The gate defers storing PV when a meaningfully cheaper pvStrong slot follows, so the pack fills
// from the PV whose forgone export costs least. That trade only exists while the two PV slots
// compete for the SAME room in the pack. Once the evening peak sits between them the pack
// discharges in between and has room for both — deferring then buys nothing and hands the
// afternoon surplus to the grid at the export price.
//
// Two defects, both invisible under saldering:
//   1. Currency — the gate compares IMPORT prices. What storing costs is the forgone EXPORT
//      revenue. Under saldering those are the same number. Fixing only this is NOT enough: the
//      next day's export is so cheap that the deferral still wins (measured 2026-08-24:
//      net gain now EUR0.115 vs next-day EUR0.189).
//   2. Window — the gate scans the whole horizon, so it defers to a PV slot on the far side of
//      tonight's peak.
//
// Live 2026-08-24 14:00:04Z, replayed from the real compute() arrays (fixture below):
//   16:00  standby  cov 0.84  price 0.204  export 0.088  storeValue 0.235  cheaperPvAhead=1
//   16:15  standby  cov 0.73  price 0.241  export 0.122  storeValue 0.235  cheaperPvAhead=1
// The candidate it deferred to is the NEXT DAY (EUR0.131 import / EUR0.022 export), on the far
// side of the 19:45 peak (EUR0.424). vStandby beat vPreserve by 0.0002, so the forward-pass
// override was the only thing that could still route the surplus into the pack — and
// cheaperPvAhead blocked it. Meanwhile the plan drains to 6.6% by 22:45 and sits empty all night
// at EUR0.30-0.33, so that surplus WOULD have been used.
//
// The fixture is a stripped copy of the live dp_input_dump (unused fields removed, prices rounded
// to 6 decimals); synthetic price shapes did not reproduce the decision.
//
// Contract under asymmetric_2027: only a pvStrong slot at or before the peak that prices the
// store value may cancel storing, compared in export value, and only while the PV left in that
// window can still fill the remaining room.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const DUMP = require('./fixtures/dp-input-20260824T140004.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Live device settings at the time of the dump.
function run(tariffModel) {
  const eng = new OE({
    battery_efficiency: 0.72,
    cycle_cost_per_kwh: 0.075,
    min_soc: 0,
    max_soc: 100,
    tariff_model: tariffModel,
    export_price_multiplier: 1.1,
    export_price_addon: 0.02,
    dp_flatten_pv_shift: true,
  });
  eng.compute(
    DUMP.prices, DUMP.soc, DUMP.capacityKwh, DUMP.maxChargePowerW, DUMP.maxDischargePowerW,
    DUMP.pvForecast, DUMP.learnedRte, DUMP.consumptionWPerSlot, DUMP.minDischargePrice,
    DUMP.consumptionMargin, DUMP.effectivePvKwhTomorrow, DUMP.adjustedTerminalPvKwh,
    DUMP.pvCloudFactor, DUMP.refillConfidence, false, DUMP.maxChargePrice,
  );
  return eng._schedule.slots;
}

console.log('DP cheaperPvAhead — peak window under asymmetric_2027\n');

test('asymmetric_2027: the PV surplus is stored, not deferred past tonight\'s peak', () => {
  const slots = run('asymmetric_2027');
  const deferred = slots.slice(0, 2).filter((s) => s.action === 'standby' && s.pvExportWins);
  assert.strictEqual(
    deferred.length, 0,
    `slots 16:00/16:15 still export the surplus (actions: ${slots.slice(0, 3).map((s) => s.action).join(',')}) `
    + '— cheaperPvAhead deferred to the next-day PV block on the far side of the 19:45 peak',
  );
  // Asserted on the SoC path, not on pvStoreWins. Since dp_flatten_arb_gate defaults on
  // (2026-08-31) the flag reads false on these two slots while the SoC path is byte-identical
  // to the gate-off run at every slot of the horizon — the surplus still lands in the pack,
  // the override just is not the thing that puts it there. Replaying this fixture both ways
  // scored the gate +EUR0.0415 under asymmetric_2027 and +EUR0.0676 under saldering
  // (scratchpad/arb-gate-0824-testconfig.js, SoC-path accounting with residual priced).
  assert.ok(
    !slots[0].pvExportWins && !slots[1].pvExportWins,
    `neither slot may route the surplus to the grid, got pvExportWins=`
    + `${slots[0].pvExportWins}/${slots[1].pvExportWins}`,
  );
  assert.ok(
    slots[3].socProjected >= 99,
    `the surplus must fill the pack over the PV block, got ${slots[3].socProjected.toFixed(1)}% at 16:45`,
  );
});

test('asymmetric_2027: the deferral itself survives — the gate is not simply disabled', () => {
  const slots = run('asymmetric_2027');
  // Next-day PV block (index 96+) is EUR0.022 export against EUR0.159 in the block before it;
  // no peak separates those, so waiting there is still the right call and the flag must stay set
  // somewhere in the horizon.
  assert.ok(
    slots.some((s) => s.cheaperPvAhead),
    'no slot carries cheaperPvAhead any more — the gate was disabled instead of scoped',
  );
});

test('saldering: standby on the surplus slots, no export detour', () => {
  const slots = run('saldering');
  // 16:00 moved standby → preserve when dp_flatten_arb_gate became the default (2026-08-31):
  // the evening peak keeps a real SoC gradient, so holding beats idling. The replay prices that
  // move at +EUR0.0676 on this fixture — the extra 0.1pp is discharged overnight, not exported,
  // and both branches reach the floor at 06:45 (scratchpad/arb-gate-0824-testconfig.js).
  assert.deepStrictEqual(
    slots.slice(0, 4).map((s) => s.action),
    ['preserve', 'standby', 'standby', 'preserve'],
    'saldering behaviour must not move',
  );
  // 91.0 → 91.1 for the same reason as the action above: the preserve at 16:00 keeps 0.1pp more
  // in the pack, drained again overnight.
  const maxSoc = Math.max(...slots.slice(0, 8).map((s) => s.socProjected));
  assert.ok(
    Math.abs(maxSoc - 91.1) < 0.05,
    `saldering SoC path must not move, peak over the first 8 slots was ${maxSoc.toFixed(1)}%`,
  );
});

console.log(`\ndp-cheaper-pv-ahead-asym-peak-window: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
