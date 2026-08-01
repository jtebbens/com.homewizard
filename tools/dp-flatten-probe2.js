'use strict';
/**
 * DP flatten-probe v2 — faithful replay with FORWARD day-ahead prices from the ENTSOE spot file.
 *
 * v1 truncated the price window at "now" (history.json only holds realized slots), so the evening
 * peak was invisible and vCharge==vPreserve collapsed to indifference. v2 splices the full forward
 * consumer-price series (spot*1.21 + 0.1331, fit RMSE 0.0000 against realized) so the DP sees
 * tonight's peak and D+1, and passes the LIVE scalars pulled from policy_last_run_debug
 * (dynamicMaxChargePrice=0.222, pvKwhTomorrow=6.4).
 *
 * Usage: node tools/dp-flatten-probe2.js <history.json> <spot.json> <Ams-datetime>[,...] \
 *          [--soc N] [--mcp 0.222] [--pvkwh-tomorrow 6.4]
 */
const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');

const CAP = 2.69, MAXW = 800, RTE = 0.72;
const A = 1.21, B = 0.1331; // consumer-price transform fit

const args = process.argv.slice(2);
const [historyPath, spotPath, slotArg] = args;
const wantSlots = (slotArg || '').split(',').filter(Boolean);
function numArg(f, d) { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; }
const SOC_OVERRIDE = numArg('--soc', null);
const MCP = numArg('--mcp', 0.222);
const PVKWH_TOM = numArg('--pvkwh-tomorrow', 6.4);
const MDP = numArg('--mdp', 0.22);

if (!historyPath || !spotPath || !wantSlots.length) {
  console.error('usage: node tools/dp-flatten-probe2.js <history.json> <spot.json> <Ams-dt>[,...] [--soc N] [--mcp x] [--pvkwh-tomorrow x]');
  process.exit(1);
}

const spot = JSON.parse(fs.readFileSync(spotPath, 'utf8')).data
  .map(x => ({ ms: new Date(x.time).getTime(), price: +(A * (x.price / 1000) + B).toFixed(4) }))
  .sort((a, b) => a.ms - b.ms);

const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const histByMs = new Map(Object.values(hist)
  .filter(e => e.pvW != null)
  .map(e => [Math.round(new Date(e.ts).getTime() / 900000) * 900000, e]));

const amsToMs = (s) => {
  const [d, t] = s.split('T'); const [Y, Mo, D] = d.split('-').map(Number); const [H, Mi] = t.split(':').map(Number);
  return Date.UTC(Y, Mo - 1, D, H - 2, Mi); // CEST = UTC+2
};
const amsStr = ms => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

// solar proxy for future slots with no realized PV: crude bell, 0 outside 05-21 UTC
function pvProxy(ms) {
  const h = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60;
  if (h < 5 || h > 20) return 0;
  return Math.round(2500 * Math.max(0, Math.sin(Math.PI * (h - 5) / 15)));
}

const engine = new OptimizationEngine({ RTE, cycleCostPerKwh: 0.075, tariffModel: 'saldering' });
if (process.env.SHIFT === '1') engine.flattenPvShift = true;

for (const want of wantSlots) {
  const targetG = Math.round(amsToMs(want) / 900000) * 900000;
  const startIdx = spot.findIndex(s => s.ms >= targetG);
  if (startIdx < 0) { console.log(`\n${want}: past end of spot\n`); continue; }
  const window = spot.slice(startIdx); // forward through end of D+1

  const prices = window.map(s => ({ timestamp: new Date(s.ms).toISOString(), price: s.price }));
  const pvForecast = window.map(s => {
    const h = histByMs.get(s.ms);
    return { timestamp: new Date(s.ms).toISOString(), pvPowerW: h ? h.pvW : pvProxy(s.ms) };
  });
  const consumption = window.map(s => { const h = histByMs.get(s.ms); return h ? h.consumW : 400; });

  const startHist = histByMs.get(targetG);
  const socStart = SOC_OVERRIDE != null ? SOC_OVERRIDE : (startHist ? startHist.soc : 50);

  engine._schedule = null;
  engine.compute(
    prices, socStart, CAP, MAXW, MAXW, pvForecast, RTE, consumption,
    MDP, 1.0, PVKWH_TOM, PVKWH_TOM, 1.0, 1.0, false, MCP,
  );
  const fd = engine._flattenDebug || {};
  const s0 = engine._schedule?.slots?.[0];
  // peek: does the forward plan ever reach full / discharge into the evening peak?
  const sl = engine._schedule?.slots || [];
  const maxSocAhead = Math.max(...sl.map(x => x.socProjected ?? 0));
  const evPeak = window.find(s => s.price === Math.max(...window.slice(0, 40).map(w => w.price)));

  console.log(`\n═══ ${amsStr(targetG)} (Ams)  soc=${socStart}%  price=${window[0].price.toFixed(4)}  mcp=${MCP} pvKwhTom=${PVKWH_TOM}  windowSlots=${window.length}`);
  console.log(`    evening peak ahead: ${amsStr(evPeak.ms)} @${evPeak.price.toFixed(4)}`);
  console.log(`    flattenGateOpen=${fd.flattenGateOpen} flattenedRealSoc=${fd.flattenedRealSoc} pvKwhFromT1=${fd.pvKwhFromT1} kwhNeededNow=${fd.kwhNeededNow} floor0=${fd.reserveFloorPct0}%`);
  console.log(`    vPreserve=${fd.vPreserve} vCharge=${fd.vCharge} vDischarge=${fd.vDischarge} chosen=${fd.chosenAction} planAction0=${s0?.action} maxSocProjectedAhead=${maxSocAhead?.toFixed?.(1)}`);
}
console.log('');
