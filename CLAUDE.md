# CLAUDE.md

## Debugging Workflow

- Form a hypothesis from concrete diagnostics (logs, values, errors) before reading large code.
- Grep/targeted Reads, never whole files upfront (5h Pro token budget).
- Check in every few minutes on long investigations; never go silent 15+ min.
- One-line finding after each debug read before the next.
- Max 5 min / 3 file reads without a user update; deeper → ask first.
- /tmp/homey.log is UTC; user is Europe/Amsterdam (UTC+1 winter, +2 CEST). Always communicate times in Amsterdam local.

## Fixing Bugs / Debugging Principles

- Fix the real root cause; no display-only annotations or 'lapmiddel' band-aids when asked to fix behaviour.
- Reproduce deterministically (minimal test / brute-force) before proposing a fix; tell the user: real bug or expected.
- After the fix: enable the debug gate, ask the user to restart (they handle restarts), wait ~90s init, show the live log lines confirming the new behaviour.
- Append the conclusion (bug/non-bug, root cause, decision) to memory so it isn't re-litigated.
- Before instrumenting or claiming what's in a published build: check documented gotchas, inspect .homeybuild (read-only), confirm with evidence.
- DP/charge-slot anomalies: trace the full backward-induction chain and report the root cause before any fix. Most past charge-slot "bugs" were phantoms (foregone-export cost, PV-insurance ordering) — verify against the DP's actual decision, not the symptom.
- Reorder-block fixes (optimization-engine.js lines 341–418): after any change, explicitly trace the rollback guard (lines 407–414). If any preserve slot inside the window has pvCoverage > 0 (trickle), simulate through it — trickle inflates socGw above dpEndTargetG, which triggers a false-positive rollback and silently reverts the fix. Two sessions burned 2026-06-26 because the wEnd=N budget fix was correct but the rollback fired anyway.

## Data Source Discipline

- State which kind every PV/battery value is: live tile, forecast, measured-historical, or DP-predicted.
- Distinguish past vs future slots; confirm which slot index before fixing.
- No forward-sim overrides or display logic that diverges from actual DP decisions.

## Firmware & Hardware

- P1 firmware enforces zero-on-meter; don't propose lifting discharge caps to full inverter capacity.
- Don't blame BMS hardware before investigating the code.
- No unsolicited Homey-app restarts during debugging.

## Documentation & Change log

