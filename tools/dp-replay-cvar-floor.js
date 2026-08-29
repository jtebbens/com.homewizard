/**
 * Replay the CVaR refill-reserve floor (`dp_cvar_reserve`) off vs on, straight off the
 * [DP-INPUT-DUMP] payloads. Everything else is held identical, so the only thing that moves
 * between the two runs is the height of the reserve floor.
 *
 * Usage: node tools/dp-replay-cvar-floor.js <dumpdir> [--k 1.40] [--cycle x] [--eff x]
 *                                           [--tariff asymmetric_2027|saldering] [--export-ratio x]
 *                                           [--realized hist.json] [--only files.txt]
 *
 * Scoring differs from tools/dp-replay-floorfix.js on two points, both load bearing here:
 *
 * 1. Energy comes off the SoC PATH, not off action labels. A floor that only relabels a slot
 *    moves no energy and must score zero (memory/feedback_score_energy_from_soc_path_not_labels).
 *    The reason floorfix avoided the SoC path — socProjected rises on PV without a grid purchase —
 *    is handled by splitting each SoC gain into its PV and grid halves with the slot's own
 *    pvCoverage, the same split the engine books in todayProjectedProfit (engine :785).
 *
 * 2. Exported PV is priced. The whole point of a reserve floor is to keep the cell fuller, which
 *    leaves less room for PV; the surplus that no longer fits leaves via the meter. Score only
 *    the battery and that give-away is invisible, so the floor looks free. Per slot the storable
 *    surplus is pvCoverage * chargeKwhFull; whatever of it does not end up in the cell is booked
 *    at exportValue() — the shared implementation in lib/price-formulas, not a second copy.
 *
 * Residual SoC is priced at RTE x mean horizon price - half a cycle, as in floorfix: a euro
 * bought with leftover charge is not a euro (memory/feedback_replay_must_price_residual_soc).
 *
 * CVAR_K is a module constant, so --k sweeps it by wrapping the static the engine calls rather
 * than by editing the engine. Sign flipping with k is the no-go signal: it would mean the value
 * sits in the tuning, not in the mechanism.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');
const { createSim } = require('./replay-sim');
const { exportValue } = require('../lib/price-formulas');

const argv = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const str = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};

const DIR = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const CYCLE = num('--cycle', 0.075);   // device setting cycle_cost_per_kwh
const EFF = num('--eff', 0.72);        // device setting battery_efficiency
const TARIFF = str('--tariff', 'asymmetric_2027'); // live since 2026-08-23
const EXPORT_RATIO = num('--export-ratio', 1.0);
const K = num('--k', null);            // null = the engine's own CVAR_K
const REALIZED = str('--realized', null); // history.json → execute the plans against measured PV/load
const ONLY = str('--only', null);      // file with one dump filename per line — score that subset only

if (!DIR || !fs.existsSync(DIR)) {
  console.error('give a directory holding dp-input-*.json dumps');
  process.exit(1);
}

if (K != null) {
  const orig = OptimizationEngine.cvarReserveAddG.bind(OptimizationEngine);
  OptimizationEngine.cvarReserveAddG = (args) => orig({ ...args, k: K });
}

// The other DP flags are pinned to what the live build runs, so the A/B isolates the floor.
const FLAGS = {
  dp_flatten_pv_shift: true, dp_flatten_arb_gate: false, dp_charge_export_gate: true,
  dp_trickle_cap_saturation: false, dp_weak_pv_tie_standby: false, dp_charge_repay_gate: false,
  dp_gate_b_count: true,
};

function run(dump, cvar) {
  const eng = new OptimizationEngine({
    battery_efficiency: EFF, cycle_cost_per_kwh: CYCLE,
    tariff_model: TARIFF, export_price_ratio: EXPORT_RATIO,
    min_soc: 0, max_soc: 100, ...FLAGS, dp_cvar_reserve: cvar,
  });
  eng.compute(
    dump.prices, dump.soc, dump.capacityKwh, dump.maxChargePowerW, dump.maxDischargePowerW,
    dump.pvForecast, dump.learnedRte, dump.consumptionWPerSlot, dump.minDischargePrice,
    dump.consumptionMargin, dump.effectivePvKwhTomorrow, dump.adjustedTerminalPvKwh,
    dump.pvCloudFactor, dump.refillConfidence, false, dump.maxChargePrice,
  );
  return eng;
}

/**
 * Score one plan off its SoC path. socProjected[t] is the SoC ENTERING slot t (the forward pass
 * pushes the slot before it advances socG, engine :761 vs :788-795), so slot t's own movement is
 * the step to t+1 and the last slot's outcome is the residual instead.
 */
