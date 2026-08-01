'use strict';

// Provider caches (merged prices, weather, Solcast) used to live in homey.settings. Every
// settings.set() ships the WHOLE settings object over the wire (SDK manager/settings.js _save ->
// emitApp('setSettings', …)), so three rebuildable caches cost 70.7 kB on every unrelated write —
// 14% of a 490 kB blob. They now share one /userdata sink, the same move mode-history (f7011bf) and
// the DP input dumps (d8bcdd7) already made.
//
// Contract covered here:
//   - a value survives a write/read round-trip, including nested arrays and null members
//   - a missing file reads as null (the existing cache-miss path), never a throw
//   - a corrupt/truncated file reads as null — one refetch, not a crash loop
//   - an unwritable dir reports false instead of throwing into the caller
//   - remove() deletes, and removing an absent file is a no-op
//   - the dir comes from HOMEY_USERDATA_DIR when set, /userdata otherwise

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

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
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'udstore-'));
  tmpDirs.push(d);
  return d;
}

const origEnv = process.env.HOMEY_USERDATA_DIR;
process.env.HOMEY_USERDATA_DIR = tmpDir();
const store = require('../lib/userdata-store');

console.log('\n--- userdata-store ---\n');

test('round-trip preserves structure', () => {
  const value = {
    prices: [{ timestamp: '2026-08-01T22:00:00.000Z', price: 0.2137 }],
    prices15min_xadi: null,
    expiry: 1754087922496,
    sources: ['kwhprice', 'xadi'],
  };
  assert.strictEqual(store.writeJson('round-trip', value), true);
  assert.deepStrictEqual(store.readJson('round-trip'), value);
});

test('missing file reads as null', () => {
  assert.strictEqual(store.readJson('never-written'), null);
});

test('corrupt file reads as null instead of throwing', () => {
  // A crash mid-write leaves a truncated file. readJson must degrade to the normal cache-miss
  // path so the provider refetches, rather than throwing on every boot.
  fs.writeFileSync(path.join(process.env.HOMEY_USERDATA_DIR, 'corrupt.json'), '{"prices":[{"pri');
  assert.strictEqual(store.readJson('corrupt'), null);
});

test('unwritable dir returns false, does not throw', () => {
  const prev = process.env.HOMEY_USERDATA_DIR;
  process.env.HOMEY_USERDATA_DIR = path.join(prev, 'no', 'such', 'dir');
  try {
    assert.strictEqual(store.writeJson('nowhere', { a: 1 }), false);
  } finally {
    process.env.HOMEY_USERDATA_DIR = prev;
  }
});

test('a payload that cannot be serialised leaves no file behind', () => {
  const circular = { a: 1 };
  circular.self = circular;
  assert.strictEqual(store.writeJson('circular', circular), false);
  assert.strictEqual(fs.existsSync(path.join(process.env.HOMEY_USERDATA_DIR, 'circular.json')), false);
});

test('removeJson deletes, and is a no-op on an absent file', () => {
  store.writeJson('doomed', { a: 1 });
  store.removeJson('doomed');
  assert.strictEqual(store.readJson('doomed'), null);
  store.removeJson('doomed'); // must not throw
});

test('dir follows HOMEY_USERDATA_DIR per call, defaults to /userdata', () => {
  const other = tmpDir();
  const prev = process.env.HOMEY_USERDATA_DIR;
  process.env.HOMEY_USERDATA_DIR = other;
  try {
    store.writeJson('elsewhere', { a: 1 });
    assert.strictEqual(fs.existsSync(path.join(other, 'elsewhere.json')), true);
  } finally {
    process.env.HOMEY_USERDATA_DIR = prev;
  }
  assert.strictEqual(store.readJson('elsewhere'), null, 'must not leak across dirs');

  delete process.env.HOMEY_USERDATA_DIR;
  assert.strictEqual(store.dir(), '/userdata');
  process.env.HOMEY_USERDATA_DIR = prev;
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
if (origEnv === undefined) delete process.env.HOMEY_USERDATA_DIR;
else process.env.HOMEY_USERDATA_DIR = origEnv;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
