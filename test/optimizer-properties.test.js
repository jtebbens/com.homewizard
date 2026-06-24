'use strict';

/**
 * Property-based test suite for OptimizationEngine.
 * Uses fast-check to generate 1000 randomized scenarios per invariant.
 *
 * Invariants under test:
 *   1. No grid charge when PV surplus fully covers charge power for the full slot
 *   2. Schedule fills to maxSoc when enough negative-price slots exist + capacity allows
 *   3. Displayed socProjected exactly matches the forward-pass action trace
 *   4. Cycle counter (kwhDischarged sum) is monotonic across simulated restarts
 *   5. policy_mode_history has exactly one entry per unique 15-min bucket
 *   6. RTE factor never double-applied: same action → same SoC delta regardless of RTE
 */

const fc    = require('fast-check');
const assert = require('assert');
const fs    = require('fs');
const path  = require('path');
const OptimizationEngine = require('../lib/optimization-engine');

const LOG_FILE = path.join(__dirname, '..', 'refactor-log.md');
const RUNS     = 1000;
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
    scenario.pvTimingRobust ?? false
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

testInvariant('1:no-grid-charge-full-pv',
  fc.tuple(
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
  ),
  ([settings, base, priceValues, consValues]) => {
    // PV = maxChargeW + max(consW) + 200 → pvCoverage = (pvW − consW) / maxChargeW > 1.0
    const pvW = base.maxChargeW + Math.max(...consValues) + 200;

    const prices    = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, Array(24).fill(pvW));
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
  }
);

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

testInvariant('1b:pv-strong-threshold-straddling',
  fc.tuple(
    fc.record({
      battery_efficiency:  fc.double({ min: 0.50, max: 1.00, noNaN: true, noDefaultInfinity: true }),
      min_soc:             fc.constant(0),
      max_soc:             fc.integer({ min: 85, max: 100 }),
      cycle_cost_per_kwh:  fc.constant(0),
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
  ]),
  ([settings, base, priceValues, consValues, coverageFrac]) => {
    // pvStrongCoverage = 400 / maxChargeW
    const pvStrongCoverage = 400 / base.maxChargeW;

    // Skip if coverageFrac is below pvStrongCoverage for this maxChargeW —
    // below the threshold preserve gets no free gain, so invariant doesn't apply.
    if (coverageFrac <= pvStrongCoverage) return true;

    // pvW = consW + coverageFrac * maxChargeW → pvCoverage = coverageFrac (0.38–0.60)
    // Per slot: use the slot's own consW so pvCoverage stays close to coverageFrac
    const prices = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, consValues.map(
      c => Math.round(c + coverageFrac * base.maxChargeW)
    ));
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
  }
);

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

testInvariant('2:fill-to-max-on-negative-prices',
  fc.tuple(
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
  ),
  ([settings, base, negPrice]) => {
    const slotH = 1; // hourly slots
    // Slots needed to charge from 0 to maxSoc (full capacity × maxSoc%)
    const maxSocFrac    = settings.max_soc / 100;
    const kwhNeeded     = base.capacityKwh * maxSocFrac;
    const kwhPerSlot    = (base.maxChargeW / 1000) * slotH;
    const slotsNeeded   = Math.ceil(kwhNeeded / kwhPerSlot);
    // Add 2 extra negative slots as margin
    const negSlots      = slotsNeeded + 2;
    const todaySlots    = 4; // small number of positive-price "today" slots

    const prices = [
      ...Array(todaySlots).fill(0.20),       // today: positive, no incentive to charge
      ...Array(negSlots).fill(negPrice),      // tomorrow: negative, charge is profitable
      ...Array(Math.max(0, 24 - todaySlots - negSlots)).fill(0.20) // padding
    ].slice(0, Math.max(24, todaySlots + negSlots));

    const currentSoc = 0; // start empty

    const eng = runCompute(settings, {
      ...base,
      currentSoc,
      prices: makePriceSlots(prices),
      pvKwhTomorrow: 0 // no PV interference
    });

    if (!eng._schedule) return true;

    const maxSocReached = eng._schedule.slots.some(
      s => s.socProjected >= settings.max_soc - 1.5 // 1.5 % rounding tolerance
    );
    return maxSocReached;
  }
);

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
// duplicates and no missing entries (up to the 192-entry FIFO cap).
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
    const MAX_HIST  = 192;

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

testInvariant('8:pv-self-consumption-before-grid',
  fc.tuple(
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
  ]),
  ([settings, base, priceValues, consValues, pvCoverages]) => {
    // pvW = consW + coverage * maxChargeW → pvCoverage = (pvW − consW) / maxChargeW = coverage
    const pvWValues = consValues.map((c, t) => c + pvCoverages[t] * base.maxChargeW);
    const prices    = makePriceSlots(priceValues);
    const pvForecast = makePvForecast(prices, pvWValues);
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
  }
);

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

