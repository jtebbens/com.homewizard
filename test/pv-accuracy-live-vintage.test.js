'use strict';

// pv_accuracy_score is scored against _pvDayStartForecast — a snapshot frozen once per day
// (device.js, "_pvDayStartForecastDate !== _pvSnapDate"). That vintage was a deliberate choice
// (de8e9eb, 2026-05-10: "avoid degrading the score when providers revise the forecast mid-day")
// and remains a valid PLANNING-accuracy metric.
//
// But the same score gates a discount on the LIVE forecast heading into the DP (device.js,
// "PV conservatism"), so that consumer needs the live vintage instead. This adds a second EMA,
// pv_accuracy_score_live, fed from the same slot of the un-frozen blended forecast
// (_pvForecastBlended). Shadow only — no gate is rewired here.
//
// Guards: both EMAs share one formula/alpha, the live one actually rises when a provider
// revises toward truth mid-day (the exact case the snapshot was introduced for), the existing
// day-start EMA is untouched when no live value is supplied, and samples the day-start early
// return drops are counted rather than silently lost.

const assert = require('assert');
const Module = require('module');

const LearningEngine = require('../lib/learning-engine');

// Stub 'homey' + heavy device-deps so battery-policy/device.js loads outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const OptimizationEngine = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEngine() {
  // Case B loops past the 10-call save throttle, so the device needs a store stub.
  const engine = new LearningEngine({ log: () => {} }, { setStoreValue: async () => {} });
  engine.data = {
    pv_predictions: [],
    pv_accuracy_score: 0.8,
    pv_accuracy_score_live: 0.8,
    pv_accuracy_om: 0.8,
    pv_accuracy_sc: 0.8,
    pv_accuracy_sat: 0.8,
  };
  return engine;
}

// Same bounded-error EMA the engine uses, recomputed here only to assert the engine's
// arithmetic — not a second implementation feeding production.
function expectedEma(prev, valueW, actualW, alpha = 0.1) {
  const err = Math.abs(actualW - valueW) / Math.max(actualW, valueW, 1);
  return (alpha * (1 - err)) + ((1 - alpha) * prev);
}

