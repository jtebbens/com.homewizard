'use strict';

// Central source guard for the battery State-of-Charge stream.
//
// A battery-device WebSocket re-init briefly reports SoC=0% while the real SoC is high
// (observed 88%→0% and 97%→0% within one sample, 2026-07-15). Several consumers branch on
// soc==0 / soc<=threshold and get corrupted by the glitch: CostModel RESET wipes the
// cost-ledger, the policy cost-reset / SmartLowSoC skip discharge logic, the reserve-floor
// trigger fires a spurious reactive run, and the SoC-history chart is polluted. The RTE
// booking is already guarded locally (efficiency-estimator.js, commit 049dd23), but the rest
// are not.
//
// This rejects the impossible collapse-to-zero at the source so every consumer sees a
// sanitised value. It holds the last valid SoC until either a plausible reading returns or
// the low reading persists across `maxHoldSamples` polls (safety-valve for a rare genuine
// collapse). Forward-only — it does not repair already-polluted state. The plausibility
// window (`<= max(minSoc,3)` from `> 10`) mirrors the RTE-local guard so the whole app uses
// one coherent rule. See project_battery_rte_power_season.

const DEFAULT_MAX_HOLD_SAMPLES = 3; // ~45s at the 15s poll cadence

function createState() {
  return { lastValidSoc: undefined, glitchCount: 0 };
}

// rawSoc: the value straight off `battery_group_average_soc` (may be null).
// state: { lastValidSoc, glitchCount } — mutated in place and returned.
// Returns { soc, state, held }. `held` = the raw sample was rejected as a glitch.
function sanitizeSoc(rawSoc, state, opts = {}) {
  if (!state) state = createState();
  const minSoc = opts.minSoc ?? 0;
  const maxHoldSamples = opts.maxHoldSamples ?? DEFAULT_MAX_HOLD_SAMPLES;

  // Preserve existing null-handling downstream (the `?? 50` fallbacks stay at the call sites).
  if (rawSoc === null || rawSoc === undefined) return { soc: rawSoc, state, held: false };

  // First-ever sample: nothing to judge against, seed it.
  if (state.lastValidSoc === undefined) {
    state.lastValidSoc = rawSoc;
    state.glitchCount = 0;
    return { soc: rawSoc, state, held: false };
  }

  const isCollapse = rawSoc <= Math.max(minSoc, 3) && state.lastValidSoc > 10;
  if (isCollapse) {
    state.glitchCount += 1;
    if (state.glitchCount < maxHoldSamples) {
      // Reject the impossible jump — hold the last valid SoC.
      return { soc: state.lastValidSoc, state, held: true };
    }
    // Low across maxHoldSamples polls → accept as a genuine (rare) collapse.
    state.lastValidSoc = rawSoc;
    state.glitchCount = 0;
    return { soc: rawSoc, state, held: false };
  }

  // Plausible reading (incl. a gradual drain 8→5→3→1→0).
  state.glitchCount = 0;
  state.lastValidSoc = rawSoc;
  return { soc: rawSoc, state, held: false };
}

module.exports = { sanitizeSoc, createState, DEFAULT_MAX_HOLD_SAMPLES };
