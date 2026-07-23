'use strict';
/**
 * DP trace-day — PHASE 2 drill-down: per-slot SoC path, realized (DP as-ran) vs relaxed oracle.
 *
 * The aggregate hedge sweep (dp-hedge-sweep.js) ruled out the price floor, charge cap AND the
 * modeled reserve levers as the cause of the DP's ~6 kWh under-discharge, and located it as a
 * cheap "hold-through" (preserve evening SoC without grid-buying). This tool answers the question
 * the aggregate can't: on the heavy-regret days, does the held evening SoC get USED next morning
 * (justified reserve) or does it sit idle / bleed out cheaply (wasted conservatism)?
 *
 * For each requested day it prints, per 15-min slot: price, PV, consumption, and BOTH the realized
 * and relaxed-oracle hwMode + SoC-after, so divergence and its downstream fate are visible.
 *
 * Usage: node tools/dp-trace-day.js <history.json> <YYYY-MM-DD>[,YYYY-MM-DD...] [--pv avg|instant] [--consumption avg|instant]
 */

const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');
const { createSim } = require('./replay-sim');

const CAPACITY_KWH = 2.69, MAX_CHARGE_W = 800, MAX_DISCHARGE_W = 800;
const MIN_SOC = 0, MAX_SOC = 100, RTE = 0.72, SLOT_H = 0.25, CYCLE_COST_PER_KWH = 0.075;

const args = process.argv.slice(2);
const historyPath = args[0];
const wantDays = (args[1] || '').split(',').filter(Boolean);
if (!historyPath || !wantDays.length) {
  console.error('usage: node tools/dp-trace-day.js <history.json> <YYYY-MM-DD>[,...] [--pv avg|instant] [--consumption avg|instant]');
  process.exit(1);
}
const pvArg = args.indexOf('--pv'); const PV_MODE = pvArg >= 0 ? args[pvArg + 1] : 'avg';
const consArg = args.indexOf('--consumption'); const CONS_MODE = consArg >= 0 ? args[consArg + 1] : 'avg';
const numArg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
// Oracle reserve/gate knobs — default = relaxed (perfect-foresight upper bound). Set defensively
// to probe whether the engine can be made to reproduce the realized full-idle-through-peak hold.
const O_PVKWH = numArg('--pv-kwh-tomorrow', 999);
const O_RC    = numArg('--refill-confidence', 1.0);
const O_MDP   = numArg('--min-discharge-price', 0);
const O_MCP   = numArg('--max-charge-price', 1.0);

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
    socStart: cur.socMeasured, dSocMeasured: nxt.socMeasured - cur.socMeasured,
    pvW: PV_MODE === 'avg' ? (nxt.pvAvgW ?? cur.pvW) : cur.pvW,
    consW: CONS_MODE === 'avg' ? (nxt.consumAvgW ?? cur.consW) : cur.consW,
  });
}
const byDay = new Map();
for (const s of paired) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }

// Relaxed oracle hwMode-per-slot for one day (no reserve, gates open — the € upper bound).
function oracleHwSeq(daySlots) {
  const socStart = daySlots[0].socStart;
  const prices = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), price: s.price }));
  const pvForecast = daySlots.map(s => ({ timestamp: new Date(s.bucket).toISOString(), pvPowerW: s.pvW }));
  const consumptionWPerSlot = daySlots.map(s => s.consW);
  engine._schedule = null;
  engine.compute(
    prices, socStart, CAPACITY_KWH, MAX_CHARGE_W, MAX_DISCHARGE_W, pvForecast, RTE, consumptionWPerSlot,
    O_MDP, 1.0, O_PVKWH, O_PVKWH, 1.0, O_RC, false, O_MCP,
  );
  const byMs = new Map((engine._schedule?.slots ?? []).map(s => [new Date(s.timestamp).getTime(), s]));
  return (s) => {
    const os = byMs.get(s.bucket);
    if (!os) return 'standby';
    const futurePrices = daySlots.filter(d => d.bucket > s.bucket)
      .map(d => ({ price: d.price, pvW: d.pvW, consumptionW: d.consW }));
    const { hwMode } = mapAction.call(mapperThis, os.action, {
      price: s.price, soc: os.socProjected ?? s.socStart, pvW: s.pvW, consumptionW: s.consW,
      tariffType: 'dynamic', userPolicyMode: 'auto', minDischargePrice: O_MDP, maxChargePrice: O_MCP,
      minSoc: MIN_SOC, maxSoc: MAX_SOC, futurePrices, battChargePowerW: MAX_CHARGE_W,
      battCapKwh: CAPACITY_KWH, pvKwhTomorrow: O_PVKWH, refillConfidence: O_RC,
    });
    return collapseHw(hwMode);
  };
}

