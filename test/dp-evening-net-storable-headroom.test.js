'use strict';

// Regression: the evening safety net behind cheaperPvAhead counted PV the plan never stores.
//
// cheaperPvAhead defers storing PV now when a meaningfully cheaper pvStrong slot follows. The
// net (eveningCoverageAtRisk) blocks that deferral when the PV still ahead can no longer fill
// the pack. Its headroom term summed ALL PV ahead (pvKwhFromT), including weak slots below
// pvStrongCoverage that the preserve branch never stores — so the pack always looked fillable
// and the net never fired. Same class as the reachPrice saturation scan (0e16ebed) and the
// flatten refill (2026-08-19): storablePrefix is the storable-PV sum.
//
// Fixture 2026-09-24 17:30Z, Friday 25th (PV x0.97, as in the sibling test):
//   12:00  standby  €0.232  cov 1.00  SoC 7%   — deferred to cheaper 13:45 (€0.160)
//   room at 12:00 is ~2.49 kWh; storable PV from 12:15 on is ~2.4 kWh (12 strong slots), the
//   weak afternoon tail pushed the raw sum past the room.
// Storing at 12:00 is what the net is for: the deferral leaves room the PV cannot fill.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const DUMP = require('./fixtures/dp-input-20260924T173007.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const AMS = (ts) => new Date(ts).toLocaleString('nl-NL', {
  timeZone: 'Europe/Amsterdam', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function run() {
  const eng = new OE({
    battery_efficiency: 0.73,
    cycle_cost_per_kwh: 0.075,
    min_soc: 0,
    max_soc: 100,
    tariff_model: 'saldering',
    dp_flatten_pv_shift: true,
    dp_flatten_arb_gate: true,
    dp_weak_pv_tie_standby: false,
  });
  const pv = DUMP.pvForecast.map(p => ({
    ...p,
    pvPowerW: p.pvPowerW * 0.97,
    satPanelW: p.satPanelW == null ? null : p.satPanelW * 0.97,
  }));
  const d = DUMP;
  eng.compute(d.prices, d.soc, d.capacityKwh, d.maxChargePowerW, d.maxDischargePowerW, pv,
    d.learnedRte, d.consumptionWPerSlot, d.minDischargePrice, d.consumptionMargin,
    d.effectivePvKwhTomorrow, d.adjustedTerminalPvKwh, d.pvCloudFactor, d.refillConfidence,
    false, d.maxChargePrice);
  const slots = eng._schedule.slots;
  return (hhmm) => slots.find(s => AMS(s.timestamp) === `25, ${hhmm}`);
}

console.log('dp-evening-net-storable-headroom');
const at = run();

test('fixture shape: 12:00 strong PV, a cheaper strong slot at 13:45', () => {
  assert.ok(at('12:00').pvCoverage >= 0.5 && at('13:45').pvCoverage >= 0.5);
  assert.ok(at('12:00').price > at('13:45').price * 1.30);
});

test('12:00 stores PV: storable PV ahead cannot fill the room a deferral leaves', () => {
  assert.strictEqual(at('12:00').action, 'preserve',
    `12:00 ${at('12:00').action}/${at('12:00').actionSrc} SoC ${at('12:00').socProjected}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
