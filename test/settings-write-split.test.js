'use strict';

// pvPredictionsRecent (300 PV samples, 12 fields each) rode along inside policy_last_run_debug.
// _queueSettingsPersist skips a write when the serialized value is byte-identical to the last one
// (device.js:341-342), but that check is per key: policy_last_run_debug changes every policy run
// through a handful of scalars (refillConfidence, reserveFloorPct, ...), so the ~45 kB array was
// re-serialized ~6.5x/hour even though it only mutates once per PV slot. settings.set is 79.9% of
// app allocation and cost scales with blob size (project_app_rss_step_0722), so the array now gets
// its own key and the existing dedupe can actually skip it.
//
// 2026-08-02: the own-key step is superseded. A key of its own still rode along in the settings
// object, and the SDK ships that object WHOLE on every set() — so the dedupe saved a re-serialize
// of 50 kB but nothing else's write got cheaper. The buffer now lives on /userdata and nothing in
// the UI reads it; the same stamp guard survives as a flash-write guard, not a blob guard.
//
// Contract covered here:
//   - policy_last_run_debug no longer carries pvPredictionsRecent
//   - the sample buffer never reaches the settings blob at all
//   - it round-trips through /userdata unchanged in shape
//   - an unchanged buffer is NOT rewritten; a new sample is
//   - the debug blob itself still goes through settings, and still dedupes

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// userdata-store reads process.env per call, so the tests can point it at a tmpdir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-predsplit-'));
process.env.HOMEY_USERDATA_DIR = tmpDir;
const userdataStore = require('../lib/userdata-store');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const PRED_KEY = 'policy_pv_predictions_recent'; // the settings key it must no longer use
const PRED_FILE = 'pv-predictions-recent';       // the /userdata sink it uses instead
const DEBUG_KEY = 'policy_last_run_debug';

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

// Real _setLive / _queueSettingsPersist / _flushSettingsQueue — the dedupe under test lives there.
// Only homey.settings.set, the flush timer and the heap probe are faked. writes[] records every
// call that actually reached settings.set, which is what the byte accounting measures on-device.
function makeCtx() {
  const store = {};
  const writes = [];
  const ctx = Object.assign(Object.create(BatteryPolicyDevice.prototype), {
    writes,
    _liveState: {},
    homey: {
      settings: {
        get: k => (k in store ? store[k] : null),
        set: (k, v) => { store[k] = v; writes.push({ key: k, bytes: JSON.stringify(v).length }); },
      },
      // Flush synchronously: the 8 s stagger is cadence, not part of the dedupe contract.
      setTimeout: fn => { fn(); return 1; },
    },
    log() {},
    error() {},
  });
  return ctx;
}

const sample = i => ({
  timestamp: new Date(Date.UTC(2026, 6, 30, 6, 0, 0) + i * 900_000).toISOString(),
  predicted: 1200 + i, actual: 1150 + i, om: 1180 + i, sc: 1210 + i,
  error: 0.0416666666666667, mf: 1190 + i, gfs: 1205 + i, icon: 1170 + i,
  knmi: 1195 + i, ecmwf: 1188 + i, sat: 1160 + i,
});
const predictions = n => Array.from({ length: n }, (_, i) => sample(i));

// Mirrors the production call order at device.js:2325-2371: the debug blob is built, the sample
// buffer goes to /userdata, then the debug blob goes out over settings. Both calls are the real
// production methods — the guard is not re-implemented here.
function runPolicyCycle(ctx, { pvPredictions, refillConfidence }) {
  const debug = {
    pvAccuracySamples: pvPredictions.length,
    refillConfidence,
    reserveFloorPct: 15,
  };
  ctx._persistPvPredictions(pvPredictions.slice(-300));
  ctx._setLive(DEBUG_KEY, debug);
  ctx._flushSettingsQueue();
  ctx._flushSettingsQueue();
}

const writesFor = (ctx, key) => ctx.writes.filter(w => w.key === key);

console.log('\nPV sample buffer — out of the settings blob, onto /userdata\n');

test('policy_last_run_debug no longer carries pvPredictionsRecent', () => {
  const ctx = makeCtx();
  runPolicyCycle(ctx, { pvPredictions: predictions(300), refillConfidence: 0.8 });
  const dbg = ctx._liveState[DEBUG_KEY];
  assert.ok(!('pvPredictionsRecent' in dbg), 'debug blob still holds the sample array');
});

test('the sample buffer never reaches the settings blob', () => {
  const ctx = makeCtx();
  runPolicyCycle(ctx, { pvPredictions: predictions(300), refillConfidence: 0.8 });
  assert.strictEqual(writesFor(ctx, PRED_KEY).length, 0, `${PRED_KEY} was written to settings`);
  assert.ok(!(PRED_KEY in ctx._liveState), `${PRED_KEY} still cached in _liveState`);
});