function runSeq(daySlots, hwOf) {
  let soc = daySlots[0].socStart; const path = [];
  for (const s of daySlots) {
    const hw = hwOf(s);
    const { nextSoc } = simulateSlot(hw, s.pvW, s.consW, soc);
    path.push({ hw, socAfter: nextSoc });
    soc = nextSoc;
  }
  return path;
}

const hhmm = (ms) => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(11, 16);
const shortHw = (h) => ({ zero_discharge_only: 'DISCH', zero_charge_only: 'chg', to_full: 'CHG!', standby: '·', preserve: '·' }[h] || h);

for (const day of wantDays) {
  const daySlots = byDay.get(day);
  if (!daySlots) { console.log(`\n${day}: no data\n`); continue; }
  const oHwOf = oracleHwSeq(daySlots);
  const rPath = runSeq(daySlots, s => s.hwMode);
  const oPath = runSeq(daySlots, oHwOf);
  console.log(`\n═══ ${day} ═══   (realized SoC uses measured ΔSoC; oracle SoC simulated)`);
  console.log('time   price    pv   cons   realized       oracle          Δ€slot  note');
  let cumReal = daySlots[0].socStart, dEurCum = 0;
  for (let i = 0; i < daySlots.length; i++) {
    const s = daySlots[i];
    const rHw = collapseHw(s.hwMode), oHw = oPath[i].hw;
    const rSocMeas = cumReal + s.dSocMeasured;  // measured realized SoC
    const oSoc = oPath[i].socAfter;
    // € this slot each side (via simulated ΔSoC for oracle, measured for realized)
    const rS = scoreSocDelta(s.dSocMeasured, s.price);
    const oD = oPath[i].socAfter - (i ? oPath[i - 1].socAfter : daySlots[0].socStart);
    const oS = scoreSocDelta(oD, s.price);
    const dEur = (oS.revenue - oS.cost) - (rS.revenue - rS.cost);
    dEurCum += dEur;
    const diverge = rHw !== oHw ? '  ⟵ diverge' : '';
    // Only print rows that matter: any divergence, or evening/overnight (17:00-08:00), or PV window edges.
    const hour = new Date(s.bucket).getHours();
    const interesting = rHw !== oHw || Math.abs(s.dSocMeasured) >= 2 || Math.abs(oD) >= 2;
    if (interesting) {
      console.log(
        `${hhmm(s.bucket)}  ${s.price.toFixed(3)}  ${String(Math.round(s.pvW)).padStart(4)}  ${String(Math.round(s.consW)).padStart(4)}   ` +
        `${shortHw(rHw).padEnd(6)}${String(Math.round(rSocMeas)).padStart(3)}%   ${shortHw(oHw).padEnd(6)}${String(Math.round(oSoc)).padStart(3)}%   ` +
        `${dEur >= 0 ? '+' : ''}${dEur.toFixed(3)}${diverge}`
      );
    }
    cumReal = rSocMeas;
  }
  console.log(`  day Δ€ (oracle−realized) = ${dEurCum >= 0 ? '+' : ''}${dEurCum.toFixed(3)}   ` +
    `end SoC realized ${Math.round(cumReal)}%  oracle ${Math.round(oPath[oPath.length - 1].socAfter)}%`);
}
console.log();
