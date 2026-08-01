'use strict';

// policy_mode_history was one settings key holding 2200 entries (~596 kB), then 23 per-day settings
// keys. Chunking cut the per-key payload but not the wire cost: every settings.set() ships the whole
// settings object (SDK manager/settings.js _save -> emitApp('setSettings', …)), so the 587 kB rode
// along on every unrelated write — 43.8% of a 1340 kB blob. The store now lives on /userdata as one
// JSON per Amsterdam day, with an in-memory Map as the source of truth (a disk read per policy run
// would re-parse the whole store, which is the allocation this move set out to kill).
//
// Retention stays the same window: 23 chunk days ≈ the old 2200-entry cap ≈ 23d @ 96 buckets/day,
// which is what learning-engine.js:715-718 (EMA alpha 0.01 ≈ 25d) is tuned against.
//
// Contract covered here:
//   - append lands in the chunk of the entry's *bucket* (not its raw ts — 15-min rounding can
//     push a 23:53 sample across the local midnight)
//   - one entry per 15-min bucket, and a null soc never overwrites a known one
//   - concatenated reads come back chronological, and lastN reads the tail correctly
//   - a single-day read touches one chunk
//   - retention prunes day files older than the window
//   - the one-time migration moves BOTH the legacy array and the per-day settings keys to files
//   - a corrupt file, an unwritable dir, and a restart each degrade the way they should

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const upsert  = BatteryPolicyDevice.prototype._upsertModeHistory;
const readAll = BatteryPolicyDevice.prototype._readModeHistory;
const readDay = BatteryPolicyDevice.prototype._readModeHistoryDay;
const migrate = BatteryPolicyDevice.prototype._migrateModeHistoryChunks;
const load    = BatteryPolicyDevice.prototype._loadModeHistory;

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

const tmpDirs = [];

// Fake device: a real /userdata stand-in on tmpfs plus a fake settings store, so the migration path
// (which reads settings and writes files) can be exercised end to end.
function makeCtx(initial = {}, dir = null) {
  const store = { ...initial };
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modehist-'));
    tmpDirs.push(dir);
  }
  return Object.assign(Object.create(BatteryPolicyDevice.prototype), {
    store,
    _modeStateDir: dir,
    homey: {
      settings: {
        get: k => (k in store ? store[k] : null),
        getAll: () => ({ ...store }),
        unset: k => { delete store[k]; },
      },
    },
    log() {},
    error() {},
  });
}

// Day keys that actually exist as files — the store is the disk, not the Map.
const dayFiles = ctx => fs.readdirSync(ctx._modeStateDir)
  .map(n => /^mode-history-(\d{4}-\d{2}-\d{2})\.json$/.exec(n))
  .filter(Boolean)
  .map(m => m[1])
  .sort();

const fileDay = (ctx, day) => JSON.parse(fs.readFileSync(`${ctx._modeStateDir}/mode-history-${day}.json`, 'utf8'));
const settingsChunkKeys = ctx => Object.keys(ctx.store).filter(k => k.startsWith('policy_mode_history_')).sort();
const entry = (iso, extra = {}) => ({ ts: new Date(iso).toISOString(), hwMode: 'predictive', soc: 50, price: null, ...extra });

console.log('\nmode history — per-day files on /userdata\n');

test('two appends on the same Amsterdam day share one day file', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T10:15:00Z'));
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-30']);
  assert.strictEqual(fileDay(ctx, '2026-07-30').length, 2);
});

test('same 15-min bucket upserts in place instead of appending', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z', { soc: 40 }));
  upsert.call(ctx, entry('2026-07-30T10:04:00Z', { soc: 42 }));
  const chunk = fileDay(ctx, '2026-07-30');
  assert.strictEqual(chunk.length, 1, 'one entry per bucket');
  assert.strictEqual(chunk[0].soc, 42, 'newest wins');
});

test('a null soc does not erase a known soc in the same bucket', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z', { soc: 44 }));
  upsert.call(ctx, entry('2026-07-30T10:04:00Z', { soc: null }));
  assert.strictEqual(fileDay(ctx, '2026-07-30')[0].soc, 44);
});

test('bucket rounding across local midnight files the entry under the next day', () => {
  const ctx = makeCtx();
  // 23:53 Amsterdam (CEST) = 21:53Z; nearest 15-min bucket is 22:00Z = 00:00 local on the 31st.
  upsert.call(ctx, entry('2026-07-30T21:53:00Z'));
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-31'],
    'file follows the bucket, not the raw ts');
});

test('concatenated read is chronological across day files', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-31T08:00:00Z'));
  upsert.call(ctx, entry('2026-07-29T08:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T08:00:00Z'));
  const all = readAll.call(ctx);
  assert.deepStrictEqual(all.map(e => e.ts.slice(0, 10)), ['2026-07-29', '2026-07-30', '2026-07-31']);
});

test('lastN read returns the newest N in order', () => {
  const ctx = makeCtx();
  for (let d = 0; d < 5; d++) {
    for (let q = 0; q < 4; q++) {
      upsert.call(ctx, entry(`2026-07-${20 + d}T${String(8 + q).padStart(2, '0')}:00:00Z`));
    }
  }
  const tail = readAll.call(ctx, 6);
  assert.strictEqual(tail.length, 6);
  assert.strictEqual(tail[0].ts.slice(0, 10), '2026-07-23');
  assert.strictEqual(tail[5].ts.slice(0, 10), '2026-07-24');
  const sorted = [...tail].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  assert.deepStrictEqual(tail, sorted, 'tail stays chronological');
});

