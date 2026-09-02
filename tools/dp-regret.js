'use strict';
/**
 * DP regret harness — PHASE 1: score the DP's decisions after the fact.
 *
 * Phase 0 (replay-calibration.js) proved the shared simulator reproduces MEASURED battery
 * behaviour from realized inputs (MAE 21.1%, VERDICT PASS 2026-07-23). This tool uses that
 * proven simulator to answer the decision-quality question the forecast-accuracy stats
 * (device.js _planAccuracyStats) cannot: given what actually happened, did the DP choose well?
 *
 * For each completed day it brackets the realized outcome between two references, ALL scored
 * through the same shared simulator (replay-sim.js) so the ~21% model error cancels in the
 * comparison rather than polluting it:
 *
 *   baseline€   — a naive "self-consume" policy (charge from surplus, discharge to cover load).
 *   realized€   — the hardware modes that actually ran.
 *   oracle€     — the DP re-run on the REALIZED PV/consumption/price (perfect foresight).
 *
 *   DP added value = realized − baseline   (how much the DP beats naive; should be > 0)
 *   regret         = oracle − realized     (money left on the table)
 *   per-slot diff  — where oracle ≠ realized (e.g. "battery could have been fuller here").
 *
 * ── Honest limits (read before trusting a number) ──
 * 1. Measures forecast+horizon regret, NOT DP-internal optimality. Re-running the same DP on
 *    perfect inputs cannot expose a flaw in the DP's own logic — it agrees with itself. That is
 *    the 2026-07-16 tautology; this tool sidesteps it by comparing against REALIZED behaviour
 *    (from measured SoC), never DP-vs-DP.
 * 2. Oracle is a CONSERVATIVE near-upper-bound, not a proven LP optimum. It reuses the trusted
 *    engine with its reserve hedges relaxed (pvKwhTomorrow high → headroom gate open → forced
 *    top-up off; refillConfidence 1) rather than a second optimizer that would need its own
 *    trust. Residual hedging makes oracle slightly defensive → regret slightly UNDERstated.
 * 3. Oracle's SoC path is counterfactual (modes that never ran). The simulator was validated
 *    only on modes that DID run, so oracle€ carries an extrapolation error bar.
 *
 * Usage:
 *   node tools/dp-regret.js <history.json> [--pv avg|instant] [--consumption avg|instant] [--tariff saldering|asymmetric_2027]
 */

const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');
const { createSim } = require('./replay-sim');
const { exportPrice: computeExportPrice } = require('../lib/price-formulas');

// ── Battery configuration (device eca0f7a8) — matches replay-calibration.js ──────────────
const CAPACITY_KWH    = 2.69;
const MAX_CHARGE_W    = 800;
const MAX_DISCHARGE_W = 800;
const MIN_SOC = 0;
const MAX_SOC = 100;
const RTE     = 0.72;
const SLOT_H  = 0.25;
const CYCLE_COST_PER_KWH = 0.075;  // engine default; real economic cost, kept for the oracle

const args = process.argv.slice(2);
const historyPath = args[0];
if (!historyPath) {
  console.error('usage: node tools/dp-regret.js <history.json> [--pv avg|instant] [--consumption avg|instant] [--tariff saldering|asymmetric_2027]');
  process.exit(1);
}
const pvArg = args.indexOf('--pv');
const PV_MODE = pvArg >= 0 ? args[pvArg + 1] : 'avg';
const consArg = args.indexOf('--consumption');
const CONS_MODE = consArg >= 0 ? args[consArg + 1] : 'avg';
// Tariff regime. The stub used to hardcode 'saldering' while the live device has run
// 'asymmetric_2027' since 23-08, so the oracle played a different game than the DP it is
// scored against. Under asymmetric_2027 export is valued per slot at prices[t].exportPrice;
// the history only records the retail import price, so the spot is reconstructed exactly the
// way the live PBTH provider does it (pbth-provider.js _mapSlot: spot = import/1.21 - markup)
// and re-derived through the shared price-formulas.exportPrice — no second formula.
// Defaults are the live device settings (eca0f7a8) read 27-08.
const tariffArg = args.indexOf('--tariff');
const TARIFF = tariffArg >= 0 ? args[tariffArg + 1] : 'saldering';
const numArg = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? parseFloat(args[i + 1]) : dflt; };
const MARKUP     = numArg('--markup', 0.1082);
const EXP_ADDON  = numArg('--export-addon', 0.02);
const EXP_MULT   = numArg('--export-mult', 1.1);
const exportPriceOf = (importPrice) => (TARIFF === 'asymmetric_2027'
  ? computeExportPrice(importPrice / 1.21 - MARKUP, EXP_ADDON, EXP_MULT)
  : null);

