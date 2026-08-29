/**
 * Voorspelde vrije-PV bijvulling versus de bijvulling die er werkelijk kwam.
 *
 * `pvKwhFromT` (optimization-engine.js:1250-1265) is de suffix-som van PV die de accu nog in
 * kan vanaf slot t. Meerdere poorten lezen dat getal als "dit vult vanzelf weer bij", en het
 * loopt over de HELE horizon — morgen-PV telt dus mee als bijvulling voor vandaag. Gemeten
 * 14-08: 7,07 kWh voorziene bijvulling tegen ~3,3 kWh werkelijk resterend PV
 * ([[project_pv_midday_two_deciders_pingpong]]).
 *
 * Dit is een MEETINSTRUMENT, geen fix: het vergelijkt een voorspelling met zijn eigen realisatie.
 * Geen €, geen restant-SoC-aanname, geen tarief — de dingen die de regret-meting onbruikbaar
 * maken op €0,03/dag spelen hier niet.
 *
 * Methode: de engine rekent BEIDE kanten uit, zodat er geen tweede kopie van de PV-formule
 * ontstaat. Voorspeld = compute() op de opgeslagen dump; realisatie = dezelfde compute() met
 * pvForecast en consumptionWPerSlot vervangen door de gemeten slotgemiddelden uit de
 * mode-history, pvCloudFactor 1.0 (die factor is een hedge op de voorspelling, geen fysica).
 * Beide runs worden afgekapt op de slots waarvoor gemeten data bestaat, anders vergelijk je
 * een volle horizon met een halve.
 *
 * Usage: node tools/dp-refill-realized.js <dumpdir> <history.json> [--min-cov 0.5]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OptimizationEngine = require('../lib/optimization-engine');

const argv = process.argv.slice(2);
const DIR = argv[0] || 'tools/_dpdumps';
const HIST = argv[1];
const num = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : dflt; };
const MIN_COV = num('--min-cov', 0.5);
if (!HIST) { console.error('usage: node tools/dp-refill-realized.js <dumpdir> <history.json>'); process.exit(1); }

// Live vlagstand van het toestel (zelfde set als tools/dp-familyB-count.js) — de meting moet de
// draaiende configuratie beschrijven. dp_gate_b_count armeert b1_pvKwhFromT0.
const FLAGS = {
  dp_flatten_pv_shift: true,
  dp_flatten_arb_gate: false,
  dp_charge_export_gate: true,
  dp_trickle_cap_saturation: false,
  dp_weak_pv_tie_standby: false,
  dp_charge_repay_gate: false,
  dp_gate_b_count: true,
};

const BUCKET_MS = 15 * 60 * 1000;

/** bucket(ms) → gemeten {pvW, consW} over het slot DAT DAAR BEGINT. */
function loadRealized(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(raw) ? raw : raw.value;
  const byBucket = new Map();
  for (const e of entries) {
    if (e.pvW == null || e.consumW == null) continue;
    const b = Math.round(new Date(e.ts).getTime() / BUCKET_MS) * BUCKET_MS;
    byBucket.set(b, e);
  }
  // pvAvgW/consumAvgW beschrijven het slot dat ÉÍNDIGT op hun eigen ts (device.js:2846-2865),
  // dus het slot dat op b begint leest het gemiddelde van de entry op b+15min. Zonder die
  // entry valt het terug op de momentopname van b zelf.
  const out = new Map();
  for (const [b, e] of byBucket) {
    const nxt = byBucket.get(b + BUCKET_MS);
    out.set(b, {
      pvW: nxt?.pvAvgW ?? e.pvW,
      consW: nxt?.consumAvgW ?? e.consumW,
    });
  }
  return out;
}

function runEngine(prices, pvForecast, consumption, dump, pvCloudFactor) {
  const eng = new OptimizationEngine({
    battery_efficiency: dump.learnedRte ?? 0.72,
    cycle_cost_per_kwh: 0.075,
    tariff_model: 'saldering',
    min_soc: 0, max_soc: 100,
    ...FLAGS,
  });
  eng.compute(
    prices, dump.soc, dump.capacityKwh, dump.maxChargePowerW, dump.maxDischargePowerW,
    pvForecast, dump.learnedRte, consumption,
    dump.minDischargePrice, dump.consumptionMargin, dump.effectivePvKwhTomorrow,
    dump.adjustedTerminalPvKwh, pvCloudFactor, dump.refillConfidence, false,
    dump.maxChargePrice,
  );
  return eng._gateB;
}

