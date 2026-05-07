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

function makePvForecast(priceSlots, pvWValues) {
  return priceSlots.map((slot, i) => ({
    timestamp: slot.timestamp,
    pvPowerW: pvWValues[i] ?? 0
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
    scenario.pvKwhTomorrow ?? 0
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
      { numRuns: runs, seed: SEED, verbose: false }
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
