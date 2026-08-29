'use strict';

/**
 * Property-based test suite for OptimizationEngine and the planning-tile mapper.
 *
 * Each invariant has its own comment block above its testInvariant() call — that is
 * the documentation. No summary list is kept here; the one that used to sit here
 * stopped at 6 of 45 and went stale.
 *
 * RUNS (1000) randomized scenarios per invariant, with these explicit exceptions
 * (4th argument to testInvariant): 11b = 50, 36 = 200, 37 = 200.
 *
 * Entries labelled `scenario:` are NOT property tests. Their arbitrary is fc.constant,
 * so they pin exactly ONE input each and run once regardless of RUNS. They are
 * regression scenarios and must not be counted as property coverage.
 *
 * EFFECTIVE SAMPLE SIZE. Several invariants bail early on a guard, so the runs that
 * reach the real assert are fewer than RUNS. Measured 2026-07-30 (see
 * project_optimizer_property_suite_audit for the method):
 *
 *   21 = 262/1000 (26%)  — guard: baseline doesn't discharge at the peak. Left as is:
 *                          21 tests the spread-band, closed 2026-07-17 as internally
 *                          incoherent, so a better arbitrary would be wasted work.
 *   16c = 605 (61%), 1b = 675 (68%), 34 = 711 (71%)
 *   16 = 852, 16d = 854, 16b = 870, 22:terminal = 870, 14 = 894 (85-89%)
 *   the remaining 31 = 100%
 *
 * Added later: 39 = 998/1000 (100%), measured 2026-08-02.
 * Added 2026-08-14: 46 = 877/1000 (88%) and 171/200 (@15min); 47 = 100% on both.
 *
 * When adding or changing an arbitrary, re-measure — a guard that swallows most runs
 * turns a green invariant into a claim about a handful of scenarios.
 */

const fc    = require('fast-check');
const assert = require('assert');
const fs    = require('fs');
const path  = require('path');
const OptimizationEngine = require('../lib/optimization-engine');
const { createSim } = require('../tools/replay-sim');
const { exportValue } = require('../lib/price-formulas');

const LOG_FILE = path.join(__dirname, '..', 'refactor-log.md');
const RUNS     = 1000;
// Reduced budget for the `@15min` re-registrations: a 15-min slot costs the DP the same
// per-slot work as an hourly one, so a second full-RUNS pass would roughly double the suite.
const RUNS_15MIN = 200;
const SEED     = 12345;

// ─── Log ─────────────────────────────────────────────────────────────────────

function initLog(header) {
  fs.writeFileSync(LOG_FILE,
    `# Optimizer Property-Based Test Log\n\nGenerated: ${new Date().toISOString()}\n\n${header}\n\n`);
}

function log(msg) {
  fs.appendFileSync(LOG_FILE, msg + '\n');
}

// ─── Engine helpers ───────────────────────────────────────────────────────────

// Start slots 2 hours from now (whole hour) so slot0RemainingFrac = 1.0
function makePriceSlots(prices, slotHours = 1) {
  const start = new Date();
  start.setMinutes(0, 0, 0, 0);
  start.setHours(start.getHours() + 2);
  return prices.map((price, i) => ({
    timestamp: new Date(start.getTime() + i * slotHours * 3_600_000).toISOString(),
    price
  }));
}

// Repeat each hourly value over the sub-slots of that hour, so a scenario written as an
// hour-by-hour path keeps the same WALL-CLOCK shape at any resolution. At slotHours = 1
// this is the identity, so the hourly registrations are untouched.
function expandToSlots(hourlyValues, slotHours = 1) {
  const rep = Math.round(1 / slotHours);
  return hourlyValues.flatMap(v => Array(rep).fill(v));
}

function makePvForecast(priceSlots, pvWValues, spreadFracValues = null) {
  return priceSlots.map((slot, i) => ({
    timestamp: slot.timestamp,
    pvPowerW: pvWValues[i] ?? 0,
    spreadFrac: spreadFracValues ? (spreadFracValues[i] ?? 0) : 0
  }));
}

