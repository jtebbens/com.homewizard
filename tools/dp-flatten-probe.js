'use strict';
/**
 * DP flatten-probe — dump the value-function decision at a live slot.
 *
 * Question: on 07-24 the battery sat in preserve/standby at cheap slots (0.13-0.15) instead of
 * to_full charging toward 100% for the evening peak. This reconstructs compute()'s inputs from the
 * realized history (forward prices/PV/consumption used as the forward window) and reads
 * engine._flattenDebug — the DP's own vPreserve vs vCharge vs vDischarge at the caller's real SoC,
 * plus whether the per-SoC flatten gate was open.
 *
 * Usage: node tools/dp-flatten-probe.js <history.json> <YYYY-MM-DDTHH:MM (Ams)>[,...] [--pvkwh-tomorrow N]
 */
const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');

const CAP = 2.69, MAXW = 800, RTE = 0.72;

const args = process.argv.slice(2);
const historyPath = args[0];
const wantSlots = (args[1] || '').split(',').filter(Boolean);
function numArg(flag, def) { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : def; }
const PVKWH_TOM = numArg('--pvkwh-tomorrow', null); // null => derive from realized PV of the day

if (!historyPath || !wantSlots.length) {
  console.error('usage: node tools/dp-flatten-probe.js <history.json> <Ams-datetime>[,...] [--pvkwh-tomorrow N]');
  process.exit(1);
}

const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const rows = Object.values(hist)
  .filter(e => e.price != null && e.soc != null && e.pvW != null)
  .map(e => ({ ...e, ms: new Date(e.ts).getTime() }))
  .sort((a, b) => a.ms - b.ms);

// Ams local "YYYY-MM-DDTHH:MM" -> ms (find nearest realized slot within 8 min)
function amsToMs(s) {
  // interpret as Europe/Amsterdam wall time; CEST in July = UTC+2
  const [d, t] = s.split('T');
  const [Y, Mo, D] = d.split('-').map(Number);
  const [H, Mi] = t.split(':').map(Number);
  return Date.UTC(Y, Mo - 1, D, H - 2, Mi); // CEST offset
}
const amsStr = ms => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

const engine = new OptimizationEngine({ RTE, cycleCostPerKwh: 0.075, tariffModel: 'saldering' });

for (const want of wantSlots) {
  const targetMs = amsToMs(want);
  // decision slot = nearest realized row at/after target
  let startIdx = rows.findIndex(r => r.ms >= targetMs - 8 * 60000);
  if (startIdx < 0) { console.log(`\n${want}: no data\n`); continue; }
  const start = rows[startIdx];
  const window = rows.slice(startIdx); // forward from decision slot to end of history

  const prices = window.map(r => ({ timestamp: new Date(r.ms).toISOString(), price: r.price }));
  const pvForecast = window.map(r => ({ timestamp: new Date(r.ms).toISOString(), pvPowerW: r.pvW }));
  const consumption = window.map(r => r.consumW);
  const socStart = start.soc;
  const mcp = start.maxChargePrice ?? 0;
  const mdp = start.minDischargePrice ?? 0;

  // pvKwhTomorrow proxy: realized net-PV-surplus kWh over the rest of the window's daylight.
  let pvKwhTom = PVKWH_TOM;
  if (pvKwhTom == null) {
    let k = 0;
    for (const r of window) { const surplus = Math.max(0, r.pvW - r.consumW); k += (surplus / 1000) * 0.25; }
    pvKwhTom = +k.toFixed(2);
  }

  engine._schedule = null;
  engine.compute(
    prices, socStart, CAP, MAXW, MAXW, pvForecast, RTE, consumption,
    mdp, 1.0, pvKwhTom, pvKwhTom, 1.0, 1.0, false, mcp,
  );
  const fd = engine._flattenDebug || {};
  const sched0 = engine._schedule?.slots?.[0];

  console.log(`\n═══ decision ${amsStr(start.ms)} (Ams)  soc=${socStart}%  price=${start.price.toFixed(4)}  mcp=${mcp} mdp=${mdp}`);
  console.log(`    liveHwMode=${start.hwMode}  liveDpAction=${start.dpAction}  windowSlots=${window.length}  pvKwhTom(proxy)=${pvKwhTom}`);
  console.log(`    flattenGateOpen=${fd.flattenGateOpen}  flattenedRealSoc=${fd.flattenedRealSoc}  pvKwhFromT1=${fd.pvKwhFromT1}  kwhNeededNow=${fd.kwhNeededNow}  reserveFloor0=${fd.reserveFloorPct0}%`);
  console.log(`    vPreserve=${fd.vPreserve}  vCharge=${fd.vCharge}  vDischarge=${fd.vDischarge}  chosen=${fd.chosenAction}  replayAction=${sched0?.action}`);
}
console.log('');
