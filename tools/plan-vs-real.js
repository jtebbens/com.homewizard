#!/usr/bin/env node
'use strict';
//
// plan-vs-real — score the DP's own SoC promise against what the battery actually did.
//
// Both halves already persist on the Homey and nothing in the app reads them together:
//   promise    /userdata/dp-trace-<day>.jsonl     socP[] per run, full horizon, 23-day retention
//   realized   /userdata/mode-history-<day>.json  soc + consum/pv pairs per quarter, 23-day retention
//
// Fetch the two files first (they are not read off the device by this tool):
//   node tools/homey-local.js userdata dp-trace-2026-08-22.jsonl    com.homewizard > dp-trace-2026-08-22.jsonl
//   node tools/homey-local.js userdata mode-history-2026-08-22.json com.homewizard > mode-history-2026-08-22.json
//
// Usage:
//   node tools/plan-vs-real.js --day 2026-08-22 [--target 16:15] [--dir scratchpad/pvr]
//   node tools/plan-vs-real.js --days 7 [--dir scratchpad/pvr] [--csv out.csv]
//   node tools/plan-vs-real.js --day 2026-08-22 --dpt <path> --mh <path>
//
// MEASURE SCOPE vs DECISION SCOPE — read before quoting any number from this tool.
// It scores a PROMISE about SoC at a point in time, over the horizon each run could see.
// It says NOTHING about whether the DP's decision was economically right: a plan that promises
// less and earns more is better, and this tool would call it worse. Pair every verdict here
// with a euro scorer before acting on it.
//
const fs = require('fs');
const path = require('path');

const SLOT = 900000; // 15 min
const floor15 = ms => Math.floor(ms / SLOT) * SLOT;

// Cached formatters: an uncached Intl.DateTimeFormat in a hot loop has bitten this repo before.
const TZ = 'Europe/Amsterdam';
const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtClock = new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// The date is deliberately part of every stamp: a plan that only reaches 100% TOMORROW prints the
// same clock time as one reaching it today, and silently reads as success.
const fmtStamp = new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const amsDay = ms => fmtDay.format(new Date(ms));
const clock = ms => fmtClock.format(new Date(ms));
const stamp = ms => fmtStamp.format(new Date(ms));

function parseArgs(argv) {
  const out = { dir: 'scratchpad/pvr' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--day') out.day = argv[++i];
    else if (a === '--days') out.days = parseInt(argv[++i], 10);
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--dpt') out.dpt = argv[++i];
    else if (a === '--mh') out.mh = argv[++i];
    else if (a === '--csv') out.csv = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else { console.error(`unknown argument: ${a}`); process.exit(1); }
  }
  return out;
}

// homey-local.js returns the whole file as a parsed JSON array, even for .jsonl. Real newline-
// delimited JSON shows up when a file is copied off the device directly, so accept both.
function readRecords(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [parsed];
  } catch (_) {
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
}