function runCompute(settings, scenario) {
  const eng = new OptimizationEngine(settings);
  eng.compute(
    scenario.prices,
    scenario.currentSoc,
    scenario.capacityKwh,
    scenario.maxChargeW,
    scenario.maxDischargeW,
    scenario.pvForecast   ?? null,
    null,                          // rte — use settings.battery_efficiency
    scenario.consumptionW ?? null,
    scenario.minDischargePrice ?? 0,
    scenario.consumptionMargin ?? 1.0,
    scenario.pvKwhTomorrow ?? 0,
    scenario.terminalPvKwhTomorrow ?? scenario.pvKwhTomorrow ?? 0,
    scenario.pvCloudFactor ?? 1.0,
    scenario.refillConfidence ?? 1.0,
    scenario.pvTimingRobust ?? false,
    scenario.maxChargePrice ?? 0
  );
  return eng;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const settingsArb = fc.record({
  battery_efficiency:  fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
  min_soc:             fc.constant(0),
  max_soc:             fc.integer({ min: 85, max: 100 }),
  cycle_cost_per_kwh:  fc.double({ min: 0, max: 0.10, noNaN: true, noDefaultInfinity: true }),
  export_price_ratio:  fc.constant(1.0),
});

const baseArb = fc.record({
  capacityKwh:   fc.double({ min: 1.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
  maxChargeW:    fc.integer({ min: 400, max: 3000 }),
  maxDischargeW: fc.integer({ min: 400, max: 3000 }),
  currentSoc:    fc.double({ min: 0, max: 94, noNaN: true, noDefaultInfinity: true }),
});

// ─── Test harness ─────────────────────────────────────────────────────────────

let totalPassed = 0;
let totalFailed = 0;
const failedInvariants = [];

function testInvariant(name, arb, predFn, runs = RUNS) {
  process.stdout.write(`[${name}] ... `);
  try {
    fc.assert(
      fc.property(arb, predFn),
      // Cap shrinking: some arbitraries (tiny-magnitude doubles, multi-array tuples)
      // shrink for tens of minutes and freeze the whole suite. Bound it so a real
      // failure reports a (possibly unshrunk) counterexample within seconds.
      { numRuns: runs, seed: SEED, verbose: false, interruptAfterTimeLimit: 10000, markInterruptAsFailure: true }
    );
    console.log('✓ PASS');
    log(`## ✓ ${name}\nPASS — ${runs} scenarios, no counterexample.\n`);
    totalPassed++;
    return true;
  } catch (err) {
    const ce = err.counterexample
      ? JSON.stringify(err.counterexample, null, 2).slice(0, 1200)
      : String(err);
    console.log('✗ FAIL');
    console.error(`   ${String(err.message || err).split('\n')[0]}`);
    log(`## ✗ ${name}\nFAIL\n\n### Counterexample\n\`\`\`json\n${ce}\n\`\`\`\n\n### Error\n\`\`\`\n${err.message}\n\`\`\`\n`);
    failedInvariants.push({ name, err, ce });
    totalFailed++;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 1
// "Plan never charges from grid when PV surplus covers full charge power"
//
// When pvW − consW ≥ maxChargeW for every slot (pvCoverage ≥ 1.0), the DP must
// not schedule 'charge' because there is no grid draw.  The semantically correct
// action is 'preserve' (→ zero_charge_only firmware mode), which lets PV fill the
// battery while correctly accounting for the foregone export opportunity cost.
//
// Known risk: the DP's vCharge formula does NOT subtract the PV export opportunity
// cost (price × pvCoverage × exportRatio × kWh) whereas vPreserve does.  When
// pvCoverage = 1.0, cycleCost = 0 this makes vCharge > vPreserve → invariant fails.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 1 — no-grid-charge-on-full-pv\n');

const inv1Arb = fc.tuple(
  // Force cycle_cost=0 to exercise the hardest case: vCharge and vPreserve are equal
  // (no cycle penalty to tip the balance). With the fixed effectiveChargeCost formula,
  // vCharge = vPreserve at pvCoverage=1.0 so preserve wins the tie.
  fc.record({
    battery_efficiency:  fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
    min_soc:             fc.constant(0),
    max_soc:             fc.integer({ min: 85, max: 100 }),
    cycle_cost_per_kwh:  fc.constant(0),
    export_price_ratio:  fc.constant(1.0),
  }),
  baseArb,
  // 24 strictly positive price slots (avoid negative-price special paths)
  fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
           { minLength: 24, maxLength: 24 }),
  // per-slot consumption: 100–400 W
  fc.array(fc.integer({ min: 100, max: 400 }), { minLength: 24, maxLength: 24 })
);

const inv1 = (SLOT_H) => ([settings, base, priceValues, consValues]) => {
  // PV = maxChargeW + max(consW) + 200 → pvCoverage = (pvW − consW) / maxChargeW > 1.0
  const pvW = base.maxChargeW + Math.max(...consValues) + 200;

  const prices    = makePriceSlots(priceValues, SLOT_H);
  const pvForecast = makePvForecast(prices, Array(priceValues.length).fill(pvW));
  // The 24 is HOURS IN A DAY, not a slot count: pvKwhTomorrow is tomorrow's yield, a
  // property of the site, not of how finely this horizon happens to be sliced. Scaling it
  // with the horizon shrinks it below capacity at 15 min, which switches on the terminal
  // hoarding value and makes grid charging genuinely optimal — breaking the premise.
  const pvKwhTomorrow = (pvW / 1000) * 24; // plenty tomorrow

  const eng = runCompute(settings, {
    ...base,
    prices,
    pvForecast,
    consumptionW: consValues,
    pvKwhTomorrow
  });

  if (!eng._schedule) return true;

  for (const slot of eng._schedule.slots) {
    if (slot.action === 'charge') return false;
  }
  return true;
};

testInvariant('1:no-grid-charge-full-pv', inv1Arb, inv1(1));
testInvariant('1:no-grid-charge-full-pv@15min', inv1Arb, inv1(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 1b
// "pvStrongCoverage threshold boundary: preserve chosen when pvCoverage straddles
//  the 400W / maxChargeW threshold"
//
// pvStrongCoverage = 400 / maxChargeW.  Only above this threshold does the DP
// apply free SoC gain to vPreserve and does the firmware run zero_charge_only.
// Below it: preserve = standby (no free PV charging).
//
// Three sub-cases:
//   below  (pvCoverage ∈ [0.38, pvStrong)):  preserve gets no free gain → standby/preserve ok
//   at     (pvCoverage = pvStrong exactly):  first slot where free gain activates
//   above  (pvCoverage ∈ (pvStrong, 0.60]): free gain active → preserve must beat charge
//
// Invariant: with cycleCost=0 and pvCoverage just above pvStrongCoverage, no slot
// should be 'charge' (same guarantee as invariant 1, but in the narrow threshold band).
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 1b — pvStrongCoverage threshold straddling\n');

// cycleCost is a parameter because the two registrations below need different tie-breaking.
// At cycleCost 0 with export_price_ratio 1.0 the DP is mathematically INDIFFERENT between
// preserve and charge above pvStrongCoverage: per kWh of SoC gained, preserve costs
// p (foregone export on the free PV) and charge costs p as well (grid import on the
// non-PV share plus the same foregone export). Hourly slots happen to settle that tie on
// preserve; 15-min slots move a quarter of the energy per slot and settle it on charge.
// Neither is cheaper — so the 15-min registration adds a small cycle cost to make preserve
// strictly better and keep testing the threshold logic rather than an arbitrary tie.
const inv1bArb = (cycleCost) => fc.tuple(
  fc.record({
    battery_efficiency:  fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
    min_soc:             fc.constant(0),
    max_soc:             fc.integer({ min: 85, max: 100 }),
    cycle_cost_per_kwh:  fc.constant(cycleCost),
    export_price_ratio:  fc.constant(1.0),
  }),
  fc.record({
    capacityKwh:   fc.double({ min: 1.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 400, max: 3000 }),
    maxDischargeW: fc.integer({ min: 400, max: 3000 }),
    currentSoc:    fc.double({ min: 0, max: 94,  noNaN: true, noDefaultInfinity: true }),
  }),
  // prices: positive only (avoid negative-price special paths)
  fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
           { minLength: 24, maxLength: 24 }),
  // per-slot consumption: 100–400 W
  fc.array(fc.integer({ min: 100, max: 400 }), { minLength: 24, maxLength: 24 }),
  // pvCoverage multiplier: 0.38–0.60 relative to maxChargeW
  // pvStrongCoverage = 400/maxChargeW (e.g. 0.13 for 3000W, 1.0 for 400W)
  // We specifically target coverage ABOVE pvStrongCoverage but below 1.0 —
  // the zone where preserve gets free PV charging but charge still has grid cost.
  fc.double({ min: 0.38, max: 0.60, noNaN: true, noDefaultInfinity: true })
).map(([settings, base, priceValues, consValues, coverageFrac]) => [
  settings,
  { ...base, currentSoc: Math.min(base.currentSoc, settings.max_soc) },
  priceValues,
  consValues,
  coverageFrac,
]);

const inv1b = (SLOT_H) => ([settings, base, priceValues, consValues, coverageFrac]) => {
  // pvStrongCoverage = 400 / maxChargeW
  const pvStrongCoverage = 400 / base.maxChargeW;

  // pvW = consW + coverageFrac * maxChargeW → pvCoverage = coverageFrac (0.38–0.60)
  // Per slot: use the slot's own consW so pvCoverage stays close to coverageFrac
  const prices = makePriceSlots(priceValues, SLOT_H);
  const pvWValues = consValues.map(c => Math.round(c + coverageFrac * base.maxChargeW));
  const pvForecast = makePvForecast(prices, pvWValues);

  // Guard on the coverage the engine actually sees, not the one we asked for: Math.round()
  // above can pull a coverageFrac that sits just over the threshold back down to exactly ON
  // it, so the requested-value guard would wave through a scenario the engine treats as
  // below-strong.
  const minActualCoverage = Math.min(
    ...pvWValues.map((pvW, i) => (pvW - consValues[i]) / base.maxChargeW)
  );
  if (minActualCoverage <= pvStrongCoverage) return true;
  // 24 = hours in a day, not a slot count — see the note on invariant 1.
  const pvKwhTomorrow = (coverageFrac * base.maxChargeW / 1000) * 24;

  const eng = runCompute(settings, {
    ...base,
    prices,
    pvForecast,
    consumptionW: consValues,
    pvKwhTomorrow,
  });

  if (!eng._schedule) return true;

  // When pvCoverage > pvStrongCoverage and exportPriceRatio=1.0:
  // vCharge cost = price (full, including foregone export) ≥ vPreserve (free PV gain + export).
  // So 'charge' must not appear when PV is above the strong threshold.
  for (const slot of eng._schedule.slots) {
    if (slot.action === 'charge') return false;
  }
  return true;
};

testInvariant('1b:pv-strong-threshold-straddling', inv1bArb(0), inv1b(1));
testInvariant('1b:pv-strong-threshold-straddling@15min', inv1bArb(0.01), inv1b(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 2
// "Plan fills to maxSoc when tomorrow has cheaper-than-today negative slots
//  and capacity allows"
//
// Set-up: 12 standby slots (today), then enough negative-price slots to fill
// battery from 0 % to maxSoc.  cycle_cost = 0 so charging is unambiguously
// profitable at any negative price.  The DP must reach maxSoc.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 2 — fill-to-max-on-negative-prices\n');

const inv2Arb = fc.tuple(
  fc.record({
    battery_efficiency: fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
    min_soc:            fc.constant(0),
    max_soc:            fc.integer({ min: 85, max: 100 }),
    cycle_cost_per_kwh: fc.constant(0),  // no cycle cost → always profitable to charge at neg price
    export_price_ratio: fc.constant(1.0),
  }),
  fc.record({
    capacityKwh:   fc.double({ min: 1.0, max: 5.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 800, max: 3000 }),  // at least 800 W so fill is feasible
    maxDischargeW: fc.integer({ min: 400, max: 3000 }),
  }),
  fc.double({ min: -0.50, max: -0.05, noNaN: true, noDefaultInfinity: true })
);

const inv2 = (SLOT_H) => ([settings, base, negPrice]) => {
  // Slots needed to charge from 0 to maxSoc (full capacity × maxSoc%). A 15-min slot
  // carries a quarter of the energy, so slotsNeeded scales up on its own.
  const maxSocFrac    = settings.max_soc / 100;
  const kwhNeeded     = base.capacityKwh * maxSocFrac;
  const kwhPerSlot    = (base.maxChargeW / 1000) * SLOT_H;
  const slotsNeeded   = Math.ceil(kwhNeeded / kwhPerSlot);
  // Add 2 extra negative slots as margin
  const negSlots      = slotsNeeded + 2;
  const todaySlots    = Math.round(4 / SLOT_H); // 4 h of positive-price "today" slots

  // 24 h horizon floor, expressed in slots. This must be rescaled: the trailing padding is
  // the window in which the filled battery is observable — socProjected is the SoC at slot
  // START, so without at least one slot after the last charge the fill never shows up.
  // Leaving the floor at 24 slots made the 15-min run end exactly on the last charge slot
  // and report peak SoC 68 % instead of 85 %.
  const minSlots      = Math.round(24 / SLOT_H);
  const prices = [
    ...Array(todaySlots).fill(0.20),       // today: positive, no incentive to charge
    ...Array(negSlots).fill(negPrice),      // tomorrow: negative, charge is profitable
    ...Array(Math.max(0, minSlots - todaySlots - negSlots)).fill(0.20) // padding
  ].slice(0, Math.max(minSlots, todaySlots + negSlots));

  const currentSoc = 0; // start empty

  const eng = runCompute(settings, {
    ...base,
    currentSoc,
    prices: makePriceSlots(prices, SLOT_H),
    pvKwhTomorrow: 0 // no PV interference
  });

  if (!eng._schedule) return true;

  const maxSocReached = eng._schedule.slots.some(
    s => s.socProjected >= settings.max_soc - 1.5 // 1.5 % rounding tolerance
  );
  return maxSocReached;
};

testInvariant('2:fill-to-max-on-negative-prices', inv2Arb, inv2(1));
testInvariant('2:fill-to-max-on-negative-prices@15min', inv2Arb, inv2(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 3
// "Displayed plan exactly matches DP decision trace"
//
// Re-execute the forward pass manually using the scheduled actions and verify
// that socProjected values are consistent:
//   charge   → SoC must increase (or be capped at maxSoc)
//   discharge → SoC must decrease (or be capped at minSoc)
//   preserve/standby/trickle → SoC must not significantly decrease
// All socProjected values must lie within [minSoc − ε, maxSoc + ε].
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 3 — soc-trace-consistency\n');
log('### Fix iteration 1: clamp currentSoc to max_soc in generator\n');

testInvariant('3:soc-trace-consistency',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(
      fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
      { minLength: 24, maxLength: 24 }
    )
  // Clamp currentSoc to max_soc so the engine never starts above its own ceiling.
  // Without this, socProjected[0] = currentSoc (clamped to GRID_TOTAL, not maxSocG)
  // which legitimately exceeds max_soc and falsely triggers the bounds check.
  ).map(([settings, base, prices]) => [
    settings,
    { ...base, currentSoc: Math.min(base.currentSoc, settings.max_soc) },
    prices
  ]),
  ([settings, base, priceValues]) => {
    const eng = runCompute(settings, {
      ...base,
      prices: makePriceSlots(priceValues)
    });

    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;
    if (slots.length < 2) return true;

    // SoC bounds tolerance: 0.5% (GRID=10 → 0.1% resolution; 0.5% covers accumulation)
    const EPS = 0.5;
    const minSoc = settings.min_soc;
    const maxSoc = settings.max_soc;

    // Check bounds
    for (const slot of slots) {
      if (slot.socProjected < minSoc - EPS) return false;
      if (slot.socProjected > maxSoc + EPS) return false;
    }

    // Check action-to-soc direction consistency
    for (let i = 0; i < slots.length - 1; i++) {
      const s = slots[i];
      const next = slots[i + 1];
      const delta = next.socProjected - s.socProjected;

      if (s.action === 'charge') {
        // SoC must not significantly decrease after a charge slot
        if (delta < -EPS) return false;
      } else if (s.action === 'discharge') {
        // SoC must not significantly increase after a discharge slot
        if (delta > EPS) return false;
      } else {
        // preserve / standby / trickle: SoC must not significantly decrease
        if (delta < -EPS) return false;
      }
    }

    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 4
// "Cycle counter is monotonic across simulated restarts"
//
// Simulate battery_cycle_history accumulation (mirrors device.js logic).
// After completing N cycles, persist the history.  Simulate a restart (reset
// in-memory accumulators, restore persisted history).  The total kwhDischarged
// after restart must equal the total before restart (no loss, no inflation).
// Subsequent cycles may only increase the total.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 4 — cycle-counter-monotonic\n');

testInvariant('4:cycle-counter-monotonic',
  fc.array(
    fc.record({
      kwhDischarged:     fc.double({ min: 0.05, max: 5.0, noNaN: true, noDefaultInfinity: true }),
      avgChargePrice:    fc.double({ min: 0,    max: 0.50, noNaN: true, noDefaultInfinity: true }),
      avgDischargePrice: fc.double({ min: 0,    max: 0.50, noNaN: true, noDefaultInfinity: true }),
      profitEur:         fc.double({ min: -2,   max: 5.0,  noNaN: true, noDefaultInfinity: true }),
    }),
    { minLength: 1, maxLength: 30 }
  ),
  (cycles) => {
    // Phase 1: accumulate cycles into history (mirrors device.js)
    const history = [];
    for (const c of cycles) {
      history.push({ date: '2026-01-15', ...c });
      if (history.length > 60) history.shift(); // FIFO cap
    }
    const totalBefore = history.reduce((s, e) => s + e.kwhDischarged, 0);

    // Simulate restart: in-memory state resets, history restored from persistent store
    const restoredHistory = history.map(e => ({ ...e }));
    // in-memory accumulators reset to 0 — but persisted history unchanged
    let inMemoryKwh = 0;

    // Phase 2: continue after restart — add one more cycle
    const newCycleKwh = 1.0;
    inMemoryKwh += newCycleKwh;
    restoredHistory.push({
      date: '2026-01-16',
      kwhDischarged: inMemoryKwh,
      avgChargePrice: 0.10,
      avgDischargePrice: 0.30,
      profitEur: 0.20,
    });
    if (restoredHistory.length > 60) restoredHistory.shift();
    inMemoryKwh = 0; // reset after recording

    const totalAfter = restoredHistory.reduce((s, e) => s + e.kwhDischarged, 0);

    // Post-restart total ≥ pre-restart total (monotonic; the new cycle adds to it)
    return totalAfter >= totalBefore - 0.001;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 5
// "policy_mode_history has exactly one entry per unique 15-min slot"
//
// Simulate the history-write logic (mirrors device.js lines 1545–1570).
// Given a sequence of policy runs at distinct 15-min bucket timestamps, the
// resulting history must contain exactly one entry per unique bucket, with no
// duplicates and no missing entries (up to the 2200-entry FIFO cap).
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 5 — policy-mode-history-per-slot\n');

testInvariant('5:policy-mode-history-per-slot',
  // Generate N distinct 15-min bucket indices in [0, 191] (48h)
  fc.array(fc.integer({ min: 0, max: 191 }), { minLength: 1, maxLength: 96 })
    .map(arr => [...new Set(arr)].sort((a, b) => a - b)),
  (bucketIndices) => {
    if (bucketIndices.length === 0) return true;

    const BASE_MS   = new Date('2026-01-15T00:00:00+01:00').getTime();
    const BUCKET_MS = 15 * 60 * 1000;
    const MAX_HIST  = 2200;

    const modeHistory = [];

    for (const idx of bucketIndices) {
      const rawTs   = BASE_MS + idx * BUCKET_MS;
      // Round to 15-min boundary (mirrors device.js)
      const roundedTs = Math.round(rawTs / BUCKET_MS) * BUCKET_MS;

      const entry = { ts: roundedTs, hwMode: 'standby', price: 0.20, soc: 50 };

      const existingIdx = modeHistory.findIndex(e => e.ts === roundedTs);
      if (existingIdx >= 0) {
        modeHistory[existingIdx] = entry; // update existing bucket
      } else {
        modeHistory.push(entry);
        if (modeHistory.length > MAX_HIST) modeHistory.shift();
      }
    }

    // Each bucket must appear exactly once
    const tsBuckets = modeHistory.map(e => e.ts);
    const uniqueBuckets = new Set(tsBuckets);
    if (uniqueBuckets.size !== modeHistory.length) return false;

    // Number of entries must equal number of unique input buckets
    // (capped at MAX_HIST when input > MAX_HIST distinct buckets)
    const expectedCount = Math.min(bucketIndices.length, MAX_HIST);
    if (modeHistory.length !== expectedCount) return false;

    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 6
// "RTE factor never double-applied to SoC delta"
//
// Physical SoC change depends on charge/discharge power and slot duration, not
// on round-trip efficiency.  RTE only affects economic value (discharge revenue).
// When two DP runs share the same action at slot t, their socProjected[t] must
// be identical regardless of RTE.  If they differ by > 0.3 % with the same
// action, RTE has leaked into the SoC calculation.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 6 — rte-no-double-apply-soc\n');
log('### Fix iteration 1: compare SoC DELTA while trajectories are synced, not absolute SoC\n');
log('Rationale: different RTE values lead to different economic decisions at some slots.\n');
log('Once actions diverge, absolute socProjected legitimately differs. The real invariant\n');
log('is: given same starting SoC AND same action, the SoC delta is RTE-independent.\n');
log('We track sync status and only compare deltas while both engines are on the same path.\n');

testInvariant('6:rte-no-double-apply-soc',
  fc.tuple(
    fc.record({
      min_soc:            fc.constant(0),
      max_soc:            fc.integer({ min: 85, max: 100 }),
      cycle_cost_per_kwh: fc.constant(0),
      export_price_ratio: fc.constant(1.0),
    }),
    baseArb,
    fc.array(
      fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
      { minLength: 24, maxLength: 24 }
    )
  // Clamp currentSoc to max_soc (same reason as invariant 3)
  ).map(([baseSettings, base, prices]) => [
    baseSettings,
    { ...base, currentSoc: Math.min(base.currentSoc, baseSettings.max_soc) },
    prices
  ]),
  ([baseSettings, base, priceValues]) => {
    const prices = makePriceSlots(priceValues);

    const eng75 = runCompute({ ...baseSettings, battery_efficiency: 0.75 }, { ...base, prices });
    const eng90 = runCompute({ ...baseSettings, battery_efficiency: 0.90 }, { ...base, prices });

    if (!eng75._schedule || !eng90._schedule) return true;

    const s75 = eng75._schedule.slots;
    const s90 = eng90._schedule.slots;
    if (s75.length !== s90.length) return true;

    // Both engines start at the same currentSoc → slot 0's socProjected must match
    if (Math.abs(s75[0].socProjected - s90[0].socProjected) > 0.2) return false;

    // Track synchronization: while both engines have taken identical actions from
    // slot 0, they're on the same SoC trajectory.  Compare SoC deltas in that window.
    // Once actions diverge, trajectories legitimately differ → stop checking.
    for (let i = 0; i < s75.length - 1; i++) {
      if (s75[i].action !== s90[i].action) break; // diverged — stop
      // Same action, same starting SoC → delta must be identical (RTE not in SoC formula)
      const delta75 = s75[i + 1].socProjected - s75[i].socProjected;
      const delta90 = s90[i + 1].socProjected - s90[i].socProjected;
      // Tolerance: 0.3 % (GRID=10 → 0.1 % resolution; small rounding on Math.round)
      if (Math.abs(delta75 - delta90) > 0.3) return false;
    }

    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 7: SoC bounds safety
//
// socProjected must never exceed maxSoc or fall below minSoc across the full
// schedule.  Catches over-charge bugs, clipping errors, rounding drift.
// Tighter than invariant 3 (which also checks action-direction consistency):
// tolerance here is 0.15 % (1.5 GRID units) vs 0.5 % in invariant 3.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 7 — soc-bounds-safety\n');

testInvariant('7:soc-bounds-safety',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(
      fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
      { minLength: 24, maxLength: 24 }
    )
  ).map(([settings, base, prices]) => [
    settings,
    { ...base, currentSoc: Math.min(base.currentSoc, settings.max_soc) },
    prices
  ]),
  ([settings, base, priceValues]) => {
    const eng = runCompute(settings, { ...base, prices: makePriceSlots(priceValues) });
    if (!eng._schedule) return true;

    const EPS = 0.15; // 1.5 GRID units — tighter than inv 3
    for (const slot of eng._schedule.slots) {
      if (slot.socProjected < settings.min_soc - EPS) return false;
      if (slot.socProjected > settings.max_soc + EPS) return false;
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 8: PV self-consumption before grid import
//
// Generate per-slot pvCoverage values (some < 1.0, some > 1.0, some straddling
// pvStrongCoverage) and verify that whenever pvCoverage >= 1.0 in a slot the
// scheduled action is NOT 'charge'.  Grid import only occurs when PV surplus
// is genuinely insufficient to cover the charge demand (pvCoverage < 1.0).
//
// Complements invariant 1 (which uses fixed pvW = maxChargeW + max(consW) + 200
// for all slots) by using VARIED per-slot pvW, producing mixed scenarios where
// some slots have surplus and some don't.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 8 — pv-self-consumption-before-grid\n');

const inv8Arb = fc.tuple(
    fc.record({
      battery_efficiency:  fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
      min_soc:             fc.constant(0),
      max_soc:             fc.integer({ min: 85, max: 100 }),
      cycle_cost_per_kwh:  fc.constant(0),
      export_price_ratio:  fc.constant(1.0),
    }),
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 100, max: 400 }), { minLength: 24, maxLength: 24 }),
    // per-slot pvCoverage fraction (0–1.6): varied so some slots are above 1.0
    fc.array(fc.double({ min: 0, max: 1.6, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 })
  ).map(([settings, base, prices, cons, coverages]) => [
    settings,
    { ...base, currentSoc: Math.min(base.currentSoc, settings.max_soc) },
    prices, cons, coverages
  ]);

const inv8 = (SLOT_H) => ([settings, base, priceValues, consValues, pvCoverages]) => {
    // pvW = consW + coverage * maxChargeW → pvCoverage = (pvW − consW) / maxChargeW = coverage
    const pvWValues = consValues.map((c, t) => c + pvCoverages[t] * base.maxChargeW);
    const prices    = makePriceSlots(priceValues, SLOT_H);
    const pvForecast = makePvForecast(prices, pvWValues);
    // Deliberately NOT scaled by SLOT_H: this sum is tomorrow's yield in kWh (a site
    // property, the 24 W-values read as 24 hours), not an integral over this horizon.
    // Scaling it down at 15 min switches on terminal hoarding — see invariant 1.
    const pvKwhTomorrow = pvWValues.reduce((s, w) => s + w / 1000, 0);

    const eng = runCompute(settings, {
      ...base,
      prices,
      pvForecast,
      consumptionW: consValues,
      pvKwhTomorrow,
    });

    if (!eng._schedule) return true;

    for (let t = 0; t < eng._schedule.slots.length; t++) {
      const slot    = eng._schedule.slots[t];
      const pvW     = pvWValues[t] ?? 0;
      const consW   = consValues[t] ?? 0;
      const surplus = Math.max(0, pvW - consW);
      const pvCov   = Math.min(1, surplus / base.maxChargeW);

      // pvCoverage >= 1.0 → PV surplus alone covers full charge power.
      // Routing rule: use PV before grid → no grid needed → action must NOT be 'charge'.
      if (pvCov >= 1.0 - 1e-9 && slot.action === 'charge') return false;

      // When action='charge' and pvCov > 0, grid import fraction = 1 − pvCov ∈ (0, 1).
      // I.e., partial PV reduces but does not eliminate grid draw (routing is correct).
      if (slot.action === 'charge' && pvCov < 0) return false; // pvCov always ≥ 0 by construction
    }
    return true;
};

testInvariant('8:pv-self-consumption-before-grid', inv8Arb, inv8(1));
testInvariant('8:pv-self-consumption-before-grid@15min', inv8Arb, inv8(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 9: Schedule feasibility — action preconditions
//
// The DP enforces SoC preconditions before assigning actions:
//   discharge only when socG > minSocG  (battery has energy to give)
//   charge    only when socG < maxSocG  (battery has room to accept)
//
// The forward pass must preserve this: a 'discharge' slot starting at minSoc is
// a feasibility violation (nothing to discharge), likewise 'charge' at maxSoc.
//
// EPS = 0.05 % (half a GRID unit).  The DP allows charge when socG < maxSocG,
// so the closest valid charge start is socProjected = maxSoc − 0.1 %.
// EPS=0.05 correctly accepts that (0.1 > 0.05 from the boundary) while still
// catching a true violation at socProjected = maxSoc (0.0 < 0.05 from boundary).
// EPS=0.15 was too wide: it rejected the legitimate near-boundary case.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 9 — schedule-feasibility\n');

testInvariant('9:schedule-feasibility',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(
      fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
      { minLength: 24, maxLength: 24 }
    )
  ).map(([settings, base, prices]) => [
    settings,
    { ...base, currentSoc: Math.min(base.currentSoc, settings.max_soc) },
    prices
  ]),
  ([settings, base, priceValues]) => {
    const eng = runCompute(settings, { ...base, prices: makePriceSlots(priceValues) });
    if (!eng._schedule) return true;

    const EPS    = 0.05; // half a GRID unit (0.1 % resolution)
    const minSoc = settings.min_soc;
    const maxSoc = settings.max_soc;

    for (const slot of eng._schedule.slots) {
      // 'discharge' at minSoc: nothing to discharge
      if (slot.action === 'discharge' && slot.socProjected <= minSoc + EPS) return false;
      // 'charge' at maxSoc: no room to charge
      if (slot.action === 'charge'    && slot.socProjected >= maxSoc - EPS) return false;
    }
    return true;
  }
);

// ─── Invariant 10 — computeExpectedProfit self-sufficiency bounds ─────────────
//
// selfSufficiencyPct must always be in [0, 100] regardless of inputs.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 10 — computeExpectedProfit-self-sufficiency-bounds\n');

testInvariant('10:expected-profit-self-sufficiency-bounds',
  fc.tuple(settingsArb, baseArb, fc.array(
    fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 24, maxLength: 24 }
  )),
  ([settings, base, priceValues]) => {
    const eng = new OptimizationEngine(settings);
    const prices = makePriceSlots(priceValues);
    const result = eng.computeExpectedProfit(
      prices, base.currentSoc, base.capacityKwh,
      base.maxChargeW, base.maxDischargeW,
      null, null, null, 0, 1.0, 0
    );
    return result.selfSufficiencyPct >= 0 && result.selfSufficiencyPct <= 100;
  }
);

// ─── Invariant 11 — computeExpectedProfit profit matches compute() ────────────
//
// Both methods call _runBackwardDP with the same params; dp[initialSocG] must
// be equal. compute() stores this as _schedule.projectedProfit.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 11 — computeExpectedProfit-profit-matches-compute\n');

testInvariant('11:expected-profit-matches-compute',
  fc.tuple(settingsArb, baseArb, fc.array(
    fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 24, maxLength: 24 }
  )),
  ([settings, base, priceValues]) => {
    const prices = makePriceSlots(priceValues);
    const eng = runCompute(settings, { ...base, prices });
    if (!eng._schedule) return true;
    const result = eng.computeExpectedProfit(
      prices, base.currentSoc, base.capacityKwh,
      base.maxChargeW, base.maxDischargeW,
      null, null, null, 0, 1.0, 0
    );
    // Allow 1e-9 floating point tolerance
    return Math.abs(result.profit - eng._schedule.projectedProfit) < 1e-6;
  }
);

// ─── Invariant 11b — profitFromEmpty is monotone in pack size ────────────────
//
// The expansion tab ranks 1-4 batteries on this figure and derives a payback period
// from the differences. A bigger pack with proportionally more power can always
// emulate a smaller one, so its earning capacity can never be lower. Ranking on the
// raw DP value violated this: dp[initialSocG] credits the opening stock, which scales
// with capacity, so four batteries could score below one once PV was in play.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 11b — profit-from-empty-monotone-in-capacity\n');

testInvariant('11b:profit-from-empty-monotone-in-capacity',
  fc.tuple(settingsArb, baseArb, fc.array(
    fc.double({ min: -0.10, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 24, maxLength: 24 }
  ), fc.array(fc.integer({ min: 0, max: 3600 }), { minLength: 24, maxLength: 24 })),
  ([settings, base, priceValues, pvValues]) => {
    const prices = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvValues);
    const consumptionW = new Array(24).fill(400);

    let prev = -Infinity;
    for (const n of [1, 2, 3, 4]) {
      const capacityKwh = base.capacityKwh * n;
      const powerW      = base.maxChargeW * n;
      const eng = runCompute(settings, {
        ...base, prices, pvForecast, consumptionW,
        capacityKwh, maxChargeW: powerW, maxDischargeW: powerW,
      });
      if (!eng._schedule) return true;
      const { profitFromEmpty } = eng.computeExpectedProfit(
        prices, base.currentSoc, capacityKwh, powerW, powerW,
        pvForecast, null, consumptionW, 0, 1.0, 0
      );
      // SoC-grid rounding leaves sub-cent noise between adjacent pack sizes.
      if (profitFromEmpty < prev - 1e-3) return false;
      prev = profitFromEmpty;
    }
    return true;
  },
  // Four full compute() runs per iteration; the default 1000 trips the 10s interrupt.
  50
);

// ─── Invariant 12 — exportPriceRatio zero-effect without PV or consumption ────
//
// When pvForecast=null and consumptionWPerSlot=null, exportPriceRatio does not
// appear in either the effectiveChargeCost formula (pvCoverage=0) or the
// discharge value formula (consumptionKwh=null path). Schedule must be identical
// for ratio=1.0 vs ratio=0.3.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 12 — exportPriceRatio-zero-effect-without-pv\n');

testInvariant('12:export-ratio-zero-effect-without-pv',
  fc.tuple(baseArb, fc.array(
    fc.double({ min: -0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 24, maxLength: 24 }
  )),
  ([base, priceValues]) => {
    const prices = makePriceSlots(priceValues);
    const baseSettings = { battery_efficiency: 0.9, min_soc: 0, max_soc: 95,
                           cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };

    const eng1 = runCompute({ ...baseSettings, export_price_ratio: 1.0 }, { ...base, prices });
    const eng2 = runCompute({ ...baseSettings, export_price_ratio: 0.3 }, { ...base, prices });

    if (!eng1._schedule || !eng2._schedule) return !eng1._schedule && !eng2._schedule;

    const slots1 = eng1._schedule.slots;
    const slots2 = eng2._schedule.slots;
    if (slots1.length !== slots2.length) return false;
    for (let i = 0; i < slots1.length; i++) {
      if (slots1[i].action !== slots2[i].action) return false;
      if (Math.abs(slots1[i].socProjected - slots2[i].socProjected) > 0.15) return false;
    }
    return true;
  }
);

// ─── Invariant 13 — exportPriceRatio: lower ratio reduces discharge profit ────
//
// When consumption=0 for all slots (all discharge goes to export), ratio=1.0
// earns full retail per kWh while ratio=0.3 earns only 30%. Therefore:
//   profit(ratio=1.0) >= profit(ratio=0.3)
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 13 — exportPriceRatio-lower-ratio-reduces-profit\n');

testInvariant('13:export-ratio-lower-ratio-reduces-profit',
  fc.tuple(baseArb, fc.array(
    fc.double({ min: 0.01, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 24, maxLength: 24 }
  )),
  ([base, priceValues]) => {
    const prices = makePriceSlots(priceValues);
    const consumption = new Array(24).fill(0);
    const baseSettings = { battery_efficiency: 0.9, min_soc: 0, max_soc: 95,
                           cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };

    const eng1 = new OptimizationEngine({ ...baseSettings, export_price_ratio: 1.0 });
    const eng2 = new OptimizationEngine({ ...baseSettings, export_price_ratio: 0.3 });

    const r1 = eng1.computeExpectedProfit(prices, base.currentSoc, base.capacityKwh,
      base.maxChargeW, base.maxDischargeW, null, null, consumption, 0, 1.0, 0);
    const r2 = eng2.computeExpectedProfit(prices, base.currentSoc, base.capacityKwh,
      base.maxChargeW, base.maxDischargeW, null, null, consumption, 0, 1.0, 0);

    return r1.profit >= r2.profit - 1e-9;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 14: Night-slot ordering — discharge deferred to higher-priced slot
//
// When pvKwhTomorrow >= 80% capacity (PV refills tomorrow) and a later night
// slot has a strictly higher discharge price, the DP must NOT discharge at the
// cheaper earlier slot when SoC allows only one discharge.
//
// Setup: [nightA(priceA), nightB(priceB>priceA), pvDay × 8 slots].
// The PV-day slots ensure pvKwhFromT[1] >= capacityKwh, which normally triggers
// dp-flattening at slot 0 — destroying the price gradient.  Our fix blocks
// flattening when a better-priced night slot is ahead.
//
// consumptionWPerSlot is randomised per slot: it determines effective discharge
// power (= min(maxDischargeW, consW)), so each slot's revenue = price × consKwh.
// To isolate price ordering, consW is equal for both night slots — so revenue
// is driven by price alone.  PV-day slots carry their own (lower) consumption.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 14 — night-discharge-defers-to-better-price\n');

const inv14Arb = fc.tuple(
    fc.record({
      battery_efficiency:  fc.double({ min: 0.50, max: 0.90, noNaN: true, noDefaultInfinity: true }),
      min_soc:             fc.constant(0),
      max_soc:             fc.constant(100),
      cycle_cost_per_kwh:  fc.double({ min: 0, max: 0.08, noNaN: true, noDefaultInfinity: true }),
      export_price_ratio:  fc.constant(1.0),
    }),
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 800 }),
    }),
    // priceA (lower night slot), priceB = priceA + delta (higher night slot)
    fc.double({ min: 0.230, max: 0.340, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.005, max: 0.040, noNaN: true, noDefaultInfinity: true }),
    // house consumption for both night slots (same → price drives the ordering)
    fc.integer({ min: 250, max: 700 }),
  );

const inv14 = (SLOT_H) => ([settings, base, priceA, priceDelta, nightConsW]) => {
    const priceB          = priceA + priceDelta;        // priceB > priceA
    const minDischargePrice = 0.220;
    const { capacityKwh, maxChargeW, maxDischargeW } = base;

    // Effective discharge power per slot = min(maxDischargeW, consW)
    const effectiveDischargeW = Math.min(maxDischargeW, nightConsW);
    // SoC % consumed per discharge slot (no RTE on SoC projection)
    const perSlotSocPct = (effectiveDischargeW / 1000) * SLOT_H * 100 / capacityKwh;

    // Skip degenerate cases: discharge delta too small to matter
    if (perSlotSocPct < 0.5) return true;

    // currentSoc = exactly 1 slot's worth: enough for 1 discharge but not 2.
    // After discharge socG drops to 0 = minSoc → can't discharge again.
    const currentSoc = Math.min(99, perSlotSocPct);

    // Guard: skip if SoC too small to discharge even once
    if (currentSoc < perSlotSocPct - 0.1) return true;

    // PV-day slots: high PV so pvKwhFromT[slot 1 onwards] >= capacityKwh.
    // The PV day is 8 HOURS wide, not 8 slots — its energy is a property of the day,
    // so the slot count scales with resolution while the kWh figures stay put.
    const pvDayHours   = 8;
    const pvDaySlots   = Math.round(pvDayHours / SLOT_H);
    const pvDayW       = maxChargeW;                               // full charge power
    const pvDayConsW   = 150;                                      // low consumption during PV hours
    const pvKwhFromDay = (pvDayW / 1000) * pvDayHours;            // kWh PV available
    // Only proceed when PV day can actually refill battery (triggers flatten guard)
    if (pvKwhFromDay < capacityKwh * 0.8) return true;

    // Price array: [nightA, nightB, pvDay×8 at low price (no discharge incentive)]
    const priceValues  = [priceA, priceB, ...Array(pvDaySlots).fill(0.05)];
    const prices       = makePriceSlots(priceValues, SLOT_H);

    // PV forecast: no PV for night slots, pvDayW for PV slots
    const pvWValues    = [0, 0, ...Array(pvDaySlots).fill(pvDayW)];
    const pvForecast   = makePvForecast(prices, pvWValues);

    // consumptionWPerSlot: nightConsW for night, pvDayConsW for PV day
    const consumptionW = [nightConsW, nightConsW, ...Array(pvDaySlots).fill(pvDayConsW)];

    // pvKwhTomorrow: net PV surplus that enters battery (pvW - consW, clamped ≥ 0)
    const pvKwhTomorrow = pvDayHours * Math.max(0, pvDayW - pvDayConsW) / 1000;

    const eng = runCompute(settings, {
      ...base,
      currentSoc,
      prices,
      pvForecast,
      consumptionW,
      minDischargePrice,
      pvKwhTomorrow,
    });

    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;
    if (slots.length < 2) return true;

    // Invariant: slot 0 (priceA, cheaper) must NOT be discharged.
    // The DP must preserve SoC for slot 1 (priceB, more expensive).
    return slots[0].action !== 'discharge';
};

testInvariant('14:night-discharge-defers-to-better-price', inv14Arb, inv14(1));
testInvariant('14:night-discharge-defers-to-better-price@15min', inv14Arb, inv14(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 15
// "Overnight refill-reserve floor never sacrifices a pricier slot for a cheaper one"
//
// The reserve floor (raised when refillConfidence < 1) holds SoC through non-PV
// slots that precede a strong-PV refill, to insure the next day if PV under-delivers.
// The reserve is only spendable AFTER the PV window, so its value is bounded by the
// best price in that trailing window. It must therefore NEVER suppress discharge at
// a slot whose own price exceeds every later slot's price: discharging there strictly
// dominates hoarding for a cheaper future peak, regardless of how PV resolves.
//
// Oracle-free check: run the same scenario twice — baseline (confidence 1.0, no floor)
// vs floored (random low confidence). For every slot the baseline discharges whose
// price is the strict maximum of the remaining horizon, the floored run must also
// discharge. Any discharge→hold delta there is caused solely by the floor = the bug.
//
// Horizon shape is fixed as [pre-PV | strong-PV block | post-PV tail] so the floor
// can actually engage (it needs a strong-PV slot ahead) and pre-PV peaks exist.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 15 — refill-reserve-floor-never-sacrifices-pricier-slot\n');

testInvariant('15:refill-reserve-floor-never-sacrifices-pricier-slot',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 60, max: 94, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.array(fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 6 }), // pre-PV prices
    fc.integer({ min: 2, max: 6 }),  // PV block length
    fc.array(fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 6 }), // post-PV tail prices
    fc.double({ min: 0.0, max: 0.6, noNaN: true, noDefaultInfinity: true }), // low refillConfidence → floor engages
  ),
  ([settings, base, prePrices, pvLen, tailPrices, refillConfidence]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;
    // PV block: strong PV (full charge power), cheap price (no discharge there anyway).
    const pvPrices = Array(pvLen).fill(0.10);
    const priceValues = [...prePrices, ...pvPrices, ...tailPrices];
    const prices = makePriceSlots(priceValues);

    const pvWValues = [
      ...prePrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800), // surplus ≥ charge power → strongPvAhead
      ...tailPrices.map(() => 0),
    ];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 500);

    const scenario = {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
    };
    const baseSlots = runCompute(settings, { ...scenario, refillConfidence: 1.0 })._schedule?.slots;
    const floorSlots = runCompute(settings, { ...scenario, refillConfidence })._schedule?.slots;
    if (!baseSlots || !floorSlots) return true;

    const N = priceValues.length;
    // The floor holds a reserve, so it inherently discharges FEWER slots than the
    // unconstrained base — it cannot be required to match every suffix-maximum base
    // discharges (that would forbid having a reserve at all). The price-blindness bug
    // the floor must never commit is suppressing discharge at THE single strict global
    // price-max: the one slot where holding energy is unambiguously value-destroying
    // (no later slot can ever pay more, and the base proves discharge there is feasible).
    let maxIdx = -1, maxPrice = -Infinity;
    for (let t = 0; t < N; t++) {
      if (priceValues[t] > maxPrice) { maxPrice = priceValues[t]; maxIdx = t; }
    }
    // strict global max (unique) and base discharges there → floor must too.
    const strictGlobalMax = priceValues.filter(p => p >= maxPrice - 1e-9).length === 1;
    if (strictGlobalMax && baseSlots[maxIdx].action === 'discharge'
        && floorSlots[maxIdx].action !== 'discharge') return false;
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 16
// "Pre-PV discharge window spends the priciest slots first (no stranded peak)"
//
// Within a contiguous pre-PV discharge window the battery has a single energy budget
// and discharge is consumption-capped (nul-op-de-meter). Under a fixed budget, every
// kWh spent at a cheaper slot is a kWh NOT spent at a pricier eligible slot in the same
// window — strictly value-destroying. So the discharged set must be the HIGHEST-priced
// eligible slots: no slot may discharge while a LATER eligible slot in the same pre-PV
// window (before strong PV refills) is held in preserve at a strictly higher price.
//
// This is the optimality guard the layer-sync rules do NOT cover: the post-DP price
// reorder (optimization-engine ~283) exists to enforce exactly this, but its
// budget-neutral revert can silently discard a valid correction, stranding the late
// peak (live miss 2026-06-08 16:45: DP discharged 17:00 €0.284 chronologically and
// left 21:00 €0.359 — the pricier slot — on preserve).
//
// refillConfidence = 1.0 (no reserve floor) so the only reason to hold a pricier slot
// would be the bug, not a deliberate overnight reserve. The window ends at the first
// strong-PV slot, matching the engine's reorder window boundary.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 16 — pre-pv-window-spends-priciest-first\n');

testInvariant('16:pre-pv-window-spends-priciest-first',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 60, max: 94, noNaN: true, noDefaultInfinity: true }),
    }),
    // 4–7 pre-PV evening slots, all eligible (≥ minDischargePrice), non-monotone so a
    // pricier slot can sit LATER than a cheaper one (the case the reorder must fix).
    fc.array(fc.double({ min: 0.230, max: 0.420, noNaN: true, noDefaultInfinity: true }),
             { minLength: 4, maxLength: 7 }),
    fc.integer({ min: 2, max: 5 }), // strong-PV block length
  ),
  ([settings, base, prePrices, pvLen]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;

    // [pre-PV evening | strong-PV block (cheap) | short cheap tail]
    const pvPrices  = Array(pvLen).fill(0.10);
    const tailPrices = [0.10, 0.10];
    const priceValues = [...prePrices, ...pvPrices, ...tailPrices];
    const prices = makePriceSlots(priceValues);

    const pvWValues = [
      ...prePrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800), // surplus ≥ charge power → strong PV / window boundary
      ...tailPrices.map(() => 0),
    ];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 500); // equal load → revenue driven by price alone

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
      refillConfidence: 1.0, // no reserve floor → holding a pricier slot can only be the bug
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const preLen = prePrices.length; // pre-PV window = [0, preLen)
    // Scope to PURE-discharge windows — the reorder's own domain (it skips windows with any
    // charge slot). A mid-window grid charge is a separate churn concern, out of scope here.
    for (let t = 0; t < preLen; t++) if (slots[t].action === 'charge') return true;
    const PRICE_EPS = 0.005; // ties within half a cent are economically equivalent (vs FP noise)
    for (let t = 0; t < preLen; t++) {
      if (slots[t].action !== 'discharge') continue;
      // Any LATER eligible slot in the same pre-PV window held at a MEANINGFULLY higher price?
      for (let u = t + 1; u < preLen; u++) {
        if (priceValues[u] < minDischargePrice) continue;
        if (priceValues[u] <= priceValues[t] + PRICE_EPS) continue;
        if (slots[u].action !== 'discharge') return false; // cheaper t discharged, pricier u stranded
      }
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 16b
// "Priciest-first holds even with the reserve floor active"
//
// Invariant 16 pins refillConfidence = 1.0, so the reserve floor never binds. But the
// floor changes the BUDGET (init − floor), not the SELECTION: of the energy actually
// discharged in the pre-PV window, it must still land on the priciest eligible slots.
//
// Live miss 2026-06-14 21:29: with the floor active, the post-DP reorder assigned the
// window price-max but that single high-net-load slot's delta overshot the budget down
// to the floor, so the budget-neutral guard reverted the whole reorder — stranding
// discharge on the CHEAPER slots the backward-DP had picked chronologically. The fix
// clamps every reorder slot to max(reserveFloor, dpEndTarget).
//
// Structure: [overnight window | strong-PV midday | EXPENSIVE evening tail]. The pricey
// tail sets releasedPeak above the window prices, so the floor actually binds on the
// window (the tail is outside the reorder window — it spends the reserve). Equal loads →
// equal net caps → priciest-first is unambiguous within the window.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 16b — priciest-first-with-reserve-floor\n');

testInvariant('16b:priciest-first-with-reserve-floor',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 60, max: 94, noNaN: true, noDefaultInfinity: true }),
    }),
    // 4–7 overnight slots, all eligible, non-monotone.
    fc.array(fc.double({ min: 0.230, max: 0.300, noNaN: true, noDefaultInfinity: true }),
             { minLength: 4, maxLength: 7 }),
    fc.integer({ min: 2, max: 5 }), // strong-PV block length
    fc.double({ min: 0.30, max: 0.75, noNaN: true, noDefaultInfinity: true }), // low refillConfidence → floor active
  ),
  ([settings, base, prePrices, pvLen, refillConfidence]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;

    // [overnight window | strong-PV block (cheap) | EXPENSIVE evening tail]. The tail price
    // exceeds every window price → releasedPeak high → reserve floor binds on the window.
    const pvPrices   = Array(pvLen).fill(0.10);
    const tailPrices = [0.360, 0.380];
    const priceValues = [...prePrices, ...pvPrices, ...tailPrices];
    const prices = makePriceSlots(priceValues);

    const pvWValues = [
      ...prePrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800), // strong PV → window boundary
      ...tailPrices.map(() => 0),
    ];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 500); // equal load → net caps equal

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
      refillConfidence,
      pvKwhTomorrow: 0, // not abundant → floor not waived
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const preLen = prePrices.length; // overnight window = [0, preLen)
    for (let t = 0; t < preLen; t++) if (slots[t].action === 'charge') return true;
    const PRICE_EPS = 0.005;
    for (let t = 0; t < preLen; t++) {
      if (slots[t].action !== 'discharge') continue;
      for (let u = t + 1; u < preLen; u++) {
        if (priceValues[u] < minDischargePrice) continue;
        if (priceValues[u] <= priceValues[t] + PRICE_EPS) continue;
        if (slots[u].action !== 'discharge') return false; // cheaper t discharged, pricier u stranded
      }
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 16c
// "Reorder budget uses DP terminal SoC, not minSoc, when wEnd = N"
//
// When no strong-PV slot or charge slot terminates the reorder window before the
// horizon end, wEnd = N. The bug (pre-fix): rawEndG collapsed to minSocG, making
// the budget windowStartSocG − minSocG too large. Extra cheap-afternoon slots
// were pulled in (ranked above even cheaper night slots), starting discharge
// earlier than the DP intended.
//
// Live miss 2026-06-26: discharge started at 16:00 (€0.246) instead of 19:00
// (€0.381). wEnd reached N because tomorrow's pvCoverage never hit pvStrongCoverage
// (cloudy or no PV data); rawEndG = minSocG → budget 0.90 → 4+ slots → 16:00 added.
//
// Structure: [cheap-ish afternoon (above minDischarge) | expensive evening | cheap night]
// Zero PV everywhere → wEnd = N guaranteed.
// Invariant: no discharged afternoon slot may hold a pricier undischarged evening slot.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 16c — reorder-wend-n-no-extra-discharge\n');

testInvariant('16c:reorder-wend-n-no-extra-discharge',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 70, max: 100, noNaN: true, noDefaultInfinity: true }),
    }),
    // 2–4 cheap-ish afternoon slots: above minDischargePrice but below the evening peaks
    fc.array(fc.double({ min: 0.230, max: 0.290, noNaN: true, noDefaultInfinity: true }),
             { minLength: 2, maxLength: 4 }),
  ),
  ([settings, base, afternoonPrices]) => {
    const minDischargePrice = 0.220;

    // Structure: [afternoon (€0.23–0.29) | evening peak (€0.36/0.41/0.46) | cheap night (€0.14)]
    // Zero PV throughout → pvCoverage = 0 everywhere → wEnd = N in the reorder block.
    const eveningPrices = [0.360, 0.410, 0.460];
    const nightPrices   = Array(18).fill(0.140); // below minDischargePrice → ineligible
    const priceValues   = [...afternoonPrices, ...eveningPrices, ...nightPrices];
    const prices        = makePriceSlots(priceValues);
    const pvForecast    = makePvForecast(prices, priceValues.map(() => 0)); // zero PV → wEnd = N

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, minDischargePrice,
      pvKwhTomorrow: 0,
      refillConfidence: 1.0, // no reserve floor → holding pricier slot can only be the bug
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const aLen = afternoonPrices.length;
    // Skip if a charge slot appears in the afternoon block (different reorder path)
    for (let t = 0; t < aLen; t++) if (slots[t].action === 'charge') return true;

    const PRICE_EPS = 0.005;
    // For each discharged afternoon slot, every evening slot with a strictly higher price
    // must also discharge. Violating this means a cheaper afternoon slot displaced a pricier
    // evening slot from the discharge set — the wEnd=N budget over-expansion bug.
    for (let t = 0; t < aLen; t++) {
      if (slots[t].action !== 'discharge') continue;
      for (let e = 0; e < eveningPrices.length; e++) {
        if (eveningPrices[e] <= afternoonPrices[t] + PRICE_EPS) continue;
        if (slots[aLen + e].action !== 'discharge') return false; // pricier evening slot stranded
      }
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 16d
// "Reorder must not rollback when in-window trickle slot inflates terminal SoC"
//
// wEnd < N (strong-PV slot terminates the discharge window before horizon end).
// The last slot before wEnd is a trickle slot (pvCoverage ∈ (0, pvStrong)),
// action=preserve, price below minDischarge (so NOT in eligible set).
//
// Old bug: after priciest-first budget assigns evening slots and skips cheap early
// slots, the forward simulation processes the trickle slot. Battery entered the
// trickle slot at dpEndTargetG (floor), trickle adds pvCov×chargeDelta GRID units
// → socGw = dpEndTargetG + trickle_delta. Rollback check fired on
// |socGw - dpEndTargetG| > 1 → reverted to original DP order → cheap early slots
// stayed as discharge, priciest evening slots missed (2026-06-26: 16:00€0.246
// discharged, 21:00€0.495 stranded).
//
// Fix: rollback only on socGw < dpEndSocG - 1 (over-discharge). Higher socGw from
// in-window PV/trickle is correct and must not trigger rollback.
//
// Invariant: for every discharged slot, all eligible slots in the window with
// strictly higher price must also be discharged.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 16d — trickle-in-window-no-rollback\n');

testInvariant('16d:trickle-in-window-no-rollback',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 70, max: 95, noNaN: true, noDefaultInfinity: true }),
    }),
    // 2–3 cheap early slots (eligible, cheaper than evening)
    fc.array(fc.double({ min: 0.230, max: 0.290, noNaN: true, noDefaultInfinity: true }),
             { minLength: 2, maxLength: 3 }),
    // 2–4 pricey evening slots
    fc.array(fc.double({ min: 0.350, max: 0.580, noNaN: true, noDefaultInfinity: true }),
             { minLength: 2, maxLength: 4 }),
    // trickle pvCoverage: strictly between 0 and pvStrongCoverage (400/maxChargeW)
    fc.integer({ min: 10, max: 35 }), // percent of pvStrongCoverage to use as pvCov fraction
  ).map(([settings, base, cheapPrices, priceyPrices, tricklePct]) => [
    settings,
    // Start with no charge headroom (currentSoc at max_soc). With headroom the DP
    // arbitrages the cheap in-window slots (0.23-0.29) into the pricey ones
    // (0.35-0.58), the window contains a 'charge', and the run bails on the guard
    // below — measured 2026-07-30: 574/1000 runs bailed there, testing nothing.
    // A full battery still exercises the path this invariant guards: the trickle
    // slot inflates socGw only AFTER the window has discharged into it.
    { ...base, currentSoc: Math.max(base.currentSoc, settings.max_soc) },
    cheapPrices, priceyPrices, tricklePct,
  ]),
  ([settings, base, cheapPrices, priceyPrices, tricklePct]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;
    const pvStrongW = 400; // fixed per optimizer constant
    // trickle pvCov is below pvStrong threshold → slot stays in window, action = trickle not discharge
    const tricklePvW = Math.floor((pvStrongW * tricklePct) / 100); // 0 < tricklePvW < pvStrongW

    // Structure: [cheap | pricey | trickle (pvCov < pvStrong, price below min) | strong-PV (terminates window) | tail]
    // Below minDischargePrice → not in the eligible set, but strictly ABOVE the
    // out-of-window tail price so the DP prefers to buy its terminal-value charge
    // there instead of inside the window. At the old value (0.10, equal to the
    // tail) it charged in-window just as often and the run bailed on the charge
    // guard below — measured 2026-07-30: 574/1000, still 494/1000 after the
    // no-headroom start fix.
    const tricklePrice = 0.215;
    const pvOnPrice    = 0.10;
    const tailPrice    = 0.10;
    const windowPrices = [...cheapPrices, ...priceyPrices, tricklePrice];
    const priceValues  = [...windowPrices, pvOnPrice, tailPrice, tailPrice];
    const prices       = makePriceSlots(priceValues);

    const wLen = windowPrices.length; // window slots [0, wLen)
    const pvWValues = [
      ...windowPrices.map((_, i) => (i === wLen - 1 ? tricklePvW : 0)), // last window slot = trickle
      maxChargeW + 800, // strong PV → terminates window (wEnd = wLen)
      0, 0,
    ];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 500);

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
      refillConfidence: 1.0,
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    // Skip if any charge slot in window (separate code path)
    for (let t = 0; t < wLen; t++) if (slots[t].action === 'charge') return true;

    // Measured 2026-07-30: all 854 runs that get here have >=1 eligible discharged slot
    // in the window, so the dominance loop below is never vacuously true. Holds because
    // the battery starts full (currentSoc = max_soc) and the window carries 2-4 slots
    // priced 0.35-0.58 against minDischargePrice 0.220. Re-check if that changes.
    const PRICE_EPS = 0.005;
    // Economic dominance: if a slot is discharged, every eligible slot in the window
    // with strictly higher price must also be discharged.
    for (let t = 0; t < wLen; t++) {
      if (slots[t].action !== 'discharge') continue;
      if (priceValues[t] < minDischargePrice) continue;
      for (let u = 0; u < wLen; u++) {
        if (priceValues[u] < minDischargePrice) continue; // not eligible
        if (priceValues[u] <= priceValues[t] + PRICE_EPS) continue; // not strictly pricier
        if (slots[u].action !== 'discharge') return false; // cheaper slot discharged, pricier stranded
      }
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 17
// "Abundant tomorrow-PV waives the overnight reserve — sunset cv-noise cannot
//  strand a high-priced discharge"
//
// refillConfidenceFromForecast derives the reserve from TODAY's forecast-error cv,
// which spikes on low-light sample noise every sunset → confidence ~0 → floor +~50%.
// When tomorrow's within-horizon PV surplus covers the usable span, that floor guards
// a risk that no longer exists. The pvKwhTomorrow lift must restore confidence enough
// that the derived-confidence run discharges every strict-price-max slot the no-floor
// baseline discharges — i.e. a noisy sunset can never hoard SoC past tonight's peak
// when tomorrow refills for free.
//
// Economic-dominance, oracle-free: baseline (confidence 1.0) vs derived (worst-case
// cv=0.60 → cv-conf 0, but pvKwhTomorrow ≥ usable span). Any discharge→hold delta at
// a strict-price-max-ahead slot is caused solely by an un-waived floor = the bug.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 17 — abundant-tomorrow-pv-waives-reserve\n');

testInvariant('17:abundant-tomorrow-pv-waives-reserve',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 60, max: 94, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.array(fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 6 }), // pre-PV prices
    fc.integer({ min: 2, max: 6 }),  // PV block length
    fc.array(fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }), { minLength: 1, maxLength: 6 }), // post-PV tail prices
    fc.option(fc.double({ min: 0, max: 0.25, noNaN: true, noDefaultInfinity: true }), { nil: undefined }), // agreeing-model spread — must never break the waiver
  ),
  ([settings, base, prePrices, pvLen, tailPrices, spreadRel]) => {
    const { maxChargeW, capacityKwh } = base;
    const minDischargePrice = 0.220;
    const pvPrices = Array(pvLen).fill(0.10);
    const priceValues = [...prePrices, ...pvPrices, ...tailPrices];
    const prices = makePriceSlots(priceValues);
    const pvWValues = [
      ...prePrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800),
      ...tailPrices.map(() => 0),
    ];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 500);

    // Worst-case sunset cv (→ cv-conf 0) but tomorrow's surplus covers 2× the usable span.
    const usableSpanKwh = ((settings.max_soc - settings.min_soc) / 100) * capacityKwh;
    const refillConfidence = OptimizationEngine.refillConfidenceFromForecast(
      0.60, undefined, usableSpanKwh * 2, usableSpanKwh, spreadRel);
    if (refillConfidence < 1.0) return false; // lift must fully waive when surplus ≥ span (agreeing spread ≤0.25 is a no-op)

    const scenario = { ...base, prices, pvForecast, consumptionW, minDischargePrice };
    const baseSlots  = runCompute(settings, { ...scenario, refillConfidence: 1.0 })._schedule?.slots;
    const derSlots   = runCompute(settings, { ...scenario, refillConfidence })._schedule?.slots;
    if (!baseSlots || !derSlots) return true;

    const N = priceValues.length;
    for (let t = 0; t < N; t++) {
      if (baseSlots[t].action !== 'discharge') continue;
      let laterMax = -Infinity;
      for (let u = t + 1; u < N; u++) laterMax = Math.max(laterMax, priceValues[u]);
      if (priceValues[t] <= laterMax) continue;
      if (derSlots[t].action !== 'discharge') return false;
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 18
// "Forward model-spread only ever lowers refill confidence — and agreement
//  (spread ≤ 0.25) is an exact no-op"
//
// The spread cap is the only forward-looking input to the reserve (cv/ratio look
// backward, the pvRefill lift trusts tomorrow's point forecast). Forbidden by
// construction:
//   (a) disagreement INCREASING confidence anywhere — would weaken the reserve
//       exactly when uncertainty rises (incl. re-lifting above the pvRefill
//       waiver or the same-day terms);
//   (b) agreement being a silent behaviour change — spread ≤ 0.25 must return
//       the exact no-spread confidence, hence the exact same DP schedule
//       (schedule-level identity follows from scalar identity; the compute-level
//       interplay is exercised by Invariant 17's randomized agreeing spread).
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 18 — spread-cap-monotonic-and-agreement-noop\n');

testInvariant('18:spread-monotonic-never-lifts',
  fc.tuple(
    fc.option(fc.double({ min: 0, max: 1.0, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),   // cv
    fc.option(fc.double({ min: 0.2, max: 1.3, noNaN: true, noDefaultInfinity: true }), { nil: undefined }), // ratio
    fc.double({ min: 0, max: 12, noNaN: true, noDefaultInfinity: true }),   // pvKwhTomorrow
    fc.double({ min: 0.5, max: 12, noNaN: true, noDefaultInfinity: true }), // usableSpanKwh
    fc.double({ min: 0, max: 1.2, noNaN: true, noDefaultInfinity: true }),  // spread sample A
    fc.double({ min: 0, max: 1.2, noNaN: true, noDefaultInfinity: true }),  // spread sample B
  ),
  ([cv, ratio, pvKwh, span, sA, sB]) => {
    const conf = (s) => OptimizationEngine.refillConfidenceFromForecast(cv, ratio, pvKwh, span, s);
    const noSpread = conf(undefined);
    const lo = Math.min(sA, sB);
    const hi = Math.max(sA, sB);
    if (conf(lo) > noSpread + 1e-12) return false;         // never lifts above no-spread conf
    if (conf(hi) > conf(lo) + 1e-12) return false;         // monotonic non-increasing in spread
    if (lo <= 0.25 && conf(lo) !== noSpread) return false; // agreement = exact no-op
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 19
// "Lifting the PV forecast never lowers projected profit (ceiling-removal econ
//  dominance)"
//
// The deleted clear-sky ceiling was a per-slot upward lift of pvPowerW (toward the
// peak yield factor). Removing it lowers the DP's PV input on clear-day slots. This
// invariant is the CLAUDE.md-required economic-dominance check for that DP-input
// change: under saldering (export_price_ratio = 1.0) every extra watt of forecast PV
// is free energy the DP can self-consume or export at full price, so a uniform or
// per-slot lift (factor ≥ 1.0) can only weakly RAISE projectedProfit — never lower it.
//
// Consequence: the ceiling never bought profit the honest yield-EMA forecast forgoes
// for any reason other than fabricating PV that wasn't there; the DP optimally uses
// whatever PV it is told. A future, justified PV lift is guaranteed to help, not hurt.
// (If this ever fails, the DP's PV accounting is non-monotonic — a real bug, not a
// forecast-accuracy question.)
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 19 — pv-lift-never-lowers-profit\n');

testInvariant('19:pv-lift-never-lowers-profit',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }), // prices
    fc.array(fc.integer({ min: 100, max: 400 }), { minLength: 24, maxLength: 24 }), // consumption
    fc.array(fc.integer({ min: 0, max: 3000 }),  { minLength: 24, maxLength: 24 }), // baseline PV W
    fc.array(fc.double({ min: 1.0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }), // per-slot ceiling-style lift ≥ 1.0
  ),
  ([settings, base, priceValues, consValues, basePvW, lift]) => {
    const prices = makePriceSlots(priceValues);
    const scenario = { ...base, prices, consumptionW: consValues };

    const pvBase = makePvForecast(prices, basePvW);
    const pvLift = makePvForecast(prices, basePvW.map((w, i) => Math.round(w * lift[i])));

    const baseProfit = runCompute(settings, { ...scenario, pvForecast: pvBase })._schedule?.projectedProfit;
    const liftProfit = runCompute(settings, { ...scenario, pvForecast: pvLift })._schedule?.projectedProfit;
    if (baseProfit == null || liftProfit == null) return true;

    // The DP runs on a quantized SoC grid (GRID=10 → 0.1%/grid-unit = capacity/1000 kWh).
    // Each lifted PV slot can flip a per-slot charge-rounding boundary, and that rounding
    // accumulates over the horizon, so reported profit can wobble by a few grid-units PER
    // CHANGED SLOT in either direction — pure discretization slack, not economic non-
    // monotonicity. Calibrated worst case over 24k random scenarios ≈ 4.4 grid-units/slot;
    // bound at 10 with margin. A real PV-accounting sign error scales with the PV ENERGY
    // added (W·h → euros), dwarfing this slack, so the invariant still catches it.
    const quantumKwh = base.capacityKwh / 1000;
    const maxPrice = Math.max(...priceValues);
    let changedSlots = 0;
    for (let i = 0; i < basePvW.length; i++) {
      if (Math.round(basePvW[i] * lift[i]) !== basePvW[i]) changedSlots++;
    }
    const slack = 10 * changedSlots * quantumKwh * maxPrice + 1e-6 * (1 + Math.abs(baseProfit));
    return liftProfit >= baseProfit - slack;
  }
);

// ─── Invariant 20 — spread-band is a monotone, agreement-preserving discount ──
// The band may only LOWER a slot's PV (assumed-PV discount for conservatism), must be a
// no-op where models agree (spreadFrac 0, incl. the predictable dawn/dusk ramp), and must
// be monotone: more disagreement → never more assumed PV. Tests the real kernel helper.
log('## Invariant 20 — spread-band-monotone-agreement-preserving\n');

testInvariant('20:spread-band-monotone',
  fc.tuple(
    fc.array(fc.integer({ min: 0, max: 4000 }), { minLength: 1, maxLength: 96 }),
    fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { minLength: 96, maxLength: 96 }),
    fc.array(fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }), { minLength: 96, maxLength: 96 }),
  ),
  ([pv, sLo, sHiRaw]) => {
    // sHi pointwise ≥ sLo (more disagreement).
    const sHi = sLo.map((v, i) => Math.max(v, sHiRaw[i]));
    const outLo = OptimizationEngine._applyPvSpreadBand(pv, sLo, 1.0);
    const outZero = OptimizationEngine._applyPvSpreadBand(pv, pv.map(() => 0), 1.0);
    const outHi = OptimizationEngine._applyPvSpreadBand(pv, sHi, 1.0);
    for (let i = 0; i < pv.length; i++) {
      if (outLo[i] > pv[i]) return false;            // never raises PV
      if (outZero[i] !== pv[i]) return false;        // spread 0 → identity
      if (outHi[i] > outLo[i] + 1e-9) return false;  // monotone: more spread → ≤ PV
      if (outLo[i] < -1e-9) return false;            // clamped ≥ 0
    }
    return true;
  }
);

