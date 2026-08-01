'use strict';
/**
 * Replay the 2026-07-24 14:00 Ams (12:00Z) decision with the flatten-arb gate OFF vs ON.
 * Faithful bits: real forward 15-min prices from the LXC ENTSOE mirror (consumer transform),
 * real ctor settings keys (battery_efficiency / cycle_cost_per_kwh / dp_flatten_arb_gate).
 * PV + consumption come from history.json REALIZED values (perfect foresight) unless a
 * forecast file is supplied — stated explicitly in the output, since flatten's condition
 * depends on pvKwhFromT.
 *
 * Usage: node replay0724.js [--soc N] [--mcp x] [--pvkwh-tomorrow x] [--rte x] [--res 15m|1h]
 */
const fs = require('fs');
const OptimizationEngine = require('/root/github/com.homewizard/lib/optimization-engine');

const args = process.argv.slice(2);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const str = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const SOC   = num('--soc', 58);
const MINSOC = num('--min-soc', 0);   // live 07-24 logged floor0=0%
const PVFILE = str('--pvfile', null); // { hourly: { "2026-07-24T12:00Z": W } } realized
const CONSFILE = str('--consfile', null); // { hourly: {...}, hodMean: { "0": W, ... } }
const MCP   = num('--mcp', 0.12);
const PVT   = num('--pvkwh-tomorrow', 6.4);
const RTE   = num('--rte', 0.733);
const CYCLE = num('--cycle', 0.075);
const CAP   = num('--cap', 2.688);
const MAXW  = num('--maxw', 800);
const MDP   = num('--mdp', 0);
const RES   = str('--res', '15m');
const SCORE_UNTIL = str('--score-until', null);
const AT    = str('--at', '2026-07-24T12:00:00Z');   // decision moment being replayed
// 'fc' = the pvFcW the live DP actually consumed (no foresight); 'realized' = pvW as measured.
// The flatten gate keys on pvKwhFromT1, so realized PV can open/close it differently than live.
const PVSRC = str('--pv-source', 'fc');
// Same distinction for consumption: consumFcW is what the live DP received, consumW is measured.
// pvCoverage subtracts consumption from PV, so this shifts pvKwhFromT1 as much as the PV source does.
const CONSSRC = str('--cons-source', 'fc');
const PRICEFILE = str('--prices', `${__dirname}/_data-prices-0724.json`);
const HISTFILE  = str('--history', '/root/github/com.homewizard/history.json');
const FROM  = Date.parse(AT);

// ── prices: spot €/MWh → consumer €/kWh
const A = 1.21, B = 0.1331;
const raw = JSON.parse(fs.readFileSync(PRICEFILE, 'utf8')).data
  .map(p => ({ ms: Date.parse(p.time), spot: p.price }))
  .filter(p => p.ms >= FROM).sort((a, b) => a.ms - b.ms);

let series;
if (RES === '1h') {
  const byHour = new Map();
  for (const p of raw) {
    const h = Math.floor(p.ms / 3600000) * 3600000;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(p.spot);
  }
  series = [...byHour.entries()].map(([ms, v]) => ({ ms, spot: v.reduce((a, b) => a + b, 0) / v.length }));
} else {
  series = raw;
}
const prices = series.map(p => ({ timestamp: new Date(p.ms).toISOString(), price: +(A * (p.spot / 1000) + B).toFixed(4) }));