function score(slots, dump, rte, slotH) {
  const cap = dump.capacityKwh;
  const chargeKwhFull = (dump.maxChargePowerW / 1000) * slotH;
  let eur = 0, chKwh = 0, disKwh = 0, expKwh = 0;
  for (let t = 0; t + 1 < slots.length; t++) {
    const s = slots[t];
    const dKwh = ((slots[t + 1].socProjected - s.socProjected) / 100) * cap;
    const pvAvail = (s.pvCoverage ?? 0) * chargeKwhFull;
    if (dKwh > 0) {
      const pvUsed = Math.min(dKwh, pvAvail);
      eur -= (dKwh - pvUsed) * s.price + 0.5 * CYCLE * dKwh; // grid half only, wear on all of it
      chKwh += dKwh;
      expKwh += Math.max(0, pvAvail - pvUsed);
    } else {
      eur += -dKwh * rte * s.price - 0.5 * CYCLE * -dKwh;
      disKwh += -dKwh;
      expKwh += pvAvail; // nothing entered the cell: the whole surplus leaves via the meter
    }
  }
  return { eur, chKwh, disKwh, expKwh };
}

// Export revenue, kept separate from score() so the battery € and the meter € stay readable.
function exportEur(slots, dump, slotH) {
  const cap = dump.capacityKwh;
  const chargeKwhFull = (dump.maxChargePowerW / 1000) * slotH;
  let eur = 0;
  for (let t = 0; t + 1 < slots.length; t++) {
    const s = slots[t];
    const dKwh = ((slots[t + 1].socProjected - s.socProjected) / 100) * cap;
    const pvAvail = (s.pvCoverage ?? 0) * chargeKwhFull;
    const stored = dKwh > 0 ? Math.min(dKwh, pvAvail) : 0;
    eur += Math.max(0, pvAvail - stored) * exportValue(s, TARIFF, EXPORT_RATIO);
  }
  return eur;
}

// ── Realized-outcome scoring (--realized) ────────────────────────────────────────────────────
// The forecast-scored A/B above cannot see what a reserve is FOR: it plans on the dump's own
// forecast and scores against that same forecast, a world where PV never under-delivers, so
// insurance can only ever cost its premium. Here the plan is still made on the forecast — that
// is the information the DP had (memory/feedback_replay_must_feed_forecast_not_realized) — but
// it is EXECUTED against measured PV and load, so an under-delivering afternoon actually bites.
//
// Physics and the action→hwMode mapper are imported, not re-derived: tools/replay-sim.js is the
// calibrated simulator both other harnesses use, and the mapper comes off PolicyEngine's own
// prototype with the stub `this` tools/dp-regret.js established.
const BUCKET_MS = 15 * 60 * 1000;

function loadRealized(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.value;
  const byBucket = new Map();
  for (const e of entries) {
    if (e.pvW == null || e.consumW == null) continue;
    byBucket.set(Math.round(new Date(e.ts).getTime() / BUCKET_MS) * BUCKET_MS, e);
  }
  // pvAvgW/consumAvgW describe the slot ENDING at their own ts (device.js:2846-2865), so the
  // slot starting at b reads the entry at b+15min and falls back to b's own snapshot.
  const out = new Map();
  for (const [b, e] of byBucket) {
    const nxt = byBucket.get(b + BUCKET_MS);
    out.set(b, { pvW: nxt?.pvAvgW ?? e.pvW, consW: nxt?.consumAvgW ?? e.consumW });
  }
  return out;
}

const collapseHw = (hwMode) => {
  switch (hwMode) {
    case 'zero_charge_only': case 'to_full': case 'zero_discharge_only': case 'standby':
      return hwMode;
    case 'pv_trickle': return 'zero_charge_only';
    default: return 'standby';   // preserve, zero, pv, ...
  }
};
const mapAction = PolicyEngine.prototype._mapActionToHwModeForPlanning;
const mapperThis = {
  settings: { tariff_model: TARIFF, export_price_ratio: EXPORT_RATIO },
  BATTERY_EFFICIENCY: EFF,
  _disposalValue: PolicyEngine.prototype._disposalValue,
};

