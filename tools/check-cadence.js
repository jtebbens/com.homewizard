'use strict';
/**
 * Instrument cadence checker.
 *
 * A meter can show a plausible value while its wiring is dead (see
 * feedback_verify_instrument_cadence_not_value.md: consumption_accuracy_hourly showed
 * score=0.8616 with count=1 where ~4/hour was expected — the meter had been dead since
 * build). Checking the VALUE never catches this; checking the CADENCE does. This script
 * counts how many times a log marker fires per UTC hour over a window and flags hours
 * that fall far short of the expected rate. The current (in-progress) hour is skipped —
 * it hasn't had a chance to fill yet.
 *
 * Usage:
 *   node tools/check-cadence.js '<marker>' --expected-per-hour <N> [--hours 24] [--log /tmp/homey.log]
 *
 * Example:
 *   node tools/check-cadence.js '[SAT YF]' --expected-per-hour 4
 */

const fs = require('fs');

function parseArgs(argv) {
  const args = { hours: 24, log: '/tmp/homey.log', expectedPerHour: null, marker: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expected-per-hour') args.expectedPerHour = Number(argv[++i]);
    else if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--log') args.log = argv[++i];
    else rest.push(a);
  }
  args.marker = rest[0];
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.marker || !args.expectedPerHour) {
    console.error('Usage: node tools/check-cadence.js \'<marker>\' --expected-per-hour <N> [--hours 24] [--log /tmp/homey.log]');
    process.exit(2);
  }

  const now = Date.now();
  const windowStart = now - args.hours * 3600 * 1000;
  const currentHourBucket = Math.floor(now / 3600000);

  const lineRe = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;
  const counts = new Map(); // hourBucket (ms/3600000, UTC) -> count

  const raw = fs.readFileSync(args.log, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.includes(args.marker)) continue;
    const m = lineRe.exec(line);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (Number.isNaN(ts) || ts < windowStart) continue;
    const bucket = Math.floor(ts / 3600000);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }

  const startBucket = Math.floor(windowStart / 3600000);
  const staleThreshold = args.expectedPerHour * 0.5;
  let staleCount = 0;
  const rows = [];

  for (let b = startBucket; b < currentHourBucket; b++) {
    const count = counts.get(b) || 0;
    const label = new Date(b * 3600000).toLocaleString('en-GB', {
      timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const stale = count < staleThreshold;
    if (stale) staleCount++;
    rows.push({ label, count, stale });
  }

  console.log(`Marker: ${args.marker}  expected/hr: ${args.expectedPerHour}  window: ${args.hours}h  log: ${args.log}`);
  console.log('');
  for (const r of rows) {
    console.log(`${r.label}  count=${r.count}${r.stale ? '  ⚠ STALE' : ''}`);
  }
  console.log('');
  if (staleCount > 0) {
    console.log(`${staleCount}/${rows.length} hours below ${staleThreshold}/hr — instrument likely dead, check the write-path.`);
    process.exit(1);
  }
  console.log('All hours within expected cadence.');
}

main();
