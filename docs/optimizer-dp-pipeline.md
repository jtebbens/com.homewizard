# OptimizationEngine DP pipeline — one mental model

Consolidates the scattered warnings about the DP passes (previously spread across
CLAUDE.md and several memory files) into one reference. Read this before touching
`lib/optimization-engine.js` — especially the post-DP passes (lines ~373–523), where
five stages mutate the same `slots[]` array in sequence and interact in non-obvious ways.

`compute()` is the entry point; `_runBackwardDP()` does the pre-compute + backward induction.
The full run is **8 stages**, executed strictly in this order:

## Stage order

| # | Stage | Location | What it produces / mutates |
|---|-------|----------|----------------------------|
| 1 | **Pre-compute deltas + reserve floor** | `_runBackwardDP` 636–724 | `chargeSocDeltaG`, `perSlotDischargeSocDeltaG[]`, `pvStrongCoverage`, `reserveFloorG[]`, `lastStrongPv` |
| 2 | **Terminal value + topup precompute** | 726–796 | `dp[]` seeded with residual value (`terminalFactor`), `pvKwhFromT[]`, `topupFiringSlots[]` |
| 3 | **Backward induction** | 804–974 | `policy[t][socG]` (best action per state); per-SoC flatten at 827–837 |
| 4 | **eveningNeedKwh** | 976–990 | forward-pass safety-net input |
| 5 | **Forward pass** | `compute` 224–370 | builds `slots[]` (action + socProjected) by tracing `policy[]`; applies runtime-mirror overrides (`pvStoreWins`, `pvTrickle`) |
| 6 | **Post-DP: reorder night discharge by price** | 373–476 | reassigns discharge to priciest slots in the overnight window; **has a rollback guard** |
| 7 | **Post-DP: preserve-island elimination** | 478–510 | flips isolated `preserve` between two `discharge` slots (tiny price delta) to `discharge` |
| 8 | **Post-DP: feasibility sweep** | 512–523 | relabels any `discharge` whose start SoC ≤ floor back to `preserve` (no-op mislabel) |

Stages 1–4 build the DP tables. Stage 5 reconstructs the plan. **Stages 6–8 are the fragile part:
each rewrites `slots[t].action` in place, reading the same shared arrays, with no trail of which
pass changed what** (this is why tracing a plan flip needed a full repro script on 2026-07-04 —
see `feedback_dp_instability_debug_workflow`).

## Shared mutable state (the dependency map)

The reason stages 6–8 interact: they all read `reserveFloorG[]` and `slots[].socProjected`, and
all mutate `slots[].action`. A change to one pass silently shifts the inputs of the next.

| State | Written by | Read by |
|-------|-----------|---------|
| `reserveFloorG[]` | stage 1 (from `refillConfidence`) | backward DP discharge gate (906), forward pass clamp (360), reorder `effFloorG` (409), island `starvesLater` (501), island SoC clamp (507), feasibility sweep (520) |
| `slots[].action` | forward pass (5) | mutated again by reorder (6), island (7), feasibility (8) |
| `slots[].socProjected` | forward pass (5) | read by reorder (`windowStartSocG`, `rawEndG`), rewritten by reorder + island |
| `pvCoverage[]` | (input) | window boundary detection (6), trickle re-sim charge (461), everywhere |
| `perSlotDischargeSocDeltaG[]` | stage 1 | forward pass, reorder budget, island drain |

## The reserve floor (stage 1) — the quiet driver

`reserveFloorG[]` (690–724) is the single most load-bearing cross-pass input. Per-slot minimum SoC:
- Driven by `refillConfidence` (0–1): low confidence → `reserveAddG` up to 50% of usable span.
- Applied **only** to overnight non-PV slots that (a) precede a strong-PV refill (`strongPvAhead`)
  and (b) whose own price ≤ `releasedPeak` (best price after `lastStrongPv`). Slots pricier than
  the released peak are never floored — discharge-now beats hoarding-for-a-cheaper-peak.
- At `refillConfidence = 1` the floor collapses to `minSocG` → passes 6–8 behave as if it isn't there.

Because every downstream pass reads this array, a change in `refillConfidence` (which itself comes
from `refillConfidenceFromForecast`, gated by ensemble `spreadRel`) reshapes the whole night plan.
This is expected behaviour, not a bug — but it means "why did discharge tonight change?" almost
always traces back here first. It is now surfaced live in `policy_last_run_debug`
(`refillConfidence`, `reserveFloorPct`, `dischargeNext12h`).