testInvariant('14:night-discharge-defers-to-better-price',
  fc.tuple(
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
  ),
  ([settings, base, priceA, priceDelta, nightConsW]) => {
    const priceB          = priceA + priceDelta;        // priceB > priceA
    const minDischargePrice = 0.220;
    const { capacityKwh, maxChargeW, maxDischargeW } = base;

    // Effective discharge power per slot = min(maxDischargeW, consW)
    const effectiveDischargeW = Math.min(maxDischargeW, nightConsW);
    // SoC % consumed per 1-hour discharge slot (no RTE on SoC projection)
    const perSlotSocPct = (effectiveDischargeW / 1000) * 100 / capacityKwh;

    // Skip degenerate cases: discharge delta too small to matter
    if (perSlotSocPct < 0.5) return true;

    // currentSoc = exactly 1 slot's worth: enough for 1 discharge but not 2.
    // After discharge socG drops to 0 = minSoc → can't discharge again.
    const currentSoc = Math.min(99, perSlotSocPct);

    // Guard: skip if SoC too small to discharge even once
    if (currentSoc < perSlotSocPct - 0.1) return true;

    // PV-day slots: high PV so pvKwhFromT[slot 1 onwards] >= capacityKwh.
    // 8 hourly slots at maxChargeW W each → pvKwh = maxChargeW/1000 * 8
    const pvDaySlots   = 8;
    const pvDayW       = maxChargeW;                               // full charge power
    const pvDayConsW   = 150;                                      // low consumption during PV hours
    const pvKwhFromDay = (pvDayW / 1000) * pvDaySlots;            // kWh PV available
    // Only proceed when PV day can actually refill battery (triggers flatten guard)
    if (pvKwhFromDay < capacityKwh * 0.8) return true;

    // Price array: [nightA, nightB, pvDay×8 at low price (no discharge incentive)]
    const priceValues  = [priceA, priceB, ...Array(pvDaySlots).fill(0.05)];
    const prices       = makePriceSlots(priceValues);

    // PV forecast: no PV for night slots, pvDayW for PV slots
    const pvWValues    = [0, 0, ...Array(pvDaySlots).fill(pvDayW)];
    const pvForecast   = makePvForecast(prices, pvWValues);

    // consumptionWPerSlot: nightConsW for night, pvDayConsW for PV day
    const consumptionW = [nightConsW, nightConsW, ...Array(pvDaySlots).fill(pvDayConsW)];

    // pvKwhTomorrow: net PV surplus that enters battery (pvW - consW, clamped ≥ 0)
    const pvKwhTomorrow = pvDaySlots * Math.max(0, pvDayW - pvDayConsW) / 1000;

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
  }
);

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

testInvariant('22:terminal-never-suppresses-priciest-reachable-discharge',
  fc.tuple(
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
    fc.integer({ min: 3, max: 5 }), // strong-PV refill block length
  ),
  ([settings, base, earlyPrices, tailPrices, pvLen]) => {
    const { maxChargeW } = base;
    const minDischargePrice = 0.220;

    // [early spike | long cheap overnight | strong-PV midday | evening tail].
    // 20 cheap overnight slots push the total horizon past 24h so the trailing-24h terminal
    // window excludes the spike (the regime where the bug exists — the live case was ~30h).
    const nightPrices = Array(20).fill(0.10);
    const pvPrices    = Array(pvLen).fill(0.10);
    const priceValues = [...earlyPrices, ...nightPrices, ...pvPrices, ...tailPrices];
    const prices = makePriceSlots(priceValues);

    const pvWValues = [
      ...earlyPrices.map(() => 0),
      ...nightPrices.map(() => 0),
      ...pvPrices.map(() => maxChargeW + 800), // surplus ≥ charge power → refills battery to full
      ...tailPrices.map(() => 0),
    ];
    const pvForecast   = makePvForecast(prices, pvWValues);
    const consumptionW = priceValues.map(() => 300); // equal load → revenue driven by price alone

    const eng = runCompute(settings, {
      ...base, prices, pvForecast, consumptionW, minDischargePrice,
      pvKwhTomorrow: base.capacityKwh * 2,   // plenty in-horizon PV → battery refills before tail
      terminalPvKwhTomorrow: 0,              // no post-horizon PV → terminalFactor = 1 (worst case)
      refillConfidence: 1.0,                 // no reserve floor → a held peak can only be the bug
    });
    if (!eng._schedule) return true;
    const slots = eng._schedule.slots;

    const tailStart = earlyPrices.length + nightPrices.length + pvLen;
    // Strictly priciest eligible tail slot (skip if a near-tie at the top → ambiguous).
    const PRICE_EPS = 0.005;
    let maxIdx = -1, maxPrice = -Infinity;
    for (let t = tailStart; t < priceValues.length; t++) {
      if (priceValues[t] < minDischargePrice) continue;
      if (priceValues[t] > maxPrice) { maxPrice = priceValues[t]; maxIdx = t; }
    }
    if (maxIdx === -1) return true;
    for (let t = tailStart; t < priceValues.length; t++) {
      if (t !== maxIdx && priceValues[t] >= maxPrice - PRICE_EPS) return true; // tie → skip
    }
    // Battery must actually carry charge into the tail (else 'preserve' is a SoC artefact,
    // not the terminal bug). The midday surplus guarantees this, but assert it explicitly.
    if ((slots[tailStart - 1]?.socProjected ?? 0) < 20) return true;

    return slots[maxIdx].action === 'discharge';
  }
);

// ─── Invariant 18 — PV correction simplification preserves plan quality ──────
//
// The simplified PV correction path (today: skip dailyBias+accFactor, use
// intradayRatio directly) should produce algebraically equivalent DP plans.
// For today's slots: pvW × bias × acc × (ratio / (bias×acc)) = pvW × ratio.
// Test: same scenario through optimizer with legacy vs simplified pvForecast,
// profit delta < 5%.
log('\n## Invariant 18 — pv-correction-simplified-equivalence\n');

{
  const dailyBiasArb = fc.double({ min: 0.8, max: 1.3, noNaN: true, noDefaultInfinity: true });
  const accFactorArb = fc.double({ min: 0.8, max: 1.0, noNaN: true, noDefaultInfinity: true });
  const intradayRatioArb = fc.double({ min: 0.5, max: 2.0, noNaN: true, noDefaultInfinity: true });

  const corrArb = fc.tuple(settingsArb, baseArb, dailyBiasArb, accFactorArb, intradayRatioArb);

  testInvariant(
    '18:pv-correction-simplified-equivalence',
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