function scoreRealized(slots, dump, rte, realized, slotH) {
  const sim = createSim({
    rte, capacityKwh: dump.capacityKwh, maxChargeW: dump.maxChargePowerW,
    maxDischargeW: dump.maxDischargePowerW, minSoc: 0, maxSoc: 100, slotH,
  });
  let soc = dump.soc, eur = 0, disKwh = 0, chKwh = 0, expKwh = 0, cov = 0;
  for (let t = 0; t < slots.length; t++) {
    const s = slots[t];
    const bucket = Math.round(Date.parse(s.timestamp) / BUCKET_MS) * BUCKET_MS;
    const m = realized.get(bucket);
    if (!m) break;                       // measured data ends — score the covered prefix only
    cov++;
    const futurePrices = slots.slice(t + 1)
      .map(d => ({ price: d.price, pvW: d.pvForecastW ?? 0, consumptionW: d.consumptionW ?? 0 }));
    const { hwMode } = mapAction.call(mapperThis, s.action, {
      price: s.price, exportPrice: s.exportPrice, soc, pvW: m.pvW, consumptionW: m.consW,
      tariffType: 'dynamic', userPolicyMode: 'auto',
      maxChargePrice: dump.maxChargePrice ?? 1.0, minDischargePrice: 0, minSoc: 0, maxSoc: 100,
      futurePrices, battChargePowerW: dump.maxChargePowerW, battCapKwh: dump.capacityKwh,
      pvKwhTomorrow: dump.effectivePvKwhTomorrow ?? 0, refillConfidence: dump.refillConfidence ?? 1,
      cheaperPvAhead: s.cheaperPvAhead || false,
    });
    const { nextSoc } = sim.simulateSlot(collapseHw(hwMode), m.pvW, m.consW, soc);
    const dKwh = ((nextSoc - soc) / 100) * dump.capacityKwh;
    const surplusKwh = (Math.max(0, m.pvW - m.consW) / 1000) * slotH;
    if (dKwh > 0) {
      const pvUsed = Math.min(dKwh, surplusKwh);
      eur -= (dKwh - pvUsed) * s.price + 0.5 * CYCLE * dKwh;
      chKwh += dKwh;
      expKwh += Math.max(0, surplusKwh - pvUsed);
    } else {
      eur += -dKwh * rte * s.price - 0.5 * CYCLE * -dKwh;
      disKwh += -dKwh;
      expKwh += surplusKwh;
    }
    eur += Math.max(0, surplusKwh - Math.max(0, Math.min(dKwh, surplusKwh)))
      * exportValue(s, TARIFF, EXPORT_RATIO);
    soc = nextSoc;
  }
  return { eur, chKwh, disKwh, expKwh, cov, endSoc: soc };
}

function residual(slots, dump, rte) {
  const last = slots[slots.length - 1];
  if (!last || last.socProjected == null) return { kwh: 0, eur: 0, socPct: null };
  const kwh = (last.socProjected / 100) * dump.capacityKwh;
  const priced = slots.filter(s => s.price != null);
  const meanPrice = priced.reduce((a, s) => a + s.price, 0) / (priced.length || 1);
  return { kwh, eur: kwh * (rte * meanPrice - 0.5 * CYCLE), socPct: last.socProjected };
}

const realizedMap = REALIZED ? loadRealized(REALIZED) : null;
// --only narrows the run set to the dumps the floor actually had something to insure: the ones
// where realized refill came in UNDER forecast. The 42-run mean hides them
// (memory/feedback_aggregate_stats_hide_hotspots); the subset is where a premium can earn back.
const onlySet = ONLY
  ? new Set(fs.readFileSync(ONLY, 'utf8').split('\n').map(l => l.trim()).filter(Boolean))
  : null;
const files = fs.readdirSync(DIR)
  .filter(f => f.startsWith('dp-input-') && f.endsWith('.json'))
  .filter(f => !onlySet || onlySet.has(f))
  .sort();
if (onlySet && files.length !== onlySet.size) {
  console.error(`--only listed ${onlySet.size} dumps, ${files.length} present in ${DIR}`);
}
const ams = iso => new Date(iso).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