## Known dangerous interactions

1. **Reorder rollback guard ↔ trickle PV (the 2026-06-26 burn).** The reorder (stage 6) re-simulates
   the window and reverts the whole window if the re-simulated end SoC undershoots
   `dpEndTargetG`. The re-sim must use the *same SoC physics as the forward pass*: free PV charge
   only on `trickle` slots (and `pvStoreWins` preserve — strong coverage, so never inside the
   window), plus the forced low-SoC top-up step on firing preserve slots. If the re-sim credits
   *less* than the forward pass (the 06-26 burn: no trickle gain at all), the rollback false-fires
   and silently reverts correct reorders; if it credits *more* (pre-2026-07-16: any
   `pvCoverage > 0` slot gained, including standby/pvExportWins slots that really export), the
   guard false-PASSES plans that end under `dpEndTargetG` and the trajectory shows a SoC rise the
   runtime never delivers. **After ANY change to the reorder block, hand-trace the rollback guard
   with a trickle slot inside the window.** Two sessions were lost to this; see CLAUDE.md
   "Reorder-block fixes" note. Guarded by property invariant 33 (standby never gains SoC).

2. **Reserve floor ↔ priciest-first hold.** The reorder deliberately holds the *cheapest* eligible
   slot when the window is floor-constrained. The island-elimination pass (stage 7) would re-discharge
   that held cheap slot (tiny price delta between neighbours), over-committing the window — so it has
   a `starvesLater` guard (498–503) that skips the override if the extra drain pushes any later
   discharge below its floor. Removing that guard reintroduces the strand.

3. **Feasibility sweep is a safety net, not logic.** Stage 8 only relabels `discharge`→`preserve`
   where SoC already sits at the floor (a no-op mislabel produced by 6 or 7). It should never be the
   thing that "fixes" a plan — if it's changing meaningful actions, a bug upstream is producing
   infeasible discharge assignments.

4. **Per-SoC flatten (stage 3, 827–837) ↔ terminal value (stage 2).** Flatten neutralises backward
   price pressure when PV can refill from a given SoC; it's guarded (positive price, `pvKwhTomorrow ≥
   0.6×cap`, non-PV slot, next slot not PV-strong). Do NOT revert to the old `dp.fill(dpMax)` +
   `_betterSlotAhead` gate — caused overnight standby. Documented in `battery-policy.md`.

5. **`_runBackwardDP` runs TWICE per `compute()` — any instance state it writes needs a call-site
   guard.** Call site 1 (`253`) is the live pass and passes the full argument list including
   `currentSoc`; call site 2 (`718`) is the expansion-scenario profit probe and stops at
   `pvKwhTomorrow`, so `currentSoc` and the eight params after it arrive `undefined`. The probe runs
   *after* the live pass, so anything the method assigns to `this.*` unconditionally gets clobbered
   by the SoC-less run before a consumer reads it. This already bit once (2026-07-25, `dd431b8`): an
   unconditional `this._flattenDebug = null` reset wiped the live snapshot and policy-engine logged a
   line full of `undefined`. Both the reset and the aggregate write now sit behind
   `initialSocG != null` (`1005–1010`). **Adding any new `this.*` diagnostic or state to
   `_runBackwardDP`: gate it on the live pass, and check both call sites.**

## Invariants that guard the pipeline

`test/optimizer-properties.test.js` (run via `npm run test-unit`):
- **20/21** — spread-band is monotone / never suppresses peak-slot discharge (band retired
  2026-07-04, no live caller; tests kept to guard the dead-but-present helper).
- **22/25** — discharge-topup cycle never net-negative (25 = same guard holds at a raised ceiling).
- **24** — upwind-cloud triggers early grid charge.
- Per CLAUDE.md: any new DP constraint (floor/cap/gate/reserve) needs a random-arb property test
  **and** ≥1 economic-dominance invariant — a hand-written scenario alone confirms the author's
  mental model instead of challenging it.

## Consolidation verdict (chunk 4, 2026-07-04)

This doc is the "overview first" half of `project_stability_focus_chunkplan` chunk 4. Whether to
*consolidate* stages 6–8 into fewer passes is a separate, higher-risk decision — deferred. The
passes are individually justified (each fixed a real €-miss); the risk is their interaction, which
this doc now makes explicit. Prefer adding a per-slot decision trail (deferred, see
`feedback_dp_instability_debug_workflow`) over merging passes, if this becomes a recurring problem.
