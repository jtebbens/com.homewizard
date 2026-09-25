'use strict';

// Regression: under saldering cheaperPvAhead deferred storing to TOMORROW's PV while today's PV
// could no longer fill the pack before tonight's peak.
//
// The gate defers storing PV when a meaningfully cheaper pvStrong slot follows. The asymmetric_2027
// branch already asks the honest question "does the PV left before the peak still fill the room
// the deferral leaves open" (deferWindowPvKwh >= roomKwh). The saldering branch never did: it
// scanned the whole horizon for a cheaper slot and deferred on price alone.
//
// Live 2026-09-25 10:15Z (12:15 NL), SoC 0%, ~2.2 kW surplus, price EUR0.207: standby
// (dp:pv_export_wins). The cheaper slot was the NEXT DAY (EUR0.152 at 11:15Z, 0.207 > 1.3x0.152);
// today's 11:45Z EUR0.160 did not qualify (1.3x0.160 = 0.208). Storable PV from 10:30Z up to
// tonight's 17:30Z peak (EUR0.503, the horizon max) was 2.22 kWh against 2.69 kWh of room, so the
// deferral could not be made good today. The pack reached ~75% by 16:00 NL.
// eveningCoverageAtRisk did not catch it: its headroom counts storable PV to the END of the
// horizon, tomorrow's block included.
//
// Fixture: the live 11:16Z dp_input_dump with the four 10:15-11:00Z slots prepended (prices and
// consumption from the [MAPPING] log lines of those runs) and SoC set to 0. The prepended slots are
// reconstructed, not captured — no dump existed for 10:15Z. On this input the backward DP itself
// already picks preserve at slot 0 (live picked standby), so the test pins the gate, not the
// final action.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const DUMP = require('./fixtures/dp-input-20260925T101500.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Live device settings (engine-relevant keys).
function run() {
  const eng = new OE({
    battery_efficiency: 0.73,
    cycle_cost_per_kwh: 0.075,
    min_soc: 0,
    max_soc: 100,
    tariff_model: 'saldering',
    export_price_multiplier: 1.1,
    export_price_addon: 0.02,
    dp_flatten_pv_shift: true,
    dp_flatten_arb_gate: true,
  });
  eng.compute(
    DUMP.prices, DUMP.soc, DUMP.capacityKwh, DUMP.maxChargePowerW, DUMP.maxDischargePowerW,
    DUMP.pvForecast, DUMP.learnedRte, DUMP.consumptionWPerSlot, DUMP.minDischargePrice,
    DUMP.consumptionMargin, DUMP.effectivePvKwhTomorrow, DUMP.adjustedTerminalPvKwh,
    DUMP.pvCloudFactor, DUMP.refillConfidence, false, DUMP.maxChargePrice,
  );
  return eng._schedule.slots;
}

console.log('DP cheaperPvAhead — fill check under saldering\n');

test('saldering: no deferral when PV before tonight\'s peak cannot fill the room', () => {
  const slots = run();
  assert.strictEqual(
    slots[0].cheaperPvAhead, false,
    'slot 0 (10:15Z, SoC 0) still defers to tomorrow\'s PV although only 2.22 of 2.69 kWh '
    + 'can be stored before the 17:30Z peak',
  );
  // 12:45Z (EUR0.205) defers the same way with 0.22 kWh of storable PV left against 0.90 kWh room.
  assert.strictEqual(slots[10].cheaperPvAhead, false, 'slot 10 (12:45Z) still defers without the PV to back it');
});

// That the gate still defers when the window PV DOES fill the room is pinned by
// dp-cheaper-pv-ahead-window.test.js (saldering). On this fixture no slot qualifies: tomorrow's
// strong PV tops out at 1.99 kWh storable against 2.63 kWh of room.
test('saldering: tomorrow morning does not defer to PV that cannot fill the pack either', () => {
  const slots = run();
  const deferring = slots.slice(85, 93).filter((s) => s.cheaperPvAhead).length;
  assert.strictEqual(deferring, 0, `${deferring} of the 06:30-08:15Z slots tomorrow still defer`);
});

console.log(`\ndp-cheaper-pv-ahead-saldering-fill: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