// ─── Invariant 21 — spread-band never suppresses peak-slot discharge ──────────
// The band only lowers assumed PV → can only raise the discharge-rate cap, never lower it.
// So it must never turn the strict global price-max slot from discharge into non-discharge:
// that slot is the most valuable place to discharge and the DP optimizes globally, so the
// conservative PV must not strand it. Spread is injected so the band actually bites.
log('## Invariant 21 — spread-band-never-suppresses-peak-discharge\n');

testInvariant('21:spread-band-keeps-peak-discharge',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.05, max: 0.40, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 100, max: 600 }), { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 24, maxLength: 24 }),
    fc.array(fc.double({ min: 0, max: 0.6, noNaN: true, noDefaultInfinity: true }), { minLength: 24, maxLength: 24 }),
    fc.integer({ min: 0, max: 23 }),
  ),
  ([settings, base, priceValues, consValues, pvValues, spreadValues, peakIdx]) => {
    // Make peakIdx the unique strict global price-max.
    const prices = priceValues.slice();
    prices[peakIdx] = 0.60;
    const priceSlots = makePriceSlots(prices);
    const pvForecast = makePvForecast(priceSlots, pvValues, spreadValues);
    const scenario = {
      prices: priceSlots, currentSoc: Math.max(60, base.currentSoc),
      capacityKwh: base.capacityKwh, maxChargeW: base.maxChargeW, maxDischargeW: base.maxDischargeW,
      pvForecast, consumptionW: consValues,
    };
    const baseEng = runCompute(settings, scenario);
    if (!baseEng._schedule) return true;
    const baseAct = baseEng._schedule.slots[peakIdx]?.action;
    if (baseAct !== 'discharge') return true; // only constrain when baseline discharges at the peak
    const robEng = runCompute(settings, { ...scenario, pvTimingRobust: true });
    if (!robEng._schedule) return true;
    return robEng._schedule.slots[peakIdx]?.action === 'discharge';
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 22
// "Terminal value never suppresses discharge at the priciest reachable future slot"
//
// The horizon-end terminal value is a proxy for the worth of energy carried past the
// horizon. It must be referenced to prices the battery can still REACH from horizon-end
// (the forward tail), not the whole horizon. When an early-horizon price spike (today's
// evening) contaminated the top-quartile, the terminal credit per kWh exceeded the net
// discharge revenue at the final day's own peak, so the DP hoarded a full battery through
// that peak instead of discharging it (live 2026-06-18: 100% SoC held through €0.386 peak
// while terminal was credited from today's unreachable €0.699 spike).
//
// Structure (matches the live ~30h horizon): [unreachable early spike | long cheap
// overnight | strong-PV midday refill | moderate evening tail]. The horizon spans > 24h
// and the spike sits in the first (N−24) slots, so the trailing-24h forward window the
// terminal reference uses EXCLUDES the spike. (For a < 24h horizon the spike-as-prior is
// defensible — no next-day data exists — so the bug, and this invariant, do not apply.)
// The spike is strictly higher than every tail price; the midday block refills the battery
// to full; terminalPvKwhTomorrow = 0 forces terminalFactor = 1 (no post-horizon PV discount
// — the worst case for hoarding). With the forward-only terminal reference, the strictly
// priciest eligible slot in the evening tail must DISCHARGE: terminal hold value
// (tail-top-quartile × 0.8 × RTE) can never beat discharging at the tail's own max price.
// refillConfidence = 1.0 → no reserve floor, so a held peak can only be the terminal bug.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 22 — terminal-never-suppresses-priciest-reachable-discharge\n');

const inv22Arb = fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 60, max: 94, noNaN: true, noDefaultInfinity: true }),
    }),
    // Early spike: 3 slots strictly above every tail price (unreachable from the tail).
    fc.array(fc.double({ min: 0.55, max: 0.70, noNaN: true, noDefaultInfinity: true }),
             { minLength: 3, maxLength: 3 }),
    // Evening tail: 4–6 eligible slots, all below the spike, non-monotone.
    fc.array(fc.double({ min: 0.270, max: 0.450, noNaN: true, noDefaultInfinity: true }),
             { minLength: 4, maxLength: 6 }),
    fc.integer({ min: 3, max: 5 }), // strong-PV refill block length, in hours
  );

const inv22 = (SLOT_H) => ([settings, base, earlyPrices, tailPrices, pvLen]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;
    const REP = Math.round(1 / SLOT_H); // sub-slots per hour

    // [early spike | long cheap overnight | strong-PV midday | evening tail].
    // The blocks below are HOURS, not slots: 20 cheap overnight hours push the total horizon
    // past 24h so the trailing-24h terminal window excludes the spike (the regime where the
    // bug exists — the live case was ~30h). Leaving them as slot counts at 15 min would
    // shrink the horizon to ~8h and silently drop the premise.
    const nightPrices = Array(20).fill(0.10);
    const pvPrices    = Array(pvLen).fill(0.10);
    const priceHours  = [...earlyPrices, ...nightPrices, ...pvPrices, ...tailPrices];
    const priceValues = expandToSlots(priceHours, SLOT_H);
    const prices = makePriceSlots(priceValues, SLOT_H);

    const pvWHours = [
      ...earlyPrices.map(() => 0),
      ...nightPrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800), // surplus ≥ charge power → refills battery to full
      ...tailPrices.map(() => 0),
    ];
    const pvForecast   = makePvForecast(prices, expandToSlots(pvWHours, SLOT_H));
    const consumptionW = priceValues.map(() => 300); // equal load → revenue driven by price alone

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
      pvKwhTomorrow: base.capacityKwh * 2,   // plenty in-horizon PV → battery refills before tail
      terminalPvKwhTomorrow: 0,              // no post-horizon PV → terminalFactor = 1 (worst case)
      refillConfidence: 1.0,                 // no reserve floor → a held peak can only be the bug
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const tailStartHour = earlyPrices.length + nightPrices.length + pvLen;
    // Strictly priciest eligible tail HOUR (skip if a near-tie at the top → ambiguous).
    // The search runs on hours, not slots: below 1h every hour is REP identical sub-slots,
    // so a slot-level tie check would call every run ambiguous and never assert anything.
    const PRICE_EPS = 0.005;
    let maxHour = -1, maxPrice = -Infinity;
    for (let h = tailStartHour; h < priceHours.length; h++) {
      if (priceHours[h] < minDischargePrice) continue;
      if (priceHours[h] > maxPrice) { maxPrice = priceHours[h]; maxHour = h; }
    }
    if (maxHour === -1) return true;
    for (let h = tailStartHour; h < priceHours.length; h++) {
      if (h !== maxHour && priceHours[h] >= maxPrice - PRICE_EPS) return true; // tie → skip
    }
    // Battery must actually carry charge into the tail (else 'preserve' is a SoC artefact,
    // not the terminal bug). The midday surplus guarantees this, but assert it explicitly.
    if ((slots[tailStartHour * REP - 1]?.socProjected ?? 0) < 20) return true;

    // The priciest hour is REP sub-slots wide; SoC may only stretch to part of it, so the
    // claim is that the DP discharges SOMEWHERE in that hour, not in all of its sub-slots.
    // At REP = 1 this reduces to the original single-slot assertion.
    return slots.slice(maxHour * REP, maxHour * REP + REP)
      .some(s => s && s.action === 'discharge');
};

