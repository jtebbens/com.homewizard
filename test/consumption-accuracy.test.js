'use strict';

// Consumption forecast accuracy tracking (observe-only).
//
// Mirrors recordPvAccuracy's error/EMA convention. The consumption side had no
// predicted-vs-actual tracking at all, so "is the load forecast getting better?"
// was unanswerable. These tests pin the contract: the EMA moves as specified, the
// guards reject unusable samples, and hourly buckets key on Amsterdam local time
// (Homey's getHours() returns UTC — the bucket must not silently follow it).

const assert = require('assert');
const LearningEngine = require('../lib/learning-engine');

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

function makeEngine(score = 0.8) {
  const e = new LearningEngine({ log: () => {} }, {});
  e.data = {
    consumption_accuracy_score: score,
    consumption_accuracy_hourly: {},
  };
  e._saveData = async () => {};
  return e;
}

console.log('Consumption accuracy tracking:');

test('perfect prediction lifts the score toward 1.0', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(500, 500, new Date('2026-07-17T10:30:00Z'));
  // error 0 → accuracy 1.0 → 0.8 + 0.1*(1.0-0.8) = 0.82
  assert.ok(Math.abs(e.data.consumption_accuracy_score - 0.82) < 1e-9,
    `expected 0.82, got ${e.data.consumption_accuracy_score}`);
});

test('bad prediction lowers the score by exactly alpha*delta (alpha=0.1)', () => {
  const e = makeEngine(0.8);
  // predicted 400, actual 2000 → denom 2000, error 0.8 → accuracy 0.2
  e.recordConsumptionAccuracy(400, 2000, new Date('2026-07-17T10:30:00Z'));
  const expected = 0.8 + 0.1 * (0.2 - 0.8); // 0.74
  assert.ok(Math.abs(e.data.consumption_accuracy_score - expected) < 1e-9,
    `expected ${expected}, got ${e.data.consumption_accuracy_score}`);
});

test('guard: actual <= 50W is not a sample (score unchanged)', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(400, 30, new Date('2026-07-17T10:30:00Z'));
  assert.strictEqual(e.data.consumption_accuracy_score, 0.8);
  assert.deepStrictEqual(e.data.consumption_accuracy_hourly, {});
});

test('guard: null/NaN predicted is not a sample (score unchanged)', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(null, 500, new Date('2026-07-17T10:30:00Z'));
  e.recordConsumptionAccuracy(NaN, 500, new Date('2026-07-17T10:30:00Z'));
  e.recordConsumptionAccuracy(0, 500, new Date('2026-07-17T10:30:00Z'));
  assert.strictEqual(e.data.consumption_accuracy_score, 0.8);
});

test('hourly bucket keys on Amsterdam local time, not UTC', () => {
  const e = makeEngine(0.8);
  // 23:30 UTC in July = 01:30 CEST the next day → bucket 1, never 23.
  e.recordConsumptionAccuracy(400, 500, new Date('2026-07-17T23:30:00Z'));
  assert.ok(e.data.consumption_accuracy_hourly[1], 'expected bucket 1 (Amsterdam) to exist');
  assert.ok(!e.data.consumption_accuracy_hourly[23], 'bucket 23 (UTC) must not be used');
});

test('hourly bucket keys correctly in winter (CET, +1)', () => {
  const e = makeEngine(0.8);
  // 23:30 UTC in January = 00:30 CET next day → bucket 0.
  e.recordConsumptionAccuracy(400, 500, new Date('2026-01-17T23:30:00Z'));
  assert.ok(e.data.consumption_accuracy_hourly[0], 'expected bucket 0 (Amsterdam winter)');
});

test('bias sign: actual > predicted means under-forecast (positive bias)', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(400, 900, new Date('2026-07-17T10:30:00Z'));
  const b = e.data.consumption_accuracy_hourly[12];
  assert.ok(b, 'expected bucket 12 (12:30 CEST)');
  assert.ok(b.emaBiasW > 0, `expected positive bias, got ${b.emaBiasW}`);
});