test('lastN larger than the store returns everything', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  assert.strictEqual(readAll.call(ctx, 96).length, 1);
});

test('single-day read returns only that day', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-29T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T11:00:00Z'));
  const day = readDay.call(ctx, '2026-07-30');
  assert.strictEqual(day.length, 2);
  assert.ok(day.every(e => e.ts.startsWith('2026-07-30')));
  assert.deepStrictEqual(readDay.call(ctx, '2026-01-01'), [], 'missing day is empty, not null');
});

test('retention keeps 23 day files and unlinks older ones', () => {
  const ctx = makeCtx();
  // 30 consecutive days, one entry each, at midday so no boundary rounding is involved.
  for (let d = 1; d <= 30; d++) {
    upsert.call(ctx, entry(`2026-06-${String(d).padStart(2, '0')}T10:00:00Z`));
  }
  const days = dayFiles(ctx);
  assert.strictEqual(days.length, 23, `expected 23 day files, got ${days.length}`);
  assert.strictEqual(days[0], '2026-06-08');
  assert.strictEqual(days[22], '2026-06-30');
});

test('an out-of-window backdated entry is not resurrected by the prune', () => {
  const ctx = makeCtx();
  for (let d = 1; d <= 30; d++) {
    upsert.call(ctx, entry(`2026-06-${String(d).padStart(2, '0')}T10:00:00Z`));
  }
  upsert.call(ctx, entry('2026-05-01T10:00:00Z'));
  assert.ok(!dayFiles(ctx).includes('2026-05-01'),
    'a stale day file written by a backdated append is pruned again');
  assert.deepStrictEqual(readDay.call(ctx, '2026-05-01'), [], 'and it is gone from memory too');
});

test('migration splits the legacy array into day files and removes the legacy key', () => {
  const legacy = [
    entry('2026-07-28T10:00:00Z'),
    entry('2026-07-29T10:00:00Z'),
    entry('2026-07-29T10:15:00Z'),
    entry('2026-07-30T10:00:00Z'),
  ];
  const ctx = makeCtx({ policy_mode_history: legacy });
  migrate.call(ctx);
  assert.strictEqual(ctx.store.policy_mode_history, undefined, 'legacy key gone');
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-28', '2026-07-29', '2026-07-30']);
  assert.strictEqual(fileDay(ctx, '2026-07-29').length, 2);
  assert.deepStrictEqual(readAll.call(ctx).map(e => e.ts), legacy.map(e => e.ts),
    'concat after migration equals the legacy order');
});

test('migration moves the per-day settings keys to files and unsets them', () => {
  const ctx = makeCtx({
    'policy_mode_history_2026-07-29': [entry('2026-07-29T10:00:00Z'), entry('2026-07-29T10:15:00Z')],
    'policy_mode_history_2026-07-30': [entry('2026-07-30T10:00:00Z')],
  });
  migrate.call(ctx);
  assert.deepStrictEqual(settingsChunkKeys(ctx), [], 'no chunk keys left in settings');
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-29', '2026-07-30']);
  assert.strictEqual(readAll.call(ctx).length, 3);
});

test('migration is a no-op when nothing is left in settings', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  const before = fileDay(ctx, '2026-07-30');
  migrate.call(ctx);
  assert.deepStrictEqual(fileDay(ctx, '2026-07-30'), before);
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-30']);
});

test('migration does not duplicate a bucket a file already holds', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-30T10:00:00Z', { soc: 44 }));
  ctx.store['policy_mode_history_2026-07-30'] = [entry('2026-07-30T10:04:00Z', { soc: 99 })];
  migrate.call(ctx);
  assert.strictEqual(fileDay(ctx, '2026-07-30').length, 1, 'same bucket, one entry');
});

test('migration drops legacy entries older than the retention window', () => {
  const legacy = [entry('2026-01-01T10:00:00Z'), entry('2026-07-30T10:00:00Z')];
  const ctx = makeCtx({ policy_mode_history: legacy });
  migrate.call(ctx);
  assert.deepStrictEqual(dayFiles(ctx), ['2026-07-30']);
});

test('a restart reloads the same series from disk', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-29T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T10:15:00Z'));
  const before = readAll.call(ctx);

  const fresh = makeCtx({}, ctx._modeStateDir);
  load.call(fresh);
  assert.deepStrictEqual(readAll.call(fresh), before, 'same entries, same order');
  assert.deepStrictEqual(readDay.call(fresh, '2026-07-30').length, 2);
});

test('a corrupt day file costs that day, not the rest', () => {
  const ctx = makeCtx();
  upsert.call(ctx, entry('2026-07-29T10:00:00Z'));
  upsert.call(ctx, entry('2026-07-30T10:00:00Z'));
  fs.writeFileSync(`${ctx._modeStateDir}/mode-history-2026-07-30.json`, '{not json');

  const fresh = makeCtx({}, ctx._modeStateDir);
  load.call(fresh);
  assert.strictEqual(readAll.call(fresh).length, 1, 'the intact day survives');
  assert.deepStrictEqual(readDay.call(fresh, '2026-07-30'), [], 'the corrupt day reads empty');
});

test('an unwritable state dir does not throw and keeps the entry readable', () => {
  const ctx = makeCtx({}, '/proc/nonexistent-mode-history');
  assert.doesNotThrow(() => upsert.call(ctx, entry('2026-07-30T10:00:00Z')));
  assert.strictEqual(readDay.call(ctx, '2026-07-30').length, 1, 'memory still has it');
});

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
