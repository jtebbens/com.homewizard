'use strict';

// getModelWeights() guard (OM submodel blend weighting).
//
// Measured 2026-06-20 (8 days, n=396): per-submodel accuracy rank rotates daily
// — no model is consistently best — so the old harsh [6,3,1,0] bucket chased
// noise (gfs swung 30%↔0%) and matched plain equal-weight in mean AND tail.
// The weighting was softened to [4,3,2,1]: keep a mild tilt toward the better-
// ranked models, but never zero a model (so a momentarily-bottom model still
// contributes and the blend keeps its diversification). These invariants pin
// that contract — a future tweak that re-introduces a zero or breaks the
// normalisation will fail here. See project_om_submodel_ema.

const assert = require('assert');
const LearningEngine = require('../lib/learning-engine');

const MODELS = ['meteofrance_arpege_europe', 'gfs_seamless', 'icon_seamless', 'knmi_harmonie_arome_netherlands'];

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

function makeEngine(acc) {
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = { pv_model_accuracy: acc };
  return engine;
}

const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);

// distinct accuracies, known order: icon > gfs > knmi > mf
const acc = {
  meteofrance_arpege_europe: 50,
  gfs_seamless: 80,
  icon_seamless: 90,
  knmi_harmonie_arome_netherlands: 60,
};

test('weights sum to 1', () => {
  const w = makeEngine(acc).getModelWeights();
  assert.ok(Math.abs(sum(w) - 1) < 1e-9, `sum=${sum(w)}`);
});

test('no model is ever zeroed (every weight > 0)', () => {
  const w = makeEngine(acc).getModelWeights();
  for (const m of MODELS) assert.ok(w[m] > 0, `${m} got ${w[m]}`);
});

test('weight set is exactly [4,3,2,1]/10 permuted', () => {
  const w = makeEngine(acc).getModelWeights();
  const got = Object.values(w).sort((a, b) => a - b);
  assert.deepStrictEqual(got.map(x => Math.round(x * 10)), [1, 2, 3, 4]);
});

test('best accuracy → highest weight, worst → lowest', () => {
  const w = makeEngine(acc).getModelWeights();
  assert.strictEqual(w.icon_seamless, 0.4, 'best=icon should be 0.4');
  assert.strictEqual(w.gfs_seamless, 0.3);
  assert.strictEqual(w.knmi_harmonie_arome_netherlands, 0.2);
  assert.strictEqual(w.meteofrance_arpege_europe, 0.1, 'worst=mf should be 0.1');
});

test('ranking is monotone in accuracy', () => {
  const w = makeEngine(acc).getModelWeights();
  const order = [...MODELS].sort((a, b) => acc[b] - acc[a]);
  for (let i = 1; i < order.length; i++) {
    assert.ok(w[order[i - 1]] >= w[order[i]], `${order[i-1]} >= ${order[i]}`);
  }
});

test('missing accuracy falls back to prior, still valid weights', () => {
  const w = makeEngine(undefined).getModelWeights();
  assert.ok(Math.abs(sum(w) - 1) < 1e-9);
  for (const m of MODELS) assert.ok(w[m] > 0);
});

console.log(`\nmodel-weights: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
