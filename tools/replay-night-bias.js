'use strict';
/**
 * € impact of the night consumption bias correction (night_consumption_bias_corr).
 *
 * The correction subtracts the measured night bias from the DP's consumption input
 * (drivers/battery-policy/device.js `_nightBiasCorrW` / `_buildDpConsumption`). Those two
 * statics are imported here, not re-implemented — one implementation, one meetlat.
 *
 * Method per night: decide at 22:00 Ams, horizon to 07:00 Ams (36 × 15-min slots).
 *   inputs  = FORECAST as the live DP received it: `price`, `pvFcW`, `consumFcW`
 *   scoring = REALIZED: `consumAvgW`, `pvAvgW` pushed through the shared replay physics
 * Two runs, identical in everything except the correction flag. Both plans are mapped to
 * hwMode with the real PolicyEngine mapper and free-run from the same measured start SoC.
 *
 * The bias fed to the correction is derived from this same corpus (mean consumAvgW − consumFcW
 * per Amsterdam hour, count-gated at NIGHT_BIAS_MIN_COUNT), standing in for the live
 * consumption_accuracy_hourly EMA. In-sample by construction: it answers "what would the
 * correction have been worth on the data it was fitted on", i.e. an upper bound.
 *
 * Known limits, equal for both runs so they cancel in the delta but not in the absolute €:
 *  - scoreSocDelta bills every charge at the slot price, including PV-sourced charge. Inside
 *    22:00-07:00 PV is ~0 except the last slots around sunrise.
 *  - pvKwhTomorrow is the realized next-day PV total (perfect-foresight scalar).
 *  - minDischargePrice is passed as the scalar the chunk logged; live it can be a per-slot
 *    array (2026-07-10 bug), which this replay cannot reproduce.
 *
 * Usage: node tools/replay-night-bias.js [--dir tools/_hist-chunks-daychunks]
 *        [--margin 1.128] [--baseload 0] [--pair next|same] [--rte 0.72] [-v]
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine       = require('../lib/policy-engine');
const { createSim }      = require('./replay-sim');

// device.js extends Homey.Device; stub the SDK so the statics can be imported offline.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const args = process.argv.slice(2);
const str = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };

const DIR      = str('--dir', path.join(__dirname, '_hist-chunks-daychunks'));
const MARGIN   = num('--margin', 1.128);   // consumptionMargin at night (low CV); multiplies the correction
const BASELOAD = num('--baseload', 0);     // floor inside _buildDpConsumption; ~314W live, inert at night
const PAIR     = str('--pair', 'next');    // forecast[t] scored against realized at t+1 (next) or t (same)
const TAIL_H   = num('--tail-hours', 5);   // hours past the window both runs free-run on one shared policy
const FROM_H   = num('--from-hour', 22);   // Amsterdam hour the decision is taken at
const WIN_H    = num('--hours', 9);        // horizon length in hours (22+9 = 07:00)
const MARGIN2  = num('--margin-b', null);  // when set, run B varies the margin instead of the bias flag
const VERBOSE  = args.includes('-v');

const CAPACITY_KWH = num('--cap', 2.69);
const MAX_CHARGE_W = num('--maxw', 800);
const MAX_DISCHARGE_W = MAX_CHARGE_W;
const MIN_SOC = 0, MAX_SOC = 100;
const RTE     = num('--rte', 0.72);
const SLOT_H  = 0.25;
const CYCLE_COST_PER_KWH = 0.075;
const SLOT_MS = 15 * 60 * 1000;

const { simulateSlot, scoreSocDelta } = createSim({
  rte: RTE, capacityKwh: CAPACITY_KWH, maxChargeW: MAX_CHARGE_W, maxDischargeW: MAX_DISCHARGE_W,
  minSoc: MIN_SOC, maxSoc: MAX_SOC, slotH: SLOT_H,
});

const mapperThis = { settings: { tariff_model: 'saldering', export_price_ratio: 1.0 }, BATTERY_EFFICIENCY: RTE };
const mapAction  = PolicyEngine.prototype._mapActionToHwModeForPlanning;

// Collapse to the 4 modes the simulator is calibrated for (same table as dp-regret.js).
function collapseHw(hwMode) {
  switch (hwMode) {
    case 'zero_charge_only': case 'to_full': case 'zero_discharge_only': case 'standby': return hwMode;
    case 'pv_trickle': return 'zero_charge_only';
    default: return 'standby';
  }
}

const amsHourFmt = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' });
const amsDayFmt  = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' });
const amsHM      = ms => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);
const amsHour    = ms => Number(amsHourFmt.format(new Date(ms)));

// ── load every chunk into one bucketed timeline ────────────────────────────────────────────
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
if (!files.length) { console.error(`no day chunks in ${DIR}`); process.exit(1); }

const byBucket = new Map();
for (const f of files) {
  for (const e of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    if (!e || e.ts == null) continue;
    const bucket = Math.round(Date.parse(e.ts) / SLOT_MS) * SLOT_MS;
    byBucket.set(bucket, { bucket, ...e });
  }
}
const timeline = [...byBucket.values()].sort((a, b) => a.bucket - b.bucket);

// ── night bias per Amsterdam hour, standing in for consumption_accuracy_hourly ─────────────
// emaBiasW = actual − predicted. Realized for the interval a forecast covers is the NEXT
// record's slot-average (device.js writes consumAvgW as the average over the elapsed slot).
function buildHourly(pairMode) {
  const acc = {};
  for (let i = 0; i < timeline.length; i++) {
    const cur = timeline[i];
    const realizedRec = pairMode === 'next' ? timeline[i + 1] : cur;
    if (!realizedRec || (pairMode === 'next' && realizedRec.bucket - cur.bucket !== SLOT_MS)) continue;
    const fc = cur.consumFcW, act = realizedRec.consumAvgW;
    if (!Number.isFinite(fc) || !Number.isFinite(act)) continue;
    const h = amsHour(cur.bucket);
    (acc[h] ??= { sum: 0, count: 0 }).sum += (act - fc);
    acc[h].count++;
  }
  const out = {};
  for (const [h, v] of Object.entries(acc)) out[h] = { emaBiasW: v.sum / v.count, count: v.count };
  return out;
}
const hourly      = buildHourly(PAIR);
const hourlyOther = buildHourly(PAIR === 'next' ? 'same' : 'next');

// ── carve the nights: 22:00 Ams → 07:00 Ams ────────────────────────────────────────────────
// Slot t is kept when its Amsterdam hour is 22/23 (evening side) or 0-6 (morning side), and
// the whole run must be contiguous, so the window is built by walking the timeline.
const WIN_SLOTS = Math.round(WIN_H * 4);
const startHH = String(FROM_H).padStart(2, '0');
const nights = [];
for (let i = 0; i < timeline.length; i++) {
  if (!amsHM(timeline[i].bucket).endsWith(`${startHH}:00`)) continue;
  const run = [];
  for (let j = i; j < timeline.length && run.length < WIN_SLOTS; j++) {
    if (j > i && timeline[j].bucket - timeline[j - 1].bucket !== SLOT_MS) break;
    run.push(timeline[j]);
  }
  // Need the successor of the last slot too: realized energy for [t, t+1] lives there.
  const tail = timeline[timeline.indexOf(run[run.length - 1]) + 1];
  if (run.length === WIN_SLOTS && tail) nights.push({ day: amsDayFmt.format(new Date(run[0].bucket)), run, tail });
}
if (!nights.length) { console.error(`no complete ${startHH}:00 +${WIN_H}h windows found`); process.exit(1); }

// ── per-night replay ───────────────────────────────────────────────────────────────────────
const engine = new OptimizationEngine({
  battery_efficiency: RTE, min_soc: MIN_SOC, max_soc: MAX_SOC,
  cycle_cost_per_kwh: CYCLE_COST_PER_KWH, tariff_model: 'saldering', export_price_ratio: 1.0,
});

// Realized inputs are tiered so an instantaneous reading standing in for a slot-average is
// visible instead of silently counted as coverage (aliasing, feedback_verify_sampling_alignment).
const cov = {
  price: 0, pvFcW: 0, consumFcW: 0, total: 0,
  consAvg: 0, consInst: 0, consCarry: 0,
  pvAvg: 0, pvInst: 0, pvCarry: 0,
};
const rows = [];
let tOff = 0, tOn = 0, tOffResid = 0, tOnResid = 0, totalDiffs = 0;
let tOffTail = 0, tOnTail = 0, tailSlotsSeen = 0;

for (const night of nights) {
  const { run, tail } = night;
  const seq = [...run, tail];

  // Realized energy for slot t comes from t+1's slot-average. Where the sampler skipped that
  // field, fall back to the instantaneous reading, then to the last valid value; each tier is
  // counted so the report can state how much of the scoring rests on a true slot-average.
  let lastC = null, lastP = null, degraded = 0;
  const realized = run.map((s, i) => {
    const nx = seq[i + 1];
    let consW, pvW;
    if (Number.isFinite(nx.consumAvgW))    { consW = nx.consumAvgW; cov.consAvg++; lastC = consW; }
    else if (Number.isFinite(s.consumW) && s.consumW > 0) { consW = s.consumW; cov.consInst++; lastC = consW; degraded++; }
    else                                   { consW = lastC ?? 0; cov.consCarry++; degraded++; }
    if (Number.isFinite(nx.pvAvgW))        { pvW = nx.pvAvgW; cov.pvAvg++; lastP = pvW; }
    else if (Number.isFinite(s.pvW))       { pvW = s.pvW; cov.pvInst++; lastP = pvW; }
    else                                   { pvW = lastP ?? 0; cov.pvCarry++; }
    return { bucket: s.bucket, price: s.price, pvW, consW };
  });
  night.degraded = degraded;

  cov.total += run.length;
  for (let i = 0; i < run.length; i++) {
    if (Number.isFinite(run[i].price))     cov.price++;
    if (Number.isFinite(run[i].pvFcW))     cov.pvFcW++;
    if (Number.isFinite(run[i].consumFcW)) cov.consumFcW++;
  }

  const prices     = run.map(s => ({ timestamp: new Date(s.bucket).toISOString(), price: s.price }));
  const pvForecast = run.map(s => ({ timestamp: new Date(s.bucket).toISOString(), pvPowerW: s.pvFcW ?? 0 }));
  const rawLearned = run.map(s => s.consumFcW ?? 0);
  const hoursAms   = run.map(s => amsHour(s.bucket));

  // Next-day realized PV total — a scalar, identical in both runs, so it cancels in the delta.
  const nextDay = amsDayFmt.format(new Date(run[run.length - 1].bucket));
  const pvKwhTomorrow = timeline
    .filter(s => amsDayFmt.format(new Date(s.bucket)) === nextDay && Number.isFinite(s.pvAvgW))
    .reduce((a, s) => a + s.pvAvgW * SLOT_H / 1000, 0);

  const socStart = run[0].soc;
  const maxChargePrice    = run[0].maxChargePrice ?? 0.12;
  const minDischargePrice = run[0].minDischargePrice ?? 0;

  function plan(corrOn, margin = MARGIN) {
    const consumptionWPerSlot = BatteryPolicyDevice._buildDpConsumption(
      rawLearned, hoursAms, hourly, BASELOAD, corrOn);
    engine._schedule = null;
    engine.compute(
      prices, socStart, CAPACITY_KWH, MAX_CHARGE_W, MAX_DISCHARGE_W, pvForecast,
      RTE, consumptionWPerSlot,
      minDischargePrice, margin,
      pvKwhTomorrow, pvKwhTomorrow,
      /* pvCloudFactor */ 1.0, /* refillConfidence */ 1.0,
      /* pvTimingRobust */ false, maxChargePrice,
    );
    return { slots: engine._schedule?.slots ?? [], consumptionWPerSlot };
  }

  // Free-run a plan through realized PV/consumption, € from the SoC deltas.
  function score(planSlots) {
    const byMs = new Map(planSlots.map(s => [Date.parse(s.timestamp), s]));
    let soc = socStart, rev = 0, cost = 0;
    const hws = [];
    for (const r of realized) {
      const ps = byMs.get(r.bucket);
      let hw = 'standby';
      if (ps) {
        const futurePrices = realized.filter(d => d.bucket > r.bucket)
          .map(d => ({ price: d.price, pvW: d.pvW, consumptionW: d.consW }));
        const m = mapAction.call(mapperThis, ps.action, {
          price: r.price, soc: ps.socProjected ?? soc, pvW: r.pvW, consumptionW: r.consW,
          tariffType: 'dynamic', userPolicyMode: 'auto',
          maxChargePrice, minDischargePrice, minSoc: MIN_SOC, maxSoc: MAX_SOC,
          futurePrices, battChargePowerW: MAX_CHARGE_W, battCapKwh: CAPACITY_KWH,
          pvKwhTomorrow, refillConfidence: 1,
        });
        hw = collapseHw(m.hwMode);
      }
      const { nextSoc } = simulateSlot(hw, r.pvW, r.consW, soc);
      const sc = scoreSocDelta(nextSoc - soc, r.price);
      rev += sc.revenue; cost += sc.cost;
      hws.push(hw);
      soc = nextSoc;
    }
    return { profit: rev - cost, endSoc: soc, hws };
  }

  // Tail: past 07:00 BOTH runs follow the same self-consume policy on the same realized data.
  // Leftover SoC then gets spent (or made worthless by the morning PV) instead of being priced
  // by a formula — the residual valuation below is a single number, this is the robustness check.
  const endMs = run[run.length - 1].bucket + SLOT_MS;
  const tailIdx = timeline.findIndex(s => s.bucket === endMs);
  const tailRun = tailIdx < 0 ? [] : timeline.slice(tailIdx, tailIdx + Math.round(TAIL_H * 4));
  let tc = null, tp = null;
  const tailRealized = tailRun.map((s, i) => {
    const nx = tailRun[i + 1] ?? s;
    const consW = Number.isFinite(nx.consumAvgW) ? nx.consumAvgW
      : (Number.isFinite(s.consumW) && s.consumW > 0 ? s.consumW : (tc ?? 0));
    const pvW = Number.isFinite(nx.pvAvgW) ? nx.pvAvgW : (Number.isFinite(s.pvW) ? s.pvW : (tp ?? 0));
    tc = consW; tp = pvW;
    return { bucket: s.bucket, price: s.price, pvW, consW };
  });
  const baselineHw = (pvW, consW) => (pvW - consW > 0 ? 'zero_charge_only'
    : consW - pvW > 0 ? 'zero_discharge_only' : 'standby');
  function scoreTail(startSoc) {
    let soc = startSoc, rev = 0, cost = 0;
    for (const r of tailRealized) {
      const { nextSoc } = simulateSlot(baselineHw(r.pvW, r.consW), r.pvW, r.consW, soc);
      const sc = scoreSocDelta(nextSoc - soc, r.price);
      rev += sc.revenue; cost += sc.cost;
      soc = nextSoc;
    }
    return { profit: rev - cost, endSoc: soc };
  }

  // Run A is always the live baseline. Run B varies ONE thing: the bias flag, or — when
  // --margin-b is given — the consumptionMargin, with the bias flag left off in both.
  const off = plan(false, MARGIN);
  const on  = MARGIN2 === null ? plan(true, MARGIN) : plan(false, MARGIN2);
  const sOff = score(off.slots), sOn = score(on.slots);
  const tOffT = scoreTail(sOff.endSoc), tOnT = scoreTail(sOn.endSoc);

  // Residual SoC left at 07:00 valued at the morning price, discharge side (× RTE), so a €
  // delta bought with leftover charge is priced instead of hidden.
  const morning = timeline.filter(s => s.bucket >= run[run.length - 1].bucket + SLOT_MS
    && s.bucket < run[run.length - 1].bucket + SLOT_MS + 2 * 3600_000 && Number.isFinite(s.price));
  const morningPrice = morning.length ? morning.reduce((a, s) => a + s.price, 0) / morning.length : run[0].price;
  const residualAt = (soc, price) => (soc / 100) * CAPACITY_KWH * RTE * price;
  const residual = soc => residualAt(soc, morningPrice);
  const tailEndPrice = tailRealized.length ? tailRealized[tailRealized.length - 1].price : morningPrice;

  const diffs = off.slots.filter((s, i) => s.action !== on.slots[i]?.action).length;
  totalDiffs += diffs;
  tOff += sOff.profit; tOn += sOn.profit;
  tOffResid += sOff.profit + residual(sOff.endSoc);
  tOnResid  += sOn.profit  + residual(sOn.endSoc);
  const eOffTail = sOff.profit + tOffT.profit + residualAt(tOffT.endSoc, tailEndPrice);
  const eOnTail  = sOn.profit  + tOnT.profit  + residualAt(tOnT.endSoc, tailEndPrice);
  tOffTail += eOffTail; tOnTail += eOnTail;
  tailSlotsSeen += tailRealized.length;

  const corrApplied = on.consumptionWPerSlot.map((v, i) => v - off.consumptionWPerSlot[i]);
  rows.push({
    night: night.day, socStart, diffs, degraded,
    corrMin: Math.min(...corrApplied), corrMax: Math.max(...corrApplied),
    eOff: sOff.profit, eOn: sOn.profit,
    socOff: sOff.endSoc, socOn: sOn.endSoc,
    dResid: (sOn.profit + residual(sOn.endSoc)) - (sOff.profit + residual(sOff.endSoc)),
    dTail: eOnTail - eOffTail,
  });

  if (VERBOSE) {
    console.log(`\n── ${night.day} 22:00 → 07:00 ──`);
    for (let i = 0; i < realized.length; i++) {
      const a = off.slots[i]?.action, b = on.slots[i]?.action;
      console.log(`  ${amsHM(realized[i].bucket)} €${realized[i].price?.toFixed(4)} `
        + `fc=${Math.round(rawLearned[i])}W corr=${Math.round(on.consumptionWPerSlot[i])}W `
        + `real=${Math.round(realized[i].consW)}W  ${a}${a !== b ? ` → ${b}` : ''}`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────────────────────
const pct = (n) => `${n}/${cov.total}`;
const nightHours = [23, 0, 1, 2, 3, 4, 5, 6];
const biasStr = (h) => nightHours.map(x => `${x}:${h[x] ? `${h[x].emaBiasW.toFixed(0)}W/n=${h[x].count}` : '—'}`).join(' ');

console.log('══ measure-scope ══');
const endHH = String((FROM_H + WIN_H) % 24).padStart(2, '0');
console.log(`variant B = ${MARGIN2 === null ? `night bias correction ON (margin ${MARGIN} in both)`
  : `consumptionMargin ${MARGIN2} instead of ${MARGIN} (bias correction off in both)`}`);
console.log(`decision ${startHH}:00 Ams, horizon ${endHH}:00 Ams — ${WIN_SLOTS} × 15-min slots per window,`
  + ` ${nights.length} windows (${nights[0].day} … ${nights[nights.length - 1].day})`);
console.log(`decision-scope = the same ${WIN_SLOTS} slots: the whole plan is replanned and rescored inside the window.`);
console.log(`source ${path.relative(process.cwd(), DIR)} (${files.length} day chunks)`);

console.log('\n══ input coverage (n real / n total) ══');
console.log(`  price       ${pct(cov.price)}      forecast input`);
console.log(`  consumFcW   ${pct(cov.consumFcW)}      forecast input (the array the correction edits)`);
console.log(`  pvFcW       ${pct(cov.pvFcW)}      forecast input`);
console.log(`  consumption REALIZED, scoring input: slot-avg ${pct(cov.consAvg)}`
  + `, instant fallback ${cov.consInst}, carried-forward ${cov.consCarry}`);
console.log(`  pv          REALIZED, scoring input: slot-avg ${pct(cov.pvAvg)}`
  + `, instant fallback ${cov.pvInst}, carried-forward ${cov.pvCarry}`);
console.log(`  instant/carried slots are the sampler's cadence gaps, not a flat default; an`);
console.log(`  instantaneous reading standing in for a 15-min mean is aliasing, counted separately.`);
console.log(`\nbias fed to _nightBiasCorrW (pair=${PAIR}, in-sample over the whole corpus):`);
console.log(`  ${biasStr(hourly)}`);
console.log(`  cross-check pair=${PAIR === 'next' ? 'same' : 'next'}: ${biasStr(hourlyOther)}`);
console.log(`  gate count>=20, cap -150W, negative-only — hours failing the gate contribute 0.`);
console.log(`params: margin=${MARGIN} baseload=${BASELOAD}W rte=${RTE} cap=${CAPACITY_KWH}kWh maxW=${MAX_CHARGE_W}`);

console.log('\n══ per night ══');
console.log('night        socStart  corr applied     Δact deg   € OFF     € ON      ΔON−OFF   endSoC OFF→ON   Δ+residual  Δ+tail');
for (const r of rows) {
  console.log(`${r.night}   ${String(r.socStart).padStart(3)}%     `
    + `${r.corrMin.toFixed(0)}..${r.corrMax.toFixed(0)}W`.padEnd(16)
    + `${String(r.diffs).padStart(3)} ${String(r.degraded).padStart(3)}  `
    + `${r.eOff.toFixed(4).padStart(8)}  ${r.eOn.toFixed(4).padStart(8)}  `
    + `${(r.eOn - r.eOff).toFixed(4).padStart(8)}   `
    + `${r.socOff.toFixed(1).padStart(5)}→${r.socOn.toFixed(1).padStart(5)}   `
    + `${r.dResid.toFixed(4).padStart(8)}  ${r.dTail.toFixed(4).padStart(8)}`);
}

console.log('\n══ total ══');
console.log(`plan action diffs A vs B    : ${totalDiffs} of ${cov.total} slots`);
console.log(`€ A (live baseline)         : ${tOff.toFixed(4)}   window only, residual ignored`);
console.log(`€ B (variant)               : ${tOn.toFixed(4)}   window only, residual ignored`);
console.log(`€ A incl. ${TAIL_H}h tail         : ${tOffTail.toFixed(4)}`);
console.log(`€ B incl. ${TAIL_H}h tail         : ${tOnTail.toFixed(4)}`);
console.log(`Δ (B − A)                   : ${(tOn - tOff).toFixed(4)}   over ${nights.length} windows`);
console.log(`Δ incl. residual SoC value  : ${(tOnResid - tOffResid).toFixed(4)}   (07:00 SoC priced at the 07-09 mean)`);
console.log(`Δ incl. ${TAIL_H}h shared tail     : ${(tOnTail - tOffTail).toFixed(4)}   `
  + `(${tailSlotsSeen} tail slots, both runs on one self-consume policy)`);
console.log(`Δ per night (tail variant)  : ${((tOnTail - tOffTail) / nights.length).toFixed(4)}`);
if (totalDiffs === 0) {
  console.log('\n0 action diffs — the correction did not move a single plan on this corpus.');
}
