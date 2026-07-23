'use strict';
/**
 * DP hedge sweep — PHASE 2: is the DP's reserve (forecast-insurance under-discharge) too
 * conservative, or justified?
 *
 * Phase 1 (dp-regret.js) found the DP discharges ~20% less kWh than a perfect-foresight oracle,
 * regret €1.465/11d, dominated by slots where price ≥ the discharge floor (0.22) yet the DP held
 * charge anyway — i.e. reserve holding, driven by the pvKwhTomorrow headroom gate + refillConfidence
 * reserve floor. Those two levers are NOT logged in history, so an exact matched-hedge oracle is
 * impossible. Instead we SWEEP them: re-run the oracle across a grid from fully-relaxed
 * (pvKwhTomorrow=999, refillConfidence=1 → no reserve) to fully-defensive (0 → maximal reserve),
 * and find the hedge level at which the oracle's discharge VOLUME matches what actually ran.
 *
 *   If matching realized volume needs only a mild reserve (plausible given the real next-day
 *   forecast) → the DP's reserve was justified.
 *   If it needs an implausibly pessimistic hedge → the DP was too conservative (real regret).
 *
 * Price gates stay relaxed (minDischargePrice=0, maxChargePrice=1.0) so ONLY the reserve levers
 * move — Phase 1 showed the headline suppressed slots sit above the 0.22 floor, so the floor is
 * not the confound here.
 *
 * Usage: node tools/dp-hedge-sweep.js <history.json> [--pv avg|instant] [--consumption avg|instant]
 */

const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');
const { createSim } = require('./replay-sim');

const CAPACITY_KWH = 2.69, MAX_CHARGE_W = 800, MAX_DISCHARGE_W = 800;
const MIN_SOC = 0, MAX_SOC = 100, RTE = 0.72, SLOT_H = 0.25, CYCLE_COST_PER_KWH = 0.075;

const args = process.argv.slice(2);
const historyPath = args[0];
if (!historyPath) { console.error('usage: node tools/dp-hedge-sweep.js <history.json> [--pv avg|instant] [--consumption avg|instant]'); process.exit(1); }
const pvArg = args.indexOf('--pv'); const PV_MODE = pvArg >= 0 ? args[pvArg + 1] : 'avg';
const consArg = args.indexOf('--consumption'); const CONS_MODE = consArg >= 0 ? args[consArg + 1] : 'avg';

const { simulateSlot, scoreSocDelta } = createSim({
  rte: RTE, capacityKwh: CAPACITY_KWH, maxChargeW: MAX_CHARGE_W, maxDischargeW: MAX_DISCHARGE_W,
  minSoc: MIN_SOC, maxSoc: MAX_SOC, slotH: SLOT_H,
});
const engine = new OptimizationEngine({
  battery_efficiency: RTE, min_soc: MIN_SOC, max_soc: MAX_SOC,
  cycle_cost_per_kwh: CYCLE_COST_PER_KWH, tariff_model: 'saldering', export_price_ratio: 1.0,
});
const mapperThis = { settings: { tariff_model: 'saldering', export_price_ratio: 1.0 }, BATTERY_EFFICIENCY: RTE };
const mapAction = PolicyEngine.prototype._mapActionToHwModeForPlanning;

function collapseHw(hwMode) {
  switch (hwMode) {
    case 'zero_charge_only': case 'to_full': case 'zero_discharge_only': case 'standby': return hwMode;
    case 'pv_trickle': return 'zero_charge_only';
    default: return 'standby';
  }
}

// ── Load + pair (identical to dp-regret.js) ──────────────────────────────────────────────────
const raw = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const entries = Array.isArray(raw) ? raw : raw.value;
const BUCKET_MS = 15 * 60 * 1000;
const slots = [];
for (const e of entries) {
  if (e.exception != null) continue;
  if (e.price == null || e.battW == null || e.soc == null || e.pvW == null || e.consumW == null) continue;
  const bucket = Math.round(new Date(e.ts).getTime() / BUCKET_MS) * BUCKET_MS;
  slots.push({
    bucket, day: new Date(bucket).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }),
    hwMode: e.hwMode, price: e.price, pvW: e.pvW, pvAvgW: e.pvAvgW ?? null,
    consW: e.consumW, consumAvgW: e.consumAvgW ?? null, socMeasured: e.soc,
  });
}
slots.sort((a, b) => a.bucket - b.bucket);
const paired = [];
for (let i = 0; i < slots.length - 1; i++) {
  const cur = slots[i], nxt = slots[i + 1];
  if (nxt.bucket - cur.bucket !== BUCKET_MS) continue;
  paired.push({
    bucket: cur.bucket, day: cur.day, hwMode: cur.hwMode, price: cur.price,
    socStart: cur.socMeasured, socEnd: nxt.socMeasured, dSocMeasured: nxt.socMeasured - cur.socMeasured,
    pvW: PV_MODE === 'avg' ? (nxt.pvAvgW ?? cur.pvW) : cur.pvW,
    consW: CONS_MODE === 'avg' ? (nxt.consumAvgW ?? cur.consW) : cur.consW,
  });
}
const byDay = new Map();
for (const s of paired) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }

// Free-run a hwMode sequence; return €, discharge kWh (energy leaving pack), charge kWh.
function scoreSequence(daySlots, hwOf) {
  let soc = daySlots[0].socStart, rev = 0, cost = 0, dischKwh = 0, chgKwh = 0;
  const socPath = [];
  for (const s of daySlots) {
    const hw = hwOf(s);
    const { nextSoc } = simulateSlot(hw, s.pvW, s.consW, soc);
    const { revenue, cost: c } = scoreSocDelta(nextSoc - soc, s.price);
    rev += revenue; cost += c;
    const dSoc = nextSoc - soc;
    if (dSoc < 0) dischKwh += (-dSoc) / 100 * CAPACITY_KWH;
    else chgKwh += dSoc / 100 * CAPACITY_KWH;
    socPath.push({ hw, socBefore: soc, socAfter: nextSoc });
    soc = nextSoc;
  }
  return { profit: rev - cost, dischKwh, chgKwh, socPath, endSoc: soc };
}

// Run the oracle for one (pvKwhTomorrow, refillConfidence, minDischargePrice, maxChargePrice) setting.
function runOracle(pvKwhTmrw, refillConf, mdp = 0, mcp = 1.0) {
  let tProfit = 0, tDisch = 0, tChg = 0;
  for (const [, daySlots] of [...byDay.entries()].sort()) {
    const socStart = daySlots[0].socStart;
    const prices = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), price: s.price }));
    const pvForecast = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), pvPowerW: s.pvW }));
    const consumptionWPerSlot = daySlots.map(s => s.consW);
    engine._schedule = null;
    engine.compute(
      prices, socStart, CAPACITY_KWH, MAX_CHARGE_W, MAX_DISCHARGE_W, pvForecast,
      RTE, consumptionWPerSlot,
      /* minDischargePrice */ mdp, /* consumptionMargin */ 1.0,
      /* pvKwhTomorrow */ pvKwhTmrw, /* terminalPvKwhTomorrow */ pvKwhTmrw,
      /* pvCloudFactor */ 1.0, /* refillConfidence */ refillConf,
      /* pvTimingRobust */ false, /* maxChargePrice */ mcp,
    );
    const oracleSlots = engine._schedule?.slots ?? [];
    const byMs = new Map(oracleSlots.map(s => [new Date(s.timestamp).getTime(), s]));
    const hwOf = (s) => {
      const os = byMs.get(s.bucket);
      if (!os) return 'standby';
      const futurePrices = daySlots.filter(d => d.bucket > s.bucket)
        .map(d => ({ price: d.price, pvW: d.pvW, consumptionW: d.consW }));
      const { hwMode } = mapAction.call(mapperThis, os.action, {
        price: s.price, soc: os.socProjected ?? s.socStart, pvW: s.pvW, consumptionW: s.consW,
        tariffType: 'dynamic', userPolicyMode: 'auto', minDischargePrice: mdp,
        minSoc: MIN_SOC, maxSoc: MAX_SOC, futurePrices, battChargePowerW: MAX_CHARGE_W,
        battCapKwh: CAPACITY_KWH, pvKwhTomorrow: pvKwhTmrw, refillConfidence: refillConf,
        maxChargePrice: mcp,
      });
      return collapseHw(hwMode);
    };
    const r = scoreSequence(daySlots, hwOf);
    tProfit += r.profit; tDisch += r.dischKwh; tChg += r.chgKwh;
  }
  return { profit: tProfit, dischKwh: tDisch, chgKwh: tChg };
}

// ── Anchors: realized (what actually ran) + measured discharge ────────────────────────────────
let realizedProfit = 0, realizedDisch = 0, realizedChg = 0, measDisch = 0;
for (const [, daySlots] of [...byDay.entries()].sort()) {
  const r = scoreSequence(daySlots, s => s.hwMode);
  realizedProfit += r.profit; realizedDisch += r.dischKwh; realizedChg += r.chgKwh;
  for (const s of daySlots) if (s.dSocMeasured < 0) measDisch += (-s.dSocMeasured) / 100 * CAPACITY_KWH;
}