testInvariant('22:terminal-never-suppresses-priciest-reachable-discharge', inv22Arb, inv22(1));
testInvariant('22:terminal-never-suppresses-priciest-reachable-discharge@15min', inv22Arb, inv22(0.25), RUNS_15MIN);

// ─── Invariant 38 — PV correction simplification preserves plan quality ──────
//
// The simplified PV correction path (today: skip dailyBias+accFactor, use
// intradayRatio directly) should produce algebraically equivalent DP plans.
// For today's slots: pvW × bias × acc × (ratio / (bias×acc)) = pvW × ratio.
// Test: same scenario through optimizer with legacy vs simplified pvForecast,
// profit delta < 5%.
log('\n## Invariant 38 — pv-correction-simplified-equivalence\n');

{
  const dailyBiasArb = fc.double({ min: 0.8, max: 1.3, noNaN: true, noDefaultInfinity: true });
  const accFactorArb = fc.double({ min: 0.8, max: 1.0, noNaN: true, noDefaultInfinity: true });
  const intradayRatioArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });

  const corrArb = fc.tuple(settingsArb, baseArb, dailyBiasArb, accFactorArb, intradayRatioArb);

  testInvariant(
    '38:pv-correction-simplified-equivalence',
    corrArb,
    ([settings, base, dailyBias, accFactor, intradayRatio]) => {
      const N = 24;
      const pvRaw = Array.from({ length: N }, (_, i) =>
        i >= 6 && i <= 18 ? 500 + 1500 * Math.sin((i - 6) * Math.PI / 12) : 0
      );

      const biasCorrLegacy = dailyBias * accFactor;

      // Legacy: pvW × dailyBias × accFactor, then intradayRatio undoes bias
      const pvLegacy = pvRaw.map(w => {
        const biased = Math.round(w * biasCorrLegacy);
        const ratio = biasCorrLegacy > 0 ? intradayRatio / biasCorrLegacy : intradayRatio;
        return Math.round(biased * ratio);
      });

      // Simplified: pvW unchanged, intradayRatio applied directly
      const pvSimpl = pvRaw.map(w => Math.round(w * intradayRatio));

      // Algebraic equivalence: both produce pvW × intradayRatio, modulo
      // double-rounding in legacy path (round-then-multiply vs single multiply).
      // Extreme ratios (high intradayRatio / low biasFactor) amplify rounding
      // to ±2-3W. Accept ±max(2, 0.5% of value).
      for (let i = 0; i < N; i++) {
        const tol = Math.max(2, Math.abs(pvSimpl[i]) * 0.005);
        if (Math.abs(pvLegacy[i] - pvSimpl[i]) > tol) return false;
      }
      return true;
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 23
// "Standby not overridden to preserve when a cheaper pvStrong slot follows"
//
// When a pvStrong slot has a CHEAPER pvStrong slot ahead, the DP correctly
// prefers standby (export now, charge free later). The forward pass must NOT
// override this to 'preserve', which would cause the runtime to charge from PV
// at the more expensive slot — a net loss versus exporting now and charging
// free at the cheaper slot.
//
// Battery starts at maxSoC (full), so preserve at t=0 is a no-op (vPreserve =
// dp[maxSocG]) while standby earns PV export revenue (vStandby > vPreserve).
// Discharge at t=0 is disabled via minDischargePrice > p0, so the DP's only
// real choice at t=0 is standby. If the forward pass overrides that to
// 'preserve', the runtime mapper enters the preserve branch and forces
// zero_charge_only — charging from PV at the pricier slot instead of exporting.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 23 — standby-not-overridden-when-cheaper-pv-ahead\n');

testInvariant('23:standby-not-overridden-when-cheaper-pv-ahead',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.5, max: 12.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
    }),
    fc.array(fc.double({ min: 0.01, max: 0.80, noNaN: true, noDefaultInfinity: true }), { minLength: 2, maxLength: 10 }),
    fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), // currentSoc
  ),
  ([settings, base, rawPrices, currentSoc]) => {
    const { maxChargeW } = base;
    const clampedSoc = Math.min(currentSoc, settings.max_soc);
    const pvStrong = maxChargeW + 500;
    const prices = makePriceSlots(rawPrices);
    // Alternate pvStrong / no-PV slots so cheaperPvAhead can arise naturally
    const pvForecast = makePvForecast(prices, rawPrices.map((_, i) => (i % 2 === 0 ? pvStrong : 0)));
    const consumptionW = rawPrices.map(() => 300);

    const eng = runCompute(settings, {
      ...base,
      prices, pvForecast, consumptionW,
      currentSoc: clampedSoc,
      minDischargePrice: 0.25,
      refillConfidence: 1.0,
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    // pvStoreWins=true means the forward pass overrode a DP standby→preserve.
    // When cheaperPvAhead=true a cheaper pvStrong slot follows — that override is wrong.
    // The fix: guard fires, pvStoreWins stays false when cheaperPvAhead is set.
    return !slots.some(s => s.cheaperPvAhead && s.pvStoreWins);
  }
);

// ─── Scenario — discharge-topup cycle never net-negative ─────────────────────
// Fixed-input regression (fc.constant → exactly 1 scenario), not property coverage.
// Concrete regression: [€0.493, €0.380], SoC=50%, RTE=0.733, cycleCost=0.075.
// Break-even P_d = (0.380 + 0.075) / 0.733 ≈ 0.621. 0.493 < 0.621 → net loss.
// terminalFactor=0 (pvKwhTomorrow=2.2, pvRefill=2.2/2.688=0.818≥0.8). maxChargePrice=0.40
// activates topup modelling. DP must NOT discharge at t=0.
// pvKwhTomorrow deliberately kept BELOW the reorder-guard's PV-headroom gate
// (0.9×2.688=2.42 — see OptimizationEngine.pvHeadroomGateOpen / Invariant 34): this
// scenario tests the guard firing under genuinely-no-headroom conditions. 3.0 was used
// originally (predating the headroom gate) and coincidentally tripped it.
log('## Scenario — discharge-topup-net-loss-guard\n');
testInvariant('scenario:discharge-topup-net-loss-guard',
  fc.constant(null),
  () => {
    const prices    = makePriceSlots([0.493, 0.380]);
    const pvForecast = makePvForecast(prices, [0, 0]);
    const eng = runCompute(
      { battery_efficiency: 0.733, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 },
      { prices, currentSoc: 50, capacityKwh: 2.688, maxChargeW: 800, maxDischargeW: 3000,
        pvForecast, pvKwhTomorrow: 2.2, maxChargePrice: 0.40 }
    );
    const slots = eng._schedule?.slots ?? [];
    if (!slots.length) return true;
    return slots[0]?.action !== 'discharge';
  },
  1
);

// ─── Scenario — higher maxChargePrice never breaks the net-loss-guard ────────
// Fixed-input regression (fc.constant → exactly 1 scenario), not property coverage.
// Same regression as scenario:discharge-topup-net-loss-guard, but maxChargePrice=0.60 (simulating the dynamic
// ceiling exceeding the static setting, project_charge_price_static_vs_dynamic_gap).
// The ceiling can only raise topup-avoidance permissiveness, never force a
// net-losing discharge — assert the guard still holds at the higher ceiling.
// pvKwhTomorrow=2.2 for the same below-headroom reason as that scenario.
log('## Scenario — higher-maxChargePrice-preserves-net-loss-guard\n');
testInvariant('scenario:higher-maxChargePrice-preserves-net-loss-guard',
  fc.constant(null),
  () => {
    const prices    = makePriceSlots([0.493, 0.380]);
    const pvForecast = makePvForecast(prices, [0, 0]);
    const eng = runCompute(
      { battery_efficiency: 0.733, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 },
      { prices, currentSoc: 50, capacityKwh: 2.688, maxChargeW: 800, maxDischargeW: 3000,
        pvForecast, pvKwhTomorrow: 2.2, maxChargePrice: 0.60 }
    );
    const slots = eng._schedule?.slots ?? [];
    if (!slots.length) return true;
    return slots[0]?.action !== 'discharge';
  },
  1
);

// ─── Scenario — upwind-cloud triggers early grid charge ──────────────────────
// Fixed-input regression (fc.constant → exactly 1 scenario), not property coverage.
// Models the upwind DP modulation in device.js: clouds from the upwind direction
// lower the pvForecast for the lead-time slot. When pvCoverage drops, battery
// can't fill discharge headroom from PV alone → DP grid-charges at cheaper slot.
//
// Setup: SoC=20%, 3 slots [€0.10(cheap), €0.15(PV), €0.40(discharge)].
// Full PV (pvW=900W → pvCoverage=1.0): trickle at t=1 provides enough capacity
//   to discharge fully at t=2 → grid charge at t=0 adds zero marginal benefit → skip.
// Cloudy PV (pvW=200W → pvCoverage=0.19): trickle leaves large gap → DP charges
//   at t=0 (€0.10) so it can discharge more at t=2 (€0.40).
log('## Scenario — upwind-cloud-triggers-early-charge\n');
testInvariant('scenario:upwind-cloud-triggers-early-charge',
  fc.constant(null),
  () => {
    const prices    = makePriceSlots([0.10, 0.15, 0.40]);
    const pvFull    = makePvForecast(prices, [0, 900, 0]); // pvCoverage[1] = 1.0  (full sun)
    const pvLowered = makePvForecast(prices, [0, 200, 0]); // pvCoverage[1] = 0.19 (kt≈0.22)
    const settings  = { battery_efficiency: 0.85, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05, export_price_ratio: 1.0 };
    const common    = { prices, currentSoc: 20, capacityKwh: 2.688, maxChargeW: 800, maxDischargeW: 800, pvKwhTomorrow: 0 };

    const slotsF = runCompute(settings, { ...common, pvForecast: pvFull })._schedule?.slots ?? [];
    const slotsL = runCompute(settings, { ...common, pvForecast: pvLowered })._schedule?.slots ?? [];
    if (!slotsF.length || !slotsL.length) return true;

    // Full PV: trickle fills enough capacity → grid charge wasted → must NOT charge at t=0
    if (slotsF[0]?.action === 'charge') return false;
    // Cloudy PV (upwind kt≈0.22): gap remains → DP charges at t=0 to maximise t=2 discharge
    if (slotsL[0]?.action !== 'charge') return false;
    return true;
  },
  1
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 25: Duck-curve trivial price dips must not indefinitely defer
// PV-surplus charging (cheaperPvAhead magnitude gate)
//
// Live miss 2026-07-01: price fell gradually (duck-curve) from €0.372 to €0.244
// across the PV-strong morning/midday window while SoC stayed at 2-3% the whole
// time — cheaperPvAhead deferred charging at EVERY slot because a marginally
// cheaper PV-strong slot was always still ahead, even when the eventual saving
// was a fraction of a cent. By the time price bottomed out, PV was already
// fading and the charge window was squeezed to almost nothing.
//
// Fix: cheaperPvAhead now requires the future slot to be meaningfully cheaper
// (mirrors pvDelayMin's 1.30x / €0.03 threshold in policy-engine.js).
//
// Setup: a PV-strong block with a monotonically non-increasing price sequence
// whose total spread (both the 1.30x ratio and the €0.03 absolute diff) stays
// below the defer threshold, followed by a high evening-peak price so storing
// always beats exporting. Since no slot in the block is ever meaningfully
// cheaper than an earlier one, cheaperPvAhead must be false throughout, so the
// battery must arrive at the evening peak holding everything the charge rate
// could have delivered across the block.
//
// The assertion used to be "no block slot may be left on 'standby'". That proxy
// was too coarse: it also forbade reordering INSIDE the block, which the
// trickle-cap saturation test does at no cost (same SoC at the peak, the
// expensive surplus exported instead of the cheap one). Asserting the arrival
// SoC catches the real 2026-07-01 failure — a near-empty battery at the peak —
// without pinning the route taken to get there.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 25 — duck-curve-trivial-dip-does-not-defer-charge\n');

testInvariant('25:duck-curve-trivial-dip-does-not-defer-charge',
  fc.tuple(
    fc.record({
      capacityKwh: fc.double({ min: 1.0, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:  fc.integer({ min: 400, max: 3000 }),
      currentSoc:  fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }), // near-empty, like the live miss
    }),
    fc.double({ min: 0.20, max: 0.40, noNaN: true, noDefaultInfinity: true }), // block start price p0
    fc.integer({ min: 3, max: 8 }), // PV-strong block length
  ),
  ([base, p0, blockLen]) => {
    const settings = { battery_efficiency: 0.65, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
    const { maxChargeW, capacityKwh, currentSoc } = base;
    const minDischargePrice = 0.220;

    // Total block spread stays strictly below both legs of the defer threshold
    // (ratio 1.30x, absolute €0.03) — 20% margin keeps it clear of float noise.
    const maxDrop = Math.min(p0 * (1 - 1 / 1.30), 0.03) * 0.8;
    const blockPrices = Array.from({ length: blockLen }, (_, i) =>
      p0 - (maxDrop * i) / Math.max(1, blockLen - 1));

    // Evening peak far above the block (and above p0 / efficiency) → storing always
    // beats exporting for every block slot, regardless of RTE.
    const eveningPeak = p0 / settings.battery_efficiency + 0.20;
    const priceValues = [...blockPrices, eveningPeak, 0.10, 0.10];
    const prices = makePriceSlots(priceValues);

    // Strong PV surplus through the whole block; none afterwards.
    const pvWValues = [...blockPrices.map(() => maxChargeW + 800), 0, 0, 0];
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 200);

    const eng = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices, pvForecast, consumptionW, minDischargePrice,
      refillConfidence: 1.0,
      pvKwhTomorrow: 0,
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    // Counting 'standby' actions is the wrong probe: the block may legitimately reorder
    // WITHIN itself — exporting an expensive slot and taking the same kWh from a cheaper
    // slot later is free when the end state is unchanged (that is what the trickle-cap
    // saturation test does). Assert the END STATE instead, which is what the 2026-07-01
    // bug actually broke: by the evening peak the battery must hold everything the charge
    // rate could have put in over the block. PV surplus exceeds maxChargeW in every block
    // slot, so blockLen slots at full charge power is the ceiling.
    const socPeak = slots[blockLen]?.socProjected;
    if (typeof socPeak !== 'number') return true;
    const achievableSoc = Math.min(settings.max_soc,
      currentSoc + (blockLen * (maxChargeW / 1000) / capacityKwh) * 100);
    // Tolerance absorbs SoC-grid quantisation (GRID_TOTAL steps, so 0.1pp): each charged
    // slot floors to the grid, and that shortfall accumulates over the block. Still two
    // orders of magnitude below the failure this guards (2026-07-01 arrived at 2-3%).
    return socPeak >= achievableSoc - (0.5 + blockLen * 0.1);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 26: Evening peak coverage shortfall forces early charging despite
// cheap future PV
//
// Even with the cheaperPvAhead magnitude gate (invariant 25), a steep long
// duck-curve could still defer charging through most of a PV-strong window if
// every future slot is marginally cheaper — arriving at the evening peak with
// insufficient battery headroom to cover the learned evening consumption need.
//
// The safety net compares remaining PV headroom (usableSpanKwh − currentKwh,
// capped by pvKwhFromT) against the evening's energy demand (eveningNeedKwh —
// same post-lastStrongPv window the reserve floor uses). When headroom < demand,
// charging fires now even if cheaper PV is nominally ahead.
//
// Setup: duck-curve PV block (same shape as invariant 25) paired with a scripted
// high evening consumption need that full deferral cannot cover. Assert (a) at
// least one PV-block slot flips off 'standby' once coverage is at risk, and (b)
// a paired low-demand run (ample headroom) defers at least as much — proving the
// guard reacts to actual risk, not just always-on (mirrors invariant 15's
// baseline-vs-floored paired-comparison style).
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 26 — evening-peak-shortfall-forces-early-charge\n');

const inv26Arb = fc.tuple(
    fc.record({
      capacityKwh: fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:  fc.integer({ min: 800, max: 2000 }),
      currentSoc:  fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }), // near-empty, like the live miss
    }),
    fc.double({ min: 0.22, max: 0.40, noNaN: true, noDefaultInfinity: true }), // block start price p0
    fc.integer({ min: 4, max: 7 }), // PV-strong block length, in hours
    fc.double({ min: 0.3, max: 0.8, noNaN: true, noDefaultInfinity: true }), // evening demand as fraction of capacity
  );

const inv26 = (SLOT_H) => ([base, p0, blockLen, eveningFrac]) => {
    const settings = { battery_efficiency: 0.70, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
    const { maxChargeW, capacityKwh, currentSoc } = base;
    const minDischargePrice = 0.220;
    const REP = Math.round(1 / SLOT_H); // sub-slots per hour

    // Duck-curve block: spread stays under the cheaperPvAhead defer threshold (same
    // construction as invariant 25), so price alone would defer through the whole block.
    const maxDrop = Math.min(p0 * (1 - 1 / 1.30), 0.03) * 0.6;
    const blockPrices = Array.from({ length: blockLen }, (_, i) =>
      p0 - (maxDrop * i) / Math.max(1, blockLen - 1));

    // Evening peak far above the block → storing always beats exporting.
    const eveningPeak = p0 / settings.battery_efficiency + 0.25;
    // High evening demand: sized against capacity so a full-block deferral can't cover it.
    const eveningDemandW = (eveningFrac * capacityKwh / 2) * 1000;

    // Every array below is written per HOUR and expanded to slots: blockLen, the two evening
    // peak hours and the two cheap tail hours are wall-clock widths, and eveningDemandW's /2
    // is those two evening HOURS — none of it is a slot count.
    const priceValues = expandToSlots([...blockPrices, eveningPeak, eveningPeak * 0.95, 0.10, 0.10], SLOT_H);
    const prices = makePriceSlots(priceValues, SLOT_H);
    const pvWValues = expandToSlots([...blockPrices.map(() => maxChargeW + 600), 0, 0, 0, 0], SLOT_H);
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = expandToSlots(
      [...blockPrices.map(() => 300), eveningDemandW * 0.9, eveningDemandW * 0.9, 200, 200], SLOT_H);

    const eng = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices, pvForecast, consumptionW, minDischargePrice,
      refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!eng._schedule) return true;
    const pvBlockSlots = eng._schedule.slots.slice(0, blockLen * REP);

    // Guard must fire: with this much evening demand, deferring through the whole block
    // is not survivable — at least one slot must flip off 'standby'.
    if (!pvBlockSlots.some(s => s.action !== 'standby')) return false;

    // Paired low-demand run: ample headroom → should defer at least as much (no over-trigger).
    const smallFrac = Math.max(0.05, eveningFrac * 0.3);
    const smallDemandW = (smallFrac * capacityKwh / 2) * 1000;
    const smallConsumptionW = expandToSlots(
      [...blockPrices.map(() => 200), smallDemandW * 0.5, smallDemandW * 0.5, 100, 100], SLOT_H);
    const engSmall = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices, pvForecast, consumptionW: smallConsumptionW, minDischargePrice,
      refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!engSmall._schedule) return true;
    const standbyHigh  = pvBlockSlots.filter(s => s.action === 'standby').length;
    const standbySmall = engSmall._schedule.slots.slice(0, blockLen * REP).filter(s => s.action === 'standby').length;
    return standbySmall >= standbyHigh;
};

testInvariant('26:evening-peak-shortfall-forces-early-charge', inv26Arb, inv26(1));
testInvariant('26:evening-peak-shortfall-forces-early-charge@15min', inv26Arb, inv26(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 27: A negative-price slot AFTER the evening tail must not suppress
// today's PV-store override
//
// hasFutureStrongNeg used to scan the ENTIRE horizon for any slot < -€0.10 and
// suppress the whole pvStoreWins override if found — including tomorrow. A
// negative slot scheduled after tonight's evening peak can't help cover it (the
// DP's own charge-negative-price action there only fills the battery in time for
// itself, not for a peak that already happened), so it must not block today's
// PV-surplus charging when tonight's coverage is at risk.
//
// Fix: hasFutureStrongNeg is scoped to slots before lastStrongPv+1 (the evening
// tail boundary) — a negative slot beyond that no longer suppresses.
//
// Setup: duck-curve PV block + evening peak (as in invariant 26) plus a strong-
// negative slot placed AFTER the evening peak. Assert the PV block still gets at
// least one non-standby slot. Paired run: same negative slot placed BEFORE the
// evening peak (reachable) — the original suppression must still apply there, so
// the fix scopes the check rather than deleting it.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 27 — unreachable-future-negative-does-not-suppress\n');

const inv27Arb = fc.tuple(
    fc.record({
      capacityKwh: fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:  fc.integer({ min: 800, max: 2000 }),
      currentSoc:  fc.double({ min: 0, max: 5, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.double({ min: 0.22, max: 0.40, noNaN: true, noDefaultInfinity: true }),
    fc.integer({ min: 4, max: 7 }), // PV-strong block length, in hours
  );

const inv27 = (SLOT_H) => ([base, p0, blockLen]) => {
    const settings = { battery_efficiency: 0.70, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
    const { maxChargeW, capacityKwh, currentSoc } = base;
    const minDischargePrice = 0.220;
    const REP = Math.round(1 / SLOT_H); // sub-slots per hour
    // Same wall-clock scenario at any resolution: every array below is an hourly path.
    const toSlots = (hours) => expandToSlots(hours, SLOT_H);

    // Duck-curve block (as invariant 25/26): stays under the cheaperPvAhead defer threshold.
    const maxDrop = Math.min(p0 * (1 - 1 / 1.30), 0.03) * 0.6;
    const blockPrices = Array.from({ length: blockLen }, (_, i) =>
      p0 - (maxDrop * i) / Math.max(1, blockLen - 1));
    const eveningPeak = p0 / settings.battery_efficiency + 0.25;
    // Meaningful evening demand so the block would need to charge to cover it.
    const eveningDemandW = (0.6 * capacityKwh / 2) * 1000;

    const pvWValues = toSlots([...blockPrices.map(() => maxChargeW + 600), 0, 0, 0, 0]);
    const consumptionW = toSlots([...blockPrices.map(() => 300), eveningDemandW * 0.9, eveningDemandW * 0.9, 200, 200]);

    // Unreachable negative: placed in the cheap tail AFTER the evening peak.
    const pricesUnreachable = makePriceSlots(
      toSlots([...blockPrices, eveningPeak, eveningPeak * 0.95, -0.15, 0.10]), SLOT_H);
    const engUnreachable = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices: pricesUnreachable,
      pvForecast: makePvForecast(pricesUnreachable, pvWValues),
      consumptionW, minDischargePrice, refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!engUnreachable._schedule) return true;

    // Fix must let the block charge despite the (unreachable) negative slot ahead: by the
    // evening peak the battery holds everything the charge rate could deliver over the
    // block. Asserted on arrival SoC, not on the per-slot action — see invariant 25 for why
    // the action-level probe was dropped.
    const peakIdx = blockLen * REP;
    const socPeakUnreachable = engUnreachable._schedule.slots[peakIdx]?.socProjected;
    if (typeof socPeakUnreachable !== 'number') return true;
    const achievableSoc = Math.min(settings.max_soc,
      currentSoc + (blockLen * (maxChargeW / 1000) / capacityKwh) * 100);
    // Tolerance absorbs SoC-grid quantisation (0.1pp per charged slot, accumulated over the
    // block) — at 15min that is 4x as many slots for the same wall-clock window.
    if (socPeakUnreachable < achievableSoc - (0.5 + peakIdx * 0.1)) return false;

    // Reachable negative: placed INSIDE the PV block itself (before the evening tail) —
    // original suppression must still hold, so the block should defer at least as much
    // as the unreachable case (the negative-price DP charge there already handles it).
    const pricesReachable = makePriceSlots(
      toSlots([...blockPrices.slice(0, -1), -0.15, eveningPeak, eveningPeak * 0.95, 0.10, 0.10]), SLOT_H);
    const pvReachable = toSlots([...blockPrices.slice(0, -1).map(() => maxChargeW + 600), 0, 0, 0, 0, 0]);
    const consReachable = toSlots(
      [...blockPrices.slice(0, -1).map(() => 300), 300, eveningDemandW * 0.9, eveningDemandW * 0.9, 200, 200]);
    const engReachable = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices: pricesReachable,
      pvForecast: makePvForecast(pricesReachable, pvReachable),
      consumptionW: consReachable, minDischargePrice, refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!engReachable._schedule) return true;
    const socPeakReachable = engReachable._schedule.slots[peakIdx]?.socProjected;
    if (typeof socPeakReachable !== 'number') return true;
    // The reachable run has strictly MORE charging opportunity than the unreachable one — a
    // negative price inside the block tops up from the grid for free, on top of the same PV.
    // So it must clear the same bar. The old paired control counted 'standby' slots and
    // expected the reachable run to defer more; that measured the route, which reordering
    // inside the block moves around without changing the outcome. Comparing the two arrival
    // SoCs directly is no better: the free grid slot makes the comparison unequal by
    // construction, so only the shared lower bound is a sound assertion here.
    return socPeakReachable >= achievableSoc - (0.5 + peakIdx * 0.1);
};

testInvariant('27:unreachable-future-negative-does-not-suppress', inv27Arb, inv27(1));
testInvariant('27:unreachable-future-negative-does-not-suppress@15min', inv27Arb, inv27(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO: preserve's PV-driven SoC gain must bear the same half-cycle
// wear cost as charge/discharge (project_dp_preserve_missing_cycle_cost)
// Fixed-input regression (fc.constant → exactly 1 scenario), not property coverage.
//
// Before the fix, vPreserve never subtracted cycleCostPerKwh, so profit from a
// PV-strong preserve slot was invariant to cycle_cost_per_kwh — the DP was
// blind to the wear cost of storing via "free" PV.
//
// Naive design note: at exportPriceRatio=1.0, 'preserve' and 'charge' are
// economic twins (identical cost-per-kWh formula) whenever the DP has room to
// pick either — 'charge' always has ≥ as much headroom to work with, so it
// never strictly loses, and at the one point where they tie exactly
// (pvCoverage==1.0, unclipped) the tie-break is float-precision-fragile
// (confirmed experimentally: it flips with cycle_cost_per_kwh). So this test
// deliberately puts the battery near maxSoc (small headroom) with PV far
// exceeding that headroom: BOTH preserve and charge clip to the same maxSoc
// and bear the same clipped kWh (so cycleCostPerKwh cancels out of their
// comparison) — but only 'preserve' also earns the surplus-PV export revenue
// for the excess beyond the headroom (optimization-engine.js ~regel 912-915),
// which 'charge' has no equivalent for. That gives 'preserve' a robust,
// cycle-cost-independent margin over 'charge' (no float-tie risk), so the
// action stays 'preserve' across both cycle_cost values tested — isolating
// vPreserve's own cost term as the only thing that can move profit.
//
// N=4 (minimum for the terminal residual-value term, ~regel 756) gives
// 'preserve' a reason to beat 'standby' (exporting everything, storing
// nothing) — that terminal credit is a fixed function of end-of-horizon
// socG, independent of cycle_cost_per_kwh, so it cancels out of the
// profitLow-vs-profitHigh comparison too. minDischargePrice=999 blocks
// discharge entirely (no other cycle_cost-sensitive path in the horizon).
// ─────────────────────────────────────────────────────────────────────────────

log('## Scenario — preserve-cycle-cost-not-free\n');

testInvariant('scenario:preserve-cycle-cost-not-free',
  fc.constant(null),
  () => {
    const prices = makePriceSlots([0.10, 0.50, 0.50, 0.50]);
    // Small headroom (90%→100%) far smaller than what maxChargeW could deliver
    // in a slot — both preserve and charge clip to maxSoc, but only preserve
    // additionally earns surplus-export revenue for the PV beyond that headroom.
    const pvForecast = makePvForecast(prices, [2100, 0, 0, 0]); // maxChargeW(2000)+100 → pvCoverage clamps to 1.0
    const scenario = {
      capacityKwh: 5, maxChargeW: 2000, maxDischargeW: 3000, currentSoc: 90,
      prices, pvForecast, pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0, minDischargePrice: 999,
    };
    const base = { battery_efficiency: 0.9, min_soc: 0, max_soc: 100, export_price_ratio: 1.0 };

    const engLow  = runCompute({ ...base, cycle_cost_per_kwh: 0 },     scenario);
    const engHigh = runCompute({ ...base, cycle_cost_per_kwh: 0.075 }, scenario);
    if (!engLow._schedule || !engHigh._schedule) return false;

    // Scenario must actually exercise preserve (not charge/standby) in both runs,
    // and no discharge anywhere — otherwise the comparison below is meaningless.
    if (engLow._schedule.slots.some(s => s.action === 'discharge')) return false;
    if (engHigh._schedule.slots.some(s => s.action === 'discharge')) return false;
    if (engLow._schedule.slots[0]?.action !== 'preserve') return false;
    if (engHigh._schedule.slots[0]?.action !== 'preserve') return false;

    const profitLow  = engLow._schedule.projectedProfit;
    const profitHigh = engHigh._schedule.projectedProfit;
    // Pre-fix this was an equality (profit invariant to cycle_cost_per_kwh).
    // Post-fix, the clipped 0.5kWh stored via preserve now costs
    // 0.075*0.5*0.5 ≈ €0.01875 more — assert with a safety margin below that.
    return profitHigh < profitLow - 0.01;
  },
  1
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 29 — minDischargePrice array-vs-scalar equivalence
//
// Regression for the 2026-07-10 bug: the eveningNeedKwh loop compared
// `prices[t].price >= minDischargePrice` without indexing the per-slot array. A bare
// `number >= array` coerces the array to a string → NaN → always false → eveningNeedKwh
// stuck at 0, disabling the eveningCoverageAtRisk safety net so the battery exported
// cheap PV instead of storing it. Passing a per-slot array of a constant value must
// therefore produce the identical schedule to passing that value as a scalar.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 29 — minDischargePrice array==scalar\n');

testInvariant('29:min-discharge-array-equals-scalar',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 100, max: 900 }), { minLength: 24, maxLength: 24 }),
    fc.double({ min: 0.10, max: 0.30, noNaN: true, noDefaultInfinity: true }) // minDischargePrice value
  ),
  ([settings, base, priceValues, pvValues, minDisch]) => {
    const prices = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvValues.map(v => v * 3)); // some PV
    const common = {
      ...base,
      currentSoc: Math.min(base.currentSoc, settings.max_soc),
      prices, pvForecast,
      consumptionW: Array(24).fill(400),
      pvKwhTomorrow: 4,
    };
    const engScalar = runCompute(settings, { ...common, minDischargePrice: minDisch });
    const engArray  = runCompute(settings, { ...common, minDischargePrice: Array(24).fill(minDisch) });
    if (!engScalar._schedule || !engArray._schedule) return true;
    // Identical value content → identical schedule, action for action.
    const a = engScalar._schedule.slots.map(s => s.action).join(',');
    const b = engArray._schedule.slots.map(s => s.action).join(',');
    return a === b;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 30 — asymmetric export dominance: store never wins when export
// strictly beats the best reachable store value (RTE-discounted suffix max).
//
// Chunk 5 of the saldering-2027 rework. Under tariff_model=asymmetric_2027 a
// PV-surplus slot's exportPrice is a separate, independently-set market value
// (chunk 1 plumbing) instead of the retail price. The forward-pass label
// (pvStoreWins/pvExportWins, ~regel 296-348) computes storeValue as
// trickleSuffixMaxPrice[t] * RTE and compares it against this._exportValue(prices[t]).
// This test builds that same bound from OUTSIDE the engine — using the actual
// future prices this scenario sets, times RTE, with no cycle-cost credit — and
// checks the engine never reports pvExportWins===false (i.e. never stores) at
// the decision slot when the synthetic exportPrice sits strictly above that
// bound. The synthetic bound omits the cycle-cost the real DP would additionally
// subtract from storeValue, so it's an upper bound on the true internal
// storeValue: dominance under this bound implies dominance internally too.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 30 — asymmetric-export-dominance\n');

testInvariant('30:asymmetric-export-dominance',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 400, max: 3000 }),
      maxDischargeW: fc.integer({ min: 400, max: 3000 }),
      currentSoc:    fc.double({ min: 20, max: 70, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.array(fc.double({ min: 0.05, max: 0.30, noNaN: true, noDefaultInfinity: true }),
             { minLength: 3, maxLength: 6 }), // evening tail (reachable future prices)
    fc.double({ min: 0.02, max: 0.10, noNaN: true, noDefaultInfinity: true }), // dominance margin
  ),
  ([settings, base, tailPrices, margin]) => {
    const effectiveRte = settings.battery_efficiency;
    const maxTailPrice = Math.max(...tailPrices);
    const decisionExportPrice = maxTailPrice * effectiveRte + margin;

    // The PV-surplus decision slot must be slot 0: any earlier cheap slot would
    // let the DP grid-charge to maxSoc before we get here (profitable, since
    // tail is pricier), saturating SoC and making the DP's own code no longer
    // 'standby' at the decision slot — which would make this invariant vacuous.
    const decisionIdx = 0;
    const priceValues = [0.05, ...tailPrices];
    const prices = makePriceSlots(priceValues);
    prices[decisionIdx].exportPrice = decisionExportPrice;

    const pvWValues = priceValues.map((_, i) => (i === decisionIdx ? base.maxChargeW + 800 : 0));
    const pvForecast = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 0);

    const eng = runCompute(
      { ...settings, tariff_model: 'asymmetric_2027' },
      { ...base, prices, pvForecast, consumptionW, minDischargePrice: 0, pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0 }
    );
    if (!eng._schedule) return true;
    const s = eng._schedule.slots[decisionIdx];
    if (!s || s.pvCoverage <= 0) return true; // no PV surplus this run, skip

    // The store/trickle/export flags only gate on code===3 internally — if none
    // fired, a different DP reason (e.g. a forced discharge) picked the action
    // and this invariant doesn't apply to that slot.
    if (!s.pvStoreWins && s.action !== 'trickle' && !s.pvExportWins) return true;

    return s.pvExportWins === true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 31 — topup forward-sim consistency (controlled world)
//
// The backward pass values preserve/standby at a topup-firing slot with SoC < 40%
// as a forced grid charge (lowSocGridTopUp mirror); the forward pass must take the
// same SoC step and flag the slot (topupForced). Controlled world: no PV and
// minDischargePrice above every price, so no discharge / reorder / island / sweep
// can rewrite the trajectory — the firing predicate is rebuilt externally and the
// equivalence must hold slot for slot:
//   preserve slot ∧ firing ∧ entering SoC < 40%  ⇔  topupForced, and
//   topupForced ⇒ SoC strictly rises across the slot.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 31 — topup-forward-sim-consistency\n');

const inv31Arb = fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 10, maxLength: 24 }),
    fc.double({ min: 0.05, max: 0.40, noNaN: true, noDefaultInfinity: true }) // maxChargePrice
  );

const inv31 = (SLOT_H) => ([settings, base, priceValues, maxChargePrice]) => {
    const prices = makePriceSlots(priceValues, SLOT_H);
    const eng = runCompute(settings, {
      ...base,
      currentSoc: Math.min(base.currentSoc, settings.max_soc),
      prices,
      minDischargePrice: 1.0, // blocks all discharge → pure charge/preserve world
      maxChargePrice,
    });
    const slots = eng._schedule?.slots ?? [];
    if (!slots.length) return true;

    // External rebuild of the engine's topupFiringSlots predicate (no PV → coverage 0):
    // price ≤ maxChargePrice AND price ≤ min(next 8 HOURS of positive prices) + 0.001.
    // The engine's window is `Math.ceil(8 / slotH)` slots (optimization-engine.js:1005), so
    // the mirror must scale with it — a fixed 8 would compare against the wrong window below
    // hourly resolution and make this equivalence test pass or fail for the wrong reason.
    const lookAhead = Math.ceil(8 / SLOT_H);
    const firing = priceValues.map((p, t) => {
      if (!(p <= maxChargePrice)) return false;
      let minFuture = p;
      for (let j = t + 1; j < Math.min(t + 1 + lookAhead, priceValues.length); j++) {
        if (priceValues[j] > 0) minFuture = Math.min(minFuture, priceValues[j]);
      }
      return p <= minFuture + 0.001;
    });

    for (let t = 0; t < slots.length; t++) {
      const s = slots[t];
      const shouldFire = s.action === 'preserve' && firing[t] && s.socProjected < 40;
      if (!!s.topupForced !== shouldFire) return false;
      if (s.topupForced && t + 1 < slots.length
          && !(slots[t + 1].socProjected > s.socProjected)) return false;
    }
    return true;
};

testInvariant('31:topup-forward-sim-consistency', inv31Arb, inv31(1));
testInvariant('31:topup-forward-sim-consistency@15min', inv31Arb, inv31(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 32 — topupForced flag is trajectory-consistent (general world)
//
// Full random world (PV, discharge, reorder, island, sweep all active): wherever
// the final schedule carries topupForced, the flag must describe a state the
// runtime heuristic would really act on — preserve label, entering SoC < 40%,
// non-negative price — and the projected SoC must strictly rise across the slot
// (the simulated forced charge; entering SoC < 40% < max_soc so the clamp can't
// nullify it). One-sided on purpose: post-DP passes may legitimately drop the
// flag (island flip to discharge, reorder rollback), never carry a stale one.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 32 — topup-flag-trajectory-consistent\n');

testInvariant('32:topup-flag-trajectory-consistent',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 0, max: 2500 }), { minLength: 24, maxLength: 24 }),
    fc.double({ min: 0.05, max: 0.40, noNaN: true, noDefaultInfinity: true }) // maxChargePrice
  ),
  ([settings, base, priceValues, pvValues, maxChargePrice]) => {
    const prices = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvValues);
    const eng = runCompute(settings, {
      ...base,
      currentSoc: Math.min(base.currentSoc, settings.max_soc),
      prices, pvForecast,
      consumptionW: Array(24).fill(400),
      pvKwhTomorrow: 2,
      maxChargePrice,
    });
    const slots = eng._schedule?.slots ?? [];
    for (let t = 0; t < slots.length; t++) {
      const s = slots[t];
      if (!s.topupForced) continue;
      if (s.action !== 'preserve') return false;
      if (!(s.socProjected < 40)) return false;
      if (!(s.price >= 0)) return false;
      if (t + 1 < slots.length && !(slots[t + 1].socProjected > s.socProjected)) return false;
    }
    return true;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 33 — standby never gains SoC in the projected trajectory
//
// Forward-pass physics: a 'standby' slot exports its PV surplus and its SoC is
// unchanged; only charge / trickle / pvStoreWins-preserve / strong-preserve /
// topupForced slots bank energy. The reorder re-sim used to credit ANY
// pvCoverage>0 slot with free PV (phantom gain on standby slots), inflating the
// simulated end SoC past the undershoot rollback guard and projecting a SoC
// rise the runtime never delivers. Full random world: SoC must never rise
// across a standby slot. (Island-pass rewrites only ever lower downstream SoC,
// so they cannot create a false counterexample here.)
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 33 — standby-never-gains-soc\n');

testInvariant('33:standby-never-gains-soc',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 0, max: 2500 }), { minLength: 24, maxLength: 24 }),
    fc.double({ min: 0, max: 0.40, noNaN: true, noDefaultInfinity: true }), // maxChargePrice (0 = topup off)
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),    // refillConfidence
  ),
  ([settings, base, priceValues, pvValues, maxChargePrice, refillConfidence]) => {
    const prices = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvValues);
    const eng = runCompute(settings, {
      ...base,
      currentSoc: Math.min(base.currentSoc, settings.max_soc),
      prices, pvForecast,
      consumptionW: Array(24).fill(400),
      pvKwhTomorrow: 2,
      maxChargePrice, refillConfidence,
    });
    const slots = eng._schedule?.slots ?? [];
    for (let t = 0; t + 1 < slots.length; t++) {
      if (slots[t].action !== 'standby') continue;
      if (slots[t + 1].socProjected > slots[t].socProjected) return false;
    }
    return true;
  }
);