- Update README.md in English (user's main changelog).
- Identify the correct changelog file before editing — multiple exist.
- Don't touch .homeybuild.

## Coding Rules

- Plan mode for non-trivial changes (multi-file, DP/policy/learning behaviour, new feature, refactor); skip for one-liners, diagnostics, read-only.
- Reduce ambiguity first: resolve scope/target file+symbol/expected behaviour/edge cases by reading code or asking — never edit on a guess.
- Surface assumptions, edge cases, and trade-offs explicitly; flag the risky/uncertain ones before code is written.
- Give clear success criteria up front (passing test, specific live log line, metric/threshold) — no vague "should work".
- Once approved, iterate to the success criteria (run → fail → fix → rerun); don't hand back half-done. Keep the check-in cadence; never expand approved scope.
- Minimum code: no speculative features, over-engineering, bloated/premature abstractions, or error handling for impossible cases. If 200 lines could be 50, rewrite.
- No laziness: within scope, finish properly — no stubs, TODOs, faked output, swallowed errors. (Scope stays minimal; quality within it does not.)
- Act, don't just measure: a stable signal → ship a bounded reversible change behind property-tests, not another observe phase.
- Risky behaviour changes ship behind a default toggle, shadow-run (logged, not acting) before switch-on.
- Touch only what's needed; don't improve adjacent code/formatting. Match existing style. Mention dead code; don't delete it.
- New feature → failing test first, then pass. Bug → reproduce in test first. Refactor → tests pass before & after.
- Policy/DP behaviour change → walk `explainability-engine.js` (user-facing reason matches the new behaviour) and keep planning (`_mapActionToHwModeForPlanning`) + optimization (`optimization-engine.js` DP) on the same line — no divergence between what the DP decides, the chart projects, and the explanation says.
- One implementation per correction/formula, feeding ALL surfaces (chart, diag, DP) — backend-vs-backend too, not just browser. Two copies drift silently (2026-06-22: webcam-OM vs accuracy-OM diverged; fixed via shared `_correctOverlayW`). Grep for an existing formula before adding one. The settings diagnose page shows backend-computed values (e.g. `policy_last_run_debug.dynamicMaxChargePrice`); never re-implement a pricing/break-even formula as a browser-side JS mirror. Known display-only mirror: per-night baseload chart minima (`_computeSmartBaseload`, settings/index.html ~1124).
- New DP constraint (floor/cap/gate/reserve) → exercised by the random arb in `test/optimizer-properties.test.js` AND ≥1 economic-dominance invariant (e.g. "never suppresses discharge at the strict price-max slot ahead"). A hand-written scenario alone confirms the author's mental model instead of challenging it (the price-blind refill-reserve bug passed all hand tests). The sync rule above guards consistency between layers; the property suite guards optimality.
- Before tuning any learning-engine EMA/weight/prior: grep-verify the update fn is called from a write-path (not just consumed by a getter), and confirm with a live log line in the expected cadence before committing. (`recordModelAccuracy` sat dead 3.7 weeks — 3 commits tuned it blind.)

---

## 5. Context Management

- Context >50% → suggest a new conversation or subagents for independent tasks. One task per conversation; finish, then start fresh.
- Recommend context-saving: file reads not pasting, /compact when heavy, subagents for research, reference files over inline.
- cavecrew-investigator for all file/symbol location (not inline Explore). Offload research/exploration/read-heavy analysis to subagents (cavecrew-investigator/Explore, haiku) — keep the main thread for decisions + edits.
- One focused task per subagent; don't bundle unrelated work. Merge results with judgement: verify claims against code, reconcile, discard wrong findings — never act on subagent output verbatim.
- Model: haiku for scans/summarization, opus for architectural decisions. Tracing call chains across 3+ files or architecture → say so, suggest `/model opus`.
- Never read a file >100 lines without grepping the target symbol first. During debugging: max 1 Read per response until a hypothesis forms.

## 6. Reference documentation

Check `/docs` before reading source for these topics:

- `battery-policy.md` — device init, policy run cadence, PV OVERSCHOT, DP discharge constraints, `_mapPolicyToHwMode`, settings keys
- `learning-engine.md` — consumption tracking, solar yield factors, radiation bias, DST handling
- `weather-forecasting.md` — Open-Meteo ensemble (MF/GFS/ICON/KNMI), Solcast, KNMI station ground-truth, per-model accuracy, bias factors
- `planning-chart.md` — quickchart.io camera images, ChartRenderer module, widget SVG
- `price-providers.md` — tariff providers, dynamic price fetching
- `baseload-monitor.md` — house baseload tracking
- `explainability-engine.md` — decision rationale strings

## Homey Pro Gotchas

- NEVER use process.memoryUsage() in diagnostic instrumentation — it hard-crashes the app on Homey Pro. Use heap-gated/safe logging instead.

## Logging & Diagnostics

- Diagnostic this.log lines are debug-gated (need debug + restart); account for ~90s driver-init defer before snapshotting devices.
- State explicitly what is committed vs running in the live build vs working-tree-only before discussing "live behaviour" or claiming a fix is active.

## Release / Versioning

- Classify version bumps correctly (patch vs minor); ALWAYS update the README changelog on publish. The user handles git pushes.

## Testing

- Correct runner (no standalone node scripts under jest); don't pkill your own background test runs — track and clean them deliberately.
- System `jest` (`/usr/bin/jest`, Debian pkg) is broken on this box (`process.config.variables.node_relative_path` undefined → `jest-config/Defaults.js:72` crash). Never run `jest`/`npx jest`. Run the suite with `npm run test-unit` (plain node scripts).

## Workflow / Playbooks

- Use the model specified in the playbook (Sonnet unless stated); don't silently upgrade to a more expensive model.
