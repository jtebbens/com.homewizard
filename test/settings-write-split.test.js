'use strict';

// pvPredictionsRecent (300 PV samples, 12 fields each) rode along inside policy_last_run_debug.
// _queueSettingsPersist skips a write when the serialized value is byte-identical to the last one
// (device.js:341-342), but that check is per key: policy_last_run_debug changes every policy run
// through a handful of scalars (refillConfidence, reserveFloorPct, ...), so the ~45 kB array was
// re-serialized ~6.5x/hour even though it only mutates once per PV slot. settings.set is 79.9% of
// app allocation and cost scales with blob size (project_app_rss_step_0722), so the array now gets
// its own key and the existing dedupe can actually skip it.
//
// Contract covered here:
//   - policy_last_run_debug no longer carries pvPredictionsRecent
//   - policy_pv_predictions_recent carries the samples unchanged in shape
//   - an unchanged sample buffer is written ONCE across two runs that both change the debug blob
//     (this is the whole point — a smaller blob written just as often buys nothing)
//   - a new sample does produce a fresh write

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const PRED_KEY = 'policy_pv_predictions_recent';
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
// buffer is written as its own key, then the debug blob goes out.
function runPolicyCycle(ctx, { pvPredictions, refillConfidence }) {
  const debug = {
    pvAccuracySamples: pvPredictions.length,
    refillConfidence,
    reserveFloorPct: 15,
  };
  ctx._setLive(PRED_KEY, pvPredictions.slice(-300));
  ctx._setLive(DEBUG_KEY, debug);
  ctx._flushSettingsQueue();
  ctx._flushSettingsQueue();
}

const writesFor = (ctx, key) => ctx.writes.filter(w => w.key === key);

console.log('\npolicy_last_run_debug — pvPredictionsRecent split to its own key\n');

test('policy_last_run_debug no longer carries pvPredictionsRecent', () => {
  const ctx = makeCtx();
  runPolicyCycle(ctx, { pvPredictions: predictions(300), refillConfidence: 0.8 });
  const dbg = ctx._liveState[DEBUG_KEY];
  assert.ok(!('pvPredictionsRecent' in dbg), 'debug blob still holds the sample array');
});

test('policy_pv_predictions_recent holds the samples unchanged in shape', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.8 });
  const stored = ctx._liveState[PRED_KEY];
  assert.strictEqual(stored.length, 300);
  assert.deepStrictEqual(stored[0], preds[0]);
  assert.deepStrictEqual(stored[299], preds[299]);
});

test('unchanged sample buffer is written once across two runs that both change the debug blob', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.80 });
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.62 });
  assert.strictEqual(writesFor(ctx, DEBUG_KEY).length, 2, 'debug blob should be written both runs');
  assert.strictEqual(writesFor(ctx, PRED_KEY).length, 1, 'sample buffer should be deduped on run 2');
});

test('a new sample does produce a fresh write', () => {
  const ctx = makeCtx();
  const preds = predictions(300);
  runPolicyCycle(ctx, { pvPredictions: preds, refillConfidence: 0.80 });
  runPolicyCycle(ctx, { pvPredictions: [...preds, sample(300)], refillConfidence: 0.80 });
  assert.strictEqual(writesFor(ctx, PRED_KEY).length, 2);
});

// The four tests above drive _setLive directly, so they pass against the pre-split code too —
// they pin the dedupe contract, not the call site. These two bind to the production source, which
// is the only part that actually moved (the debug blob is assembled inline in a ~300-line method;
// extracting it just to make it callable would be a bigger change than the fix itself).
const deviceSrc = fs.readFileSync(path.join(__dirname, '../drivers/battery-policy/device.js'), 'utf8');

test('device.js no longer assigns pvPredictionsRecent into the debug blob', () => {
  assert.ok(!/result\.debug\.pvPredictionsRecent\s*=/.test(deviceSrc),
    'result.debug.pvPredictionsRecent assignment still present');
});

test('device.js writes the samples as their own settings key', () => {
  assert.ok(new RegExp(`_setLive\\(\\s*'${PRED_KEY}'`).test(deviceSrc),
    `no _setLive('${PRED_KEY}', ...) call site found`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
