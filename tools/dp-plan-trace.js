'use strict';
/**
 * DP plan-trace — dump the forward plan (action + socProjected + price) from a single compute() run,
 * to see whether the DP actually discharges the evening peak or leaves the battery idle.
 * Same faithful inputs as dp-flatten-probe2 (forward spot prices, live scalars).
 *
 * Usage: node tools/dp-plan-trace.js <history.json> <spot.json> <Ams-decision-dt> [--soc N] [--mcp x] [--pvkwh-tomorrow x]
 */
const fs = require('fs');
const OptimizationEngine = require('../lib/optimization-engine');
const CAP = 2.69, MAXW = 800, RTE = 0.72, A = 1.21, B = 0.1331;

const args = process.argv.slice(2);
const [historyPath, spotPath, decisionDt] = args;
function numArg(f, d) { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; }
const SOC = numArg('--soc', null), MCP = numArg('--mcp', 0.222), PVT = numArg('--pvkwh-tomorrow', 6.4), MDP = numArg('--mdp', 0.22);

const spot = JSON.parse(fs.readFileSync(spotPath, 'utf8')).data
  .map(x => ({ ms: new Date(x.time).getTime(), price: +(A * (x.price / 1000) + B).toFixed(4) })).sort((a, b) => a.ms - b.ms);
const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
const histByMs = new Map(Object.values(hist).filter(e => e.pvW != null)
  .map(e => [Math.round(new Date(e.ts).getTime() / 900000) * 900000, e]));

const amsToMs = (s) => { const [d, t] = s.split('T'); const [Y, Mo, D] = d.split('-').map(Number); const [H, Mi] = t.split(':').map(Number); return Date.UTC(Y, Mo - 1, D, H - 2, Mi); };
const amsStr = ms => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);
function pvProxy(ms) { const h = new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60; if (h < 5 || h > 20) return 0; return Math.round(2500 * Math.max(0, Math.sin(Math.PI * (h - 5) / 15))); }

const targetG = Math.round(amsToMs(decisionDt) / 900000) * 900000;
const startIdx = spot.findIndex(s => s.ms >= targetG);
const window = spot.slice(startIdx);
const prices = window.map(s => ({ timestamp: new Date(s.ms).toISOString(), price: s.price }));
const pvForecast = window.map(s => { const h = histByMs.get(s.ms); return { timestamp: new Date(s.ms).toISOString(), pvPowerW: h ? h.pvW : pvProxy(s.ms) }; });
const consumption = window.map(s => { const h = histByMs.get(s.ms); return h ? h.consumW : 400; });
const startHist = histByMs.get(targetG);
const socStart = SOC != null ? SOC : (startHist ? startHist.soc : 50);

const engine = new OptimizationEngine({ RTE, cycleCostPerKwh: 0.075, tariffModel: 'saldering' });
engine._schedule = null;
engine.compute(prices, socStart, CAP, MAXW, MAXW, pvForecast, RTE, consumption, MDP, 1.0, PVT, PVT, 1.0, 1.0, false, MCP);

const slots = engine._schedule?.slots || [];
console.log(`decision ${amsStr(targetG)} soc=${socStart}% mcp=${MCP} pvKwhTom=${PVT}  ${slots.length} plan slots`);
console.log('time(Ams)     price   action        socProj  pvFc  cons');
// print through end of D0 evening (up to 07-25 06:00 UTC)
for (const sl of slots) {
  const ms = new Date(sl.timestamp).getTime();
  if (ms > Date.UTC(2026, 6, 25, 6, 0)) break;
  const h = histByMs.get(Math.round(ms / 900000) * 900000);
  const pv = h ? h.pvW : pvProxy(ms);
  const cons = h ? h.consumW : 400;
  console.log(amsStr(ms).padEnd(12), (sl.price ?? 0).toFixed(4).padStart(6), String(sl.action).padEnd(13), String((sl.socProjected ?? 0).toFixed(1)).padStart(6), String(Math.round(pv)).padStart(5), String(Math.round(cons)).padStart(5));
}