console.log(`\nDP hedge sweep — RTE=${RTE}, pv=${PV_MODE}, consumption=${CONS_MODE}, days=${byDay.size}`);
console.log(`(price gates relaxed: minDischargePrice=0, maxChargePrice=1.0 — only reserve levers vary)\n`);
console.log(`REALIZED (DP as-ran):  €${realizedProfit.toFixed(3)}  discharge ${realizedDisch.toFixed(2)} kWh (sim)  ${measDisch.toFixed(2)} kWh (measured anchor)\n`);

// ── Sweep grid ────────────────────────────────────────────────────────────────────────────────
const pvGrid = [999, 8, 6, 4, 3, 2, 1, 0.5, 0];
const rcGrid = [1.0, 0.8, 0.6, 0.4, 0.2, 0.0];
console.log('oracle discharge kWh by (pvKwhTomorrow rows × refillConfidence cols):');
console.log('             rc=' + rcGrid.map(r => r.toFixed(1).padStart(7)).join(''));
const results = [];
for (const pv of pvGrid) {
  const row = [];
  for (const rc of rcGrid) {
    const o = runOracle(pv, rc);
    row.push(o.dischKwh);
    results.push({ pv, rc, ...o });
  }
  console.log(`pvKwh=${String(pv).padStart(4)}   ` + row.map(v => v.toFixed(2).padStart(7)).join(''));
}

console.log('\noracle €profit by (pvKwhTomorrow × refillConfidence):');
console.log('             rc=' + rcGrid.map(r => r.toFixed(1).padStart(7)).join(''));
for (const pv of pvGrid) {
  const row = results.filter(r => r.pv === pv);
  console.log(`pvKwh=${String(pv).padStart(4)}   ` + row.map(r => r.profit.toFixed(3).padStart(7)).join(''));
}

// Which grid cell's oracle discharge is closest to realized? That is the "as-conservative-as-the-DP" point.
results.sort((a, b) => Math.abs(a.dischKwh - realizedDisch) - Math.abs(b.dischKwh - realizedDisch));
const best = results[0];
console.log(`\nclosest match to realized discharge (${realizedDisch.toFixed(2)} kWh):`);
console.log(`  pvKwhTomorrow=${best.pv}, refillConfidence=${best.rc}  →  oracle discharge ${best.dischKwh.toFixed(2)} kWh, €${best.profit.toFixed(3)}`);
console.log(`  regret at that hedge: €${(best.profit - realizedProfit).toFixed(3)}  (residual = pure slot-selection, not reserve)`);
console.log(`  fully-relaxed regret: €${(results.find(r => r.pv === 999 && r.rc === 1.0).profit - realizedProfit).toFixed(3)}  (reserve + selection combined)\n`);

// ── Decomposition: isolate the minDischargePrice=0.22 floor from the reserve levers ──────────
// The real DP ran with minDischargePrice=0.22 (constant across the window). Re-run the oracle
// at that floor with reserve OFF to see how much of the discharge-volume gap is the price floor
// (a deliberate "don't discharge below €0.22" economic setting) vs the forecast-reserve hedges.
console.log('decomposition — peel the real economic gates (reserve OFF: pvKwh=999, rc=1.0):');
const cfgs = [
  ['relaxed (mdp=0,    mcp=1.0)', runOracle(999, 1.0, 0,    1.0)],
  ['+ floor (mdp=0.22, mcp=1.0)', runOracle(999, 1.0, 0.22, 1.0)],
  ['+ chgcap(mdp=0.22, mcp=0.12)', runOracle(999, 1.0, 0.22, 0.12)],
];
for (const [label, o] of cfgs) console.log(`  ${label.padEnd(30)} ${o.dischKwh.toFixed(2).padStart(6)} kWh  €${o.profit.toFixed(3).padStart(7)}`);
console.log(`  ${'realized (DP as-ran)'.padEnd(30)} ${realizedDisch.toFixed(2).padStart(6)} kWh  €${realizedProfit.toFixed(3).padStart(7)}`);
const relaxed = cfgs[0][1], gated = cfgs[2][1];
console.log(`  → real gates (floor+chgcap) close ${(relaxed.dischKwh - gated.dischKwh).toFixed(2)} kWh of the ${(relaxed.dischKwh - realizedDisch).toFixed(2)} kWh gap; ` +
  `residual ${(gated.dischKwh - realizedDisch).toFixed(2)} kWh = forecast-reserve + selection\n`);