// ── PV + consumption from history.json (realized). Keyed to the slot grid.
const histRaw = JSON.parse(fs.readFileSync(HISTFILE, 'utf8'));
const grid = RES === '1h' ? 3600000 : 900000;
const hist = new Map();
for (const e of Object.values(histRaw)) {
  if (!e || e.ts == null || e.pvW == null) continue;
  hist.set(Math.floor(Date.parse(e.ts) / grid) * grid, e);
}
// Realized hourly PV (W) keyed "YYYY-MM-DDTHH:00Z" — covers the past only. For the horizon
// tail (07-25 daylight, not yet realized) fall back to a sine profile scaled so the day total
// equals pvKwhTomorrow (the scalar the live DP actually received). Stated in the output.
const pvHourly = PVFILE ? (JSON.parse(fs.readFileSync(PVFILE, 'utf8')).hourly || {}) : {};
const hourKey = ms => new Date(ms).toISOString().slice(0, 13) + ':00Z';
const TAIL_DAY = '2026-07-25';
function tailW(ms) {
  const d = new Date(ms);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (h < 5 || h > 20) return 0;
  return Math.max(0, Math.sin(Math.PI * (h - 5) / 15));
}
// scale factor so Σ tail kWh == PVT over the tail day
const tailSlots = series.filter(p => new Date(p.ms).toISOString().slice(0, 10) === TAIL_DAY && !(hourKey(p.ms) in pvHourly));
const slotH = grid / 3600000;
const tailShapeKwh = tailSlots.reduce((a, p) => a + tailW(p.ms) * slotH, 0);
const tailScale = tailShapeKwh > 0 ? PVT / tailShapeKwh : 0;

let pvHit = 0, consHit = 0, pvTail = 0;
const pvForecast = series.map(p => {
  const k = hourKey(p.ms);
  if (k in pvHourly) { pvHit++; return { timestamp: new Date(p.ms).toISOString(), pvPowerW: pvHourly[k] }; }
  const h = hist.get(Math.floor(p.ms / grid) * grid);
  const histW = h && (PVSRC === 'fc' ? h.pvFcW : h.pvW);
  if (histW != null) { pvHit++; return { timestamp: new Date(p.ms).toISOString(), pvPowerW: histW }; }
  const w = Math.round(tailW(p.ms) * tailScale * 1000);
  if (w > 0) pvTail++;
  return { timestamp: new Date(p.ms).toISOString(), pvPowerW: w };
});
// Consumption: history.json 15-min realized first (only covers up to 07-24T13:50Z), then the
// hourly reconstruction cons = pv + grid - batt from Insights (--consfile), then a per-hour-of-day
// mean over the last 7 days for the not-yet-realized tail. Flat 400W is the last resort.
const consFile = CONSFILE ? JSON.parse(fs.readFileSync(CONSFILE, 'utf8')) : { hourly: {}, hodMean: {} };
let consReal = 0, consHod = 0;
const consumptionW = series.map(p => {
  const h = hist.get(Math.floor(p.ms / grid) * grid);
  const histC = h && (CONSSRC === 'fc' ? h.consumFcW : h.consumW);
  if (histC != null) { consHit++; return histC; }
  const k = hourKey(p.ms);
  if (k in (consFile.hourly || {})) { consHit++; consReal++; return consFile.hourly[k]; }
  const hod = new Date(p.ms).getUTCHours();
  if (consFile.hodMean && consFile.hodMean[hod] != null) { consHod++; return consFile.hodMean[hod]; }
  return 400;
});

// ── run both gate states
function run(gateOn) {
  const eng = new OptimizationEngine({
    battery_efficiency: RTE,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
    min_soc: MINSOC,
    max_soc: 100,
    dp_flatten_arb_gate: gateOn,
  });
  eng.compute(prices, SOC, CAP, MAXW, MAXW, pvForecast, RTE, consumptionW,
    MDP, 1.0, PVT, PVT, 1.0, 1.0, false, MCP);
  return eng;
}

// € from physical actionKwh (NOT socProjected deltas — those jump non-physically at PV/horizon
// edges). Wear 0.5/side matches the DP objective (vCharge ~1144 / vDischarge ~1186).
function score(slots, untilMs = Infinity) {
  let eur = 0, chKwh = 0, disKwh = 0;
  for (const s of slots) {
    if (Date.parse(s.timestamp) >= untilMs) break;
    const k = s.actionKwh || 0;
    if (!k) continue;
    if (s.action === 'charge') { eur -= k * s.price + 0.5 * CYCLE * k; chKwh += k; }
    else if (s.action === 'discharge') { eur += k * RTE * s.price - 0.5 * CYCLE * k; disKwh += k; }
  }
  return { eur, chKwh, disKwh };
}

