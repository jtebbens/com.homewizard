#!/usr/bin/env node
/**
 * Observe-gate for the unconditional trickle cap (commit e865177).
 *
 * The cap moves charging out of the morning into the cheap midday, so the battery is now
 * full around 17:00 instead of 13:00 — the plan leans on the 13:00-17:00 PV forecast. The
 * risk being watched: on a day where that midday PV disappoints, the battery enters the
 * evening peak under-filled.
 *
 * A day only counts as evidence when the plan actually INTENDED a full battery. If the
 * evening spread does not justify filling up, not-full is the correct decision, not a miss.
 * So the fail test is `planned >= 95% && actual < 95%`, never `actual < 95%` alone.
 *
 * Two shots, because the two numbers are not available at the same moment:
 *   plan   (~13:00 local) — the intent, read BEFORE the charge window. Later in the day
 *                           `policy_optimizer_schedule` has been rewritten by a run that
 *                           already knows how the PV turned out.
 *   close  (~23:00 local) — realized PV (every hour bucket complete) and the SoC the
 *                           battery actually had at the peak slot.
 *
 * Install:
 *   crontab -l 2>/dev/null | { cat; \
 *     echo "5 13 * * * /root/github/com.homewizard/tools/trickle-cap-gate.js plan  >> /root/logs/trickle-cap-gate.log 2>&1"; \
 *     echo "5 23 * * * /root/github/com.homewizard/tools/trickle-cap-gate.js close >> /root/logs/trickle-cap-gate.log 2>&1"; \
 *   } | crontab -
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getAppSetting, getInsightsEntries } = require('./homey-local');

const TZ = 'Europe/Amsterdam';
const SOC_LOG_ID = 'homey:device:08e18fb1-bc61-49d3-94b4-bcedb3ff7d6d:battery_group_average_soc';
const HOMEY_LOG = process.env.HOMEY_LOG || '/tmp/homey.log';
const OUT_DIR = process.env.GATE_DIR || '/root/logs';
const CSV = path.join(OUT_DIR, 'trickle-cap-gate.csv');
const PENDING = path.join(OUT_DIR, 'trickle-cap-gate-pending.json');

// SoC the plan has to reach for the evening peak to be "covered". The gate's fail criterion.
const FULL_PCT = 95;
// Earliest local hour that counts as the evening peak. Below this the max price is a
// midday/morning slot, which is not what the cap risks.
const PEAK_FROM_HOUR = 16;
// Hours the delayed charge plan leans on. Realized PV here is the input the gate judges,
// not the whole-day total — a bright morning cannot rescue a dead afternoon.
const LEAN_HOURS = [13, 14, 15, 16];

const CSV_HEADER = 'date,verdict,capSaturating,capBindsRuns,pvKwhDay,pvKwhLean,'
  + 'peakLocal,peakPrice,socPlanned,socActual,socOverride';

/** Amsterdam wall-clock parts of an instant, as numbers. */
function localParts(d) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function todayLocal() {
  return localParts(new Date()).date;
}

/**
 * Trickle-cap activity from today's log lines. Two different scopes, kept apart on purpose:
 *  - saturating: horizon-wide count from `Optimizer: trickle-cap` — the cap was honoured
 *    somewhere on the planned horizon. This is the one that qualifies the day as evidence.
 *  - bindsRuns: `PV OVERSCHOT: ... cap bindt` fires for the CURRENT slot only (t=0), so it
 *    counts decision moments, not horizon coverage. A day can be evidence with 0 of these.
 * A day with saturating=0 says nothing about the fix and must not land in the denominator.
 */
function scanLog(date) {
  let text;
  try {
    text = fs.readFileSync(HOMEY_LOG, 'utf8');
  } catch {
    return { saturating: null, bindsRuns: null };
  }
  let saturating = 0;
  let bindsRuns = 0;
  for (const line of text.split('\n')) {
    const ts = line.slice(0, 24);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(ts)) continue;
    const when = new Date(ts);
    if (Number.isNaN(when.getTime()) || localParts(when).date !== date) continue;
    const m = line.match(/Optimizer: trickle-cap .*saturating=(\d+)/);
    if (m) saturating = Math.max(saturating, Number(m[1]));
    else if (line.includes('cap bindt')) bindsRuns += 1;
  }
  return { saturating, bindsRuns };
}

/**
 * The moment the battery ENTERS the evening peak: the first planned discharge slot of the
 * evening, not the highest-priced one. By the time the price maxes out the battery has been
 * discharging for an hour, so its SoC there says nothing about whether it started out full.
 * Returns that entry slot plus the peak price of the evening for context.
 */
function peakFromSchedule(schedule, date) {
  const evening = schedule.filter((s) => {
    if (!s || typeof s.price !== 'number' || !s.timestamp) return false;
    const { date: d, hour } = localParts(new Date(s.timestamp));
    return d === date && hour >= PEAK_FROM_HOUR;
  });
  if (!evening.length) return null;
  const entry = evening.find((s) => s.action === 'discharge');
  if (!entry) return null;
  const peakPrice = evening.reduce((m, s) => Math.max(m, s.price), 0);
  return { ...entry, hour: localParts(new Date(entry.timestamp)).hour, peakPrice };
}