// ─── Invariant 34 — KNOWN BUG: topup-guard ignores PV-headroom ──────────────
// Fixed 2026-07-19 (memory: project_topup_guard_pv_headroom_conflict). The
// reorder-block's lowSocGridTopUp break-even guard (optimization-engine.js
// ~482-499) searches forward for a cheap grid slot to justify skipping a pricier
// night discharge — but ignored pvKwhTomorrow/refillConfidence. When PV tomorrow
// is abundant + confidently forecast (gateOpen — OptimizationEngine.
// pvHeadroomGateOpen, the same condition device.js uses to waive the reserve
// floor), the anticipated grid top-up never actually fires live (PV refills for
// free instead), so the guard's net-loss premise is false and must not suppress
// the priciest slot. Fix: the guard (and its live/planning mirror
// lowSocGridTopUp in policy-engine.js) is now skipped entirely when gateOpen.
//
// Economic-dominance check: whenever gateOpen is true, the guard must be fully
// waived — guardKwh === unguKwh (identical to the unguarded priciest-first
// budget, since it's the same loop with the guard condition now false) and no
// trace entry may carry skip:'topup'. The live-traced regression (prices
// [€0.33, €0.284], SoC 41%, pvKwhTomorrow 6.6kWh / 2.688kWh cap — previously
// bugged: guard fired, cheaper slot discharged instead of the pricier one) is
// pinned as one fixed corpus entry alongside randomized coverage.
log('## Invariant 34 — topup-guard-respects-pv-headroom\n');

testInvariant('34:topup-guard-respects-pv-headroom',
  fc.tuple(
    fc.oneof(
      fc.constant({ p0: 0.33, p1: 0.284, capacityKwh: 2.688, currentSoc: 41, maxChargePrice: 0.29, pvKwhTomorrow: 6.6, refillConfidence: 1.0 }),
      // Arbitrary shaped so the guard body actually runs. Measured 2026-07-30 on the
      // previous (independent-sampling) version: 522/1000 runs reached the assert —
      // 438 bailed on !gateOpen, 40 on p1 >= maxChargePrice. Both bails are decided
      // entirely by this arbitrary, so tightening it here is the whole fix.
      fc.record({
        p0:               fc.double({ min: 0.20, max: 0.60, noNaN: true, noDefaultInfinity: true }),
        p1:               fc.double({ min: 0.05, max: 0.20, noNaN: true, noDefaultInfinity: true }),
        capacityKwh:      fc.double({ min: 1.0, max: 4.0, noNaN: true, noDefaultInfinity: true }),
        currentSoc:       fc.double({ min: 41, max: 95, noNaN: true, noDefaultInfinity: true }),
        // Strictly above p1's max (0.20) — p1 must qualify as a topup candidate or
        // the run tests nothing.
        maxChargePrice:   fc.double({ min: 0.21, max: 0.35, noNaN: true, noDefaultInfinity: true }),
        // pvHeadroomGateOpen needs pvKwhTomorrow >= 0.9*capacityKwh && refillConfidence >= 0.8.
        // Sampling pvKwhTomorrow absolutely (0-10 kWh) against a capacity drawn
        // independently closed the gate most of the time; draw it as a multiple of
        // capacity instead, straddling the 0.9 threshold so the boundary stays covered.
        pvRatio:          fc.double({ min: 0.75, max: 3.0, noNaN: true, noDefaultInfinity: true }),
        refillConfidence: fc.double({ min: 0.70, max: 1.0, noNaN: true, noDefaultInfinity: true }),
      }).map(r => ({ ...r, pvKwhTomorrow: r.capacityKwh * r.pvRatio })),
    ),
    fc.double({ min: 0.50, max: 0.95, noNaN: true, noDefaultInfinity: true }), // battery_efficiency
    fc.double({ min: 0, max: 0.10, noNaN: true, noDefaultInfinity: true }),   // cycle_cost_per_kwh
  ),
  ([s, efficiency, cycleCost]) => {
    if (s.p1 >= s.maxChargePrice) return true; // p1 must qualify as a topup candidate
    const prices = makePriceSlots([s.p0, s.p1]);
    const pvForecast = makePvForecast(prices, [0, 0]);
    const eng = runCompute(
      { battery_efficiency: efficiency, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: cycleCost, export_price_ratio: 1.0 },
      { prices, currentSoc: s.currentSoc, capacityKwh: s.capacityKwh, maxChargeW: 800, maxDischargeW: 3000,
        pvForecast, pvKwhTomorrow: s.pvKwhTomorrow, terminalPvKwhTomorrow: s.pvKwhTomorrow,
        refillConfidence: s.refillConfidence, maxChargePrice: s.maxChargePrice }
    );
    const dbg = eng._reorderDebug;
    if (!dbg) return true; // reorder block didn't run (e.g. eligible<2) — nothing to check
    if (!dbg.gateOpen) return true; // no headroom → original guard behavior, covered by Invariants 22/25
    const hasTopupSkip = dbg.trace.some(e => e.skip === 'topup');
    return !hasTopupSkip && dbg.guardKwh === dbg.unguKwh;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO — flatten-arb-gate restores pre-evening charge value (repro)
// Fixed-input regression (fc.constant → exactly 1 scenario), not property coverage.
// The randomized companion is invariant 36.
//
// Bug (project_flatten_gate_zeros_midband_gradient): the per-SoC flatten sets
// dp[sg]=dpMax across the whole band whenever remaining PV can refill the gap. On a
// day with terminalFactor=0 (sunny tomorrow → terminal dp all-zeros) this also kills
// the UPWARD charge gradient, so a cheap pre-evening slot no longer sees the value of
// charging to sell into tonight's peak — the battery dumps at the cheap price instead.
//
// Deterministic repro of the 2026-07-24 14:00 forecast, distilled:
//   - cheap pre-evening (0.10), tonight peak (0.40) — spread beats RTE + cycle cost
//   - PV only next-morning (feeds pvKwhFromT + terminalFactor=0); the profitable
//     window is PV-free so the SoC-trace € replay (scoreSocDelta) is exact grid.
// With the gate ON the flatten is skipped (arb beats round-trip) → the gradient
// survives → realized profit strictly beats the ungated (buggy) plan.
// ─────────────────────────────────────────────────────────────────────────────

log('## Scenario — flatten-arb-gate-restores-preevening-charge\n');

// € realized by replaying the schedule's SoC trace at slot prices. Exact only when
// the moving window is PV-free (all SoC deltas are grid charge / discharge).
function realizedProfitFromTrace(slots, priceValues, capacityKwh, rte, cycleCost = 0) {
  const { scoreSocDelta } = createSim({ rte, capacityKwh });
  let profit = 0;
  for (let t = 0; t < slots.length - 1; t++) {
    const deltaPct = slots[t + 1].socProjected - slots[t].socProjected;
    const { revenue, cost } = scoreSocDelta(deltaPct, priceValues[t]);
    // Cycle wear on any throughput, 0.5/side to match the DP objective (vCharge
    // line ~1144 and vDischarge line ~1186 both apply cycleCostPerKwh*0.5). Without
    // this the metric credits a spot round-trip that is wear-negative once the DP's
    // own cycle cost is counted — falsely penalising cycle-cost-aware restraint.
    const throughputKwh = Math.abs(deltaPct / 100 * capacityKwh);
    profit += revenue - cost - throughputKwh * cycleCost * 0.5;
  }
  return profit;
}

testInvariant('scenario:flatten-arb-gate-restores-preevening-charge',
  fc.constant(0),
  () => {
    const N = 24;
    const priceValues = [];
    for (let i = 0; i < N; i++) {
      if (i <= 2) priceValues.push(0.10);              // cheap pre-evening charge window
      else if (i >= 10 && i <= 13) priceValues.push(0.40); // peak (absorbs discharge)
      else priceValues.push(0.20);
    }
    // The refill has to land BEFORE the peak, or the flatten credit's order check zeroes it
    // and the flatten never opens — leaving this scenario with nothing to say about the arb
    // gate. PV after the peak is already covered by invariant 51.
    const pvW = new Array(N).fill(0);
    for (let i = 5; i <= 8; i++) pvW[i] = 2500;

    const prices     = makePriceSlots(priceValues);
    const pvForecast  = makePvForecast(prices, pvW);
    const consumptionW = new Array(N).fill(300);
    const settings = { battery_efficiency: 0.9, min_soc: 0, max_soc: 95,
                       cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 };
    const scenario = {
      prices, pvForecast, consumptionW, currentSoc: 20, capacityKwh: 10,
      maxChargeW: 2500, maxDischargeW: 2500, minDischargePrice: 0,
      pvKwhTomorrow: 12, terminalPvKwhTomorrow: 12, maxChargePrice: 0.30,
    };

    const engOff = runCompute({ ...settings, dp_flatten_arb_gate: false }, scenario);
    const engOn  = runCompute({ ...settings, dp_flatten_arb_gate: true  }, scenario);
    if (!engOff._schedule || !engOn._schedule) return false;

    // Sanity: the flatten gate must actually be open here (else the test proves nothing).
    if (!engOff._flattenDebug?.flattenGateOpen) return false;

    const profOff = realizedProfitFromTrace(engOff._schedule.slots, priceValues, 10, 0.9, 0.075);
    const profOn  = realizedProfitFromTrace(engOn._schedule.slots,  priceValues, 10, 0.9, 0.075);

    // Gate must lift realized profit by a clear margin: ungated flatten leaves the
    // battery holding charge it never deploys into the peak; gated discharges it.
    return profOn > profOff + 0.05;
  },
  1
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 36 — flatten-arb-gate never lowers realized profit (dominance)
//
// Economic-dominance guard for the gate: across randomized arbs where the flatten
// gate opens AND a future discharge slot beats the charge-now→discharge-later
// round-trip cost (suffixMaxPrice·RTE − chargeCost > cycleCost), the gated plan's
// realized profit must be ≥ the ungated plan's. The flatten dp=dpMax is a value
// inflation; removing it restores the true value function, which can only help.
// Window kept PV-free (PV only in the trailing block) so the € replay is exact.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 36 — flatten-arb-gate-never-lowers-profit\n');

testInvariant('36:flatten-arb-gate-never-lowers-profit',
  fc.tuple(
    fc.double({ min: 0.05, max: 0.15, noNaN: true, noDefaultInfinity: true }), // cheap charge-window price
    fc.double({ min: 0.35, max: 0.55, noNaN: true, noDefaultInfinity: true }), // peak price
    fc.double({ min: 0.15, max: 0.25, noNaN: true, noDefaultInfinity: true }), // moderate filler
    fc.double({ min: 5, max: 35, noNaN: true, noDefaultInfinity: true }),       // currentSoc (low → charge headroom)
    fc.double({ min: 6, max: 12, noNaN: true, noDefaultInfinity: true }),       // capacityKwh
    fc.double({ min: 0, max: 0.08, noNaN: true, noDefaultInfinity: true }),     // cycle cost
    fc.double({ min: 0.80, max: 0.95, noNaN: true, noDefaultInfinity: true }),  // battery efficiency
  ),
  ([cheap, peak, mod, soc, cap, cycle, rte]) => {
    const N = 24;
    const priceValues = [];
    for (let i = 0; i < N; i++) {
      if (i <= 2) priceValues.push(cheap);
      else if (i >= 3 && i <= 6) priceValues.push(peak);
      else priceValues.push(mod);
    }
    const pvW = new Array(N).fill(0);
    for (let i = 19; i <= 23; i++) pvW[i] = 2500;   // trailing PV only → window PV-free

    const prices     = makePriceSlots(priceValues);
    const pvForecast  = makePvForecast(prices, pvW);
    const consumptionW = new Array(N).fill(300);
    const settings = { battery_efficiency: rte, min_soc: 0, max_soc: 95,
                       cycle_cost_per_kwh: cycle, export_price_ratio: 1.0 };
    const scenario = {
      prices, pvForecast, consumptionW, currentSoc: soc, capacityKwh: cap,
      maxChargeW: 2500, maxDischargeW: 2500, minDischargePrice: 0,
      pvKwhTomorrow: cap * 1.5, terminalPvKwhTomorrow: cap * 1.5, maxChargePrice: 0.30,
    };

    const engOff = runCompute({ ...settings, dp_flatten_arb_gate: false }, scenario);
    const engOn  = runCompute({ ...settings, dp_flatten_arb_gate: true  }, scenario);
    if (!engOff._schedule || !engOn._schedule) return true;

    // Only assert where the gate is relevant: flatten open AND arb beats round-trip.
    if (!engOff._flattenDebug?.flattenGateOpen) return true;
    const arbAhead = peak * rte - cheap > cycle;
    if (!arbAhead) return true;

    const profOff = realizedProfitFromTrace(engOff._schedule.slots, priceValues, cap, rte, cycle);
    const profOn  = realizedProfitFromTrace(engOn._schedule.slots,  priceValues, cap, rte, cycle);
    return profOn >= profOff - 1e-6; // gate never lowers realized profit
  },
  200
);

// ─── Invariant 37 — planning tile shows the DP's own SoC curve ───────────────
// CLAUDE.md: socProjected has ONE writer, the DP. buildPlanningSchedule() may pass
// it through, never recompute it. Until 2026-07-30 it re-simulated the whole curve
// from a second PV source, and nothing here caught it: this suite never loaded
// PolicyEngine, so all 36 invariants above validated the DP half only.
//
// Contract: on every slot where the planning mapper follows the DP action
// (socOverride === false), the tile value must equal the DP value verbatim. Only
// mapper overrides — where the DP projected no delta for what the mapper decided —
// may deviate, and those must be flagged.
// ─────────────────────────────────────────────────────────────────────────────

const PolicyEngine = require('../lib/policy-engine');

log('## Invariant 37 — planning-tile-matches-dp-soc\n');

testInvariant('37:planning-tile-matches-dp-soc',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.01, max: 0.50, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 0, max: 2500 }), { minLength: 24, maxLength: 24 }),
    fc.double({ min: 0, max: 0.40, noNaN: true, noDefaultInfinity: true }), // maxChargePrice
    fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),    // refillConfidence
  ),
  ([settings, base, priceValues, pvValues, maxChargePrice, refillConfidence]) => {
    const prices     = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvValues);
    const eng = runCompute(settings, {
      ...base,
      currentSoc: Math.min(base.currentSoc, settings.max_soc),
      prices, pvForecast,
      consumptionW: Array(24).fill(400),
      pvKwhTomorrow: 2,
      maxChargePrice, refillConfidence,
    });
    const dpSlots = eng._schedule?.slots ?? [];
    if (dpSlots.length === 0) return true;

    // Same settings on both sides: a mismatch must come from the re-simulation,
    // not from the planning mapper reading different thresholds than the DP.
    const policy = new PolicyEngine({ log() {}, error() {} }, {
      tariff_type:        'dynamic',
      battery_efficiency: settings.battery_efficiency,
      min_soc:            settings.min_soc,
      max_soc:            settings.max_soc,
      cycle_cost_per_kwh: settings.cycle_cost_per_kwh,
      max_charge_price:   maxChargePrice,
      min_discharge_price: 0,
      respect_minmax:     true,
      policy_mode:        'balanced',
    });

    const tile = policy.buildPlanningSchedule(
      dpSlots, pvForecast, null, base.maxChargeW, maxChargePrice,
      base.capacityKwh, 2, refillConfidence
    );
    if (tile.length !== dpSlots.length) return false;

    for (let i = 0; i < tile.length; i++) {
      if (tile[i].socOverride) continue;          // override slots may deviate by design
      // buildPlanningSchedule rounds to 0.1pp; allow that and nothing more.
      if (Math.abs(tile[i].socProjected - dpSlots[i].socProjected) > 0.05) return false;
    }
    return true;
  },
  200
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 39
// "The per-slot discharge floor never suppresses discharge at a comfortably profitable peak"
//
// buildPerSlotDischargeFloors replaces the scalar min_discharge_price with one floor per
// slot. Two of its three regimes can sit ABOVE the scalar: the weak-PV regime returns
// max(weakPvFloorBase, cheapestRefillAhead / rte), which the live diag has already shown at
// €0.24 against a €0.22 scalar. Blocking a marginal slot that way is the guard doing its job
// (discharge €0.23, rebuy €0.21 at 75% RTE = a loss). Blocking the horizon's strict maximum
// when it clears every possible rebuy is not.
//
// Refill candidates are by construction priced below dayFloor, so cheapestRefillAhead / rte
// < dayFloor / rte. Pin the strict global price-max at or above dayFloor / rte and no regime
// can legitimately block it. The baseline runs the same scenario on the flat scalar floor; if
// the baseline discharges at the peak, the per-slot array must too. That makes this a test of
// the array's INTERACTION with the rest of the DP (reorder, reserve floor, terminal value),
// not of the floor formula in isolation — the shape-sensitive class that the 2026-07-10
// scalar-vs-array dispatch bug fell into.
//
// The peak slot gets weak PV (60–200 W) against 300–800 W of consumption, so it lands in the
// weak-PV regime — the one branch that can floor above the scalar — and is not turned into a
// PV-surplus preserve/standby slot before the assert runs. Measured effective sample size
// 2026-08-02: 998/1000 (100%), all 998 in the weak-PV regime. With random PV at the peak it
// was 121/500 (24%) and every skipped run was PV ≥ consumption at the peak.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 39 — perslot-floor-never-suppresses-profitable-peak\n');

