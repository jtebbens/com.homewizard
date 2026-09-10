'use strict';

// Reproduction of the 2026-09-09 morning: the battery sat at 5% SoC while up to 1550 W of PV
// surplus went to the grid, because the price horizon ended at midnight (day-ahead for tomorrow
// had not arrived yet). At 13:37 CEST the horizon jumped 42 -> 138 slots and the DP immediately
// chose to charge.
//
// The two scenarios below differ in ONE thing: how far the price list reaches. Same starting SoC,
// same PV, same consumption, same prices for the overlapping part. If only the horizon length
// decides whether the battery charges, the short-horizon terminal value is what suppresses it.
//
// Expected state BEFORE the fix (this file is the red test):
//   - long horizon  -> charges in the cheap afternoon slots
//   - short horizon -> does not charge
// See docs/optimizer-dp-pipeline.md and lib/optimization-engine.js:1485-1525 (terminal value).

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

const SLOT_H = 0.25; // 15-minute slots, as the live app runs

// ─── Scenario builders ────────────────────────────────────────────────────────

// Start the horizon at a whole hour two hours out, matching the convention in
// test/optimizer-properties.test.js (keeps slot0RemainingFrac = 1.0).
function slotsFrom(prices) {
  const start = new Date();
  start.setMinutes(0, 0, 0, 0);
  start.setHours(start.getHours() + 2);
  return prices.map((price, i) => ({
    timestamp: new Date(start.getTime() + i * SLOT_H * 3_600_000).toISOString(),
    price,
  }));
}

function repeat(value, count) {
  return Array(count).fill(value);
}

// Price shape of 2026-09-09 from 13:30 CEST to midnight, at 15-min resolution (42 slots):
// cheap afternoon around EUR 0.20, rising into an evening peak of EUR 0.385, easing overnight.
const TODAY_TAIL = [
  ...repeat(0.206, 8),   // 13:30-15:30  cheap window, this is where charging should happen
  ...repeat(0.215, 4),   // 15:30-16:30
  ...repeat(0.260, 4),   // 16:30-17:30
  ...repeat(0.310, 4),   // 17:30-18:30
  ...repeat(0.385, 8),   // 18:30-20:30  evening peak actually seen that day
  ...repeat(0.300, 6),   // 20:30-22:00
  ...repeat(0.240, 8),   // 22:00-00:00
];

// Tomorrow, only known after the day-ahead publication: a night trough, a morning peak of
// EUR 0.432 and the big evening peak of EUR 0.863 that the planning actually discharged into.
const TOMORROW = [
  ...repeat(0.190, 24),  // 00:00-06:00 night
  ...repeat(0.300, 8),   // 06:00-08:00
  ...repeat(0.432, 4),   // 08:00-09:00 morning peak
  ...repeat(0.240, 28),  // 09:00-16:00 solar midday
  ...repeat(0.400, 8),   // 16:00-18:00
  ...repeat(0.863, 8),   // 18:00-20:00 evening peak
  ...repeat(0.350, 16),  // 20:00-00:00
];

const SETTINGS = {
  battery_efficiency: 0.7315,   // measured RTE on this pack
  min_soc: 5,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,    // current default
  export_price_ratio: 1.0,
  tariff_model: 'saldering',
};

function buildScenario(prices) {
  const priceSlots = slotsFrom(prices);
  return {
    prices: priceSlots,
    currentSoc: 5,
    capacityKwh: 2.688,
    maxChargeW: 800,
    maxDischargeW: 800,
    // PV surplus over the first ten slots (~2.5 h), like the cloudy-bright afternoon that day.
    pvForecast: priceSlots.map((slot, i) => ({
      timestamp: slot.timestamp,
      pvPowerW: i < 10 ? 1500 : 0,
      spreadFrac: 0,
    })),
    consumptionW: priceSlots.map(() => 450),
    pvKwhTomorrow: 1.9,           // the forecast the app held that morning
    terminalPvKwhTomorrow: 1.9,
  };
}

function run(prices) {
  const eng = new OptimizationEngine(SETTINGS);
  const s = buildScenario(prices);
  eng.compute(
    s.prices, s.currentSoc, s.capacityKwh, s.maxChargeW, s.maxDischargeW,
    s.pvForecast, null, s.consumptionW,
    0,      // minDischargePrice
    1.0,    // consumptionMargin
    s.pvKwhTomorrow, s.terminalPvKwhTomorrow,
    1.0,    // pvCloudFactor
    1.0,    // refillConfidence
    false,  // pvTimingRobust
    0.2415, // maxChargePrice — the ceiling once tomorrow was visible
  );
  return eng;
}

// Count planned charge slots inside the cheap window (the first 12 slots, EUR 0.206-0.215).
function chargeSlotsInCheapWindow(eng) {
  const slots = eng._schedule.slots.slice(0, 12);
  return slots.filter(s => s.action === 'charge').length;
}

function plannedSocGain(eng) {
  const slots = eng._schedule.slots;
  const start = slots[0].socProjected;
  const peak = Math.max(...slots.slice(0, 24).map(s => s.socProjected));
  return peak - start;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

console.log('dp-short-horizon-terminal');

const longEng = run([...TODAY_TAIL, ...TOMORROW]);
const shortEng = run(TODAY_TAIL);

const longCharges = chargeSlotsInCheapWindow(longEng);
const shortCharges = chargeSlotsInCheapWindow(shortEng);
const longGain = plannedSocGain(longEng);
const shortGain = plannedSocGain(shortEng);

console.log(`  long  horizon: ${longEng._schedule.slots.length} slots, `
  + `${longCharges} charge slots in cheap window, planned SoC gain ${longGain.toFixed(1)}pp`);
console.log(`  short horizon: ${shortEng._schedule.slots.length} slots, `
  + `${shortCharges} charge slots in cheap window, planned SoC gain ${shortGain.toFixed(1)}pp`);

// Baseline: with tomorrow visible the DP does use the cheap window.
check('long horizon charges in the cheap window', () => {
  assert.ok(longCharges > 0,
    `expected at least one charge slot with tomorrow visible, got ${longCharges}`);
});

// The regression itself. Truncating the horizon must not remove the charge decision:
// the overlapping slots are identical, so a shorter view of the future may not plan LESS
// stored energy than a longer one.
check('short horizon charges in the cheap window too', () => {
  assert.ok(shortCharges > 0,
    `horizon truncation removed every charge slot: long=${longCharges}, short=${shortCharges}`);
});

check('short horizon plans at least as much SoC gain as long horizon', () => {
  assert.ok(shortGain >= longGain - 1e-6,
    `truncated horizon plans less stored energy: long=${longGain.toFixed(1)}pp, `
    + `short=${shortGain.toFixed(1)}pp`);
});

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
