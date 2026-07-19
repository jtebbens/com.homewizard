'use strict';
/**
 * Counterfactual replay harness — PHASE 0: calibration only.
 *
 * Answers one falsifiable question: fed the REALIZED per-slot inputs (PV, consumption,
 * price) and the hardware mode that actually ran, can a simulator reproduce the MEASURED
 * battery behaviour? If it cannot reproduce the past, it cannot score a counterfactual
 * future either, and the whole replay idea stops here.
 *
 * Three earlier attempts to prove a DP change died on the metric, not the idea:
 *   2026-07-04  forecast-MAE          — blind to a discharge-cap-only change
 *   2026-07-16  spreadband_shadow     — 201:0 tautology (ON relaxes a constraint, Δ>=0 by
 *                                       construction; compared two self-reported optima)
 * See project_dp_pv_timing_robustness.md. The close-out demands exactly this harness before
 * the chapter may reopen.
 *
 * ⚠️ DELIBERATE FORMULA DUPLICATION — phase 0 only.
 * The physics below is copied from lib/optimization-engine.js rather than shared with it.
 * This violates the "one implementation per formula" rule in CLAUDE.md on purpose: extracting
 * them touches the backward-induction core that CLAUDE.md itself calls fragile, and that risk
 * is only worth taking once the replay is proven possible at all. If phase 0 passes, the FIRST
 * step of phase 1 is to extract these into shared static methods on OptimizationEngine and
 * delete the copies here.
 *
 * Sources (verified 2026-07-19):
 *   charge SoC delta      optimization-engine.js:783-785
 *   discharge cap         optimization-engine.js:808-817   netW = max(0, cons - pv)
 *   discharge SoC delta   optimization-engine.js:819-821
 *   RTE (discharge only)  optimization-engine.js:1090-1097 (charge gets none, see :782-784)
 *   € scoring             device.js:5328-5338 (_computeDailyProfit)
 *
 * Usage:
 *   node tools/replay-calibration.js <history.json> [--rte 0.72] [--consumption avg|instant]
 *
 * The --rte flag exists for the negative control: run with --rte 1.0 and the verdict MUST
 * degrade. If a deliberately wrong constant still passes, the harness measures nothing —
 * the same failure class as the 2026-07-16 tautology.
 */

const fs = require('fs');

// ── Battery configuration (device eca0f7a8, read from live settings 2026-07-19) ──────────
const CAPACITY_KWH  = 2.69;   // policy_last_run_debug.battCapKwh
const MAX_CHARGE_W  = 800;    // device.js:2566 default
const MAX_DISCHARGE_W = 800;  // device.js:2567 default
const MIN_SOC = 0;            // device setting min_soc
const MAX_SOC = 100;          // device setting max_soc
const SLOT_H  = 0.25;         // 15-min buckets

const args = process.argv.slice(2);
const historyPath = args[0];
if (!historyPath) {
  console.error('usage: node tools/replay-calibration.js <history.json> [--rte N] [--consumption avg|instant]');
  process.exit(1);
}
const rteArg = args.indexOf('--rte');
const RTE = rteArg >= 0 ? Number(args[rteArg + 1]) : 0.72;
const consArg = args.indexOf('--consumption');
const CONS_MODE = consArg >= 0 ? args[consArg + 1] : 'avg';
// Optional higher-fidelity SoC source. policy_mode_history stores SoC as whole percent
// sampled once per policy run, and that reading does not refresh every slot — consecutive
// discharge slots alternate large/small steps whose MEAN matches the simulator while the
// individual values do not. Homey Insights carries the same capability at 5-min resolution
// WITH decimals (it averages within the bucket), which removes the artefact. Only the last
// 24h are available at that resolution (7d drops to hourly), so this validates the model on
// one day rather than replacing the history source.
const insArg = args.indexOf('--insights-soc');
const INSIGHTS_SOC = insArg >= 0 ? args[insArg + 1] : null;

/**
 * Per-slot battery power the hardware mode implies, given realized PV and load.
 * Sign convention matches the measured `battW` field and _computeDailyProfit:
 * positive = charging, negative = discharging.
 *
 * socPct limits the result: a full battery cannot charge, an empty one cannot discharge.
 * RTE is applied to the SoC cost of discharging (physical drain exceeds delivered energy),
 * never to the € scoring — the measured battW is already AC-side, so the losses are inside it.
 */