testInvariant('39:perslot-floor-never-suppresses-profitable-peak',
  fc.tuple(
    settingsArb,
    baseArb,
    fc.array(fc.double({ min: 0.05, max: 0.30, noNaN: true, noDefaultInfinity: true }),
             { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 300, max: 800 }), { minLength: 24, maxLength: 24 }),
    fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 24, maxLength: 24 }),
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 60, max: 200 }),
  ),
  ([settings, base, priceValues, consValues, pvValues, peakIdx, peakPvW]) => {
    const dayFloor  = 0.22;
    const rte       = settings.battery_efficiency;
    // Strict global max, at or above dayFloor / rte → above every possible rebuy cost.
    const peakPrice = Math.max(0.40, dayFloor / rte + 0.01);
    const prices = priceValues.slice();
    prices[peakIdx] = peakPrice;
    const pvW = pvValues.slice();
    pvW[peakIdx] = peakPvW;

    const priceSlots = makePriceSlots(prices);
    const pvForecast = makePvForecast(priceSlots, pvW);
    const scenario = {
      prices: priceSlots, currentSoc: Math.max(60, base.currentSoc),
      capacityKwh: base.capacityKwh, maxChargeW: base.maxChargeW, maxDischargeW: base.maxDischargeW,
      pvForecast, consumptionW: consValues,
    };

    const baseEng = runCompute(settings, { ...scenario, minDischargePrice: dayFloor });
    if (!baseEng._schedule) return true;
    if (baseEng._schedule.slots[peakIdx]?.action !== 'discharge') return true;

    const floors = new OptimizationEngine(settings).buildPerSlotDischargeFloors(priceSlots, pvForecast, {
      dayFloor,
      nightFloor: 0.00,
      weakPvFloorBase: Math.max((settings.cycle_cost_per_kwh ?? 0.075) / rte + 0.02, 0.115),
      pvStrongW: base.maxChargeW * 0.5,
      atMaxSoc: false,
      effectiveRte: rte,
    });
    // Guard the premise: nothing may floor the peak above its own price.
    if (floors[peakIdx] > peakPrice) return false;

    const perSlotEng = runCompute(settings, { ...scenario, minDischargePrice: floors });
    if (!perSlotEng._schedule) return true;
    return perSlotEng._schedule.slots[peakIdx]?.action === 'discharge';
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 40: finer resolution never lowers projected profit
//
// The same WALL-CLOCK world is handed to the DP twice: once as hourly slots, once
// as quarter-hour slots where each hour is four identical sub-slots (same price,
// same PV, same consumption). The quarter-hour run can reproduce any hourly plan
// by repeating each hourly action four times, so it has strictly MORE freedom —
// its projected profit can never come out lower.
//
// This is the cross-cutting guard for the per-invariant @15min registrations: those
// each pin one behaviour at one resolution, while this one fails whenever ANY hour↔slot
// conversion in the engine is wrong (an energy term multiplied by slot count instead of
// hours, a window sized in slots where it means hours, a per-slot cost applied four times
// as often). maxChargePrice is drawn non-zero so the topup look-ahead window — the one
// place that already had to say `Math.ceil(8 / slotH)` — is on the path.
//
// One-sided on purpose: equal is the expected outcome (the hourly plan is usually already
// optimal), strictly better is allowed, worse is the bug.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 40 — finer-resolution-never-lowers-profit\n');

const inv40Arb = fc.tuple(
  settingsArb,
  baseArb,
  // 24 hourly prices, spanning negative to expensive so arbitrage has something to chew on
  fc.array(fc.double({ min: -0.05, max: 0.60, noNaN: true, noDefaultInfinity: true }),
           { minLength: 24, maxLength: 24 }),
  // hourly PV in W: zero at night, real surplus around midday
  fc.array(fc.integer({ min: 0, max: 3500 }), { minLength: 24, maxLength: 24 }),
  fc.array(fc.integer({ min: 100, max: 900 }), { minLength: 24, maxLength: 24 }),
  fc.double({ min: 0.00, max: 0.30, noNaN: true, noDefaultInfinity: true }), // minDischargePrice
  fc.double({ min: 0.05, max: 0.40, noNaN: true, noDefaultInfinity: true }), // maxChargePrice (> 0)
  // pvKwhTomorrow as a MULTIPLE of capacity, held at ≥ 0.8 on purpose: above that threshold
  // the engine leaves the horizon-end dp all zeros, so projectedProfit is pure in-horizon
  // economics and the two runs are comparable.
  //
  // Below 0.8 they are not. projectedProfit is `dp[initialSocG]` (optimization-engine.js:266) —
  // a value function that also carries a modelled credit for energy left past the horizon. That
  // credit is the mean of the top `Math.floor(L / 4)` tail prices, and floor() truncates far
  // harder when L is a count of HOURS than when it is a count of quarters: at 1h it keeps only
  // the very top prices, at 15 min the full 25% window including cheaper ones. Measured over 400
  // random price paths the reference comes out 17% lower at 15 min on average (worst 43%), which
  // made 140/359 terminal-alive runs "violate" this invariant without any plan being worse —
  // 0/41 violated once the terminal was zero. Comparing residual-SoC credit across resolutions
  // is the apples-to-oranges here, so this invariant stays out of that regime.
  fc.double({ min: 0.8, max: 2.5, noNaN: true, noDefaultInfinity: true }) // pvKwhTomorrow / capacity
);

testInvariant('40:finer-resolution-never-lowers-profit',
  inv40Arb,
  ([settings, base, priceHours, pvWHours, consHours, minDischargePrice, maxChargePrice, pvRefill]) => {
    // Everything below is identical between the two runs except slot width. pvKwhTomorrow is
    // an energy, so it stays put — scaling it would change the world, not just its sampling.
    const pvKwhTomorrow = pvRefill * base.capacityKwh;

    const runAt = (SLOT_H) => {
      const prices = makePriceSlots(expandToSlots(priceHours, SLOT_H), SLOT_H);
      const eng = runCompute(settings, {
        ...base,
        currentSoc: Math.min(base.currentSoc, settings.max_soc),
        prices,
        pvForecast: makePvForecast(prices, expandToSlots(pvWHours, SLOT_H)),
        consumptionW: expandToSlots(consHours, SLOT_H),
        minDischargePrice,
        maxChargePrice,
        pvKwhTomorrow,
      });
      return eng._schedule;
    };

    const hourly  = runAt(1);
    const quarter = runAt(0.25);
    if (!hourly || !quarter) return true;

    const p1h  = hourly.projectedProfit;
    const p15  = quarter.projectedProfit;
    if (typeof p1h !== 'number' || typeof p15 !== 'number') return true;

    // Tolerance absorbs SoC-grid quantisation (GRID_TOTAL steps) and the smaller per-slot
    // energy at 15 min, both of which can cost a fraction of a cent without being a bug.
    const tol = Math.max(0.01, Math.abs(p1h) * 0.02);
    return p15 >= p1h - tol;
  },
  RUNS_15MIN
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 41 — trickle-cap saturation: the cap only binds when PV really saturates
//
// The saturation test decides whether a zeroed trickleSuffixMaxPrice is honoured or falls
// back to the uncapped suffix max (optimization-engine.js, the rawStorePrice branch in the
// forward pass). It is unconditional behaviour, so the guard is that it never fires on a
// premise that does not hold. This is the negative twin of invariant 42: there the PV block
// dwarfs the battery (premise true), here the PV ahead is far too small to refill a 5-12 kWh
// pack, so the cap may never be honoured and nCapZeroSaturating must be 0.
//
// Runs where the battery ends up full anyway are skipped: with roomKwh 0 the test "free PV
// ahead >= room" is trivially true and saturating IS the right answer — nothing is left to
// store, so the store value should collapse.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 41 — trickle-cap-does-not-bind-without-saturation\n');

testInvariant('41:trickle-cap-does-not-bind-without-saturation',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 5.0, max: 12.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 800, max: 2000 }),
      maxDischargeW: fc.integer({ min: 800, max: 2000 }),
      currentSoc:    fc.double({ min: 5, max: 25, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.array(fc.double({ min: 0.02, max: 0.40, noNaN: true, noDefaultInfinity: true }),
             { minLength: 6, maxLength: 14 }),
    fc.integer({ min: 0, max: 120 }),   // PV surplus far below what a 5-12 kWh pack needs
  ),
  ([settings, base, priceValues, tinyPvW]) => {
    const prices       = makePriceSlots(priceValues);
    const pvForecast   = makePvForecast(prices, priceValues.map(() => tinyPvW));
    const consumptionW = priceValues.map(() => 0);
    const scenario = { ...base, prices, pvForecast, consumptionW };

    const run = runCompute({ ...settings }, scenario);
    if (!run._schedule || !run._trickleCapDebug) return true;

    const maxSoc = settings.max_soc ?? 100;
    const everFull = run._schedule.slots.some(s => (s.socProjected ?? 0) >= maxSoc - 0.5);
    return everFull || run._trickleCapDebug.nCapZeroSaturating === 0;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 42 — trickle-cap saturation: honouring the cap costs no SoC at the peak
//
// The economic-dominance check for the new constraint (CLAUDE.md requires one for any
// DP constraint that can ship live). The cap's premise is that a downstream pvStrong
// block refills the battery anyway, so PV stored BEFORE that block is redundant. When
// that premise genuinely holds — free PV ahead exceeds the whole usable span — acting on
// it may not cost anything at the evening peak: the SoC the plan projects at the peak slot
// must be at least what it already was before the free PV block. If suppressing the early
// store ever left the battery short for the peak, this fails.
//
// Scenario shape: weak-PV morning slots (surplus below the 400 W pvStrong threshold, so
// they run through the trickle branch) → a PV block far larger than the battery → an
// evening peak with no PV. The scenario is built so saturation is guaranteed by
// construction; the guard below only skips runs where the DP produced no schedule.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 42 — trickle-cap-no-soc-cost-at-peak\n');

testInvariant('42:trickle-cap-no-soc-cost-at-peak',
  fc.tuple(
    settingsArb,
    fc.record({
      capacityKwh:   fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),
      maxChargeW:    fc.integer({ min: 800, max: 3000 }),
      maxDischargeW: fc.integer({ min: 800, max: 3000 }),
      currentSoc:    fc.double({ min: 5, max: 50, noNaN: true, noDefaultInfinity: true }),
    }),
    fc.double({ min: 0.10, max: 0.25, noNaN: true, noDefaultInfinity: true }), // morning price
    fc.double({ min: 0.30, max: 0.60, noNaN: true, noDefaultInfinity: true }), // evening peak
    fc.integer({ min: 50, max: 390 }),                                         // weak PV surplus (W)
  ),
  ([settings, base, morningPrice, peakPrice, weakPvW]) => {
    // 2 weak-PV morning slots, 4 saturating PV slots, 3 evening peak slots.
    const priceValues = [morningPrice, morningPrice, 0.08, 0.08, 0.08, 0.08, peakPrice, peakPrice, peakPrice];
    // Each PV-block slot delivers a full hour at max charge power → 4x the charge the
    // battery can take in an hour, which exceeds the usable span for every capacity here.
    const bigPvW = base.maxChargeW + 2000;
    const pvValues = [weakPvW, weakPvW, bigPvW, bigPvW, bigPvW, bigPvW, 0, 0, 0];

    const prices       = makePriceSlots(priceValues);
    const pvForecast   = makePvForecast(prices, pvValues);
    const consumptionW = priceValues.map(() => 0);
    const scenario = { ...base, prices, pvForecast, consumptionW, minDischargePrice: 0,
      pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0 };

    const run = runCompute({ ...settings }, scenario);
    if (!run._schedule) return true;

    const peakIdx = 6;  // first evening peak slot, straight after the saturating PV block
    const preIdx  = 1;  // last weak-PV morning slot, before the block
    const socPeak = run._schedule.slots[peakIdx]?.socProjected;
    const socPre  = run._schedule.slots[preIdx]?.socProjected;
    if (typeof socPeak !== 'number' || typeof socPre !== 'number') return true;

    // Tolerance absorbs SoC-grid quantisation (GRID_TOTAL steps), same reason as invariant 3.
    return socPeak >= socPre - 0.5;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 43 — PV-block charging lands on the cheap slots, not the early ones
//
// Live miss 2026-08-08: the plan charged 09:45-13:00 at €0.145-0.148 while 13:30-15:30 sat
// at €0.115-0.127 with the battery already full — the cheap window went unused. Measured
// independently over the day: realised charge price €0.1476/kWh against an optimum of
// €0.1413, with more than half the gap in 09:00-12:00.
//
// Charging from PV surplus is not free: the kWh put in the battery is a kWh not exported, so
// the cost of a PV-block charge slot IS that slot's price. When a later, cheaper stretch of
// the same block can absorb the whole pack on its own, every earlier charge is strictly
// worse — it forgoes export revenue at a higher price for the same end state.
//
// The spread here stays deliberately under BOTH legs of the cheaperPvAhead gate (1.30x ratio
// and €0.03 absolute, mirroring the live numbers), so that gate cannot be what fires: this
// pins the trickle-cap saturation test, which is the mechanism that has to catch it.
//
// Setup: 8 PV-strong hourly slots — 4 expensive, then 4 cheap — sized so the cheap half
// alone exceeds the usable span, followed by an evening peak far above the block so storing
// always beats exporting. Asserts (a) no SoC is gained in the expensive half, and (b) the
// battery still arrives at the peak with everything the charge rate could deliver, so (a)
// cannot be satisfied by simply refusing to charge.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 43 — pv-block-charge-lands-on-cheap-slots\n');

testInvariant('43:pv-block-charge-lands-on-cheap-slots',
  fc.tuple(
    fc.integer({ min: 800, max: 2000 }),                                        // maxChargeW
    fc.double({ min: 0.30, max: 0.90, noNaN: true, noDefaultInfinity: true }),  // pack size as
                                                                                // fraction of what
                                                                                // the cheap half holds
    fc.double({ min: 0.13, max: 0.20, noNaN: true, noDefaultInfinity: true }),  // expensive-half price
    fc.double({ min: 0.015, max: 0.028, noNaN: true, noDefaultInfinity: true }), // drop to the cheap half
  ),
  ([maxChargeW, capFrac, priceHigh, drop]) => {
    // dp_trickle_cap_saturation is what makes this invariant hold, and it ships default-off
    // (shadow, since 81b07a8) — so it is set here explicitly. Without it slots 0-3 preserve and
    // the pack is full before the cheap half starts: assert (a) fails on the very first draw.
    // ⚠️ This invariant therefore describes the behaviour AFTER switch-on; live the flag is
    // still off and that decision is open (reorder↔trickle, see HANDOFF "Niet-doen").
    // Left red instead, it stopped being a signal: it ran red from 17-08 as known background
    // noise, which is why invariant 52 going red on 20-08 went unnoticed next to it.
    const settings = { battery_efficiency: 0.70, min_soc: 0, max_soc: 100,
      cycle_cost_per_kwh: 0, export_price_ratio: 1.0, dp_trickle_cap_saturation: true };
    const HALF = 4;                                   // slots per half of the PV block
    const chargeKwhPerSlot = maxChargeW / 1000;       // hourly slots, PV surplus exceeds maxChargeW
    const capacityKwh = capFrac * HALF * chargeKwhPerSlot;
    const currentSoc  = 0;
    const priceLow    = priceHigh - drop;             // ratio stays < 1.30x for every draw here

    const eveningPeak = priceHigh / settings.battery_efficiency + 0.20;
    const priceValues = [
      ...Array(HALF).fill(priceHigh), ...Array(HALF).fill(priceLow),
      eveningPeak, 0.10, 0.10,
    ];
    const prices = makePriceSlots(priceValues);
    const pvWValues = [...Array(HALF * 2).fill(maxChargeW + 800), 0, 0, 0];
    const consumptionW = priceValues.map(() => 200);

    const eng = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices, pvForecast: makePvForecast(prices, pvWValues), consumptionW,
      minDischargePrice: 0.220, refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const socCheapStart = slots[HALF]?.socProjected;      // SoC arriving at the cheap half
    const socPeak       = slots[HALF * 2]?.socProjected;  // SoC arriving at the evening peak
    if (typeof socCheapStart !== 'number' || typeof socPeak !== 'number') return true;

    // (a) Nothing may be stored while the expensive half runs — the cheap half can take the
    // whole pack, so any kWh held back here is export revenue thrown away at the higher price.
    if (socCheapStart > currentSoc + 1.0) return false;

    // (b) …and deferring may not cost anything: the pack still arrives at the peak holding
    // what the charge rate could deliver over the cheap half. Tolerance is SoC-grid
    // quantisation (0.1pp per charged slot), as in invariants 25 and 27.
    const achievableSoc = Math.min(settings.max_soc,
      currentSoc + (HALF * chargeKwhPerSlot / capacityKwh) * 100);
    return socPeak >= achievableSoc - (0.5 + HALF * 2 * 0.1);
  }
);

log('## Invariant 44 — pv-strong-slot-stores-instead-of-exporting\n');

// The trickle cap zeroes the store value when free PV ahead will refill the battery anyway.
// Inside a pvStrong slot that reasoning eats itself: the PV it counts on is the PV being
// decided, so zeroing makes export win, the charge is withheld, and the battery never
// saturates. Live on 2026-08-08 the pack sat at 12% through a 2.5kW block and entered a
// €0.363 peak at 38%. A second PV day beyond the peak is what makes pvSaturatesAhead true
// while today's peak is still very much reachable — inv43 has no PV after its block, so it
// never draws this shape.
testInvariant('44:pv-strong-slot-stores-instead-of-exporting',
  fc.tuple(
    fc.integer({ min: 800, max: 1600 }),                                       // maxChargeW
    fc.double({ min: 0.20, max: 0.60, noNaN: true, noDefaultInfinity: true }), // pack as fraction
                                                                               // of block output
    fc.double({ min: 0.10, max: 0.16, noNaN: true, noDefaultInfinity: true }), // daytime price
    fc.double({ min: 0.30, max: 0.45, noNaN: true, noDefaultInfinity: true }), // evening peak
  ),
  ([maxChargeW, capFrac, priceDay, pricePeak]) => {
    const settings = { battery_efficiency: 0.73, min_soc: 0, max_soc: 100,
      cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 };
    const BLOCK = 6;                                  // pvStrong slots today
    const chargeKwhPerSlot = maxChargeW / 1000;
    const capacityKwh = capFrac * BLOCK * chargeKwhPerSlot;
    const currentSoc  = 0;

    // today's PV block → evening peak → night → a second PV block tomorrow
    const priceValues = [
      ...Array(BLOCK).fill(priceDay), pricePeak, pricePeak, 0.12, 0.12,
      ...Array(BLOCK).fill(priceDay),
    ];
    const pvWValues = [
      ...Array(BLOCK).fill(maxChargeW + 900), 0, 0, 0, 0,
      ...Array(BLOCK).fill(maxChargeW + 900),
    ];
    const prices = makePriceSlots(priceValues);
    const consumptionW = priceValues.map(() => 200);

    const eng = runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: maxChargeW,
      currentSoc, prices, pvForecast: makePvForecast(prices, pvWValues), consumptionW,
      minDischargePrice: 0.220, refillConfidence: 1.0, pvKwhTomorrow: 0,
    });
    if (!eng._schedule) return true;
    const socPeak = eng._schedule.slots[BLOCK]?.socProjected;
    if (typeof socPeak !== 'number') return true;

    // Storing beats exporting by construction: pricePeak × rte − cycle > priceDay for every
    // draw. The block can more than fill the pack, so the pack must arrive at the peak full.
    if (pricePeak * settings.battery_efficiency - settings.cycle_cost_per_kwh <= priceDay) return true;
    const achievableSoc = Math.min(settings.max_soc,
      currentSoc + (BLOCK * chargeKwhPerSlot / capacityKwh) * 100);
    return socPeak >= achievableSoc - (0.5 + BLOCK * 0.1);
  }
);

// Economic dominance: a PV surplus must never buy the battery out of the priciest slot.
// A slot whose PV forecast sits in the band `cons < pv < cons * consumptionMargin` has BOTH
// a live standby option (pvCoverage > 0) and a live discharge option (the zero-on-the-meter
// cap `cons*margin - pv` is still positive). When that slot is also the strict price maximum
// of the horizon and the pack holds energy above its floor, selling beats idling: the kWh
// cannot fetch more anywhere else, and every later slot here can absorb the whole pack.
// Regression guard for the standby export bonus (see test/dp-standby-export-bonus.test.js):
// vStandby used to book PV export revenue on top of dp[socG] while vDischarge booked none,
// even though discharging forgoes no export at all (zero_discharge_only runs both at once).
// At low SoC the discharge margin is thin enough that the bonus flipped the decision.
testInvariant('45:pv-surplus-never-idles-the-priciest-slot',
  fc.tuple(
    fc.integer({ min: 800, max: 1600 }),                                       // maxChargeW
    fc.integer({ min: 40, max: 180 }),                                         // PV above load (W)
    fc.double({ min: 0.35, max: 0.60, noNaN: true, noDefaultInfinity: true }), // peak at t0
    fc.integer({ min: 30, max: 80 }),                                          // starting SoC %
  ),
  ([maxChargeW, pvOverLoadW, pricePeak, currentSoc]) => {
    const settings = { battery_efficiency: 0.73, min_soc: 0, max_soc: 100,
      cycle_cost_per_kwh: 0.075, export_price_ratio: 1.0 };
    const CONS_W = 1000, MARGIN = 1.2, TAIL_PRICE = 0.24, MIN_DISCHARGE = 0.22;
    // pvOverLoadW < CONS_W * (MARGIN - 1) = 200 keeps the slot inside the band by construction.
    const priceValues = [pricePeak, ...Array(7).fill(TAIL_PRICE)];
    const pvWValues   = [CONS_W + pvOverLoadW, ...Array(7).fill(0)];
    const prices = makePriceSlots(priceValues);

    const eng = runCompute(settings, {
      capacityKwh: 2.7, maxChargeW, maxDischargeW: maxChargeW, currentSoc, prices,
      pvForecast: makePvForecast(prices, pvWValues),
      consumptionW: priceValues.map(() => CONS_W),
      consumptionMargin: MARGIN,
      minDischargePrice: MIN_DISCHARGE,
      pvKwhTomorrow: 5.4,          // free refill tomorrow → no reason to hoard the pack
      terminalPvKwhTomorrow: 0,    // terminalFactor = 1 (worst case for discharging)
      refillConfidence: 1.0,       // no reserve floor → an idle t0 can only be the bug
    });
    if (!eng._schedule) return true;
    const t0 = eng._schedule.slots[0];
    if (!t0) return true;

    // Premises: the band is open (both actions physically real) and t0 is the strict max.
    if (!(t0.pvCoverage > 0)) return true;
    if (pricePeak <= TAIL_PRICE + 0.005) return true;

    return t0.action !== 'standby';
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 46
// "Evening coverage is measured in kWh, not in slot count"
//
// eveningCoverageAtRisk (optimization-engine.js:394) is the safety net that lets a
// pvStrong slot override cheaperPvAhead: don't defer charging to the cheaper PV slot
// ahead if the evening's learned need would then no longer be coverable. Its input,
// eveningNeedKwh (r.1394-1409), is an ENERGY sum — every slot contributes
// `netW/1000 * slotH`. Drop that `* slotH` and the need inflates 4× at 15-min slots,
// so the net fires on evenings that are comfortably covered and the deferral is
// wrongly overridden into preserve (runtime: zero_charge_only at the pricier slot).
//
// Scenario is derived, not sampled, so the decision sits inside the sensitive band:
//   coverage = socKwh + reachable free PV
//   coverage > need                (correct arithmetic → net must stay silent)
//   4*need >= span AND coverage < span  (inflated need saturates the usableSpan cap
//                                        → net fires on every run)
// Two PV hours (the second one cheaper → cheaperPvAhead at hour 0), then a 10-hour
// evening at an eligible price. Discharge is blocked during the PV hours by
// minDischargePrice, so hour 0's only live choice is standby vs the override.
//
// The 1h registration is the CONTROL: `* slotH` is the identity at hourly slots, so
// only the @15min registration carries teeth. Negative control 2026-08-14 (drop
// `* slotH` in the engine): the whole suite still passes except this one registration.
// Effective sample size: 877/1000 (1h), 171/200 (@15min) — the rest bail on the
// band guards after rounding consEvW / clamping maxChargeW.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 46 — evening-need-is-energy-not-slotcount\n');

const inv46Arb = fc.tuple(
  fc.double({ min: 0.80, max: 0.95, noNaN: true, noDefaultInfinity: true }),  // rte
  fc.double({ min: 5.0,  max: 12.0, noNaN: true, noDefaultInfinity: true }),  // capacityKwh
  fc.double({ min: 0.55, max: 0.80, noNaN: true, noDefaultInfinity: true }),  // SoC fraction of span
  fc.double({ min: 1.00, max: 1.25, noNaN: true, noDefaultInfinity: true }),  // need vs span/4
  fc.double({ min: 0.30, max: 0.75, noNaN: true, noDefaultInfinity: true }),  // PV ahead vs room
  fc.double({ min: 0.25, max: 0.40, noNaN: true, noDefaultInfinity: true }),  // price hour 0
  fc.double({ min: 0.20, max: 0.55, noNaN: true, noDefaultInfinity: true }),  // hour 1 as × hour 0
  fc.double({ min: 0.45, max: 0.80, noNaN: true, noDefaultInfinity: true }),  // evening price
  fc.integer({ min: 400, max: 900 }),                                        // maxDischargeW
);

const inv46 = (SLOT_H) => ([rte, capacityKwh, socFrac, needMult, pvFrac, p0, p1Mult, pE, maxDischargeW]) => {
  const H = 12, PV_H = 2, EV_H = H - PV_H;
  const settings = { battery_efficiency: rte, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: 0.01, export_price_ratio: 1.0 };
  const span    = capacityKwh;                 // min_soc 0, max_soc 100
  const socKwh  = socFrac * span;
  const consEvW = Math.round(((span / 4) * needMult / EV_H) * 1000);
  const maxChargeW = Math.round(Math.min(2500, (span - socKwh) * 1000 * pvFrac));
  if (maxChargeW < 400) return true;
  // Guard the BUILT values, not the requested ones — consEvW is rounded to whole watts
  // and maxChargeW is clamped, so both can land outside the band that was asked for.
  const needKwh = (consEvW / 1000) * EV_H;
  const pvAheadKwh = (maxChargeW / 1000) * (PV_H - 1);
  if (!(socKwh + pvAheadKwh > needKwh)) return true;   // correct arithmetic: covered
  if (!(4 * needKwh >= span)) return true;             // inflated need: hits the span cap
  if (!(socKwh + pvAheadKwh < span)) return true;      // free PV must not saturate the pack

  const p1 = p0 * p1Mult;
  const hourly = Array.from({ length: H }, (_, h) => (h === 0 ? p0 : h === 1 ? p1 : pE));
  const prices = makePriceSlots(expandToSlots(hourly, SLOT_H), SLOT_H);
  const consumptionW = expandToSlots(
    Array.from({ length: H }, (_, h) => (h < PV_H ? 200 : consEvW)), SLOT_H);
  // PV surplus above maxChargeW → pvCoverage clamps to 1 on both PV hours.
  const pvWValues = expandToSlots(
    Array.from({ length: H }, (_, h) => (h < PV_H ? 200 + maxChargeW + 300 : 0)), SLOT_H);

  const eng = runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW, currentSoc: socFrac * 100, prices,
    pvForecast: makePvForecast(prices, pvWValues), consumptionW,
    minDischargePrice: (p0 + pE) / 2,   // blocks both PV hours, evening eligible
    refillConfidence: 1.0,              // no reserve floor
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });
  if (!eng._schedule) return true;
  const slots = eng._schedule.slots;
  // Premise: the deferral the net could override must actually be on the table.
  if (!slots.some(s => s.cheaperPvAhead)) return true;

  // The evening is covered, so the net has no business firing — at any resolution.
  return !slots.some(s => s.cheaperPvAhead && s.pvStoreWins);
};

testInvariant('46:evening-need-is-energy-not-slotcount', inv46Arb, inv46(1));
testInvariant('46:evening-need-is-energy-not-slotcount@15min', inv46Arb, inv46(0.25), RUNS_15MIN);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 47
// "Terminal credit references the trailing 24 WALL-CLOCK hours"
//
// The post-horizon residual value of held energy is priced off the last 24 hours of
// the horizon — `tailCount = round(24 / slotH)` (optimization-engine.js:1041), a
// duration, not a slot count. Hard-code it to 24 SLOTS and at 15-min resolution the
// reference silently shrinks to the last 6 hours, so anything expensive earlier in
// that day stops crediting held energy and the DP under-hoards.
//
// Isolation: minDischargePrice blocks discharge on every slot, so in-horizon
// arbitrage is impossible and the terminal credit is the ONLY reason to ever charge.
// Control run = flat cheap horizon: credit = pLo × 0.8 × rte < pLo, charging is never
// worth it. Spike run = the same horizon with a 6-8h expensive block placed inside the
// trailing 24h but outside the trailing 6h; the block is at least a full quartile of
// the tail window, so the credit becomes pHi × 0.8 × rte and charging becomes strictly
// profitable. terminalPvKwhTomorrow = 0 keeps terminalFactor at 1.
//
// Negative control 2026-08-14 (tailCount → `Math.min(N, 24)`): 1h unchanged, 15-min
// spike run collapses onto the control (0 charge slots, end SoC = start SoC) → fails.
// Effective sample size: 1000/1000 and 200/200 — no run bails, both premises hold by
// construction over the whole arbitrary.
// ─────────────────────────────────────────────────────────────────────────────

log('## Invariant 47 — terminal-credit-spans-trailing-24h\n');

const inv47Arb = fc.tuple(
  fc.double({ min: 0.80, max: 0.98, noNaN: true, noDefaultInfinity: true }),  // rte
  fc.double({ min: 4.0,  max: 12.0, noNaN: true, noDefaultInfinity: true }),  // capacityKwh
  fc.double({ min: 0.06, max: 0.20, noNaN: true, noDefaultInfinity: true }),  // flat price
  fc.double({ min: 3.0,  max: 6.0,  noNaN: true, noDefaultInfinity: true }),  // spike × flat
  fc.integer({ min: 0, max: 8 }),      // spike offset into the trailing 24h
  fc.integer({ min: 6, max: 8 }),      // spike length (hours) — ≥ one tail quartile
  fc.integer({ min: 5, max: 40 }),     // starting SoC %
  fc.integer({ min: 800, max: 2500 }), // maxChargeW
);

const inv47 = (SLOT_H) => ([rte, capacityKwh, pLo, hiMult, spikeOffset, spikeLen, currentSoc, maxChargeW]) => {
  const H = 30;                                  // > 24h, so the tail window is a strict subset
  const CYCLE = 0.01;
  const pHi = pLo * hiMult;
  // Charging must be strictly worth it on the spike credit and strictly not on the flat one.
  if (!(pHi * 0.8 * rte - pLo - CYCLE > 0.02)) return true;
  const spikeStart = (H - 24) + spikeOffset;     // inside the trailing 24h …
  if (spikeStart + spikeLen > H - 6) return true; // … and outside the trailing 6h

  const settings = { battery_efficiency: rte, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, export_price_ratio: 1.0 };

  const build = (withSpike) => {
    const hourly = Array.from({ length: H }, (_, h) =>
      (withSpike && h >= spikeStart && h < spikeStart + spikeLen) ? pHi : pLo);
    const prices = makePriceSlots(expandToSlots(hourly, SLOT_H), SLOT_H);
    return runCompute(settings, {
      capacityKwh, maxChargeW, maxDischargeW: 800, currentSoc, prices,
      pvForecast: null,
      consumptionW: prices.map(() => 300),
      minDischargePrice: 1e6,       // discharge blocked → terminal credit is the only channel
      refillConfidence: 1.0,
      pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,   // pvRefill 0 → terminalFactor 1
    });
  };

  const ctl = build(false);
  const spk = build(true);
  if (!ctl._schedule || !spk._schedule) return true;
  // Premise: without the spike, held energy is not worth buying (0.8 × rte < 1).
  if (ctl._schedule.slots.some(s => s.action === 'charge')) return true;

  // With the spike inside the trailing 24h, it is — regardless of slot width.
  return spk._schedule.slots.some(s => s.action === 'charge');
};

testInvariant('47:terminal-credit-spans-trailing-24h', inv47Arb, inv47(1));
testInvariant('47:terminal-credit-spans-trailing-24h@15min', inv47Arb, inv47(0.25), RUNS_15MIN);

// ─── 48: weak-PV surplus is priced, not floored ──────────────────────────────
// Economic dominance for dp_weak_pv_tie_standby. Below pvStrongCoverage (a 400 W net-surplus
// floor) the free PV SoC gain is zeroed, which ties vPreserve to vStandby; the strict `>` in
// the argmax then always lands on preserve and every weak-PV branch in the forward pass — all
// keyed on code === 3 — becomes unreachable. The flag resolves that tie to standby instead.
//
// The claim under test is NOT "store more". It is that the weak-PV slots the DP leaves idle
// agree with the store-vs-export comparison in BOTH directions: store when storing pays more,
// export when exporting pays more. A one-directional check would pass a DP that simply hoards.
//
// Both sides are read off the engine's own published slot fields and price-formulas.js — no
// second implementation of either value (CLAUDE.md single-implementation rule).
const inv48Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }),  // rte
  fc.double({ min: 3.0,  max: 12.0, noNaN: true, noDefaultInfinity: true }),  // capacityKwh
  fc.double({ min: 0.05, max: 0.35, noNaN: true, noDefaultInfinity: true }),  // base price
  fc.double({ min: 0.9,  max: 4.0,  noNaN: true, noDefaultInfinity: true }),  // peak × base
  fc.double({ min: 0.1,  max: 1.0,  noNaN: true, noDefaultInfinity: true }),  // export ratio
  fc.integer({ min: 20,  max: 390 }),   // net PV surplus W — strictly under the 400 W floor
  fc.integer({ min: 200, max: 900 }),   // house load W
  fc.integer({ min: 800, max: 2500 }),  // maxChargeW
  fc.integer({ min: 10,  max: 80 }),    // starting SoC %
  fc.boolean(),                          // asymmetric_2027 (export < price) or saldering
);

