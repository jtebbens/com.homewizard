'use strict';

// Single scalar satellite yield factor (panel-plane basis).
//
// recordSatYield is fed panel-plane GHI (raw satellite GHI × the ensemble's own
// gtiOverGhi transposition — device.js). In that basis the yield factor
//   yf = actualW / panelPlaneGHI[W/m²] = array area × system efficiency
// is ~constant across the day: the sun-angle geometry already lives in gtiOverGhi,
// so it must NOT be re-encoded per hour. The old per-hour SAT_YIELD_FACTORS table
// (0.498–5.924, morning-peaked) was a HORIZONTAL-basis artifact; combined with the
// panel-plane feed it double-counted the tilt geometry, which is why the per-hour
// EMA ramped 1.5 (morning) → 5.8 (afternoon) and never settled (see
// project_sat_yield_ema_cross_hour_fix). Collapsed to one scalar 2026-07-12.
//
// PRIOR is only a warm-start; the pooled EMA (~30–50 daytime samples/day) refines
// it to the true installation value within a day. ~2.5 ≈ this install's empirical
// panel-plane yield.
const SAT_YF_PRIOR = 2.5;

module.exports = { SAT_YF_PRIOR };