function firstExisting(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function locate(day, opts) {
  return {
    dpt: opts.dpt || firstExisting([
      path.join(opts.dir, `dp-trace-${day}.jsonl`),
      path.join(opts.dir, `dp-trace-${day}.json`),
    ]),
    mh: opts.mh || firstExisting([
      path.join(opts.dir, `mode-history-${day}.json`),
      path.join(opts.dir, `${day}.json`),
    ]),
  };
}

// Build the ms of an Amsterdam wall-clock slot without hand-rolling DST maths: try both possible
// offsets and keep the one that formats back to the requested day and time.
function amsSlotMs(day, hhmm) {
  for (const off of ['+01:00', '+02:00']) {
    const ms = Date.parse(`${day}T${hhmm}:00${off}`);
    if (Number.isNaN(ms)) continue;
    if (amsDay(ms) === day && clock(ms) === hhmm) return floor15(ms);
  }
  return null;
}

// One entry per 15-min bucket. Timestamps do not land on an exact grid (899934 ms seen, not
// 900000), so bucket with floor15 — matching exactly threw away ~97% of the pairs once.
function bucketHistory(hist) {
  const byBucket = new Map();
  for (const r of hist) {
    const b = floor15(new Date(r.ts).getTime());
    const prev = byBucket.get(b);
    // A run reporting soc == null must never displace an earlier real reading for the same bucket.
    if (!prev || (prev.soc == null && r.soc != null)) byBucket.set(b, r);
  }
  return byBucket;
}

function kwh(sumW, n) { return (sumW * 0.25) / 1000 * (n ? 1 : 0); }

function summarize(day, runs, byBucket, targetMs) {
  const buckets = [...byBucket.entries()].filter(([b]) => amsDay(b) === day).sort((a, b) => a[0] - b[0]);

  const socN = buckets.filter(([, r]) => r.soc != null).length;
  const avgN = buckets.filter(([, r]) => r.consumAvgW != null).length;

  let maxSoc = null; let maxSocAt = null;
  for (const [b, r] of buckets) {
    if (r.soc != null && (maxSoc == null || r.soc > maxSoc)) { maxSoc = r.soc; maxSocAt = b; }
  }

  // Daylight window only: night slots pair 0 against 0 and would flatter every aggregate.
  let cFc = 0; let cAct = 0; let cN = 0; let cAliased = 0;
  let pFc = 0; let pAct = 0; let pN = 0;
  for (const [, r] of buckets) {
    const daylight = (r.pvFcW || 0) > 0 || (r.pvW || 0) > 0;
    if (!daylight) continue;
    const actual = r.consumAvgW != null ? r.consumAvgW : r.consumW;
    if (r.consumFcW != null && actual != null) {
      cFc += r.consumFcW; cAct += actual; cN++;
      if (r.consumAvgW == null) cAliased++;
    }
    const pvActual = r.pvAvgW != null ? r.pvAvgW : r.pvW;
    if (r.pvFcW != null && pvActual != null) { pFc += r.pvFcW; pAct += pvActual; pN++; }
  }

  const rows = [];
  let covered = 0;
  for (const run of runs) {
    const t0 = floor15(new Date(run.ts).getTime());
    const socP = run.socP || [];
    if (!socP.length) continue;

    let promised = null;
    if (targetMs != null) {
      const idx = (targetMs - t0) / SLOT;
      // Runs starting after the target get no index at all — skip them, never clamp to 0.
      if (!Number.isInteger(idx) || idx < 0 || idx >= socP.length) continue;
      promised = socP[idx];
      if (promised == null) continue;
    }
    covered++;

    // Best SoC this run still expected to reach TODAY (slots on the same Amsterdam day).
    let best = null; let bestAt = null;
    for (let k = 0; k < socP.length; k++) {
      const t = t0 + k * SLOT;
      if (amsDay(t) !== day) continue;
      if (socP[k] != null && (best == null || socP[k] > best)) { best = socP[k]; bestAt = t; }
    }
    rows.push({ t0, promised, best, bestAt });
  }

  return {
    day, rows, covered, runsTotal: runs.length, buckets: buckets.length, socN, avgN,
    maxSoc, maxSocAt,
    realizedAtTarget: targetMs != null ? (byBucket.get(targetMs) || {}).soc ?? null : null,
    cFc, cAct, cN, cAliased, pFc, pAct, pN,
  };
}

function report(s, targetMs, opts) {
  const L = [];
  L.push(`=== ${s.day} ===`);

  if (!s.runsTotal) {
    L.push('  geen dp-trace (bestaat pas vanaf 15-08) — beloftekant niet beschikbaar');
  } else if (targetMs != null) {
    const real = s.realizedAtTarget;
    L.push(`doel ${stamp(targetMs)} — realisatie ${real == null ? '-' : `${real}%`}` +
      `   [dekking: ${s.covered}/${s.runsTotal} runs bestrijken het doelslot]`);

    if (!opts.quiet) {
      L.push('  run           | belofte@doel | fout (pp) | plan-max vandaag');
      for (const r of s.rows) {
        const err = (r.promised != null && real != null) ? r.promised - real : null;
        L.push(`  ${stamp(r.t0)} | ${String(r.promised).padStart(11)}% | ` +
          `${err == null ? '     -' : (err > 0 ? '+' : '') + err}`.padEnd(12) +
          `| ${r.best == null ? '-' : `${r.best}% @ ${stamp(r.bestAt)}`}`);
      }
    }

    const hundreds = s.rows.filter(r => r.promised >= 100);
    if (hundreds.length) {
      const lastHundred = hundreds[hundreds.length - 1];
      const after = s.rows.find(r => r.t0 > lastHundred.t0);
      L.push(`  belofte 100%: ${hundreds.length} runs, ${stamp(hundreds[0].t0)} t/m ${stamp(lastHundred.t0)}` +
        (after ? ` — eerste omslag ${stamp(after.t0)} naar ${after.promised}%` : ' — geen omslag in de reeks'));
    } else {
      L.push('  belofte 100%: geen enkele run');
    }

    const errs = s.rows.filter(r => r.promised != null && real != null).map(r => r.promised - real);
    if (errs.length) {
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      // Signed on purpose: promising too little is as wrong as promising too much, and 22-08 did both.
      L.push(`  beloftefout (belofte − realisatie): gem ${mean > 0 ? '+' : ''}${mean.toFixed(1)} pp, ` +
        `min ${Math.min(...errs)} / max ${Math.max(...errs)} pp`);
    }
  } else {
    L.push(`plan-max vandaag vs realisatie   [dekking: ${s.covered}/${s.runsTotal} runs]`);
    if (!opts.quiet) {
      L.push('  run           | plan-max vandaag');
      for (const r of s.rows) L.push(`  ${stamp(r.t0)} | ${r.best == null ? '-' : `${r.best}% @ ${stamp(r.bestAt)}`}`);
    }
    const full = s.rows.filter(r => r.best >= 100);
    if (full.length) {
      const last = full[full.length - 1];
      const after = s.rows.find(r => r.t0 > last.t0 && r.best < 100);
      L.push(`  belofte 100% vandaag: ${full.length}/${s.rows.length} runs, ${stamp(full[0].t0)} t/m ${stamp(last.t0)}` +
        (after ? ` — eerste omslag ${stamp(after.t0)} naar ${after.best}%` : ' — nooit losgelaten'));
    } else {
      const best = s.rows.reduce((m, r) => (r.best != null && (m == null || r.best > m) ? r.best : m), null);
      L.push(`  belofte 100% vandaag: geen enkele run (hoogste plan-max ${best == null ? '-' : `${best}%`})`);
    }
    if (s.maxSoc != null) {
      // Signed against the realized max: a plan that promised less than it achieved is a miss too.
      const errs = s.rows.filter(r => r.best != null).map(r => r.best - s.maxSoc);
      if (errs.length) {
        const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
        L.push(`  plan-max − realisatie-max: gem ${mean > 0 ? '+' : ''}${mean.toFixed(1)} pp, ` +
          `min ${Math.min(...errs)} / max ${Math.max(...errs)} pp`);
      }
    }
  }

  L.push(`  realisatie max: ${s.maxSoc == null ? '-' : `${s.maxSoc}% @ ${stamp(s.maxSocAt)}`}` +
    `   [dekking: ${s.socN}/${s.buckets} kwartieren met SoC]`);

  if (s.cN) {
    const dW = (s.cAct - s.cFc) / s.cN;
    const dKwh = ((s.cAct - s.cFc) * 0.25) / 1000;
    L.push(`  verbruik daglicht: voorspeld ${Math.round(s.cFc / s.cN)} W, gemeten ${Math.round(s.cAct / s.cN)} W, ` +
      `Δ ${dW > 0 ? '+' : ''}${Math.round(dW)} W = ${dKwh > 0 ? '+' : ''}${dKwh.toFixed(2)} kWh` +
      `   [dekking: ${s.cN - s.cAliased}/${s.cN} op consumAvgW${s.cAliased ? `, ${s.cAliased} GEALIASD op consumW` : ''}]`);
  } else {
    L.push('  verbruik daglicht: geen paren');
  }
  if (s.pN) {
    const dKwh = ((s.pAct - s.pFc) * 0.25) / 1000;
    L.push(`  PV daglicht: voorspeld ${Math.round(s.pFc / s.pN)} W, gemeten ${Math.round(s.pAct / s.pN)} W, ` +
      `Δ ${dKwh > 0 ? '+' : ''}${dKwh.toFixed(2)} kWh   [dekking: ${s.pN} kwartieren]`);
  }
  return L.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let days = [];
  if (opts.day) {
    days = [opts.day];
  } else if (opts.days) {
    const today = floor15(Date.now());
    for (let i = opts.days - 1; i >= 0; i--) days.push(amsDay(today - i * 86400000));
  } else {
    console.error('usage: plan-vs-real.js --day YYYY-MM-DD [--target HH:MM] | --days N   [--dir <dir>]');
    process.exit(1);
  }

  const csv = [];
  for (const day of days) {
    const { dpt, mh } = locate(day, opts);
    if (!mh) { console.log(`=== ${day} ===\n  geen mode-history — overgeslagen`); continue; }
    // The dp-trace is optional: without it the promise half is unavailable, but the realized and
    // forecast-vs-measured halves come from mode-history alone and stay valid.
    const runs = dpt ? readRecords(dpt) : [];
    const byBucket = bucketHistory(readRecords(mh));

    let targetMs = null;
    if (opts.target) {
      targetMs = amsSlotMs(day, opts.target);
      if (targetMs == null) { console.error(`kan doeltijd ${opts.target} niet plaatsen op ${day}`); process.exit(1); }
    }

    const s = summarize(day, runs, byBucket, targetMs);
    console.log(report(s, targetMs, opts));
    csv.push([day, s.covered, s.runsTotal, s.maxSoc ?? '', s.socN, s.buckets,
      s.cN ? Math.round(s.cFc / s.cN) : '', s.cN ? Math.round(s.cAct / s.cN) : '', s.cN, s.cAliased,
      s.pN ? Math.round(s.pFc / s.pN) : '', s.pN ? Math.round(s.pAct / s.pN) : '', s.pN].join(','));
  }

  if (opts.csv) {
    const head = 'day,runsCovered,runsTotal,maxSoc,socN,buckets,consumFcW,consumActW,consumN,consumAliased,pvFcW,pvActW,pvN';
    fs.writeFileSync(opts.csv, `${head}\n${csv.join('\n')}\n`);
    console.log(`\ncsv → ${opts.csv}`);
  }
}

main();
