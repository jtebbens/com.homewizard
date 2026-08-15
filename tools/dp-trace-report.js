#!/usr/bin/env node
/**
 * Read the DP decision trace (/userdata/dp-trace-YYYY-MM-DD.jsonl) and say in plain terms what the
 * planner did that day. Without this the trace is a file nobody opens: every question needed a
 * throwaway one-liner, which is how earlier measurement series quietly died.
 *
 * Usage:
 *   node tools/dp-trace-report.js                 # today (Amsterdam)
 *   node tools/dp-trace-report.js 2026-08-15      # one day, with the per-run table
 *   node tools/dp-trace-report.js --days 7        # one summary line per day
 *
 * Read-only: it fetches over the local API and never writes to the device.
 */
const { getUserdata } = require('./homey-local');

const ACTION = { P: 'preserve', C: 'charge', D: 'discharge', S: 'standby', T: 'trickle' };
const V0_KEY = { P: 'pre', C: 'chg', D: 'dis', S: 'stb' };

const dayFmt  = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' });
const timeFmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function analyse(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push((Date.parse(rows[i].ts) - Date.parse(rows[i - 1].ts)) / 60000);

  const diverged = [];
  for (const r of rows) {
    const finalChar = r.act?.[0];
    const picked = r.v0?.act;
    if (!finalChar || !picked || ACTION[finalChar] === picked) continue;
    // What the backward pass thought the two options were worth. Missing when the final label came
    // from a pass with no t=0 value of its own (trickle), so the gap is reported only when known.
    const vPicked = r.v0[V0_KEY[picked[0].toUpperCase()]] ?? null;
    const vFinal  = V0_KEY[finalChar] ? r.v0[V0_KEY[finalChar]] : null;
    diverged.push({ r, from: picked, to: ACTION[finalChar] ?? finalChar, gap: (vPicked != null && vFinal != null) ? vPicked - vFinal : null });
  }

  const floored = rows.filter((r) => r.conf != null && r.conf < 1);
  const boundShare = floored.map((r) => r.floor.filter((x) => x > 0).length / r.n);

  return {
    runs: rows.length,
    first: rows.length ? timeFmt.format(new Date(rows[0].ts)) : null,
    last: rows.length ? timeFmt.format(new Date(rows[rows.length - 1].ts)) : null,
    medGapMin: gaps.length ? Math.round(median(gaps)) : null,
    socMin: Math.min(...rows.map((r) => r.soc)),
    socMax: Math.max(...rows.map((r) => r.soc)),
    diverged,
    medDivGap: median(diverged.map((d) => d.gap).filter((g) => g != null)),
    flooredRuns: floored.length,
    medFloorPct: median(floored.map((r) => Math.max(...r.floor))),
    medBoundShare: median(boundShare),
    bytes: rows.reduce((s, r) => s + JSON.stringify(r).length, 0),
  };
}

function summaryLine(day, a) {
  if (!a.runs) return `${day}  no runs`;
  const div = a.diverged.length
    ? `${a.diverged.length} flipped after the DP${a.medDivGap != null ? ` (median €${a.medDivGap.toFixed(4)} at stake)` : ''}`
    : 'none flipped after the DP';
  const floor = a.flooredRuns
    ? `floor active in ${a.flooredRuns}, median ${a.medFloorPct}% binding ${Math.round(a.medBoundShare * 100)}% of the horizon`
    : 'floor never active';
  return `${day}  ${a.runs} DP runs (${a.first}-${a.last}, every ~${a.medGapMin ?? '?'} min) | SoC ${a.socMin}-${a.socMax}% | ${div} | ${floor} | ${(a.bytes / 1024).toFixed(0)} kB`;
}

async function loadDay(day) {
  const rows = await getUserdata(`dp-trace-${day}.jsonl`);
  return Array.isArray(rows) ? rows : [];
}

async function detail(day, rows) {
  const a = analyse(rows);
  console.log(summaryLine(day, a));
  if (!rows.length) return;

  // Join to mode-history so each decision sits next to what the battery actually did that quarter.
  const mh = (await getUserdata(`mode-history-${day}.json`)) || [];
  const bucket = (ts) => Math.round(new Date(ts).getTime() / 900000) * 900000;
  const byBucket = new Map(mh.map((h) => [bucket(h.ts), h]));

  console.log('\ntime   SoC  DP pick    ended as   conf  floor  applied mode');
  for (const r of rows) {
    const h = byBucket.get(bucket(r.ts));
    const fMax = Math.max(...r.floor);
    console.log([
      timeFmt.format(new Date(r.ts)).padEnd(6),
      `${String(r.soc).padStart(3)}%`,
      (r.v0.act ?? '?').padEnd(10),
      (ACTION[r.act[0]] ?? r.act[0]).padEnd(10),
      String(r.conf ?? '?').padEnd(5),
      `${String(fMax).padStart(4)}%`,
      h ? `${h.hwMode} (dp=${h.dpAction})` : '— no mode-history bucket',
    ].join(' '));
  }

  if (a.diverged.length) {
    console.log(`\n${a.diverged.length}/${a.runs} runs ended on a different action than the DP picked at t=0:`);
    for (const d of a.diverged.slice(0, 10)) {
      console.log(`  ${timeFmt.format(new Date(d.r.ts))}  ${d.from} → ${d.to}${d.gap != null ? `  (€${d.gap.toFixed(4)} of horizon value)` : ''}`);
    }
    console.log('  A post-DP pass (reorder/island/topup/trickle) relabelled slot 0. Which one is not in the trace.');
  }
}

(async () => {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf('--days');

  if (daysIdx >= 0) {
    const n = Number(args[daysIdx + 1] || 7);
    const today = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const day = dayFmt.format(new Date(today.getTime() - i * 86400000));
      console.log(summaryLine(day, analyse(await loadDay(day))));
    }
    return;
  }

  const day = args[0] || dayFmt.format(new Date());
  await detail(day, await loadDay(day));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