test('the buffer round-trips through /userdata unchanged in shape', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.8 });
  const stored = userdataStore.readJson(PRED_FILE);
  assert.strictEqual(stored.length, 300);
  assert.deepStrictEqual(stored[0], preds[0]);
  assert.deepStrictEqual(stored[299], preds[299]);
});

test('an unchanged buffer is not rewritten across two runs that both change the debug blob', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.80 });
  const firstMtime = fs.statSync(path.join(tmpDir, `${PRED_FILE}.json`)).mtimeNs;
  const rewrote = ctx._persistPvPredictions(preds.slice(-300));
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.62 });
  assert.strictEqual(rewrote, false, 'guard let an identical buffer through');
  assert.strictEqual(fs.statSync(path.join(tmpDir, `${PRED_FILE}.json`)).mtimeNs, firstMtime,
    'file was rewritten for an unchanged buffer');
  assert.strictEqual(writesFor(ctx, DEBUG_KEY).length, 2, 'debug blob should be written both runs');
});

test('a new sample does produce a fresh write', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.80 });
  assert.strictEqual(ctx._persistPvPredictions([...preds, sample(300)].slice(-300)), true);
  assert.strictEqual(userdataStore.readJson(PRED_FILE)[299].timestamp, sample(300).timestamp);
});

test('a failed write does not arm the guard, so the next run retries', () => {
  const ctx = makeCtx();
  const preds = predictions(4);
  process.env.HOMEY_USERDATA_DIR = path.join(tmpDir, 'does-not-exist');
  assert.strictEqual(ctx._persistPvPredictions(preds), false);
  process.env.HOMEY_USERDATA_DIR = tmpDir;
  assert.strictEqual(ctx._persistPvPredictions(preds), true, 'guard armed on a failed write');
});

// The tests above drive the production methods directly, so they pin the contract, not the call
// site. These two bind to the production source, which is the part that actually moved (the debug
// blob is assembled inline in a ~300-line method; extracting it just to make it callable would be
// a bigger change than the fix itself).
const deviceSrc = fs.readFileSync(path.join(__dirname, '../drivers/battery-policy/device.js'), 'utf8');

test('device.js no longer assigns pvPredictionsRecent into the debug blob', () => {
  assert.ok(!/result\.debug\.pvPredictionsRecent\s*=/.test(deviceSrc),
    'result.debug.pvPredictionsRecent assignment still present');
});

test('device.js persists the samples via /userdata, not via a settings key', () => {
  assert.ok(!new RegExp(`_setLive\\(\\s*'${PRED_KEY}'`).test(deviceSrc),
    `_setLive('${PRED_KEY}', ...) call site is still there`);
  assert.ok(/this\._persistPvPredictions\(/.test(deviceSrc),
    'no _persistPvPredictions(...) call site found');
});

// 2026-08-31: learning_pv_chart_data carried a SECOND copy of the same buffer —
// pv_predictions.slice(-864) next to the slice(-300) above it. learning-engine.js:794 caps the
// source at 300, so the two slices were byte-identical: 59.5 kB of duplicate, 20% of a 292 kB blob,
// shipped on every unrelated settings.set(). The key keeps modelAcc (5 scalars) and the settings
// page now reads the array from the /userdata file that already holds it.
const CHART_KEY = 'learning_pv_chart_data';
const settingsSrc = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');

test('learning_pv_chart_data no longer carries the sample array', () => {
  assert.ok(!/_setLive\('learning_pv_chart_data',\s*\{[^}]*pvPredictions/.test(deviceSrc),
    `${CHART_KEY} is still written with pvPredictions in its payload`);
  assert.ok(new RegExp(`_setLive\\('${CHART_KEY}',`).test(deviceSrc),
    `${CHART_KEY} write site disappeared entirely — modelAcc must survive`);
});

test('device.js no longer takes a second slice of the prediction buffer', () => {
  assert.ok(!/pv_predictions\?\.slice\(-864\)/.test(deviceSrc),
    'the slice(-864) duplicate of the sample buffer is still there');
});

test('the settings page reads the samples from /userdata, not from the settings key', () => {
  assert.ok(settingsSrc.includes(`/app/com.homewizard/userdata/${PRED_FILE}.json`),
    `settings page never fetches ${PRED_FILE}.json`);
  assert.ok(!/const \{ pvPredictions, modelAcc \} = pvc/.test(settingsSrc),
    'settings page still destructures pvPredictions out of the settings key');
});

test('app.js drops the stale settings key on boot, not only on a version change', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const migrateBlock = appSrc.slice(0, appSrc.indexOf('_runSettingsMigration(currentVersion)'));
  assert.ok(appSrc.includes(PRED_KEY), `app.js never mentions ${PRED_KEY}`);
  assert.ok(!migrateBlock.includes(PRED_KEY),
    `${PRED_KEY} is unset before the version-change branch — it must be unconditional, after it`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
