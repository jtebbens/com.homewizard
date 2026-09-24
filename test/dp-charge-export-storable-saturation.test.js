'use strict';

// Regression: the charge-export gate cancelled a charge on the promise that PV ahead would fill
// the pack anyway — counting PV the plan itself never stores.
//
// The forward pass prices a kWh stored now at the best price the pack can still serve before
// "free PV ahead" fills the remaining room (reachPrice). That fill test summed ALL PV ahead
// (pvKwhFromT), including weak slots below pvStrongCoverage. The preserve branch only stores
// PV at or above that threshold, so the weak kWh never enter the cell: the saturation is a
// promise the plan does not keep. storablePrefix exists for exactly this reason (flatten fix
// 2026-08-19) but the saturation scan did not use it.
//
// Live 2026-09-24 18:30Z plan (diag at 19:02 Ams), shape reproduced from the 19:30Z
// dp_input_dump with PV x0.97:
//   14:45  charge   €0.205  SoC 81%
//   15:00  standby  €0.185  SoC 89%  cov 0.51  store €0.138 < export €0.185 → charge cancelled
//   15:15  charge   €0.220  SoC 89%  cov 0.39  store €0.293 → grid charge at a HIGHER price
// Room at 15:00 is 0.301 kWh. All PV from 15:15 reaches that by 16:15 (reachPrice €0.292 →
// store €0.138). Storable PV from 15:15 is only 0.117 kWh (one strong slot, 15:45): the pack
// never fills from PV, so the store is worth the uncapped peak (€0.293) and the charge stands.

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

// Live device settings at the time of the dump (saldering, flags at their defaults).
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
  const at = (hhmm) => slots.find(s => AMS(s.timestamp) === `25, ${hhmm}`);
  return { at };
}

console.log('dp-charge-export-storable-saturation');
const { at } = run();

test('fixture reproduces the shape: 15:00 cheaper than 15:15, both carry PV', () => {
  assert.ok(at('15:00').price < at('15:15').price);
  assert.ok(at('15:00').pvCoverage > 0 && at('15:15').pvCoverage > 0);
});

test('a grid charge at 15:15 does not coexist with a cancelled charge at the cheaper 15:00', () => {
  const cancelled = at('15:00').action === 'standby' && at('15:00').actionSrc === 'X';
  assert.ok(!(cancelled && at('15:15').action === 'charge'),
    `15:00 ${at('15:00').action}/${at('15:00').actionSrc} store €${at('15:00').pvStoreValue?.toFixed(3)}, `
    + `15:15 ${at('15:15').action}`);
});

test('store value at 15:00 is not capped by weak PV the plan never stores', () => {
  // Uncapped peak value, the same figure 14:45 and 15:15 carry.
  assert.ok(at('15:00').pvStoreValue > at('15:00').price,
    `store €${at('15:00').pvStoreValue?.toFixed(3)} vs price €${at('15:00').price.toFixed(3)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
