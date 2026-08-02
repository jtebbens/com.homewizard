'use strict';

// The shared fetch-debug log lived in homey.settings under `debug_logs`. Every settings.set()
// ships the WHOLE settings object over IPC (SDK manager/settings.js _save -> emitApp('setSettings',…)),
// and at 500 entries this one key was 46.5 kB of a 364.5 kB blob — 13% of every unrelated write,
// for pure diagnostics no other code reads. It now shares the /userdata sink, like the provider
// caches (lib/userdata-store.js), mode-history (f7011bf) and the DP input dumps (d8bcdd7).
//
// Contract covered here:
//   - append returns the stored list, oldest first, across calls
//   - the list is capped at 500 and the cap drops the OLDEST entries
//   - reading before anything was written yields [], not null (the UI joins on it)
//   - a corrupt file does not throw and does not lose the new entries
//   - clear() empties it, and clearing twice is a no-op
//   - an unwritable dir reports false instead of throwing into the driver's poll loop

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dbglogs-'));
  tmpDirs.push(d);
  return d;
}

const origEnv = process.env.HOMEY_USERDATA_DIR;
process.env.HOMEY_USERDATA_DIR = tmpDir();
const { appendDebugLogs, readDebugLogs, clearDebugLogs, MAX_DEBUG_LOGS } = require('../lib/debug-logs');

function reset() {
  clearDebugLogs();
}

console.log('\n--- debug-logs store ---\n');

test('reads as an empty array before anything is written', () => {
  reset();
  assert.deepStrictEqual(readDebugLogs(), []);
});

test('append stores entries oldest-first and accumulates across calls', () => {
  reset();
  appendDebugLogs(['a', 'b']);
  appendDebugLogs(['c']);
  assert.deepStrictEqual(readDebugLogs(), ['a', 'b', 'c']);
});

test('append returns true when the write landed', () => {
  reset();
  assert.strictEqual(appendDebugLogs(['x']), true);
});

test('an empty batch is a no-op and does not rewrite the file', () => {
  reset();
  appendDebugLogs(['keep']);
  assert.strictEqual(appendDebugLogs([]), false);
  assert.deepStrictEqual(readDebugLogs(), ['keep']);
});

test(`caps at ${MAX_DEBUG_LOGS} entries, dropping the oldest`, () => {
  reset();
  const batch = [];
  for (let i = 0; i < MAX_DEBUG_LOGS + 25; i++) batch.push(`line-${i}`);
  appendDebugLogs(batch);
  const logs = readDebugLogs();
  assert.strictEqual(logs.length, MAX_DEBUG_LOGS);
  assert.strictEqual(logs[0], 'line-25', 'oldest entries must be the ones dropped');
  assert.strictEqual(logs[logs.length - 1], `line-${MAX_DEBUG_LOGS + 24}`);
});

test('the cap also holds when the overflow arrives across several appends', () => {
  reset();
  for (let i = 0; i < MAX_DEBUG_LOGS + 10; i++) appendDebugLogs([`n-${i}`]);
  const logs = readDebugLogs();
  assert.strictEqual(logs.length, MAX_DEBUG_LOGS);
  assert.strictEqual(logs[0], 'n-10');
});

test('a corrupt file does not throw and the new entries still land', () => {
  // A crash mid-write leaves a truncated file. Diagnostics are expendable; the poll loop is not.
  reset();
  fs.writeFileSync(path.join(process.env.HOMEY_USERDATA_DIR, 'debug_logs.json'), '["half of a li');
  assert.strictEqual(appendDebugLogs(['after-corrupt']), true);
  assert.deepStrictEqual(readDebugLogs(), ['after-corrupt']);
});

test('a file holding a non-array reads as empty rather than throwing', () => {
  reset();
  fs.writeFileSync(path.join(process.env.HOMEY_USERDATA_DIR, 'debug_logs.json'), '{"not":"an array"}');
  assert.deepStrictEqual(readDebugLogs(), []);
});

test('clear empties the list, and clearing twice is a no-op', () => {
  reset();
  appendDebugLogs(['gone']);
  clearDebugLogs();
  assert.deepStrictEqual(readDebugLogs(), []);
  clearDebugLogs(); // must not throw
  assert.deepStrictEqual(readDebugLogs(), []);
});

test('an unwritable dir returns false instead of throwing', () => {
  const prev = process.env.HOMEY_USERDATA_DIR;
  process.env.HOMEY_USERDATA_DIR = path.join(prev, 'no', 'such', 'dir');
  try {
    assert.strictEqual(appendDebugLogs(['nowhere']), false);
    assert.deepStrictEqual(readDebugLogs(), []);
  } finally {
    process.env.HOMEY_USERDATA_DIR = prev;
  }
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
if (origEnv === undefined) delete process.env.HOMEY_USERDATA_DIR;
else process.env.HOMEY_USERDATA_DIR = origEnv;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