(async () => {
  // ── A. Both EMAs update, one shared formula/alpha ────────────────────────────
  {
    const engine = makeEngine();
    // day-start says 300W, live blend says 480W, actual is 500W → live is closer.
    await engine.recordPvAccuracy(300, 500, null, null, null, null, null, 480);

    test('day-start EMA uses predictedW', () => {
      assert.strictEqual(engine.data.pv_accuracy_score, expectedEma(0.8, 300, 500));
    });
    test('live EMA uses predictedLiveW', () => {
      assert.strictEqual(engine.data.pv_accuracy_score_live, expectedEma(0.8, 480, 500));
    });
    test('closer live forecast scores higher than day-start', () => {
      assert.ok(engine.data.pv_accuracy_score_live > engine.data.pv_accuracy_score,
        `live ${engine.data.pv_accuracy_score_live} !> daystart ${engine.data.pv_accuracy_score}`);
    });
    test('raw live value stored on the prediction row for offline replay', () => {
      assert.strictEqual(engine.data.pv_predictions[0].predictedLive, 480);
    });
  }

  // ── B. Mid-day revision: the exact case the day-start snapshot was introduced for ──
  // Morning forecast calls for heavy cloud (200W); by midday the providers have revised
  // up toward what actually happens (900W). The frozen snapshot keeps being scored against
  // a forecast nobody is planning on any more; the live vintage tracks the revision.
  {
    const engine = makeEngine();
    for (let i = 0; i < 20; i++) {
      await engine.recordPvAccuracy(200, 900, null, null, null, null, null, 880);
    }
    test('mid-day revision: live EMA ends above day-start EMA', () => {
      assert.ok(engine.data.pv_accuracy_score_live > engine.data.pv_accuracy_score,
        `live ${engine.data.pv_accuracy_score_live} !> daystart ${engine.data.pv_accuracy_score}`);
    });
    test('mid-day revision: day-start EMA is dragged below the 0.80 gate threshold', () => {
      assert.ok(engine.data.pv_accuracy_score < 0.80,
        `expected day-start < 0.80, got ${engine.data.pv_accuracy_score}`);
    });
    test('mid-day revision: live EMA stays above the 0.80 gate threshold', () => {
      assert.ok(engine.data.pv_accuracy_score_live > 0.80,
        `expected live > 0.80, got ${engine.data.pv_accuracy_score_live}`);
    });
  }

  // ── C. Backwards compatible: no live value → day-start behaviour unchanged ───
  {
    const engine = makeEngine();
    await engine.recordPvAccuracy(300, 500, null, null, null, null);

    test('predictedLiveW omitted: day-start EMA still updates', () => {
      assert.strictEqual(engine.data.pv_accuracy_score, expectedEma(0.8, 300, 500));
    });
    test('predictedLiveW omitted: live EMA untouched', () => {
      assert.strictEqual(engine.data.pv_accuracy_score_live, 0.8);
    });
    test('predictedLiveW omitted: prediction row carries null', () => {
      assert.strictEqual(engine.data.pv_predictions[0].predictedLive, null);
    });
  }

  // ── D. n_liveOnly: samples the day-start early return drops must be counted ──
  // device.js returns early when the DAY-START value is <=50W. On a slot where the
  // morning forecast said ~nothing but the live blend sees real production, that drop
  // silently removes exactly the samples where the live vintage proves its worth. The
  // counter makes that blind spot measurable instead of invisible.
  {
    // Wall-clock relative on purpose: _recordPvAccuracySample drops samples whose PV reading
    // is >20 min old, and that age is measured against Date.now() — a hardcoded date would
    // pass on the day it was written and rot into a failure every day after.
    const nowMs = Date.now();
    const slot = w => [{ timestamp: new Date(nowMs).toISOString(), pvPowerW: w }];

    const makeCtx = (dayStartW, liveW) => {
      const recorded = [];
      return {
        ctx: {
          learningEngine: { recordPvAccuracy: (...a) => { recorded.push(a); return Promise.resolve(); } },
          optimizationEngine: new OptimizationEngine({ log: () => {} }),
          _pvProductionW: 500,
          _pvProductionTimestamp: nowMs,
          _pvDayStartForecast: slot(dayStartW),
          _pvForecastBlended: slot(liveW),
          _pvForecastOM: null,
          _pvForecastSC: null,
          _pvForecastPerModel: null,
          weatherData: null,
          weatherForecaster: null,
          _correctOverlayW: w => w,
          _pvDayCorrectionFactor: 1.0,
          _lastIntradayPvRatio: 1.0,
          log: () => {},
          error: () => {},
        },
        recorded,
      };
    };

    // Day-start ~0 (morning said overcast), live blend sees 480W, actual 500W.
    const dropped = makeCtx(10, 480);
    BatteryPolicyDevice.prototype._recordPvAccuracySample.call(dropped.ctx, new Date(nowMs), null);
    test('day-start below threshold: no accuracy sample recorded (unchanged)', () => {
      assert.strictEqual(dropped.recorded.length, 0);
    });
    test('day-start below threshold: counted as live-only blind spot', () => {
      assert.strictEqual(dropped.ctx._pvAccLiveOnlyCount, 1);
    });

    // Both usable → normal path, counter must NOT move.
    const kept = makeCtx(300, 480);
    BatteryPolicyDevice.prototype._recordPvAccuracySample.call(kept.ctx, new Date(nowMs), null);
    test('both usable: sample recorded', () => {
      assert.strictEqual(kept.recorded.length, 1);
    });
    test('both usable: live value passed through as 8th arg', () => {
      assert.strictEqual(kept.recorded[0][7], 480);
    });
    test('both usable: blind-spot counter not incremented', () => {
      assert.ok(!kept.ctx._pvAccLiveOnlyCount, `expected 0/undefined, got ${kept.ctx._pvAccLiveOnlyCount}`);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
