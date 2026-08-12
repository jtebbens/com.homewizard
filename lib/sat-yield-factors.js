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

// Below this solar elevation the satellite GHI retrieval is known-noisy (grazing angles:
// a near-zero reading cannot be told apart from a retrieval artifact). satGhiToPanelW
// refuses to convert such slots; recordSatYield must refuse to LEARN from them for the
// same reason, or the display path and the training path disagree about what is usable.
const SAT_MIN_ELEV_DEG = 15;

// Lower clamp on the ensemble's GTI/GHI transposition ratio. When the true geometric
// ratio falls below this (late afternoon on an east-of-south array), gtiOverGhi is pinned
// here and the panel-plane GHI it produces is larger than reality — so any yield factor
// derived from it (yf = actualW / panelPlaneGHI) is understated by construction and must
// not train the EMA.
const GTI_GHI_CLAMP_MIN = 0.3;

module.exports = { SAT_YF_PRIOR, SAT_MIN_ELEV_DEG, GTI_GHI_CLAMP_MIN };
