/**
 * Replay the per-slot discharge-floor fix (`pv_floor_fix`) off vs on, straight off the
 * [DP-INPUT-DUMP] payloads on /userdata.
 *
 * Each dump carries the exact compute() input arrays of one live DP run, including BOTH floor
 * arrays since ee2c536: `minDischargePrice` (the old, whole-horizon-one-branch array the live DP
 * actually ran on) and `minDischargePriceNew` (the per-slot shadow array). Everything else is
 * held identical, so the only thing that moves between the two runs is the floor.
 *
 * Usage: node tools/dp-replay-floorfix.js <dumpdir> [--cycle x] [--eff x] [--until ISO]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OptimizationEngine = require('../lib/optimization-engine');

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
const UNTIL = str('--until', null);

if (!DIR || !fs.existsSync(DIR)) {
  console.error('give a directory holding dp-input-*.json dumps');
  process.exit(1);
}

function run(dump, floors) {
  const eng = new OptimizationEngine({
    battery_efficiency: EFF,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
    min_soc: 0,
    max_soc: 100,
  });
  eng.compute(
    dump.prices, dump.soc, dump.capacityKwh, dump.maxChargePowerW, dump.maxDischargePowerW,
    dump.pvForecast, dump.learnedRte, dump.consumptionWPerSlot,
    floors, dump.consumptionMargin, dump.effectivePvKwhTomorrow, dump.adjustedTerminalPvKwh,
    dump.pvCloudFactor, dump.refillConfidence, false, dump.maxChargePrice,
  );
  return eng;
}

// € from physical actionKwh, wear split 0.5 per side — same accounting as tools/dp-replay-0724.js
// so the two harnesses stay comparable. socProjected deltas are NOT used: they jump
// non-physically at PV and horizon edges.
function score(slots, rte, untilMs = Infinity) {
  let eur = 0, chKwh = 0, disKwh = 0;
  for (const s of slots) {
    if (Date.parse(s.timestamp) >= untilMs) break;
    const k = s.actionKwh || 0;
    if (!k) continue;
    if (s.action === 'charge') { eur -= k * s.price + 0.5 * CYCLE * k; chKwh += k; }
    else if (s.action === 'discharge') { eur += k * rte * s.price - 0.5 * CYCLE * k; disKwh += k; }
  }
  return { eur, chKwh, disKwh };
}

// A € delta bought with leftover charge is not a € delta. Price the SoC that is still in the
// battery at the end of the scored window at what it can realistically fetch: the mean price
// over the window, derated by RTE and the discharge half of the cycle cost.
function residualEur(slots, dump, rte, untilMs = Infinity) {
  const inWin = slots.filter(s => Date.parse(s.timestamp) < untilMs);
  const last = inWin[inWin.length - 1];
  if (!last || last.socProjected == null) return { kwh: 0, eur: 0, socPct: null };
  const kwh = (last.socProjected / 100) * dump.capacityKwh;
  const priced = inWin.filter(s => s.price != null);
  const meanPrice = priced.reduce((a, s) => a + s.price, 0) / (priced.length || 1);
  return { kwh, eur: kwh * (rte * meanPrice - 0.5 * CYCLE), socPct: last.socProjected };
}

const files = fs.readdirSync(DIR).filter(f => f.startsWith('dp-input-') && f.endsWith('.json')).sort();
const ams = iso => new Date(iso).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

const rows = [];
for (const f of files) {
  const dump = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (!Array.isArray(dump.minDischargePriceNew)) {
    console.log(`${f}: no minDischargePriceNew (dump predates ee2c536) — skipped`);
    continue;
  }
  const rte = dump.learnedRte;
  const off = run(dump, dump.minDischargePrice);
  const on = run(dump, dump.minDischargePriceNew);
  const so = off._schedule?.slots || [];
  const sn = on._schedule?.slots || [];
  const u = UNTIL ? Date.parse(UNTIL) : Infinity;

  const A = score(so, rte, u), B = score(sn, rte, u);
  const RA = residualEur(so, dump, rte, u), RB = residualEur(sn, dump, rte, u);
  const nDiff = dump.minDischargePrice
    .reduce((n, v, i) => n + (Math.abs(v - dump.minDischargePriceNew[i]) > 1e-6 ? 1 : 0), 0);

  rows.push({
    at: ams(dump.at),
    soc: dump.soc,
    slots: dump.prices.length,
    nDiff,
    dEur: B.eur - A.eur,
    dTot: (B.eur + RB.eur) - (A.eur + RA.eur),
    dSocPct: (RB.socPct ?? 0) - (RA.socPct ?? 0),
    dDis: B.disKwh - A.disKwh,
    dCh: B.chKwh - A.chKwh,
    act0: `${so[0]?.action || '-'}→${sn[0]?.action || '-'}`,
  });
}

console.log(`\ncycle=€${CYCLE}/kWh eff=${EFF} scored${UNTIL ? ` until ${UNTIL}` : ' over full horizon'}`);
console.log('Δ = NEW (per-slot floor) − OLD (live floor). dTot includes residual SoC priced at RTE×meanPrice − ½cycle.\n');
console.log('run (Ams)      soc%  slots  nDiff   Δ€ plan   Δ€ +resid   ΔendSoC%   Δdis kWh   Δch kWh   slot0');
for (const r of rows) {
  console.log(
    `${r.at}   ${String(r.soc).padStart(3)}   ${String(r.slots).padStart(4)}   ${String(r.nDiff).padStart(4)}`
    + `   ${r.dEur.toFixed(4).padStart(8)}   ${r.dTot.toFixed(4).padStart(9)}`
    + `   ${r.dSocPct.toFixed(1).padStart(8)}   ${r.dDis.toFixed(3).padStart(8)}   ${r.dCh.toFixed(3).padStart(7)}   ${r.act0}`,
  );
}

const sum = k => rows.reduce((a, r) => a + r[k], 0);
const wins = rows.filter(r => r.dTot > 1e-4).length;
const loss = rows.filter(r => r.dTot < -1e-4).length;
console.log(`\nn=${rows.length}  NEW better ${wins}  worse ${loss}  tied ${rows.length - wins - loss}`);
console.log(`mean Δ€ plan  ${(sum('dEur') / rows.length).toFixed(4)}`);
console.log(`mean Δ€ +res  ${(sum('dTot') / rows.length).toFixed(4)}`);
