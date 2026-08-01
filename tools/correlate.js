// Correlate high-rate VmRSS samples with [MEM] stage markers.
// Answers two questions the in-process net-deltas cannot:
//   1) Which stage window carries the RSS PEAK (transient allocation)?
//   2) Which stage window carries a persistent RSS STEP (the ratchet)?
const fs = require('fs');
const [, , csvPath, logPath] = process.argv;

const samples = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1)
  .map(l => { const [ts, kb] = l.split(','); return { t: Date.parse(ts), mb: Number(kb) / 1024 }; })
  .filter(s => Number.isFinite(s.t) && Number.isFinite(s.mb));

const MARK = /(\d{4}-\d\d-\d\dT[\d:.]+Z) \[MEM\] \[BatteryPolicy\] ([\w:-]+):/;
const marks = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const m = line.match(MARK);
  if (m && !/footprint/.test(line)) marks.push({ t: Date.parse(m[1]), label: m[2] });
}

const t0 = samples[0].t, t1 = samples[samples.length - 1].t;
const inWindow = marks.filter(m => m.t >= t0 && m.t <= t1);
console.log(`samples ${samples.length} (${new Date(t0).toISOString()} .. ${new Date(t1).toISOString()})`);
console.log(`markers in sampler window: ${inWindow.length}\n`);

// Split markers into policy runs (a run starts at 'policy-run').
const runs = [];
for (const m of inWindow) {
  if (m.label === 'policy-run') runs.push([]);
  if (runs.length) runs[runs.length - 1].push(m);
}

const slice = (a, b) => samples.filter(s => s.t >= a && s.t < b);
const fmt = n => n.toFixed(1).padStart(6);

for (const run of runs) {
  if (run.length < 2) continue;
  const start = run[0].t, end = run[run.length - 1].t;
  const pre = samples.filter(s => s.t < start).slice(-25);
  const post = samples.filter(s => s.t > end).slice(0, 25);
  const base = pre.length ? Math.min(...pre.map(s => s.mb)) : NaN;
  const settled = post.length ? Math.min(...post.map(s => s.mb)) : NaN;
  const all = slice(start, end + 1);
  const peak = all.length ? Math.max(...all.map(s => s.mb)) : NaN;
  console.log(`── run ${new Date(start).toISOString()}  base=${fmt(base)}  peak=${fmt(peak)}  settled=${fmt(settled)}  STEP=${fmt(settled - base)}`);
  for (let i = 0; i < run.length - 1; i++) {
    const w = slice(run[i].t, run[i + 1].t);
    if (!w.length) { console.log(`   ${run[i].label.padEnd(20)} → ${run[i + 1].label.padEnd(20)} (no samples, ${run[i + 1].t - run[i].t}ms)`); continue; }
    const lo = Math.min(...w.map(s => s.mb)), hi = Math.max(...w.map(s => s.mb));
    console.log(`   ${run[i].label.padEnd(20)} → ${run[i + 1].label.padEnd(20)} n=${String(w.length).padStart(3)}  min=${fmt(lo)} max=${fmt(hi)}  Δend=${fmt(w[w.length - 1].mb - w[0].mb)}`);
  }
  console.log('');
}

// Global: largest sample-to-sample RSS jumps, and which stage window each lands in.
const labelAt = t => {
  let cur = null;
  for (const m of inWindow) { if (m.t <= t) cur = m.label; else break; }
  return cur ?? '(before first marker)';
};
const jumps = [];
for (let i = 1; i < samples.length; i++) {
  const d = samples[i].mb - samples[i - 1].mb;
  if (d >= 1.0) jumps.push({ t: samples[i].t, d, mb: samples[i].mb });
}
jumps.sort((a, b) => b.d - a.d);
console.log('── top RSS jumps (≥1.0 MB between consecutive 20ms samples)');
for (const j of jumps.slice(0, 15)) {
  console.log(`   ${new Date(j.t).toISOString()}  +${j.d.toFixed(1)} MB → ${j.mb.toFixed(1)}  after marker: ${labelAt(j.t)}`);
}
console.log(`   (total jumps ≥1MB: ${jumps.length})`);

const lo = Math.min(...samples.map(s => s.mb)), hi = Math.max(...samples.map(s => s.mb));
console.log(`\nRSS over whole window: min=${lo.toFixed(1)} max=${hi.toFixed(1)} first=${samples[0].mb.toFixed(1)} last=${samples[samples.length - 1].mb.toFixed(1)}`);
