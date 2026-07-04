'use strict';

// recordPvAccuracy() must score Open-Meteo/Solcast/Satellite over the SAME
// sample set, or the three settings-page accuracy pills aren't comparable.
// Satellite coverage is inherently narrower (SAT_YIELD_FACTORS UTC4-18 +
// forward-only guard in weather-forecaster.js, both correct and untouched
// here) — so OM/SC must also require a valid satW>50 reading before their
// own accuracy EMA updates, matching sat's existing >50 threshold.
// See project_running_experiments_tracker / user-flagged 2026-07-04.

const assert = require('assert');
const LearningEngine = require('../lib/learning-engine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEngine() {
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {
    pv_predictions: [],
    pv_accuracy_score: 0.8,
    pv_accuracy_om: 0.8,
    pv_accuracy_sc: 0.8,
    pv_accuracy_sat: 0.8,
  };
  return engine;
}

(async () => {
  // Case A: satW missing → om/sc must NOT update (the core fix)
  {
    const engine = makeEngine();
    await engine.recordPvAccuracy(200, 200, 200, 200, null, null);
    test('satW=null: pv_accuracy_om unchanged', () => {
      assert.strictEqual(engine.data.pv_accuracy_om, 0.8);
    });
    test('satW=null: pv_accuracy_sc unchanged', () => {
      assert.strictEqual(engine.data.pv_accuracy_sc, 0.8);
    });
  }

  // Case B: all three present and >50W → all three update
  {
    const engine = makeEngine();
    await engine.recordPvAccuracy(200, 200, 200, 200, null, 200);
    test('satW=200: pv_accuracy_om updates', () => {
      assert.notStrictEqual(engine.data.pv_accuracy_om, 0.8);
    });
    test('satW=200: pv_accuracy_sc updates', () => {
      assert.notStrictEqual(engine.data.pv_accuracy_sc, 0.8);
    });
    test('satW=200: pv_accuracy_sat updates', () => {
      assert.notStrictEqual(engine.data.pv_accuracy_sat, 0.8);
    });
  }

  // Case C: om's own <50W gate still applies independently of the new satW condition
  {
    const engine = makeEngine();
    await engine.recordPvAccuracy(200, 200, 30, 200, null, 200);
    test('omW=30 (own gate): pv_accuracy_om unchanged', () => {
      assert.strictEqual(engine.data.pv_accuracy_om, 0.8);
    });
    test('omW=30 (own gate): pv_accuracy_sc still updates', () => {
      assert.notStrictEqual(engine.data.pv_accuracy_sc, 0.8);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
