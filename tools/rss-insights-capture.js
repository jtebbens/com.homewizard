#!/usr/bin/env node
/**
 * Continuous 5-second app-RSS capture off the Homey's own Insights log.
 *
 * `lastHour` is the only resolution Insights stores unaggregated: 720 points at 5 s. Every
 * coarser resolution is a mean over its bucket (verified 2026-08-01: stored == mean of the
 * twelve 5 s samples, to three decimals, on 9/9 informative buckets), so a floor or a
 * percentile can only be computed from `lastHour`.
 *
 * The window is an hour wide and drops everything older, so it has to be re-read before it
 * rolls over. Polling every 45 min leaves 15 min of overlap; duplicate timestamps are
 * dropped, which makes a missed poll a gap rather than a corruption.
 *
 * This replaces tools/rss-sampler.js for the real Homey: that one reads /proc/<pid>/status
 * and therefore only ever saw the local Docker container.
 *
 * Control apps are captured alongside on the same schedule. They are the reference the
 * historical comparison lacks: our own numbers can only be held against 23-30 July, so any
 * Homey-wide change since then would land in the delta and be read as our doing. Apps we
 * never touched, sampled in the same window, separate the two. Picked for showing movement —
 * com.tuya and com.solcast sit at an identical value for all 720 samples, which is a stopped
 * app rather than a quiet one, the same artefact as our own 85.957 MB on 31-07.
 *
 * Usage:  node tools/rss-insights-capture.js [hours]      (default 24)
 * Out:    tools/_data-rss-insights.csv   (t,v         — this app)
 *         tools/_data-rss-controls.csv   (app,t,v     — control apps)
 */
const fs = require('fs');
const path = require('path');
const { getInsightsEntries } = require('./homey-local');

const LOG_ID = 'homey:manager:apps:com.homewizard-mem';
const CONTROLS = [
  'com.gruijter.powerhour',
  'com.athom.homeyscript',
  'io.home-assistant.community',
  'com.ubnt.unifi',
  'com.tuya2',
];
const OUT = path.join(__dirname, '_data-rss-insights.csv');
const OUT_CTL = path.join(__dirname, '_data-rss-controls.csv');
const POLL_MS = 45 * 60 * 1000;

const hours = Number(process.argv[2] || 24);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('usage: rss-insights-capture.js [hours]');
  process.exit(2);
}

/** Timestamps already on disk, per app, so a restart resumes instead of duplicating. */
function loadSeen(file, header, keyed) {
  const seen = new Map();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${header}\n`);
    return seen;
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith(header.slice(0, 3))) continue;
    const c = line.split(',');
    const [app, t] = keyed ? [c[0], c[1]] : [LOG_ID, c[0]];
    if (!seen.has(app)) seen.set(app, new Set());
    seen.get(app).add(t);
  }
  return seen;
}

const seen = loadSeen(OUT, 't,v', false);
const seenCtl = loadSeen(OUT_CTL, 'app,t,v', true);
const stamp = () => new Date().toISOString().slice(11, 19);

/** Appends the samples of one log that are not on disk yet. Returns how many were new. */
async function fetchLog(logId, store, file, prefix) {
  const { values } = await getInsightsEntries(logId, 'lastHour');
  if (!store.has(logId)) store.set(logId, new Set());
  const known = store.get(logId);
  const rows = values
    .filter((x) => x.v != null && !known.has(x.t))
    .sort((a, b) => (a.t < b.t ? -1 : 1));
  for (const r of rows) known.add(r.t);
  if (rows.length) fs.appendFileSync(file, `${rows.map((r) => `${prefix}${r.t},${r.v}`).join('\n')}\n`);
  return rows.length;
}

async function poll() {
  const n = await fetchLog(LOG_ID, seen, OUT, '');
  const ctl = [];
  for (const app of CONTROLS) {
    try {
      ctl.push(await fetchLog(`homey:manager:apps:${app}-mem`, seenCtl, OUT_CTL, `${app},`));
    } catch (err) {
      ctl.push(`ERR(${err.message})`);
    }
  }
  console.log(`${stamp()} +${n} own (${seen.get(LOG_ID).size} tot), ctl +[${ctl.join(' ')}]`);
}

(async () => {
  const until = Date.now() + hours * 3600 * 1000;
  console.log(`${stamp()} capture start, ${hours}h, poll ${POLL_MS / 60000} min, ${CONTROLS.length} controls`);
  for (;;) {
    try {
      await poll();
    } catch (err) {
      console.log(`${stamp()} poll failed: ${err.message}`);
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`${stamp()} capture done, ${seen.get(LOG_ID).size} own samples`);
})();