const { simulateSlot, scoreSocDelta } = createSim({
  rte: RTE, capacityKwh: CAPACITY_KWH, maxChargeW: MAX_CHARGE_W, maxDischargeW: MAX_DISCHARGE_W,
  minSoc: MIN_SOC, maxSoc: MAX_SOC, slotH: SLOT_H,
});

const engine = new OptimizationEngine({
  battery_efficiency: RTE, min_soc: MIN_SOC, max_soc: MAX_SOC,
  cycle_cost_per_kwh: CYCLE_COST_PER_KWH, tariff_model: TARIFF, export_price_ratio: 1.0,
});

// The action→hwMode mapper only reads this.settings, this.BATTERY_EFFICIENCY and
// this._disposalValue (verified policy-engine.js:1840-1995), so a stub `this` calls it offline
// without a full PolicyEngine. _disposalValue is taken from the prototype rather than copied —
// it reads this.settings, which the stub supplies, so the mapper and the app share one formula.
const mapperThis = {
  settings: { tariff_model: TARIFF, export_price_ratio: 1.0 },
  BATTERY_EFFICIENCY: RTE,
  _disposalValue: PolicyEngine.prototype._disposalValue,
};
const mapAction = PolicyEngine.prototype._mapActionToHwModeForPlanning;

// Collapse the mapper's richer hwMode vocabulary onto the 4 modes the simulator is calibrated
// for. pv_trickle charges from PV surplus exactly like zero_charge_only (identical simulator
// physics); preserve holds SoC like standby. Modes outside the validated 4 default to standby.
function collapseHw(hwMode) {
  switch (hwMode) {
    case 'zero_charge_only':
    case 'to_full':
    case 'zero_discharge_only':
    case 'standby':
      return hwMode;
    case 'pv_trickle':
      return 'zero_charge_only';
    default:                 // preserve, zero, pv, etc.
      return 'standby';
  }
}

// ── Load + normalize (mirrors replay-calibration.js) ────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const entries = Array.isArray(raw) ? raw : raw.value;
const BUCKET_MS = 15 * 60 * 1000;
const slots = [];
for (const e of entries) {
  if (e.exception != null) continue;
  if (e.price == null || e.battW == null || e.soc == null || e.pvW == null || e.consumW == null) continue;
  const bucket = Math.round(new Date(e.ts).getTime() / BUCKET_MS) * BUCKET_MS;
  slots.push({
    bucket,
    day: new Date(bucket).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }),
    hwMode: e.hwMode,
    price: e.price,
    exportPrice: exportPriceOf(e.price),
    pvW: e.pvW, pvAvgW: e.pvAvgW ?? null,
    consW: e.consumW, consumAvgW: e.consumAvgW ?? null,
    socMeasured: e.soc,
  });
}
slots.sort((a, b) => a.bucket - b.bucket);

// Pair each slot with its successor: hwMode[t] governs [t, t+1] and soc[t]→soc[t+1] is the
// energy that moved. Realized PV/consumption for the interval is the NEXT entry's slot-average
// (device.js:2141-2145), falling back to this slot's instantaneous reading.
const paired = [];
for (let i = 0; i < slots.length - 1; i++) {
  const cur = slots[i], nxt = slots[i + 1];
  if (nxt.bucket - cur.bucket !== BUCKET_MS) continue;
  paired.push({
    bucket: cur.bucket, day: cur.day, hwMode: cur.hwMode, price: cur.price,
    exportPrice: cur.exportPrice,
    socStart: cur.socMeasured, socEnd: nxt.socMeasured,
    dSocMeasured: nxt.socMeasured - cur.socMeasured,
    pvW: PV_MODE === 'avg' ? (nxt.pvAvgW ?? cur.pvW) : cur.pvW,
    consW: CONS_MODE === 'avg' ? (nxt.consumAvgW ?? cur.consW) : cur.consW,
  });
}

const byDay = new Map();
for (const s of paired) {
  if (!byDay.has(s.day)) byDay.set(s.day, []);
  byDay.get(s.day).push(s);
}