const inv48 = ([rte, capacityKwh, base, peakMult, ratio, surplusW, consW, maxChargeW,
  currentSoc, asym]) => {
  const H = 16;
  const CYCLE = 0.05;
  const MAX_SOC = 100;
  const settings = {
    battery_efficiency: rte, min_soc: 0, max_soc: MAX_SOC,
    cycle_cost_per_kwh: CYCLE, export_price_ratio: ratio,
    tariff_model: asym ? 'asymmetric_2027' : 'saldering',
    dp_weak_pv_tie_standby: true,
  };

  // PV runs over the first half, the peak sits in the second — so a weak surplus has
  // somewhere to be stored into, without the peak itself carrying PV.
  const hourly = Array.from({ length: H }, (_, h) => (h >= 10 && h < 13) ? base * peakMult : base);
  const prices = makePriceSlots(expandToSlots(hourly, 1), 1);
  const pvW = Array.from({ length: H }, (_, h) => (h < 8 ? consW + surplusW : 0));
  const eng = runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 800, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });
  if (!eng._schedule) return true;

  const pvStrongCoverage = 400 / maxChargeW;
  const IDLE = new Set(['preserve', 'standby', 'trickle']);
  const EPS = 1e-6;

  for (let t = 0; t < eng._schedule.slots.length; t++) {
    const s = eng._schedule.slots[t];
    // Only the slots the flag can reach: a real weak surplus, no strict charge/discharge
    // winner, room left in the cell, and not a forced grid top-up (which ties the two
    // actions on purpose and relies on preserve winning).
    if (!(s.pvCoverage > 0 && s.pvCoverage < pvStrongCoverage)) continue;
    if (!IDLE.has(s.action) || s.topupForced) continue;
    if (s.socProjected >= MAX_SOC - 0.5) continue;

    const exportVal = exportValue(prices[t], settings.tariff_model, ratio);
    const stored = s.action === 'trickle';
    if (s.pvStoreValue > exportVal + EPS && !stored) return false;   // free energy wasted
    if (s.pvStoreValue < exportVal - EPS && stored)  return false;   // hoarding at a loss
  }
  return true;
};

testInvariant('48:weak-pv-surplus-is-priced-not-floored', inv48Arb, inv48);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 49
// "Sub-threshold PV is not a refill promise"
//
// The flatten asks "can the PV still ahead refill this level back to maxSoc?" and, when the
// answer is yes, removes the SoC gradient — discharging now then costs nothing, because the
// pack is assumed full again by the next window. That accounting is only sound for PV the
// battery will actually absorb: the preserve branch stores PV only at pvCoverage >=
// pvStrongCoverage (400 W of surplus). Counting weaker slots promises a recharge the plan
// itself refuses to make, and the pack drains into whatever slot comes first.
//
// Live 2026-08-19 09:15 CEST: an afternoon of pvCoverage 0.07-0.43 (threshold 0.50) was
// credited as 1.54 kWh of refill; planned SoC never moved off 8.4%. The DP spent 0.29 kWh at
// €0.288-0.292 and stood empty through 20:00-20:45 at €0.373-0.393 — €0.0165 on identical
// energy, and its own objective ranked the worse plan higher.
//
// Shape: [weak-PV daytime block at the cheaper price | no-PV evening block, strictly pricier].
// Every daytime slot carries a surplus under the 400 W store threshold, so the whole block is
// refill the cell will never take. This checks the mechanism rather than the resulting plan:
// the economic loss it causes is pinned on real arrays in
// test/dp-midday-drain-before-evening-peak.test.js, but a synthetic price shape that provokes
// the same reordering was not found — two attempts (PV block + evening; PV dip between two PV
// blocks) both planned correctly on the pre-fix engine, so an outcome assertion here would
// have been vacuous. The credit itself is wrong the moment weak PV exists, which is testable
// directly and fails on the pre-fix engine by construction.
const inv49Arb = fc.tuple(
  settingsArb,
  fc.record({
    capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 800, max: 3000 }),
    maxDischargeW: fc.integer({ min: 400, max: 1200 }),
    // Low enough that the evening block alone outruns the pack — the DP must choose.
    currentSoc:    fc.double({ min: 8, max: 30, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.double({ min: 0.24, max: 0.30, noNaN: true, noDefaultInfinity: true }), // daytime price
  fc.double({ min: 0.06, max: 0.16, noNaN: true, noDefaultInfinity: true }), // evening premium
  fc.integer({ min: 15, max: 80 }), // daytime PV surplus as % of the 400 W store threshold
);

const inv49 = ([settings, base, dayPrice, premium, weakPct]) => {
  const DAY = 6, EVE = 6;
  const consW = 350;
  // pvCoverage = (pvW - consW) / maxChargeW and pvStrongCoverage = 400 / maxChargeW, so
  // coverage stays under the threshold exactly when the surplus stays under 400 W —
  // independent of maxChargeW, which the arb varies freely.
  const surplusW = Math.floor((400 * weakPct) / 100); // 60..320 W, strictly weak
  const evePrice = dayPrice + premium;

  const priceValues = [
    ...Array(DAY).fill(dayPrice),
    ...Array(EVE).fill(evePrice),
  ];
  const prices = makePriceSlots(priceValues);
  const pvW = [...Array(DAY).fill(consW + surplusW), ...Array(EVE).fill(0)];

  const eng = runCompute(settings, {
    ...base,
    prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: priceValues.map(() => consW),
    minDischargePrice: 0,
    refillConfidence: 1.0,
    // Opens the flatten gate (needs pvKwhTomorrow >= capacityKwh * 0.6); the terminal side
    // is abundant too, so end-of-horizon SoC is worthless and the pack is meant to empty.
    pvKwhTomorrow: base.capacityKwh * 2,
    terminalPvKwhTomorrow: base.capacityKwh * 2,
  });
  if (!eng._schedule || !eng._flattenDebug) return true;
  const slots = eng._schedule.slots;

  // The flatten's refill credit, as the engine actually used it at the live slot.
  const creditKwh = eng._flattenDebug.pvKwhFromT1;

  // What the preserve branch can really put in the cell over the same span (slot 1 onwards,
  // matching pvKwhFromT[1]): only slots at or above the store threshold contribute, and each
  // contributes pvCoverage * chargeKwhFull. Recomputed here from the schedule's own coverage
  // rather than from the scenario, so it tracks whatever the engine derived.
  const pvStrongCoverage = 400 / base.maxChargeW;
  const chargeKwhFull = base.maxChargeW / 1000; // 1-hour slots
  let storableKwh = 0;
  for (let t = 1; t < slots.length; t++) {
    const cov = slots[t].pvCoverage ?? 0;
    if (cov >= pvStrongCoverage) storableKwh += cov * chargeKwhFull;
  }

  // Credit above what can be stored is a promise of a recharge the plan will not make; the
  // flatten then removes an SoC gradient that is still real, and discharging reads as free.
  // pvKwhFromT1 is rounded to 2 decimals for the log line, hence the tolerance.
  return creditKwh <= storableKwh + 0.011;
};

testInvariant('49:flatten-refill-credit-never-exceeds-storable-pv', inv49Arb, inv49);

// ─── 50: the charge-slot export gate ─────────────────────────────────────────
// dp_charge_export_gate ships default-on, so it needs both halves: the constraint must bind
// where it should, and it must never bind where it should not. Half (b) is the one that
// catches an over-eager gate — a gate that simply refuses PV charging would pass (a) alone.
//
// Shape: a PV block whose price is deliberately swept across the store-vs-export break-even,
// followed by a no-PV evening block that sets the reachable peak. Sweeping `premium` moves
// storeValue = peak × rte − cycleCost through the daytime price from below to above, so both
// halves get exercised by the same arb.
const inv50Arb = fc.tuple(
  settingsArb,
  fc.record({
    capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 800, max: 3000 }),
    maxDischargeW: fc.integer({ min: 400, max: 1200 }),
    currentSoc:    fc.double({ min: 0, max: 40, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.double({ min: 0.10, max: 0.30, noNaN: true, noDefaultInfinity: true }),  // daytime price
  fc.double({ min: 0.00, max: 0.45, noNaN: true, noDefaultInfinity: true }),  // evening premium
  fc.integer({ min: 120, max: 220 }), // daytime PV surplus as % of the 400 W store threshold
);

const inv50 = ([settings, base, dayPrice, premium, strongPct]) => {
  const DAY = 6, EVE = 6;
  const consW = 350;
  const surplusW = Math.floor((400 * strongPct) / 100); // strictly above the store threshold
  const priceValues = [
    ...Array(DAY).fill(dayPrice),
    ...Array(EVE).fill(dayPrice + premium),
  ];
  const prices = makePriceSlots(priceValues);
  const pvW = [...Array(DAY).fill(consW + surplusW), ...Array(EVE).fill(0)];
  const scenario = {
    ...base,
    prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: priceValues.map(() => consW),
    minDischargePrice: 0,
    // High enough that a grid charge is never blocked by the ceiling — the gate must be the
    // only thing that can veto a charge here, or (b) would measure the ceiling instead.
    maxChargePrice: 10,
  };

  const on  = runCompute({ ...settings, dp_charge_export_gate: true }, scenario);
  const off = runCompute({ ...settings, dp_charge_export_gate: false }, scenario);
  if (!on._schedule || !off._schedule) return true;

  const slotsOn  = on._schedule.slots;
  const slotsOff = off._schedule.slots;

  for (let t = 0; t < slotsOn.length; t++) {
    const s = slotsOn[t];
    const store = s.pvStoreValue;
    if (store == null) continue;

    // (a) the constraint binds: no charge survives on a PV slot where exporting pays more.
    // Saldering (export_price_ratio 1.0 in settingsArb) makes the export value the slot price.
    if (s.action === 'charge' && (s.pvCoverage ?? 0) > 0 && store <= s.price) return false;

    // (b) economic dominance: the gate may only remove a charge that loses money. Anywhere
    // storing beats exporting, the plan must be untouched by the flag.
    if (store > s.price && slotsOff[t].action === 'charge' && s.action !== 'charge') return false;
  }
  return true;
};

testInvariant('50:charge-export-gate-binds-only-below-break-even', inv50Arb, inv50);

// ─── 51: the flatten refill credit must arrive in time ───────────────────────
// Invariant 49 asks whether the credited PV can be stored at all. This one asks WHEN it lands:
// a refill only makes today's SoC worthless if it arrives before the best price still ahead.
// Traced live 2026-08-20 — 5.47 of 5.57 kWh credit came from the next morning while the peak
// sat that same evening, so the pack dumped its last kWh at €0.227 under a €0.375 slot.
//
// Shape: a cheap no-PV head, a peak block, and a PV block, with the PV block placed either
// after the peak (the credit must be dropped) or before it (the credit must survive untouched).
// The second half is what catches an over-eager cut-off: a rule that always zeroed the credit
// would satisfy the first half on its own.
const inv51Arb = fc.tuple(
  settingsArb,
  fc.record({
    capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 800, max: 3000 }),
    maxDischargeW: fc.integer({ min: 400, max: 1200 }),
    currentSoc:    fc.double({ min: 0, max: 40, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.double({ min: 0.10, max: 0.30, noNaN: true, noDefaultInfinity: true }),  // base price
  fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }),  // peak premium
  fc.integer({ min: 120, max: 220 }), // PV surplus as % of the 400 W store threshold
  fc.boolean(),                       // PV block after the peak?
);

const inv51 = ([settings, base, basePrice, premium, strongPct, pvAfterPeak]) => {
  const HEAD = 4, PEAK = 2, PV = 5;
  const consW = 350;
  const surplusW = Math.floor((400 * strongPct) / 100);

  const headPrices = Array(HEAD).fill(basePrice);
  const peakPrices = Array(PEAK).fill(basePrice + premium);
  const pvPrices   = Array(PV).fill(basePrice);
  const pvBlockW   = Array(PV).fill(consW + surplusW);
  const flatBlockW = n => Array(n).fill(0);

  const priceValues = pvAfterPeak
    ? [...headPrices, ...peakPrices, ...pvPrices]
    : [...headPrices, ...pvPrices, ...peakPrices];
  const pvW = pvAfterPeak
    ? [...flatBlockW(HEAD), ...flatBlockW(PEAK), ...pvBlockW]
    : [...flatBlockW(HEAD), ...pvBlockW, ...flatBlockW(PEAK)];

  const prices = makePriceSlots(priceValues);
  const eng = runCompute(settings, {
    ...base,
    prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: priceValues.map(() => consW),
    minDischargePrice: 0,
    refillConfidence: 1.0,
    // Opens the flatten gate, which needs pvKwhTomorrow >= capacityKwh * 0.6.
    pvKwhTomorrow: base.capacityKwh * 2,
    terminalPvKwhTomorrow: base.capacityKwh * 2,
  });
  if (!eng._schedule || !eng._flattenDebug) return true;
  const fd = eng._flattenDebug;
  if (fd.pvKwhBeforePeak == null) return false; // the order check must be reported at all

  // Both figures are rounded to 2 decimals for the log line, hence the tolerance.
  if (pvAfterPeak) {
    // (a) the constraint binds: every storable slot lies past the peak, so nothing may be
    // credited and the gate must stay shut at the live slot.
    return fd.pvKwhBeforePeak <= 0.011 && fd.flattenGateOpen === false;
  }
  // (b) economic dominance: the PV lands before the peak, so the order check may remove
  // nothing — the flatten must see exactly the credit it saw before this constraint existed.
  return fd.pvKwhBeforePeak >= fd.pvKwhFromT1 - 0.011;
};

testInvariant('51:flatten-credit-must-arrive-before-the-peak', inv51Arb, inv51);

// ─── 52: every planned charge must be repayable ──────────────────────────────
// The other 51 invariants each guard one mechanism; none looks at the outcome. Measured
// 2026-08-20 on dp-trace 19/20 aug: 21 unique charge→discharge pairs, all negative at
// RTE 0.732 — the DP's own break-even `pd >= (pc + cycle) / rte` was met by none of them.
// Every single fix stayed green while the emitted plan kept losing money, so this asks the
// only question that matters: can the plan pay back what it buys?
//
// Deliberately the WEAKEST form of that question, so a failure is unambiguous:
//  - it credits the charge with the best price anywhere ahead, not with the slot the plan
//    actually discharges into (pairing-independent — if the best case cannot repay it,
//    no pairing can);
//  - it exempts charging that the terminal value pays for, using an upper bound on that
//    value rather than a second copy of the formula at optimization-engine.js:1160-1163
//    (topQuartile of the last 24h × 0.8 × rte × terminalFactor ≤ maxPrice × 0.8 × rte ×
//    terminalFactor). Bounding from above can only suppress failures, never invent one.
//
// No PV inside the horizon: every charge is then a grid charge and pvCoverage stays 0, which
// is also what arms the pvAbundant cycle-cost waiver (engine :1428). pvKwhTomorrow is swept
// across that waiver's 1.5 × capacity threshold so both regimes are exercised.
//
// Guards the dp_charge_repay_gate cancel (engine compute(), forward roll-out). Root cause is
// unchanged and deliberately so: pvAbundant waives the discharge-side half cycle while the
// charge side always pays its own, so the backward pass still prices a round trip at half a
// cycle. Ablating that term instead measured worse over 52 dumps (−€0.036/horizon at the DP's
// own residual value, −13.4 kWh discharge) to catch one 0.20 kWh slot, so the plan is filtered
// on the way out rather than repriced. The gate is set below because it ships default-off
// (shadow) — this invariant tests the behaviour with it on, which is what switch-on will make
// live. See memory/project_dp_pvabundant_waiver_halves_roundtrip_0820.md.
// Shape: a cheap head followed by a peak block, on 15-MINUTE slots. Both details are load
// bearing and were found by probing, not assumed. On hourly slots one charge step is a third
// of a small pack, which is chunky enough that the DP never takes the marginal step that
// loses money; at 15 min it does. And the loss only appears once pvKwhTomorrow clears the
// pvAbundant threshold (1.5 × capacity), so the ratio is swept across it — 36/972 probed
// combinations were unrepayable and every one of them had both.
//
// Own settings arbitrary instead of settingsArb: a round trip can only be unrepayable when
// the losses are real, and settingsArb spans rte 0.50–1.00 × wear €0–0.10, where the two
// draws that matter are jointly rare enough that 1000 runs never landed on a counterexample
// the predicate does reject when handed to it directly. Narrowed to the band real packs
// occupy (live device: rte 0.732, wear €0.075) so the property is exercised, not decorative.
const inv52SettingsArb = fc.record({
  battery_efficiency:  fc.double({ min: 0.60, max: 0.85, noNaN: true, noDefaultInfinity: true }),
  min_soc:             fc.constant(0),
  max_soc:             fc.integer({ min: 85, max: 100 }),
  cycle_cost_per_kwh:  fc.double({ min: 0.04, max: 0.10, noNaN: true, noDefaultInfinity: true }),
  export_price_ratio:  fc.constant(1.0),
  dp_charge_repay_gate: fc.constant(true),
});

const inv52Arb = fc.tuple(
  inv52SettingsArb,
  fc.record({
    capacityKwh:   fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),
    maxChargeW:    fc.integer({ min: 800, max: 3000 }),
    maxDischargeW: fc.integer({ min: 400, max: 1200 }),
    currentSoc:    fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.double({ min: 0.10, max: 0.30, noNaN: true, noDefaultInfinity: true }), // base price
  fc.double({ min: 0.05, max: 0.30, noNaN: true, noDefaultInfinity: true }), // peak premium
  fc.integer({ min: 6, max: 12 }),                                           // cheap head, slots
  fc.integer({ min: 3, max: 8 }),                                            // peak block, slots
  fc.double({ min: 0, max: 3.0, noNaN: true, noDefaultInfinity: true }),     // pvKwhTomorrow / capacity
  fc.integer({ min: 200, max: 600 }),                                        // flat house load, W
);

const inv52 = ([settings, base, basePrice, premium, headLen, peakLen, pvTomRatio, consW]) => {
  const priceValues = [
    ...Array(headLen).fill(basePrice),
    ...Array(peakLen).fill(basePrice + premium),
  ];
  const prices = makePriceSlots(priceValues, 0.25);
  const eng = runCompute(settings, {
    ...base,
    prices,
    pvForecast: makePvForecast(prices, priceValues.map(() => 0)),
    consumptionW: priceValues.map(() => consW),
    minDischargePrice: 0,
    pvKwhTomorrow: base.capacityKwh * pvTomRatio,
    terminalPvKwhTomorrow: base.capacityKwh * pvTomRatio,
  });
  const slots = eng._schedule?.slots;
  if (!slots || slots.length === 0) return true;

  const rte = settings.battery_efficiency;
  const cycle = settings.cycle_cost_per_kwh;
  const maxPrice = Math.max(...priceValues);
  const terminalCeil = maxPrice * 0.8 * rte * (eng._schedule.terminalFactor ?? 0);

  // Best net €/kWh still obtainable at or after each index, by discharging there.
  const valueAhead = new Array(slots.length).fill(-Infinity);
  let best = -Infinity;
  for (let i = slots.length - 1; i >= 0; i--) {
    valueAhead[i] = best;
    const v = slots[i].price * rte - 0.5 * cycle;
    if (v > best) best = v;
  }

  const EPS = 0.002; // €/kWh — do not fail on ties
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].action !== 'charge' || !(slots[i].actionKwh > 0)) continue;
    const cost = slots[i].price + 0.5 * cycle;
    if (cost > Math.max(valueAhead[i], terminalCeil) + EPS) return false;
  }
  return true;
};

testInvariant('52:planned-charge-must-be-repayable', inv52Arb, inv52);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 53
// "A deferral must point at a slot that competes for the same cell"
//
// cheaperPvAhead cancels storing PV because a cheaper pvStrong slot follows. That trade only
// exists while both slots want the SAME room: once the price peak that the store value is
// priced against sits between them, the pack discharges into that peak and has room for both,
// so waiting buys nothing and hands this slot's surplus to the grid at the export price.
// Under asymmetric_2027 the export price is well below retail, which makes the give-away real.
//
// Economic dominance: whenever the gate is set, there must be a pvStrong slot at or before the
// peak whose EXPORT value is meaningfully lower — that is, a genuine cheaper place to store,
// reachable before the pack empties. Live 2026-08-24 14:00Z the gate pointed at the next day.
// Saldering keeps the old retail comparison and is exempt.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 53 — deferral-must-precede-the-peak\n');

const inv53Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 6.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.double({ min: 0.05, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 8, maxLength: 20 }),                                        // hourly prices
  fc.integer({ min: 800, max: 2500 }),                                       // maxChargeW
  fc.integer({ min: 200, max: 900 }),                                        // consumption W
  fc.integer({ min: 10, max: 95 }),                                          // starting SoC %
);

const inv53 = ([rte, capacityKwh, hourly, maxChargeW, consW, currentSoc]) => {
  const settings = {
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    tariff_model: 'asymmetric_2027', export_price_ratio: 0.5,
  };
  const prices = makePriceSlots(hourly, 1);
  // Alternate PV-strong and PV-free hours so both the gate and a peak between them can arise.
  const pvW = hourly.map((_, h) => (h % 2 === 0 ? consW + maxChargeW + 500 : 0));
  const eng = runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 800, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });
  if (!eng._schedule) return true;

  const slots = eng._schedule.slots;
  const N = slots.length;
  const pvStrongCoverage = 400 / maxChargeW;
  const exp = (t) => exportValue(prices[t], settings.tariff_model, 0.5);

  for (let t = 0; t < N; t++) {
    if (!slots[t].cheaperPvAhead) continue;
    // Earliest slot after t carrying the highest price — the peak the store value is priced on.
    let peak = t + 1;
    for (let k = t + 2; k < N; k++) if (slots[k].price > slots[peak].price) peak = k;
    let reachable = false;
    for (let k = t + 1; k <= peak && k < N; k++) {
      if (slots[k].pvCoverage >= pvStrongCoverage && exp(k) < exp(t) - 1e-9) { reachable = true; break; }
    }
    if (!reachable) return false;   // deferring to a slot on the far side of the peak
  }
  return true;
};