function simulateSlot(hwMode, pvW, consW, socPct) {
  const surplusW = Math.max(0, pvW - consW);
  const deficitW = Math.max(0, consW - pvW);
  const capWh = CAPACITY_KWH * 1000;

  // physW is measured at the CELLS; deliveredW is what reaches the house.
  // The power limit binds on the cell side: to deliver D the pack must draw D/RTE, so a
  // demand above MAX_DISCHARGE_W * RTE cannot be fully covered and the grid supplies the
  // rest. Calibration 2026-07-19 confirms this — across 36 discharge slots the largest
  // delivered power ever observed is 542 W ≈ 800 W * 0.72, never the nominal 800 W.
  let physW = 0;
  switch (hwMode) {
    case 'zero_charge_only':                        // PV surplus only, never from grid
      physW = Math.min(MAX_CHARGE_W, surplusW);
      break;
    case 'to_full':                                 // grid charging allowed
      physW = MAX_CHARGE_W;
      break;
    case 'zero_discharge_only':                     // cover net load, never export
      physW = -Math.min(MAX_DISCHARGE_W, deficitW / RTE);
      break;
    case 'standby':
    default:
      physW = 0;
  }

  // Clamp against remaining headroom / stored energy (both cell-side).
  if (physW > 0) {
    physW = Math.min(physW, ((MAX_SOC - socPct) / 100 * capWh) / SLOT_H);
  } else if (physW < 0) {
    physW = -Math.min(-physW, ((socPct - MIN_SOC) / 100 * capWh) / SLOT_H);
  }

  const deliveredW = physW >= 0 ? physW : physW * RTE;
  const nextSoc = Math.max(MIN_SOC, Math.min(MAX_SOC, socPct + ((physW * SLOT_H) / capWh) * 100));

  return { battW: Math.round(deliveredW), nextSoc };
}

/**
 * € accounting from a SoC delta rather than from measured battW.
 *
 * device.js:5328-5338 (_computeDailyProfit) scores `battW * 0.25h`, but battW is a single
 * instantaneous reading taken at the START of the policy run, before that run's mode takes
 * effect — it lags the mode by one slot and is blind to the firmware's continuous zero-on-meter
 * regulation in between. Measured per-slot check (2026-07-19, n=297): using battW to predict
 * the SoC step gives MAE 0.53% of capacity, and the outliers are exactly one-slot-shifted.
 *
 * SoC does not have that problem: soc[t] and soc[t+1] bracket the interval in which hwMode[t]
 * is in force, so the delta lands in the right time window by construction.
 *
 * Charge: energy into the pack is billed at the slot price.
 * Discharge: the pack loses |ΔSoC| physically, of which RTE reaches the house (RTE lives on
 * the discharge side — optimization-engine.js:782-784, :1090-1097).
 */
function scoreSocDelta(deltaSocPct, price) {
  const wh = (deltaSocPct / 100) * CAPACITY_KWH * 1000;
  if (wh > 1)  return { revenue: 0, cost: (wh / 1000) * price };
  if (wh < -1) return { revenue: (Math.abs(wh) * RTE / 1000) * price, cost: 0 };
  return { revenue: 0, cost: 0 };
}

/**
 * Physical energy moved in a slot, in Wh at the cells. This is the calibration target rather
 * than €, because it is RTE-FREE: a SoC delta is a measurement, whereas converting it to money
 * requires the very efficiency constant the model is being tested on.
 *
 * The first version of this harness scored € on both sides, so running the negative control
 * (--rte 1.0) moved the measured reference along with the simulation — the yardstick flexed
 * with the thing being measured, and the control could not fail. Same failure class as the
 * 2026-07-16 tautology, reproduced here by accident and caught by the control itself.
 */
function physicalWh(deltaSocPct) {
  return (deltaSocPct / 100) * CAPACITY_KWH * 1000;
}

// ── Load + normalize ──────────────────────────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const entries = Array.isArray(raw) ? raw : raw.value;

const BUCKET_MS = 15 * 60 * 1000;
const skipped = { exception: 0, missingField: 0, noConsumption: 0, gap: 0, noSoc: 0 };
const slots = [];

