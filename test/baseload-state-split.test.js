'use strict';

// baseload_state was 260 kB in the app settings blob, of which 99% is the per-night
// `samples` arrays. Every settings.set() re-serializes the whole blob (~1338 kB over the
// wire, 191x/hour), so those samples inflated writes that have nothing to do with baseload.
// The samples now live in a file under /userdata; the settings key keeps the slim state
// (2.8 kB) that the settings page already reads through Homey.get().

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

function makeMonitor(stored = null) {
  const store = { baseload_state: stored };
  const homey = {
    settings: {
      get: (k) => store[k] ?? null,
      set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const m = new BaseloadMonitor(homey);
  m.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseload-'));
  return { m, store };
}

function nights(n = 2, samplesPerNight = 3) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-07-${String(10 + i).padStart(2, '0')}`,
    avg: 30 + i,
    invalid: false,
    samples: Array.from({ length: samplesPerNight }, (_, j) => ({ ts: 1000 + j, power: 25 + j })),
  }));
}

test('write splits samples to file, keeps slim state in settings', () => {
  const { m, store } = makeMonitor();
  m.nightHistory = nights();
  m.currentBaseload = 135;
  m._writeState();

  const slim = store.baseload_state;
  assert.strictEqual(slim.nightHistory.length, 2);
  assert.strictEqual(slim.currentBaseload, 135);
  for (const n of slim.nightHistory) {
    assert.ok(!('samples' in n), 'settings copy must not carry samples');
    assert.strictEqual(typeof n.avg, 'number', 'slim night keeps its aggregate');
  }

  const onDisk = JSON.parse(fs.readFileSync(path.join(m.stateDir, 'baseload-samples.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['2026-07-10', '2026-07-11']);
  assert.strictEqual(onDisk['2026-07-10'].length, 3);
});

test('load merges file samples back onto the slim nights', () => {
  const { m } = makeMonitor();
  m.nightHistory = nights();
  m.currentBaseload = 135;
  m._writeState();

  const fresh = new BaseloadMonitor(m.homey);
  fresh.stateDir = m.stateDir;
  fresh._loadState();

  assert.strictEqual(fresh.nightHistory.length, 2);
  assert.strictEqual(fresh.currentBaseload, 135);
  assert.strictEqual(fresh.nightHistory[0].samples.length, 3);
  assert.strictEqual(fresh.nightHistory[0].samples[2].power, 27);
});

test('migrates an old settings blob that still carries samples inline', () => {
  const { m, store } = makeMonitor({
    nightHistory: nights(),
    currentBaseload: 99,
    deviceNotificationPrefs: [['dev-1', true]],
    invalidNightCounter: 0,
  });
  m._loadState();

  assert.strictEqual(m.currentBaseload, 99);
  assert.strictEqual(m.nightHistory[1].samples.length, 3, 'inline samples survive the migration');
  assert.strictEqual(m.deviceNotificationPrefs.get('dev-1'), true);

  m._writeState();
  assert.ok(!('samples' in store.baseload_state.nightHistory[0]), 'rewrite drops samples from settings');
});

test('missing or corrupt sample file leaves the slim state usable', () => {
  const { m } = makeMonitor();
  m.nightHistory = nights();
  m._writeState();
  fs.writeFileSync(path.join(m.stateDir, 'baseload-samples.json'), '{ not json');

  const fresh = new BaseloadMonitor(m.homey);
  fresh.stateDir = m.stateDir;
  fresh._loadState();

  assert.strictEqual(fresh.nightHistory.length, 2, 'nights still load');
  assert.deepStrictEqual(fresh.nightHistory[0].samples, [], 'samples fall back to empty');
});

test('an unwritable state dir does not throw', () => {
  const { m, store } = makeMonitor();
  m.stateDir = '/proc/nonexistent-baseload-dir';
  m.nightHistory = nights();
  assert.doesNotThrow(() => m._writeState());
  assert.ok(store.baseload_state, 'settings write still happened');
});

console.log(`\nbaseload-state-split.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