// Baseline "self-consume": charge from any PV surplus, discharge to cover any deficit.
function baselineHw(pvW, consW) {
  if (pvW - consW > 0) return 'zero_charge_only';
  if (consW - pvW > 0) return 'zero_discharge_only';
  return 'standby';
}

// Free-run a hwMode sequence through the shared simulator from socStart, accumulating €.
function scoreSequence(daySlots, hwOf) {
  let soc = daySlots[0].socStart;
  let rev = 0, cost = 0;
  const socPath = [];
  for (const s of daySlots) {
    const hw = hwOf(s);
    const { nextSoc } = simulateSlot(hw, s.pvW, s.consW, soc);
    const { revenue, cost: c } = scoreSocDelta(nextSoc - soc, s.price);
    rev += revenue; cost += c;
    socPath.push({ hw, socBefore: soc, socAfter: nextSoc });
    soc = nextSoc;
  }
  return { profit: rev - cost, socPath, endSoc: soc };
}

// ── Per-day bracket ─────────────────────────────────────────────────────────────────────────
const dayRows = [];
const slotDiffs = [];
let tBaseline = 0, tRealized = 0, tOracle = 0, tRealizedMeas = 0;

for (const [day, daySlots] of [...byDay.entries()].sort()) {
  const socStart = daySlots[0].socStart;

  // Oracle: DP on realized inputs, hedges relaxed for a perfect-foresight upper bound.
  const prices = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), price: s.price, exportPrice: s.exportPrice }));
  const pvForecast = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), pvPowerW: s.pvW }));
  const consumptionWPerSlot = daySlots.map(s => s.consW);
  engine._schedule = null;
  engine.compute(
    prices, socStart, CAPACITY_KWH, MAX_CHARGE_W, MAX_DISCHARGE_W, pvForecast,
    RTE, consumptionWPerSlot,
    /* minDischargePrice */ 0, /* consumptionMargin */ 1.0,
    /* pvKwhTomorrow */ 999, /* terminalPvKwhTomorrow */ 999,
    /* pvCloudFactor */ 1.0, /* refillConfidence */ 1.0,
    /* pvTimingRobust */ false, /* maxChargePrice */ 1.0,
  );
  const oracleSlots = engine._schedule?.slots ?? [];
  const oracleActionByMs = new Map(oracleSlots.map(s => [new Date(s.timestamp).getTime(), s]));

  // Map each oracle action → hwMode with per-slot context, then collapse to the sim vocabulary.
  const oracleHwOf = (s) => {
    const os = oracleActionByMs.get(s.bucket);
    if (!os) return 'standby';
    const futurePrices = daySlots
      .filter(d => d.bucket > s.bucket)
      .map(d => ({ price: d.price, pvW: d.pvW, consumptionW: d.consW }));
    const { hwMode } = mapAction.call(mapperThis, os.action, {
      price: s.price, exportPrice: s.exportPrice, soc: os.socProjected ?? s.socStart, pvW: s.pvW, consumptionW: s.consW,
      tariffType: 'dynamic', userPolicyMode: 'auto',
      maxChargePrice: 1.0, minDischargePrice: 0, minSoc: MIN_SOC, maxSoc: MAX_SOC,
      futurePrices, battChargePowerW: MAX_CHARGE_W, battCapKwh: CAPACITY_KWH,
      pvKwhTomorrow: 999, refillConfidence: 1,
    });
    return collapseHw(hwMode);
  };

  const baseline = scoreSequence(daySlots, s => baselineHw(s.pvW, s.consW));
  const oracle   = scoreSequence(daySlots, oracleHwOf);
  const realized = scoreSequence(daySlots, s => s.hwMode);

  // Realized measured € — ground-truth anchor from the actual SoC deltas (not simulated).
  let rmRev = 0, rmCost = 0;
  for (const s of daySlots) { const r = scoreSocDelta(s.dSocMeasured, s.price); rmRev += r.revenue; rmCost += r.cost; }
  const realizedMeas = rmRev - rmCost;

  tBaseline += baseline.profit; tRealized += realized.profit; tOracle += oracle.profit; tRealizedMeas += realizedMeas;
  dayRows.push({
    day, n: daySlots.length,
    baseline: baseline.profit, realized: realized.profit, oracle: oracle.profit, realizedMeas,
    dpValue: realized.profit - baseline.profit, regret: oracle.profit - realized.profit,
  });

  // Per-slot decision differences: oracle mode ≠ realized mode, with the € each side booked.
  for (let i = 0; i < daySlots.length; i++) {
    const s = daySlots[i];
    const oHw = oracle.socPath[i].hw;
    const rHw = collapseHw(s.hwMode);
    if (oHw === rHw) continue;
    const oD = oracle.socPath[i].socAfter - oracle.socPath[i].socBefore;
    const rD = realized.socPath[i].socAfter - realized.socPath[i].socBefore;
    const oS = scoreSocDelta(oD, s.price); const rS = scoreSocDelta(rD, s.price);
    slotDiffs.push({
      bucket: s.bucket, oHw, rHw, price: s.price, pv: Math.round(s.pvW), cons: Math.round(s.consW),
      eur: (oS.revenue - oS.cost) - (rS.revenue - rS.cost),  // oracle − realized € this slot
    });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────
console.log(`\nDP regret — RTE=${RTE}, pv=${PV_MODE}, consumption=${CONS_MODE}, days=${dayRows.length}`);
console.log('(all three scored through the shared simulator; realizedMeas = measured-SoC anchor)\n');
console.log('day          n   baseline€   realized€   oracle€   DPvalue€   regret€   (measAnchor€)');
for (const r of dayRows) {
  const f = (x) => x.toFixed(3).padStart(9);
  console.log(
    `${r.day}  ${String(r.n).padStart(3)}  ${f(r.baseline)}  ${f(r.realized)}  ${f(r.oracle)}  ` +
    `${f(r.dpValue)}  ${f(r.regret)}   ${r.realizedMeas.toFixed(3).padStart(8)}`
  );
}
console.log('  ─────────────────────────────────────────────────────────────────────────────');
const tf = (x) => x.toFixed(3).padStart(9);
console.log(
  `TOTAL          ${tf(tBaseline)}  ${tf(tRealized)}  ${tf(tOracle)}  ` +
  `${tf(tRealized - tBaseline)}  ${tf(tOracle - tRealized)}   ${tRealizedMeas.toFixed(3).padStart(8)}`
);

// Sanity invariant: oracle is the perfect-foresight best, so it must dominate BOTH references.
// (baseline ≤ realized is NOT an invariant — the DP underperforming naive is a finding, below.)
// A violation here means oracle is not actually optimal: a relaxed hedge or a wrong param.
const oracleDominates = tOracle + 1e-9 >= tRealized && tOracle + 1e-9 >= tBaseline
  && dayRows.every(r => r.oracle + 1e-9 >= r.realized && r.oracle + 1e-9 >= r.baseline);
console.log(`\noracle dominates (oracle ≥ realized AND ≥ baseline, every day): ${oracleDominates ? 'OK' : '⚠️  VIOLATED — oracle not optimal, a hedge/param is off'}`);
console.log(`model gap (realized sim − measured anchor): €${(tRealized - tRealizedMeas).toFixed(3)}  (the ~21% calibration residual, not regret)`);

// Headline finding: days where the DP earned LESS than naive self-consume (DPvalue < 0).
const worse = dayRows.filter(r => r.dpValue < -0.005).sort((a, b) => a.dpValue - b.dpValue);
if (worse.length) {
  console.log(`\n⚠️  DP UNDERPERFORMED naive self-consume on ${worse.length}/${dayRows.length} days:`);
  for (const r of worse) console.log(`   ${r.day}  DP €${r.realized.toFixed(3)} vs naive €${r.baseline.toFixed(3)}  (lost €${(-r.dpValue).toFixed(3)})`);
}

console.log('\ntop 15 decision differences by |€| (oracle mode ≠ realized mode):');
slotDiffs.sort((a, b) => Math.abs(b.eur) - Math.abs(a.eur));
console.log('ts                 realized→oracle                  price     pv   cons     Δ€');
for (const d of slotDiffs.slice(0, 15)) {
  const when = new Date(d.bucket).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
  console.log(
    `${when}  ${(d.rHw + '→' + d.oHw).padEnd(30)} ${d.price.toFixed(3).padStart(6)}  ` +
    `${String(d.pv).padStart(5)}  ${String(d.cons).padStart(5)}  ${d.eur.toFixed(4).padStart(8)}`
  );
}
console.log();