for (const e of entries) {
  if (e.exception != null) { skipped.exception++; continue; }
  if (e.price == null || e.battW == null || e.soc == null || e.pvW == null) {
    skipped.missingField++; continue;
  }
  // Timestamps are not on an exact grid (899934ms gaps observed) — round, never match exactly.
  const bucket = Math.round(new Date(e.ts).getTime() / BUCKET_MS) * BUCKET_MS;
  if (e.consumW == null) { skipped.noConsumption++; continue; }

  slots.push({
    bucket,
    day: new Date(bucket).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }),
    hwMode: e.hwMode,
    price: e.price,
    pvW: e.pvW,
    consW: e.consumW,
    consumAvgW: e.consumAvgW ?? null,
    socMeasured: e.soc,
    battMeasured: e.battW,
  });
}
slots.sort((a, b) => a.bucket - b.bucket);

// Pair each slot with its successor: hwMode[t] governs the interval [t, t+1], and
// soc[t]→soc[t+1] is exactly the energy that moved during it. Slots whose successor is
// missing (gap in the ring buffer) are dropped rather than paired across the gap.
//
// Consumption for that interval: consumAvgW is the mean over the slot ENDING at its own
// timestamp (device.js:2141-2145), so the mean covering [t, t+1] is the NEXT entry's value.
// Falls back to this slot's instantaneous reading when the averaged field is absent.
// Higher-fidelity SoC lookup, when an Insights export is supplied. Values are 5-min bucket
// means; pick the sample nearest each slot boundary and refuse anything more than half a
// bucket away rather than interpolating across a gap.
let socAt = null;
if (INSIGHTS_SOC) {
  const ins = JSON.parse(fs.readFileSync(INSIGHTS_SOC, 'utf8'));
  const pts = (ins.values || [])
    .filter(v => v.v != null)
    .map(v => ({ t: new Date(v.t).getTime(), v: v.v }))
    .sort((a, b) => a.t - b.t);
  socAt = (ms) => {
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const dd = Math.abs(p.t - ms);
      if (dd < bestD) { bestD = dd; best = p; }
    }
    return bestD <= 150000 ? best.v : null;   // within half a 5-min bucket
  };
}

const paired = [];
for (let i = 0; i < slots.length - 1; i++) {
  const cur = slots[i];
  const nxt = slots[i + 1];
  if (nxt.bucket - cur.bucket !== BUCKET_MS) { skipped.gap++; continue; }

  let socStart = cur.socMeasured;
  let socEnd = nxt.socMeasured;
  if (socAt) {
    const a = socAt(cur.bucket);
    const b = socAt(nxt.bucket);
    if (a == null || b == null) { skipped.noSoc++; continue; }
    socStart = a; socEnd = b;
  }

  paired.push({
    ...cur,
    socStart,
    socEnd,
    dSocMeasured: socEnd - socStart,
    consW: CONS_MODE === 'avg' ? (nxt.consumAvgW ?? cur.consW) : cur.consW,
  });
}

// ── Replay ────────────────────────────────────────────────────────────────────────────────
// Two modes, both informative:
//   free-running — SoC evolves from the simulator's own output (errors accumulate; strict)
//   re-anchored  — SoC reset to the measured value each slot (tests per-slot response only)
const byDay = new Map();
for (const s of paired) {
  if (!byDay.has(s.day)) byDay.set(s.day, []);
  byDay.get(s.day).push(s);
}

const dayRows = [];
let signMatch = 0, signTotal = 0;
const slotErrors = [];

for (const [day, daySlots] of [...byDay.entries()].sort()) {
  let socFree = daySlots[0].socStart;
  let measRev = 0, measCost = 0, freeRev = 0, freeCost = 0, anchRev = 0, anchCost = 0;

  for (const s of daySlots) {
    // free-running: SoC carried from the simulator's own output (errors accumulate; strict)
    // re-anchored: SoC reset to the measured value each slot (per-slot response only)
    const free = simulateSlot(s.hwMode, s.pvW, s.consW, socFree);
    const anch = simulateSlot(s.hwMode, s.pvW, s.consW, s.socStart);
    const dSocFree = free.nextSoc - socFree;
    const dSocAnch = anch.nextSoc - s.socStart;
    socFree = free.nextSoc;

    const m = scoreSocDelta(s.dSocMeasured, s.price);
    const f = scoreSocDelta(dSocFree, s.price);
    const a = scoreSocDelta(dSocAnch, s.price);
    measRev += m.revenue; measCost += m.cost;
    freeRev += f.revenue; freeCost += f.cost;
    anchRev += a.revenue; anchCost += a.cost;

    // Direction over a slot, with a dead-band of half the 1% SoC quantisation step.
    const dir = d => (d < -0.5 ? -1 : d > 0.5 ? 1 : 0);
    signTotal++;
    if (dir(dSocAnch) === dir(s.dSocMeasured)) signMatch++;
    slotErrors.push({ ...s, simDSoc: dSocAnch, absErr: Math.abs(dSocAnch - s.dSocMeasured) });
  }

  const measured = measRev - measCost;
  const freeP = freeRev - freeCost;
  const anchP = anchRev - anchCost;
  const pct = (v) => (Math.abs(measured) > 1e-9 ? ((v - measured) / Math.abs(measured)) * 100 : NaN);
  dayRows.push({ day, n: daySlots.length, measured, freeP, anchP, freePct: pct(freeP), anchPct: pct(anchP) });
}