const off = run(false), on = run(true);
const so = off._schedule?.slots || [], sn = on._schedule?.slots || [];
const A1 = score(so), B1 = score(sn);

const ams = ms => new Date(ms).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);
console.log(`inputs: res=${RES} slots=${prices.length} soc=${SOC}% mcp=${MCP} pvKwhTom=${PVT} rte=${RTE} cycle=${CYCLE} cap=${CAP}kWh maxW=${MAXW}`);
console.log(`PV source: ${PVFILE ? 'insights-realized+history' : 'history only'} (${PVSRC === 'fc' ? 'pvFcW = forecast the live DP saw' : 'pvW = realized'}) — real slots ${pvHit}/${series.length}, sine-tail slots ${pvTail} scaled to ${PVT}kWh; cons ${CONSSRC === 'fc' ? 'consumFcW = forecast' : 'consumW = realized'} ${consHit}/${series.length} (of which ${consReal} hourly-reconstructed), hod-mean ${consHod}, flat-400W ${series.length - consHit - consHod}`);
console.log(`flattenDebug OFF: ${JSON.stringify(off._flattenDebug)}`);
console.log(`flattenDebug ON : ${JSON.stringify(on._flattenDebug)}`);
console.log(`\nplan slot0: OFF=${so[0]?.action} ON=${sn[0]?.action}`);
console.log(`charge kWh  OFF=${A1.chKwh.toFixed(3)}  ON=${B1.chKwh.toFixed(3)}`);
console.log(`dischg kWh  OFF=${A1.disKwh.toFixed(3)}  ON=${B1.disKwh.toFixed(3)}`);
console.log(`realized €  OFF=${A1.eur.toFixed(4)}  ON=${B1.eur.toFixed(4)}  Δ(ON−OFF)=${(B1.eur - A1.eur).toFixed(4)}`);
console.log(`end SoC%    OFF=${so[so.length - 1]?.socProjected?.toFixed(1)}  ON=${sn[sn.length - 1]?.socProjected?.toFixed(1)}`);
console.log(`terminalFactor OFF=${off._schedule?.terminalFactor} ON=${on._schedule?.terminalFactor}`);

// Same score restricted to the window where PV *and* consumption are realized (no sine tail,
// no hour-of-day means). Residual SoC at the boundary is reported so a € delta bought with
// leftover charge is visible instead of hidden.
if (SCORE_UNTIL) {
  const u = Date.parse(SCORE_UNTIL);
  const A2 = score(so, u), B2 = score(sn, u);
  const socAt = sl => { const s = sl.filter(x => Date.parse(x.timestamp) < u).pop(); return s?.socProjected?.toFixed(1); };
  console.log(`\n── realized-data window only (< ${SCORE_UNTIL}) ──`);
  console.log(`charge kWh  OFF=${A2.chKwh.toFixed(3)}  ON=${B2.chKwh.toFixed(3)}`);
  console.log(`dischg kWh  OFF=${A2.disKwh.toFixed(3)}  ON=${B2.disKwh.toFixed(3)}`);
  console.log(`realized €  OFF=${A2.eur.toFixed(4)}  ON=${B2.eur.toFixed(4)}  Δ(ON−OFF)=${(B2.eur - A2.eur).toFixed(4)}`);
  console.log(`SoC% at boundary  OFF=${socAt(so)}  ON=${socAt(sn)}`);
}

const diff = so.map((s, i) => (s.action !== sn[i]?.action)
  ? `${ams(Date.parse(s.timestamp))} €${s.price} ${s.action} → ${sn[i]?.action}` : null).filter(Boolean);
console.log(`\naction diffs (${diff.length}):`);
for (const d of diff.slice(0, 40)) console.log('  ' + d);