test('bias sign: actual < predicted means over-forecast (negative bias)', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(900, 400, new Date('2026-07-17T10:30:00Z'));
  assert.ok(e.data.consumption_accuracy_hourly[12].emaBiasW < 0);
});

test('hourly abs-error EMA accumulates and counts samples', () => {
  const e = makeEngine(0.8);
  const ts = new Date('2026-07-17T10:30:00Z');
  e.recordConsumptionAccuracy(400, 900, ts); // absErr 500
  e.recordConsumptionAccuracy(400, 900, ts);
  const b = e.data.consumption_accuracy_hourly[12];
  assert.strictEqual(b.count, 2);
  assert.ok(b.emaAbsErrW > 0 && b.emaAbsErrW <= 500,
    `abs-err EMA should be within (0,500], got ${b.emaAbsErrW}`);
});

test('first sample of a bucket seeds the EMA rather than dragging from zero', () => {
  const e = makeEngine(0.8);
  e.recordConsumptionAccuracy(400, 900, new Date('2026-07-17T10:30:00Z'));
  const b = e.data.consumption_accuracy_hourly[12];
  // Seeded → equals the observation, not alpha*500.
  assert.strictEqual(b.emaAbsErrW, 500);
  assert.strictEqual(b.emaBiasW, 500);
});

test('returns true when a sample lands, false when a guard rejects it', () => {
  const e = makeEngine(0.8);
  const ts = new Date('2026-07-17T10:30:00Z');
  assert.strictEqual(e.recordConsumptionAccuracy(400, 900, ts), true);
  // The caller marks its 15-min bucket done only on true — a rejected sample must not
  // consume the bucket, or the P1-zero right after a restart locks out the real one.
  assert.strictEqual(e.recordConsumptionAccuracy(400, 0, ts), false, 'actual=0 → false');
  assert.strictEqual(e.recordConsumptionAccuracy(null, 900, ts), false, 'predicted null → false');
  assert.strictEqual(e.recordConsumptionAccuracy(0, 900, ts), false, 'predicted 0 → false');
});

test('missing hourly container is created (existing stores have no such field)', () => {
  const e = new LearningEngine({ log: () => {} }, {});
  e.data = { consumption_accuracy_score: 0.8 }; // no consumption_accuracy_hourly
  e._saveData = async () => {};
  e.recordConsumptionAccuracy(400, 900, new Date('2026-07-17T10:30:00Z'));
  assert.ok(e.data.consumption_accuracy_hourly[12], 'must self-initialise the container');
});

test('persists on a throttle (every 4th sample), not on every one', () => {
  const e = makeEngine(0.8);
  let saves = 0;
  e._saveData = async () => { saves++; };
  const ts = new Date('2026-07-17T10:30:00Z');
  for (let i = 0; i < 3; i++) e.recordConsumptionAccuracy(400, 900, ts);
  assert.strictEqual(saves, 0, 'must not hit the store on every sample');
  e.recordConsumptionAccuracy(400, 900, ts);
  assert.strictEqual(saves, 1, '4th sample persists');
  for (let i = 0; i < 4; i++) e.recordConsumptionAccuracy(400, 900, ts);
  assert.strictEqual(saves, 2, '8th sample persists');
});

test('rejected samples do not advance the persist counter', () => {
  const e = makeEngine(0.8);
  let saves = 0;
  e._saveData = async () => { saves++; };
  const ts = new Date('2026-07-17T10:30:00Z');
  for (let i = 0; i < 8; i++) e.recordConsumptionAccuracy(400, 0, ts); // all guarded out
  assert.strictEqual(saves, 0, 'guarded samples must not trigger a store write');
});

test('a failing store write does not throw into the caller', () => {
  const e = makeEngine(0.8);
  e._saveData = async () => { throw new Error('store unavailable'); };
  const ts = new Date('2026-07-17T10:30:00Z');
  assert.doesNotThrow(() => {
    for (let i = 0; i < 4; i++) e.recordConsumptionAccuracy(400, 900, ts);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
