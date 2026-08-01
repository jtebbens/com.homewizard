// High-rate VmRSS sampler for a foreign PID.
// compute() is synchronous, so no in-process sampler can observe the peak inside it.
// Reading /proc/<pid>/status from outside is the only way to see the transient.
const fs = require('fs');
const pid = process.argv[2];
const out = process.argv[3];
const durationMs = Number(process.argv[4] || 1_200_000);
const intervalMs = Number(process.argv[5] || 20);

const fd = fs.openSync(out, 'w');
fs.writeSync(fd, 'ts_iso,rss_kb\n');
const stop = Date.now() + durationMs;

function tick() {
  let txt;
  try { txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); }
  catch { fs.closeSync(fd); process.exit(0); }
  const m = txt.match(/VmRSS:\s+(\d+) kB/);
  if (m) fs.writeSync(fd, `${new Date().toISOString()},${m[1]}\n`);
  if (Date.now() < stop) setTimeout(tick, intervalMs);
  else { fs.closeSync(fd); process.exit(0); }
}
tick();