const rows = [];
const skipped = [];
for (const f of files) {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { skipped.push(`${f}: unreadable`); continue; }
  if (!Array.isArray(dump.prices) || dump.prices.length < 2) { skipped.push(`${f}: no prices`); continue; }

  const slotH = (Date.parse(dump.prices[1].timestamp) - Date.parse(dump.prices[0].timestamp)) / 3_600_000;
  const rte = dump.learnedRte ?? EFF;
  const off = run(dump, false);
  const on = run(dump, true);
  const so = off._schedule?.slots || [];
  const sn = on._schedule?.slots || [];
  if (!so.length || so.length !== sn.length) { skipped.push(`${f}: no comparable schedule`); continue; }

  let A, B, AX = 0, BX = 0, RA, RB, cov = null;
  if (realizedMap) {
    A = scoreRealized(so, dump, rte, realizedMap, slotH);
    B = scoreRealized(sn, dump, rte, realizedMap, slotH);
    cov = `${A.cov}/${so.length}`;
    if (!A.cov || A.cov !== B.cov) { skipped.push(`${f}: no measured coverage`); continue; }
    const priced = so.slice(0, A.cov);
    const mean = priced.reduce((a, s) => a + s.price, 0) / (priced.length || 1);
    const resid = (endSoc) => ({
      socPct: endSoc,
      eur: (endSoc / 100) * dump.capacityKwh * (rte * mean - 0.5 * CYCLE),
    });
    RA = resid(A.endSoc); RB = resid(B.endSoc);
  } else {
    A = score(so, dump, rte, slotH); B = score(sn, dump, rte, slotH);
    AX = exportEur(so, dump, slotH); BX = exportEur(sn, dump, slotH);
    RA = residual(so, dump, rte); RB = residual(sn, dump, rte);
  }

  const floorG = on._lastDpArrays?.reserveFloorG || [];
  const nFloor = Array.from(floorG).filter(v => v > 0).length;
  // Did the floor actually hold energy? Largest SoC the ON plan carried over the OFF plan
  // on a slot the floor covers — the quantity the legacy floor scored 0.00 on.
  let heldPct = 0;
  for (let t = 0; t < sn.length; t++) {
    if (!(floorG[t] > 0)) continue;
    heldPct = Math.max(heldPct, sn[t].socProjected - so[t].socProjected);
  }

  rows.push({
    cov,
    at: ams(dump.at),
    soc: Math.round(dump.soc),
    slots: dump.prices.length,
    addPct: (on._gateB?.b6_reserveAddG ?? 0) / 10,
    nFloor,
    heldKwh: Math.max(0, heldPct / 100) * dump.capacityKwh,
    dEur: (B.eur + BX) - (A.eur + AX),
    dTot: (B.eur + BX + RB.eur) - (A.eur + AX + RA.eur),
    dExp: B.expKwh - A.expKwh,
    dSocPct: (RB.socPct ?? 0) - (RA.socPct ?? 0),
    dDis: B.disKwh - A.disKwh,
    dCh: B.chKwh - A.chKwh,
  });
}

console.log(`\ncycle=EUR${CYCLE}/kWh eff=${EFF} tariff=${TARIFF} exportRatio=${EXPORT_RATIO}`
  + ` k=${K == null ? 'engine default' : K}`);
console.log('D = CVaR floor ON - OFF. Battery EUR from the SoC path, PV that no longer fits priced'
  + ' at exportValue, residual SoC at RTE x mean price - half cycle.\n');
console.log(REALIZED
  ? `plans made on the dump forecast, EXECUTED against measured PV/load from ${path.basename(REALIZED)}`
  : 'plans scored against their own forecast — insurance can only cost its premium here');
console.log('run (Ams)     cover   soc%  slots  floor%  nFlr  held kWh    D EUR    D EUR+res   Dexp kWh   DendSoC%   Ddis kWh   Dch kWh');
for (const r of rows) {
  console.log(
    `${r.at}   ${String(r.cov ?? '-').padStart(7)}   ${String(r.soc).padStart(3)}   ${String(r.slots).padStart(4)}   ${r.addPct.toFixed(1).padStart(5)}`
    + `  ${String(r.nFloor).padStart(4)}   ${r.heldKwh.toFixed(3).padStart(7)}`
    + `   ${r.dEur.toFixed(4).padStart(8)}   ${r.dTot.toFixed(4).padStart(9)}`
    + `   ${r.dExp.toFixed(3).padStart(8)}   ${r.dSocPct.toFixed(1).padStart(8)}`
    + `   ${r.dDis.toFixed(3).padStart(8)}   ${r.dCh.toFixed(3).padStart(7)}`,
  );
}

const n = rows.length || 1;
const sum = k => rows.reduce((a, r) => a + r[k], 0);
const wins = rows.filter(r => r.dTot > 1e-4).length;
const loss = rows.filter(r => r.dTot < -1e-4).length;
console.log(`\nn=${rows.length}  ON better ${wins}  worse ${loss}  tied ${rows.length - wins - loss}`);
console.log(`floor set in ${rows.filter(r => r.nFloor > 0).length} runs, held >0.01 kWh in `
  + `${rows.filter(r => r.heldKwh > 0.01).length}`);
console.log(`mean D EUR plan   ${(sum('dEur') / n).toFixed(4)}`);
console.log(`mean D EUR +res   ${(sum('dTot') / n).toFixed(4)}`);
console.log(`mean D dis kWh    ${(sum('dDis') / n).toFixed(3)}   mean D exp kWh ${(sum('dExp') / n).toFixed(3)}`);
if (skipped.length) console.log(`\nskipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