// ── Report ────────────────────────────────────────────────────────────────────────────────
console.log(`\nReplay calibration — RTE=${RTE}, consumption=${CONS_MODE}`);
console.log(`slots used: ${paired.length}  skipped: exception=${skipped.exception} missingField=${skipped.missingField} noConsumption=${skipped.noConsumption} gap=${skipped.gap}\n`);

console.log('day          n   measured €   free-run €   Δ%      re-anchored €   Δ%');
for (const r of dayRows) {
  const f = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(6) : '   n/a');
  console.log(
    `${r.day}  ${String(r.n).padStart(3)}   ${r.measured.toFixed(3).padStart(9)}   ` +
    `${r.freeP.toFixed(3).padStart(9)}   ${f(r.freePct)}   ` +
    `${r.anchP.toFixed(3).padStart(11)}   ${f(r.anchPct)}`
  );
}

const signPct = (signMatch / signTotal) * 100;
console.log(`\nper-slot direction match (re-anchored): ${signMatch}/${signTotal} = ${signPct.toFixed(1)}%`);

// RTE-free fidelity: how well does the simulated SoC step reproduce the measured one?
// This is the honest calibration target — see physicalWh() on why € cannot be.
const whErrors = slotErrors.map(s => Math.abs(physicalWh(s.simDSoc) - physicalWh(s.dSocMeasured)));
const whMeasured = slotErrors.map(s => Math.abs(physicalWh(s.dSocMeasured)));
const mae = whErrors.reduce((a, b) => a + b, 0) / whErrors.length;
const meanMoved = whMeasured.reduce((a, b) => a + b, 0) / whMeasured.length;
console.log(`per-slot energy MAE: ${mae.toFixed(1)} Wh  (mean |energy moved| ${meanMoved.toFixed(1)} Wh → relative ${(mae / meanMoved * 100).toFixed(1)}%)`);

// Verdict against the criterion fixed BEFORE running (see plan gentle-prancing-pnueli.md):
// day-€ within 10% on >=3 full days, AND >90% per-slot direction match.
const fullDays = dayRows.filter(r => r.n >= 90);
const within10 = fullDays.filter(r => Math.abs(r.anchPct) < 10);
console.log(`full days (n>=90): ${fullDays.length}, of which within 10%: ${within10.length}`);

const pass = within10.length >= 3 && signPct > 90;
console.log(`\nVERDICT: ${pass ? 'PASS' : 'FAIL'}`);

if (!pass) {
  // Report the worst individual slots, not an aggregate — an aggregate hides the hotspots
  // that identify WHICH assumption is wrong (feedback_aggregate_stats_hide_hotspots).
  console.log('\nworst 15 slots by |ΔSoC sim − ΔSoC measured| (re-anchored):');
  slotErrors.sort((a, b) => b.absErr - a.absErr);
  console.log('ts                 hwMode                  pv   cons   soc  dSoC_meas  dSoC_sim    err');
  for (const s of slotErrors.slice(0, 15)) {
    const f = (x, w) => x.toFixed(1).padStart(w);
    console.log(
      `${new Date(s.bucket).toISOString().slice(0, 16)}  ${(s.hwMode || '?').padEnd(20)} ` +
      `${String(s.pvW).padStart(5)} ${String(Math.round(s.consW)).padStart(6)} ${String(s.socStart).padStart(5)} ` +
      `${f(s.dSocMeasured, 10)} ${f(s.simDSoc, 9)} ${f(s.absErr, 6)}`
    );
  }
}
console.log();
