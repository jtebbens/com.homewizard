'use strict';

const assert = require('assert');
const BaseloadMonitor = require('../includes/utils/baseloadMonitor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// The monitor only needs homey.settings for these paths.
function makeMonitor(state) {
  const store = { baseload_state: state };
  const homey = {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    __store: store,
  };
  const monitor = new BaseloadMonitor(homey);
  // Migrating schedules a debounced _save(); clear it so the test process can exit.
  if (monitor._saveTimer) clearTimeout(monitor._saveTimer);
  return monitor;
}

function isoNight(date, count, stepMs) {
  const t0 = Date.parse(`${date}T01:00:00.000Z`);
  const samples = [];
  for (let i = 0; i < count; i++) {
    samples.push({ ts: new Date(t0 + i * stepMs).toISOString(), power: 900 + (i % 7) });
  }
  return { date, avg: null, invalid: true, samples };
}

console.log('baseload history migration:');

test('thins a legacy night stored at 2 s resolution', () => {
  const night = isoNight('2025-12-30', 600, 2000);          // 20 minutes at 2 s
  const m = makeMonitor({ nightHistory: [night] });
  assert.strictEqual(m.nightHistory[0].samples.length, 40);  // one per 30 s
  assert.strictEqual(typeof m.nightHistory[0].samples[0].ts, 'number');
});

test('leaves a night already at 30 s alone', () => {
  const night = isoNight('2026-03-25', 40, 30000);
  const m = makeMonitor({ nightHistory: [night] });
  assert.strictEqual(m.nightHistory[0].samples.length, 40);
});

test('normalises ISO timestamps to numbers', () => {
  const m = makeMonitor({ nightHistory: [isoNight('2026-01-01', 10, 60000)] });
  for (const s of m.nightHistory[0].samples) {
    assert.strictEqual(typeof s.ts, 'number');
    assert.ok(Number.isFinite(s.ts));
  }
});

test('handles mixed numeric and ISO timestamps in one night', () => {
  const t0 = Date.parse('2026-01-05T01:00:00.000Z');
  const samples = [
    { ts: t0, power: 900 },
    { ts: new Date(t0 + 30000).toISOString(), power: 901 },
    { ts: t0 + 60000, power: 902 },
  ];
  const m = makeMonitor({ nightHistory: [{ date: '2026-01-05', avg: null, invalid: true, samples }] });
  assert.strictEqual(m.nightHistory[0].samples.length, 3);
  assert.ok(m.nightHistory[0].samples.every((s) => typeof s.ts === 'number'));
});

test('drops samples whose timestamp cannot be parsed', () => {
  const t0 = Date.parse('2026-01-06T01:00:00.000Z');
  const samples = [
    { ts: 'not a date', power: 5 },
    { ts: t0, power: 900 },
    { ts: undefined, power: 7 },
  ];
  const m = makeMonitor({ nightHistory: [{ date: '2026-01-06', avg: null, invalid: true, samples }] });
  assert.strictEqual(m.nightHistory[0].samples.length, 1);
  assert.strictEqual(m.nightHistory[0].samples[0].power, 900);
});

test('survives malformed history without throwing', () => {
  const m = makeMonitor({
    nightHistory: [
      null,
      { date: '2026-01-07' },                                   // no samples key
      { date: '2026-01-08', samples: [] },                      // empty
      { date: '2026-01-09', samples: [null, { power: 3 }] },    // null sample, sample without ts
    ],
  });
  assert.strictEqual(m.nightHistory.length, 4);
  assert.deepStrictEqual(m.nightHistory[3].samples, []);
});

test('preserves the night median it is used for', () => {
  const t0 = Date.parse('2026-01-10T01:00:00.000Z');
  const samples = [];
  for (let i = 0; i < 3000; i++) samples.push({ ts: t0 + i * 2000, power: 700 + (i % 200) });
  const median = (arr) => {
    const p = arr.map((s) => s.power).filter((x) => x >= 0 && x < 1000).sort((a, b) => a - b);
    const half = p.slice(0, Math.floor(p.length / 2));
    return half[Math.floor(half.length / 2)];
  };
  const before = median(samples);
  const m = makeMonitor({ nightHistory: [{ date: '2026-01-10', avg: 800, invalid: false, samples }] });
  const after = median(m.nightHistory[0].samples);
  assert.ok(Math.abs(after - before) <= 5, `median moved from ${before} to ${after}`);
});

console.log('\n══════════════════════════════');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('══════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
