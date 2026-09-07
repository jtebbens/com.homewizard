/**
 * Replay the forced low-SoC grid top-up threshold (TOPUP_THRESH_G, optimization-engine.js:35)
 * at its live value 40 against alternative thresholds, straight off the [DP-INPUT-DUMP]
 * payloads on /userdata.
 *
 * WHY A PATCHED MODULE INSTEAD OF A SETTING: TOPUP_THRESH_G is a module-level const, not a
 * device setting — there is no flag to flip. This loads the ENGINE SOURCE twice and rewrites
 * only that one literal, so both runs share the same build and every other line of code. If the
 * literal is not found the tool aborts: a silent no-op replay that reports €0.000 for every dump
 * is exactly the flat-log trap this harness exists to avoid.
 *
 * WHAT THE THRESHOLD DOES (read before interpreting a number): at a slot that fires the top-up
 * predicate and a state below the threshold, the backward pass overrides vPreserve and vStandby
 * to vForcedCharge (:1763). vForcedCharge is formula-identical to vCharge (:1706), so the DP
 * cannot decline the charge there. The constraint therefore only CHANGES anything where charging
 * is unprofitable by the DP's own valuation — a Δ€ > 0 at a lower threshold means the DP's own
 * economics beat the constraint on these inputs, NOT that the DP's valuation is correct. The
 * insurance motive the threshold may have been born for (arriving empty on a forecast miss) is
 * outside what this measures.
 *
 * WHAT THIS SCORES: the DP's own plan, not the battery. The live runtime maps the plan through
 * _mapPolicyToHwMode and can land elsewhere on the same slot.
 *
 * Refusals carried over from tools/dp-replay-weakpvtie.js:
 *  - no window is scored without pricing the SoC left in the battery at the end of it
 *    (feedback_replay_must_price_residual_soc);
 *  - a dump where no in-window slot differs between the two plans is marked NO-SCOPE rather
 *    than reported as €0.000.
 * Shifting the window is the caller's job (--from/--until). Sign flips between windows → the
 * signal is under the noise and there is no verdict.
 *
 * Usage: node tools/dp-replay-topup.js <dumpdir> [--thresh 0,20] [--cycle x] [--eff x]
 *                                      [--model saldering|asymmetric_2027] [--ratio x]
 *                                      [--from ISO] [--until ISO]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
const MODEL = str('--model', 'saldering');
const RATIO = num('--ratio', 1.0);
const FROM = str('--from', null);
const UNTIL = str('--until', null);
const BASE_THRESH = 40;                // the live value; every Δ is variant − 40
const THRESHES = str('--thresh', '0,20').split(',').map(Number).filter(v => Number.isFinite(v));

if (!DIR || !fs.existsSync(DIR)) {
  console.error('give a directory holding dp-input-*.json dumps');
  process.exit(1);
}
if (MODEL !== 'saldering' && MODEL !== 'asymmetric_2027') {
  console.error('--model must be saldering or asymmetric_2027');
  process.exit(1);
}
if (!THRESHES.length) {
  console.error('--thresh needs at least one number (SoC percent)');
  process.exit(1);
}

// ── engine loading ───────────────────────────────────────────────────────────────────────────
// A fresh Module compiled from the patched source. filename/paths point at the real engine file
// so its own relative requires resolve exactly as in-app.
const ENG_PATH = require.resolve('../lib/optimization-engine');
const ENG_SRC = fs.readFileSync(ENG_PATH, 'utf8');
const NEEDLE = 'const TOPUP_THRESH_G = 40 * GRID;';
if (!ENG_SRC.includes(NEEDLE)) {
  console.error(`ABORT: literal "${NEEDLE}" not found in ${ENG_PATH}.`);
  console.error('The engine changed shape; patching would silently replay the same build twice.');
  process.exit(1);
}

const engineCache = new Map();
function engineFor(thresh) {
  if (engineCache.has(thresh)) return engineCache.get(thresh);
  const patched = ENG_SRC.replace(NEEDLE, `const TOPUP_THRESH_G = ${thresh} * GRID;`);
  const m = new Module(`${ENG_PATH}#topup${thresh}`, null);
  m.filename = ENG_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(ENG_PATH));
  m._compile(patched, ENG_PATH);
  engineCache.set(thresh, m.exports);
  return m.exports;
}
const UnpatchedEngine = require('../lib/optimization-engine');

function run(dump, Engine) {
  const eng = new Engine({
    battery_efficiency: EFF,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: MODEL,
    export_price_ratio: RATIO,
    min_soc: 0,
    max_soc: 100,
  });
  eng.compute(
    dump.prices, dump.soc, dump.capacityKwh, dump.maxChargePowerW, dump.maxDischargePowerW,
    dump.pvForecast, dump.learnedRte, dump.consumptionWPerSlot,
    dump.minDischargePrice, dump.consumptionMargin, dump.effectivePvKwhTomorrow,
    dump.adjustedTerminalPvKwh, dump.pvCloudFactor, dump.refillConfidence, false,
    dump.maxChargePrice,
  );
  return eng;
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────
// € from physical actionKwh, wear split 0.5 per side — same accounting as
// tools/dp-replay-weakpvtie.js so the harnesses stay comparable.
//
// The top-up slot is the term that harness did not need: a forced top-up keeps action 'preserve'
// and carries actionKwh (optimization-engine.js:805), so an action-label test books it as free.
// It is a grid charge and is priced as one here — without this term the constraint under test
// would cost exactly €0 while its energy still lands in end-SoC, crediting the forced run with
// free stock. See feedback_score_energy_from_soc_path_not_labels.
function score(slots, rte, fromMs, untilMs, eng, priceSlots, slotH, capacityKwh) {
  let eur = 0, chKwh = 0, disKwh = 0, topupKwh = 0, expKwh = 0, storedKwh = 0, n = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const ts = Date.parse(s.timestamp);
    if (ts < fromMs || ts >= untilMs) continue;
    n++;

    const k = s.actionKwh || 0;
    if (k) {
      // Grid fraction only, same as optimization-engine.js:702.
      if (s.action === 'charge') { eur -= k * s.price * (1 - (s.pvCoverage ?? 0)) + 0.5 * CYCLE * k; chKwh += k; }
      else if (s.action === 'discharge') { eur += k * rte * s.price - 0.5 * CYCLE * k; disKwh += k; }
      else if (s.topupForced) { eur -= k * s.price * (1 - (s.pvCoverage ?? 0)) + 0.5 * CYCLE * k; topupKwh += k; }
    }

    // PV surplus this slot, split over what the plan's own SoC path shows entering the pack and
    // what therefore left the house. Read off socProjected rather than action labels, for the
    // reason named above.
    const surplusKwh = Math.max(0, (s.pvForecastW || 0) - (s.consumptionW || 0)) / 1000 * slotH;
    if (surplusKwh <= 0) continue;
    const next = slots[i + 1];
    const rise = (next && next.socProjected != null && s.socProjected != null)
      ? Math.max(0, (next.socProjected - s.socProjected) / 100 * capacityKwh) : 0;
    // A forced top-up raises SoC from the GRID in the same slot; that rise is not stored PV and
    // is already paid for above. Charge slots are excluded for the same reason.
    const gridRise = (s.action === 'charge' || s.topupForced) ? k : 0;
    const toBatt = Math.min(surplusKwh, Math.max(0, rise - gridRise));
    const toGrid = surplusKwh - toBatt;
    storedKwh += toBatt;
    expKwh += toGrid;
    eur -= 0.5 * CYCLE * toBatt;
    eur += toGrid * eng._exportValue(priceSlots[i]);
  }
  return { eur, chKwh, disKwh, topupKwh, expKwh, storedKwh, n };
}

// A € delta bought with leftover charge is not a € delta. Price the SoC still in the battery at
// the end of the scored window at what it can realistically fetch: the mean price over the
// window, derated by RTE and the discharge half of the cycle cost.
function residualEur(slots, dump, rte, fromMs, untilMs) {
  const inWin = slots.filter(s => {
    const ts = Date.parse(s.timestamp);
    return ts >= fromMs && ts < untilMs;
  });
  const last = inWin[inWin.length - 1];
  if (!last || last.socProjected == null) return { kwh: 0, eur: 0, socPct: null };
  const kwh = (last.socProjected / 100) * dump.capacityKwh;
  const priced = inWin.filter(s => s.price != null);
  const meanPrice = priced.reduce((a, s) => a + s.price, 0) / (priced.length || 1);
  return { kwh, eur: kwh * (rte * meanPrice - 0.5 * CYCLE), socPct: last.socProjected };
}

// Input coverage: how much of each array is real data rather than a flat default or a synthetic
// tail. A replay run on a flat consumption default has flipped sign before (2026-07-24/25).
// belowThresh is this constraint's own coverage question: a plan that never visits a state under
// the threshold cannot be moved by it, whatever the € column says.
function coverage(dump, slots) {
  const N = dump.prices.length;
  const cons = dump.consumptionWPerSlot || [];
  const pv = dump.pvForecast || [];
  return {
    priceReal: dump.prices.filter(p => Number.isFinite(p?.price)).length,
    priceN: N,
    consDistinct: new Set(cons.map(v => Math.round(v * 10))).size,
    consN: cons.length,
    pvReal: pv.filter(p => p && p.pvPowerW != null).length,
    pvN: pv.length,
    belowThresh: slots.filter(s => s.socProjected != null && s.socProjected < BASE_THRESH).length,
    topupSlots: slots.filter(s => s.topupForced).length,
  };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const files = fs.readdirSync(DIR).filter(f => f.startsWith('dp-input-') && f.endsWith('.json')).sort();
const ams = iso => new Date(iso).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

const rowsBy = new Map(THRESHES.map(t => [t, []]));
const covLines = [];
let ctrlMax = 0, ctrlChecked = 0;

for (const f of files) {
  const dump = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const rte = dump.learnedRte;

  const fromMs = FROM ? Date.parse(FROM) : -Infinity;
  const untilMs = UNTIL ? Date.parse(UNTIL) : Infinity;
  const slotH = dump.prices.length >= 2
    ? (Date.parse(dump.prices[1].timestamp) - Date.parse(dump.prices[0].timestamp)) / 3_600_000
    : 1;

  const base = run(dump, engineFor(BASE_THRESH));
  const sb = base._schedule?.slots || [];
  if (!sb.length) { console.log(`${f}: compute() produced no schedule — skipped`); continue; }
  const A = score(sb, rte, fromMs, untilMs, base, dump.prices, slotH, dump.capacityKwh);
  const RA = residualEur(sb, dump, rte, fromMs, untilMs);

  // Negative control: the patched module at the live value must equal the unpatched require.
  // Any drift here means the patch changed something other than the literal.
  const ctrl = run(dump, UnpatchedEngine);
  const sc = ctrl._schedule?.slots || [];
  if (sc.length) {
    const C = score(sc, rte, fromMs, untilMs, ctrl, dump.prices, slotH, dump.capacityKwh);
    ctrlMax = Math.max(ctrlMax, Math.abs(C.eur - A.eur));
    ctrlChecked++;
  }

  const c = coverage(dump, sb);
  covLines.push(`${ams(dump.at)}  prices ${c.priceReal}/${c.priceN}  cons ${c.consDistinct} distinct/${c.consN}`
    + `  pv ${c.pvReal}/${c.pvN}  slots<${BASE_THRESH}% ${c.belowThresh}  forced top-ups ${c.topupSlots}`);

  for (const th of THRESHES) {
    const v = run(dump, engineFor(th));
    const sv = v._schedule?.slots || [];
    if (!sv.length) continue;
    const B = score(sv, rte, fromMs, untilMs, v, dump.prices, slotH, dump.capacityKwh);
    const RB = residualEur(sv, dump, rte, fromMs, untilMs);

    // Decision scope, measured on the realised plans: the two runs differ in one literal, so any
    // slot whose action OR top-up flag differs IS the decision. A forced top-up keeps the
    // 'preserve' label, so an action-only test would miss precisely this constraint's slots.
    let nActDiff = 0;
    let firstT = null;
    for (let i = 0; i < Math.min(sb.length, sv.length); i++) {
      const ts = Date.parse(sb[i].timestamp);
      if (ts < fromMs || ts >= untilMs) continue;
      if (sb[i].action !== sv[i].action || !!sb[i].topupForced !== !!sv[i].topupForced) {
        nActDiff++;
        if (firstT === null) firstT = i;
      }
    }

    rowsBy.get(th).push({
      at: ams(dump.at),
      soc: dump.soc,
      win: A.n,
      slots: dump.prices.length,
      below: c.belowThresh,
      topA: c.topupSlots,
      topB: sv.filter(s => s.topupForced).length,
      firstT,
      inScope: nActDiff > 0,
      nActDiff,
      dEur: B.eur - A.eur,
      dTot: (B.eur + RB.eur) - (A.eur + RA.eur),
      dSocPct: (RB.socPct ?? 0) - (RA.socPct ?? 0),
      dTopupKwh: B.topupKwh - A.topupKwh,
      dDisKwh: B.disKwh - A.disKwh,
    });
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────
const winDesc = FROM || UNTIL ? `${FROM || 'start'} .. ${UNTIL || 'end of horizon'}` : 'full horizon';
console.log(`\ncycle=€${CYCLE}/kWh eff=${EFF} model=${MODEL}${MODEL === 'asymmetric_2027' ? ` ratio=${RATIO}` : ''}`
  + `  window: ${winDesc}`);
console.log(`negative control (patched@${BASE_THRESH} vs unpatched require): max |Δ€| ${ctrlMax.toFixed(6)} over ${ctrlChecked} dumps`
  + `${ctrlMax > 1e-9 ? '  ⚠️ NOT INERT — the patch changes more than the literal' : ''}`);
console.log(`Δ = TOPUP_THRESH_G at the variant − at the live ${BASE_THRESH}. dTot includes residual SoC`
  + ' priced at RTE×meanPrice − ½cycle.');
console.log('below = slots the LIVE plan spends under 40% SoC (the region the constraint can reach);');
console.log('top = forced top-up slots in the live plan → in the variant plan;');
console.log('actΔ = slots whose action or top-up flag differs; t0 = first such slot.');

for (const th of THRESHES) {
  const rows = rowsBy.get(th);
  console.log(`\n══ TOPUP_THRESH_G = ${th}%  (live ${BASE_THRESH}%) ══`);
  console.log('run (Ams)      soc%  win/tot  below  top    t0  actΔ   Δ€ plan   Δ€ +resid   ΔendSoC%   Δtopup kWh   Δdis kWh   scope');
  for (const r of rows) {
    console.log(
      `${r.at}   ${String(r.soc).padStart(3)}   ${String(r.win).padStart(3)}/${String(r.slots).padEnd(3)}`
      + `  ${String(r.below).padStart(5)}  ${String(r.topA).padStart(2)}→${String(r.topB).padEnd(2)} ${String(r.firstT ?? '-').padStart(4)} ${String(r.nActDiff).padStart(5)}`
      + `   ${r.dEur.toFixed(4).padStart(8)}   ${r.dTot.toFixed(4).padStart(9)}`
      + `   ${r.dSocPct.toFixed(1).padStart(8)}   ${r.dTopupKwh.toFixed(3).padStart(10)}   ${r.dDisKwh.toFixed(3).padStart(8)}`
      + `   ${r.inScope ? 'ok' : 'NO-SCOPE'}`,
    );
  }

  const scoped = rows.filter(r => r.inScope);
  const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
  console.log(`n=${rows.length} dumps, ${scoped.length} with the decision inside the scored window`);
  if (!scoped.length) {
    const anyBelow = rows.some(r => r.below > 0);
    console.log('NO VERDICT: no dump changes an action inside the window. The measurement cannot move here —');
    console.log(anyBelow
      ? '  the plans do visit sub-40% states but the threshold changes nothing there; widen the window.'
      : '  no plan visits a sub-40% state at all; these dumps cannot test this constraint.');
  } else {
    const wins = scoped.filter(r => r.dTot > 1e-4).length;
    const loss = scoped.filter(r => r.dTot < -1e-4).length;
    console.log(`variant better ${wins}  worse ${loss}  tied ${scoped.length - wins - loss}`);
    console.log(`mean Δ€ plan  ${(sum(scoped, 'dEur') / scoped.length).toFixed(4)}`);
    console.log(`mean Δ€ +res  ${(sum(scoped, 'dTot') / scoped.length).toFixed(4)}`);
    console.log(`Δ forced top-up energy: ${sum(scoped, 'dTopupKwh').toFixed(3)} kWh over ${scoped.length} scoped runs`);
  }
}

console.log('\ninput coverage (real / total per array — a flat default counts as synthetic)');
for (const l of covLines) console.log('  ' + l);
console.log('\nShift the window (--from/--until) and rerun. Sign flips → signal under the noise, no verdict.');