const realized = loadRealized(HIST);
const files = fs.readdirSync(DIR).filter(f => f.startsWith('dp-input-') && f.endsWith('.json')).sort();
const ams = iso => new Date(iso).toLocaleString('sv', { timeZone: 'Europe/Amsterdam' }).slice(5, 16);

const rows = [];
const skipped = [];
for (const f of files) {
  let dump;
  try { dump = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
  if (!Array.isArray(dump.prices) || !dump.prices.length) continue;

  // Afkappen op het aaneengesloten voorstuk waarvoor gemeten data bestaat. Een gat in het
  // midden stopt de horizon: verderop meten zou voorspelling en realisatie uit elkaar trekken.
  const buckets = dump.prices.map(p => Math.round(new Date(p.timestamp).getTime() / BUCKET_MS) * BUCKET_MS);
  let cov = 0;
  while (cov < buckets.length && realized.has(buckets[cov])) cov++;
  if (cov < 4 || cov / buckets.length < MIN_COV) { skipped.push({ f, cov, N: buckets.length }); continue; }

  const prices = dump.prices.slice(0, cov);
  const consPred = Array.isArray(dump.consumptionWPerSlot)
    ? dump.consumptionWPerSlot.slice(0, cov) : dump.consumptionWPerSlot;
  const pvPred = Array.isArray(dump.pvForecast)
    ? dump.pvForecast.filter(p => new Date(p.timestamp).getTime() < buckets[cov - 1] + BUCKET_MS)
    : dump.pvForecast;

  const pvReal = prices.map((p, t) => ({ timestamp: p.timestamp, pvPowerW: realized.get(buckets[t]).pvW }));
  const consReal = prices.map((p, t) => realized.get(buckets[t]).consW);

  const gPred = runEngine(prices, pvPred, consPred, dump, dump.pvCloudFactor);
  const gReal = runEngine(prices, pvReal, consReal, dump, 1.0);
  if (!gPred || !gReal) { console.error(`${f}: geen _gateB — engine niet geïnstrumenteerd`); process.exit(1); }

  rows.push({
    at: ams(dump.at), N: buckets.length, cov,
    pred: gPred.b1_pvKwhFromT0, real: gReal.b1_pvKwhFromT0,
    tomPart: gPred.b1_pvKwhTomorrowPart, cap: dump.capacityKwh,
  });
}

const p = (v, w) => String(v).padStart(w);
console.log(`\ndumps=${files.length} bruikbaar=${rows.length} overgeslagen=${skipped.length}`
  + ` (dekking < ${(MIN_COV * 100).toFixed(0)}% of < 4 slots)`);
console.log('pred/real = vrije-PV bijvulling over DEZELFDE afgekapte horizon, engine-formule.');
console.log('tomPart = deel van diezelfde voorspelling dat voorbij de dagrand (Ams) ligt.\n');
console.log('run (Ams)         N  dekking   pred   real   pred−real  ratio  tomPart  cap');
for (const r of rows) {
  const ratio = r.real > 0.05 ? (r.pred / r.real).toFixed(2) : '  ∞';
  console.log(`${r.at}  ${p(r.N, 3)}  ${p(`${r.cov}/${r.N}`, 7)}  ${p(r.pred.toFixed(2), 5)}  `
    + `${p(r.real.toFixed(2), 5)}  ${p((r.pred - r.real).toFixed(2), 9)}  ${p(ratio, 5)}  `
    + `${p(r.tomPart.toFixed(2), 7)}  ${p(r.cap.toFixed(2), 4)}`);
}

if (rows.length) {
  const diffs = rows.map(r => r.pred - r.real).sort((a, b) => a - b);
  const med = diffs[Math.floor(diffs.length / 2)];
  const over = rows.filter(r => r.pred > r.real).length;
  const overCap = rows.filter(r => r.pred - r.real > r.cap).length;
  console.log(`\nn=${rows.length} runs · mediaan pred−real ${med.toFixed(2)} kWh`
    + ` · overschat in ${over}/${rows.length} runs`
    + ` · overschatting > accucapaciteit in ${overCap}/${rows.length}`);
}