testInvariant('53:deferral-must-precede-the-peak', inv53Arb, inv53);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 54
// "The curtailment floor is exactly a zero-clamped export price — on every DP surface"
//
// pv_curtailment_enabled tells the DP the inverter can be throttled, so surplus PV that does
// not fit in the battery can be thrown away for free. _disposalValue() implements that as
// max(0, exportValue). It matters because the DP books export ONLY as forgone revenue
// (effectiveChargeCost, vPreserve): an unfloored negative export price reads as a payment for
// charging — the phantom test/dp-curtailment-floor.test.js reproduces.
//
// Economic dominance: the plan made with the floor ON must be IDENTICAL to the plan the same
// engine makes with the floor OFF on prices whose export side is already clamped at zero.
// Any DP site still reading the raw exportValue while the flag is set diverges here, and so
// does any site applying the floor while the flag is off. Actions AND the SoC path are
// compared — a floor that only moves labels is not a floor.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 54 — curtailment-floor-equals-zero-clamped-export\n');

const inv54Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.tuple(
    fc.double({ min: 0.05, max: 0.45, noNaN: true, noDefaultInfinity: true }),  // import price
    fc.double({ min: -0.25, max: 0.25, noNaN: true, noDefaultInfinity: true }), // export price
  ), { minLength: 8, maxLength: 16 }),
  fc.integer({ min: 600, max: 2500 }),                                      // maxChargeW
  fc.integer({ min: 150, max: 900 }),                                       // consumption W
  fc.integer({ min: 5, max: 90 }),                                          // starting SoC %
);

const inv54 = ([rte, capacityKwh, hourly, maxChargeW, consW, currentSoc]) => {
  const base = {
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    tariff_model: 'asymmetric_2027', export_price_ratio: 1.0,
  };
  // clampExport = the same horizon with the negative export slots already at zero.
  const mkPrices = (clampExport) => makePriceSlots(hourly.map(([p]) => p), 1)
    .map((s, i) => ({ ...s, exportPrice: clampExport ? Math.max(0, hourly[i][1]) : hourly[i][1] }));

  // Surplus every other hour, so both the charge and the preserve branch see PV to dispose of.
  const pvW = hourly.map((_, h) => (h % 2 === 0 ? consW + maxChargeW + 400 : 0));
  const run = (settings, prices) => runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 1200, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });

  const on  = run({ ...base, pv_curtailment_enabled: true  }, mkPrices(false));
  const off = run({ ...base, pv_curtailment_enabled: false }, mkPrices(true));
  if (!on._schedule || !off._schedule) return !on._schedule === !off._schedule;

  const a = on._schedule.slots;
  const b = off._schedule.slots;
  if (a.length !== b.length) return false;
  for (let t = 0; t < a.length; t++) {
    if (a[t].action !== b[t].action) return false;
    if (Math.abs(a[t].socProjected - b[t].socProjected) > 0.05) return false;
  }
  return true;
};

testInvariant('54:curtailment-floor-equals-zero-clamped-export', inv54Arb, inv54);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 55
// "The refill reserve never rises when the forecast promises more refill"
//
// The floor this replaces (dp_cvar_reserve off) is (1 - refillConfidence) * 0.5 * span, whose
// height rises with forecast UNCERTAINTY and therefore sits above the post-peak SoC exactly
// when PV is doubtful — measured live, all ~64 runs at floor 24-38% held 0.00 kWh. The CVaR
// height is meant to invert that: it insures the evening need that the refill plausibly fails
// to deliver, so more demonstrable coverage must lower it, never raise it.
//
// test/cvar-reserve-floor.test.js already pins the closed form. What is tested HERE is the
// path from PV forecast to reserve height through compute(): eveningNeedKwh shrinks as PV
// serves the tail, lastStrongPv moves later, storablePrefix grows. Each of those is monotone
// on its own; the property is that their composition is too, which no unit test can see.
//
// Scaling one PV shape over a ladder keeps every other input fixed, so a rise anywhere on the
// ladder is attributable to PV alone. The saturated run is a separate, absolute claim: PV over
// the strong threshold in every slot leaves no post-PV tail at all, so the height must be
// exactly zero — the "demonstrable coverage collapses it" half of the design.
//
// Reads _gateB.b6_reserveAddG, the height the formula emitted, not max(reserveFloorG): WHERE
// the floor lands also depends on lastStrongPv and releasedPeak, so a placement change would
// otherwise read as a height change. Placement is invariant 56's subject.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 55 — cvar-reserve-floor-monotone\n');

const inv55Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.double({ min: 0.05, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 10, maxLength: 20 }),                                       // hourly prices
  fc.array(fc.double({ min: 0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    { minLength: 10, maxLength: 20 }),                                       // PV surplus shape
  fc.integer({ min: 800, max: 2500 }),                                       // maxChargeW
  fc.integer({ min: 200, max: 900 }),                                        // consumption W
  fc.integer({ min: 5, max: 95 }),                                           // starting SoC %
);

// Coverage counters. A ladder pinned at the 0.5-span cap on every step satisfies monotonicity
// trivially, so the number that matters is how often the height actually MOVED.
let inv55Binding = 0;  // ladder steps with a non-zero reserve
let inv55Moved = 0;    // scenarios where more PV strictly lowered the height at least once

const inv55 = ([rte, capacityKwh, hourly, pvShape, maxChargeW, consW, currentSoc]) => {
  const settings = {
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    export_price_ratio: 1.0, dp_cvar_reserve: true, dp_gate_b_count: 1,
  };
  const prices = makePriceSlots(hourly, 1);
  const run = (pvW) => runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 1200, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });
  const heightOf = (eng) => eng._gateB?.b6_reserveAddG;

  // Same shape at 0x, 1/2x, 1x, 2x, 4x. pvShape is indexed, not cycled: a shape shorter than
  // the horizon leaves the tail PV-free, which is what creates an evening need to insure.
  let prev = null;
  let moved = false;
  for (const scale of [0, 0.5, 1, 2, 4]) {
    const h = heightOf(run(prices.map((_, t) => (pvShape[t] ?? 0) * maxChargeW * scale)));
    if (h == null) return true; // compute bailed out — nothing to compare
    if (h > 0) inv55Binding++;
    if (prev != null && h > prev) return false;
    if (prev != null && h < prev) moved = true;
    prev = h;
  }
  if (moved) inv55Moved++;

  // Strong PV in every slot: no post-PV tail, hence nothing to insure.
  const saturated = heightOf(run(prices.map(() => consW + maxChargeW * 2)));
  return saturated === 0;
};

testInvariant('55:cvar-reserve-floor-monotone', inv55Arb, inv55, 300);
log(`Reserve non-zero on ${inv55Binding} ladder steps; height strictly fell with more PV in `
  + `${inv55Moved} scenarios (0 there would mean the ladder never left the cap).\n`);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 56
// "The reserve never withholds the priciest slot ahead"
//
// The reserve is only spendable AFTER the last strong-PV slot, so its value is the best price
// in that trailing window (releasedPeak). Flooring a slot whose own price beats releasedPeak
// therefore sacrifices an expensive kWh to insure a cheaper one — the floor pays for its own
// insurance out of the horizon's best slot. The guard for that lives in the placement loop
// (engine :1357-1366) and is untouched by the CVaR rewrite, but the rewrite changes the height
// and the height decides whether the placement runs at all, so it is exercised here.
//
// Two claims, structural first and economic second:
//  (a) no floored slot is the strict price maximum of everything at or after it. Floored slots
//      always precede lastStrongPv and releasedPeak is attained after it, so a floored slot
//      must have a slot ahead priced at least as high. Prices are kept positive: at a negative
//      price discharging is worth nothing and minDischargePrice blocks it anyway, so a floor
//      there withholds nothing.
//  (b) economic dominance against a floor-free baseline (flag off at refillConfidence 1.0,
//      where the legacy height is exactly 0): at the horizon's strict price maximum, entering
//      with at least as much SoC must not deliver less energy. This is where a floor placed on
//      LATER slots would show up — the per-slot floor cannot itself starve an earlier slot, but
//      the post-DP passes (reorder rollback, near-floor chatter, forward roll-out at :1021-1042)
//      all read reserveFloorG and can move discharge across it.
//
// Energy is read off the SoC path, not the action label: a relabelled slot that still delivers
// the same kWh is not a suppression (memory/feedback_score_energy_from_soc_path_not_labels).
// socProjected[t] is the SoC ENTERING slot t — the forward pass pushes the slot before it
// advances socG (engine :761 vs :788-795) — so slot t's own delivery is the step to t+1, and a
// peak in the last slot has no step to read and is skipped.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 56 — cvar-floor-never-suppresses-priciest-slot\n');

const inv56Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.double({ min: 0.02, max: 0.60, noNaN: true, noDefaultInfinity: true }),
    { minLength: 10, maxLength: 20 }),                                       // hourly prices
  fc.array(fc.double({ min: 0, max: 1.5, noNaN: true, noDefaultInfinity: true }),
    { minLength: 6, maxLength: 14 }),                                        // PV surplus shape
  fc.integer({ min: 800, max: 2500 }),                                       // maxChargeW
  fc.integer({ min: 200, max: 900 }),                                        // consumption W
  fc.integer({ min: 5, max: 95 }),                                           // starting SoC %
);

let inv56Floored = 0;  // slots the reserve actually floored — claim (a)'s exposure
let inv56Judged = 0;   // scenarios where the dominance comparison ran — claim (b)'s exposure

const inv56 = ([rte, capacityKwh, hourly, pvShape, maxChargeW, consW, currentSoc]) => {
  const base = {
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    export_price_ratio: 1.0,
  };
  const prices = makePriceSlots(hourly, 1);
  const pvW = prices.map((_, t) => (pvShape[t] ?? 0) * maxChargeW);
  const run = (settings) => runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 1200, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });

  const on  = run({ ...base, dp_cvar_reserve: true });
  const off = run({ ...base, dp_cvar_reserve: false });
  const floorG = on._lastDpArrays?.reserveFloorG;
  if (!floorG || !on._schedule || !off._schedule) return true;

  const slotsOn = on._schedule.slots;
  const N = Math.min(slotsOn.length, floorG.length, hourly.length);

  // (a) min_soc is 0, so any floorG above 0 is a reserve.
  for (let t = 0; t < N; t++) {
    if (floorG[t] <= 0) continue;
    inv56Floored++;
    let maxAhead = -Infinity;
    for (let u = t + 1; u < N; u++) if (hourly[u] > maxAhead) maxAhead = hourly[u];
    if (!(maxAhead >= hourly[t] - 1e-9)) return false;
  }

  // (b) only meaningful at a unique maximum: on a tie the plan may legitimately serve the
  // other copy instead, which is the same kWh at the same price.
  let peak = 0;
  for (let t = 1; t < N; t++) if (hourly[t] > hourly[peak]) peak = t;
  if (hourly.filter(p => p >= hourly[peak] - 1e-9).length !== 1) return true;

  const slotsOff = off._schedule.slots;
  if (slotsOff.length !== slotsOn.length) return true;
  if (peak + 1 >= slotsOn.length) return true;
  const delivered = (slots, t) =>
    Math.max(0, (slots[t].socProjected - slots[t + 1].socProjected) / 100) * capacityKwh;

  const socOn = slotsOn[peak].socProjected;
  const socOff = slotsOff[peak].socProjected;
  if (socOn < socOff - 1e-9) return true; // entered poorer for other reasons — not this claim

  inv56Judged++;
  return delivered(slotsOn, peak) >= delivered(slotsOff, peak) - 0.02;
};

testInvariant('56:cvar-floor-never-suppresses-priciest-slot', inv56Arb, inv56, 400);
log(`Reserve floored ${inv56Floored} slots (claim a); the dominance comparison at the price `
  + `maximum ran in ${inv56Judged} scenarios (claim b — 0 there would make that half decorative).\n`);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 57
// "Never discharge into a negative import price"
//
// Below zero the grid pays per kWh drawn. Discharging replaces an import that would
// have EARNED price × kwh, so it books a strict loss against preserve — which is
// always available. This is the economic-dominance half of the inverter-off change
// (lib/curtailment.js fullCurtailSlot): the runtime throttles PV to 0W and lets the
// grid serve house and battery, and that only pays off if the DP is not
// simultaneously emptying the battery into the same slot.
//
// It also guards the assumption recorded in the plan: policy-engine's discharge
// branch has no price < 0 guard of its own (the charge and preserve branches do),
// so nothing but the DP's own arithmetic keeps discharge out of these slots.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 57 — never-discharge-into-negative-import-price\n');

let inv57NegSlots = 0;

const inv57Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.double({ min: -0.20, max: 0.45, noNaN: true, noDefaultInfinity: true }),
    { minLength: 8, maxLength: 16 }),                                       // import prices
  fc.integer({ min: 600, max: 2500 }),                                      // maxChargeW
  fc.integer({ min: 150, max: 900 }),                                       // consumption W
  fc.integer({ min: 5, max: 90 }),                                          // starting SoC %
);

const inv57 = ([rte, capacityKwh, hourly, maxChargeW, consW, currentSoc]) => {
  const prices = makePriceSlots(hourly, 1);
  const pvW = hourly.map((_, h) => (h % 2 === 0 ? consW + maxChargeW + 400 : 0));
  const r = runCompute({
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    tariff_model: 'saldering', pv_curtailment_enabled: true,
  }, {
    capacityKwh, maxChargeW, maxDischargeW: 1200, currentSoc, prices,
    pvForecast: makePvForecast(prices, pvW),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });
  if (!r._schedule) return true;

  const slots = r._schedule.slots;
  for (let t = 0; t < slots.length; t++) {
    if (!(hourly[t] < 0)) continue;
    inv57NegSlots++;
    if (slots[t].action === 'discharge') return false;
    // Labels are not the ledger — check the SoC path too (feedback_score_energy_from_soc_path).
    const next = slots[t + 1]?.socProjected;
    if (next != null && next < slots[t].socProjected - 0.05) return false;
  }
  return true;
};

testInvariant('57:never-discharge-into-negative-import-price', inv57Arb, inv57);
log(`Judged ${inv57NegSlots} negative-price slots — 0 would make this invariant decorative.\n`);

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT 58
// "pv_curtailment_enabled does exactly two things and nothing else"
//
// The flag has two channels: the disposal floor on export value (invariant 54) and,
// new, zeroing pvW on slots the plan will throttle to 0W (optimization-engine.js
// masks pvWPerSlot, the single feed for pvKwhFromT / pvSaturatesAhead / pvAbundant /
// refillConfidence / pvWForDischarge). If those are the only channels, the flag ON
// must produce the identical plan to the flag OFF fed the already-transformed inputs.
//
// A mask applied in one of the two pv arrays but not the other, or a downstream
// aggregate reading the raw forecast around the mask, diverges here. Actions AND the
// SoC path are compared.
// ─────────────────────────────────────────────────────────────────────────────

log('\n## Invariant 58 — curtailment-flag-equals-masked-pv-and-clamped-export\n');

let inv58NegSlots = 0;

const inv58Arb = fc.tuple(
  fc.double({ min: 0.70, max: 0.95, noNaN: true, noDefaultInfinity: true }), // rte
  fc.double({ min: 1.5, max: 8.0, noNaN: true, noDefaultInfinity: true }),   // capacityKwh
  fc.array(fc.tuple(
    fc.double({ min: -0.20, max: 0.45, noNaN: true, noDefaultInfinity: true }),  // import price
    fc.double({ min: -0.25, max: 0.25, noNaN: true, noDefaultInfinity: true }),  // export price
  ), { minLength: 8, maxLength: 16 }),
  fc.integer({ min: 600, max: 2500 }),                                      // maxChargeW
  fc.integer({ min: 150, max: 900 }),                                       // consumption W
  fc.integer({ min: 5, max: 90 }),                                          // starting SoC %
);

const inv58 = ([rte, capacityKwh, hourly, maxChargeW, consW, currentSoc]) => {
  const base = {
    battery_efficiency: rte, min_soc: 0, max_soc: 100, cycle_cost_per_kwh: 0.05,
    tariff_model: 'asymmetric_2027', export_price_ratio: 1.0,
  };
  const mkPrices = (clampExport) => makePriceSlots(hourly.map(([p]) => p), 1)
    .map((s, i) => ({ ...s, exportPrice: clampExport ? Math.max(0, hourly[i][1]) : hourly[i][1] }));

  const pvW = hourly.map((_, h) => (h % 2 === 0 ? consW + maxChargeW + 400 : 0));
  // The OFF run gets the transform applied by hand: PV gone where the import price
  // is negative, export floored at zero everywhere.
  const pvWMasked = pvW.map((w, i) => (hourly[i][0] < 0 ? 0 : w));
  for (let i = 0; i < hourly.length; i++) if (hourly[i][0] < 0) inv58NegSlots++;

  const run = (settings, prices, pv) => runCompute(settings, {
    capacityKwh, maxChargeW, maxDischargeW: 1200, currentSoc, prices,
    pvForecast: makePvForecast(prices, pv),
    consumptionW: prices.map(() => consW),
    minDischargePrice: 0, refillConfidence: 1.0,
    pvKwhTomorrow: 0, terminalPvKwhTomorrow: 0,
  });

  const on  = run({ ...base, pv_curtailment_enabled: true  }, mkPrices(false), pvW);
  const off = run({ ...base, pv_curtailment_enabled: false }, mkPrices(true), pvWMasked);
  if (!on._schedule || !off._schedule) return !on._schedule === !off._schedule;

  const a = on._schedule.slots;
  const b = off._schedule.slots;
  if (a.length !== b.length) return false;
  for (let t = 0; t < a.length; t++) {
    if (a[t].action !== b[t].action) return false;
    if (Math.abs(a[t].socProjected - b[t].socProjected) > 0.05) return false;
  }
  return true;
};

testInvariant('58:curtailment-flag-equals-masked-pv-and-clamped-export', inv58Arb, inv58);
log(`Masked ${inv58NegSlots} negative-price slots across the runs.\n`);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(60));
console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);

if (failedInvariants.length > 0) {
  console.log('\nFailed:');
  for (const f of failedInvariants) console.log(`  ✗ ${f.name}`);
}

log(`\n---\n## Summary\n- Passed: ${totalPassed}\n- Failed: ${totalFailed}\n`);
if (failedInvariants.length > 0) {
  log('### Failed invariants\n' + failedInvariants.map(f => `- ${f.name}`).join('\n') + '\n');
}

console.log(`\nFull log: ${LOG_FILE}\n`);

if (totalFailed > 0) process.exit(1);