async function shotPlan() {
  const date = todayLocal();
  const schedule = await getAppSetting('policy_optimizer_schedule');
  if (!Array.isArray(schedule) || !schedule.length) throw new Error('policy_optimizer_schedule empty');

  // No planned evening discharge means there is no "enters the peak" moment to score. Record
  // the day as unscoreable rather than crashing, so a gap in the CSV always means a failed run.
  const peak = peakFromSchedule(schedule, date);
  const cap = scanLog(date);
  const pending = {
    date,
    peakTs: peak ? peak.timestamp : null,
    peakLocal: peak
      ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .format(new Date(peak.timestamp))
      : '-',
    peakPrice: peak ? Number(peak.peakPrice.toFixed(4)) : null,
    socPlanned: peak ? (peak.socProjected ?? null) : null,
    socOverride: peak ? peak.socOverride === true : false,
    capSaturating: cap.saturating,
    capBindsRuns: cap.bindsRuns,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PENDING, `${JSON.stringify(pending, null, 2)}\n`);
  console.log(`${new Date().toISOString()} plan ${date} peak=${pending.peakLocal} `
    + `€${pending.peakPrice} socPlanned=${pending.socPlanned}% `
    + `capSat=${pending.capSaturating} binds=${pending.capBindsRuns}`);
}

/** Realized PV. `hourly` is average W per LOCAL hour, so /1000 is that hour's kWh. */
function realizedPv(actual, date) {
  if (!actual || actual.date !== date || !Array.isArray(actual.hourly)) return { day: null, lean: null };
  const kwh = (h) => (typeof actual.hourly[h] === 'number' ? actual.hourly[h] / 1000 : 0);
  let day = 0;
  for (let h = 0; h < 24; h += 1) day += kwh(h);
  const lean = LEAN_HOURS.reduce((a, h) => a + kwh(h), 0);
  return { day: Number(day.toFixed(2)), lean: Number(lean.toFixed(2)) };
}

/** SoC sample closest to the peak slot start, within half a slot. */
function socAt(entries, peakTs) {
  const target = new Date(peakTs).getTime();
  let best = null;
  for (const v of entries?.values || []) {
    if (v?.v == null || !v.t) continue;
    const dt = Math.abs(new Date(v.t).getTime() - target);
    if (!best || dt < best.dt) best = { dt, soc: v.v };
  }
  if (!best || best.dt > 8 * 60 * 1000) return null;
  return Number(best.soc.toFixed(1));
}

function verdict(row) {
  if (!row.capSaturating) return 'na:cap-idle';
  if (row.peakLocal === '-') return 'na:no-discharge';
  if (row.socPlanned == null || row.socActual == null) return 'na:missing';
  if (row.socOverride) return 'na:soc-override';
  if (row.socPlanned < FULL_PCT) return 'na:no-full-intent';
  return row.socActual < FULL_PCT ? 'FAIL' : 'ok';
}

function appendRow(row) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, `${CSV_HEADER}\n`);
  const existing = fs.readFileSync(CSV, 'utf8').split('\n');
  const kept = existing.filter((l) => l && !l.startsWith(`${row.date},`));
  const line = [row.date, row.verdict, row.capSaturating, row.capBindsRuns, row.pvKwhDay,
    row.pvKwhLean, row.peakLocal, row.peakPrice, row.socPlanned, row.socActual,
    row.socOverride].join(',');
  fs.writeFileSync(CSV, `${[...kept, line].join('\n')}\n`);
}

async function shotClose() {
  const date = todayLocal();
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
  } catch {
    throw new Error(`no pending plan shot — run "plan" at ~13:00 first (${PENDING})`);
  }
  if (pending.date !== date) throw new Error(`pending shot is for ${pending.date}, today is ${date}`);

  const [actual, entries] = await Promise.all([
    getAppSetting('policy_pv_actual_today'),
    getInsightsEntries(SOC_LOG_ID, 'last24Hours'),
  ]);

  const pv = realizedPv(actual, date);
  // The plan shot ran before the afternoon; take the wider of the two counts so a cap that
  // only started binding after 13:00 still qualifies the day.
  const cap = scanLog(date);
  const row = {
    date,
    capSaturating: Math.max(pending.capSaturating || 0, cap.saturating || 0),
    capBindsRuns: Math.max(pending.capBindsRuns || 0, cap.bindsRuns || 0),
    pvKwhDay: pv.day,
    pvKwhLean: pv.lean,
    peakLocal: pending.peakLocal,
    peakPrice: pending.peakPrice,
    socPlanned: pending.socPlanned,
    socActual: socAt(entries, pending.peakTs),
    socOverride: pending.socOverride,
  };
  row.verdict = verdict(row);
  appendRow(row);
  console.log(`${new Date().toISOString()} close ${date} ${row.verdict} `
    + `planned=${row.socPlanned}% actual=${row.socActual}% `
    + `pv=${row.pvKwhDay}kWh lean=${row.pvKwhLean}kWh capSat=${row.capSaturating}`);
}

/** Gate status over the rows collected so far. */
function report() {
  if (!fs.existsSync(CSV)) { console.log('no rows yet'); return; }
  const rows = fs.readFileSync(CSV, 'utf8').split('\n').slice(1).filter(Boolean)
    .map((l) => { const c = l.split(','); return { date: c[0], verdict: c[1], lean: c[5] }; });
  const scored = rows.filter((r) => r.verdict === 'ok' || r.verdict === 'FAIL');
  const fails = scored.filter((r) => r.verdict === 'FAIL');
  for (const r of rows) console.log(`${r.date}  ${r.verdict.padEnd(16)} lean=${r.lean}kWh`);
  console.log(`\nscored ${scored.length}/5 days, ${fails.length} FAIL`);
  if (fails.length >= 2) console.log('GATE FAILS → tune the pvSaturatesAhead margin, do NOT revert e865177');
  else if (scored.length >= 5) console.log('GATE PASSES → close the observe-gate');
  else console.log('gate still open');
}

const cmd = process.argv[2];
const run = { plan: shotPlan, close: shotClose, report: async () => report() }[cmd];
if (!run) {
  console.error('usage: trickle-cap-gate.js plan | close | report');
  process.exit(2);
}
run().catch((err) => { console.error(err.message); process.exit(1); });
