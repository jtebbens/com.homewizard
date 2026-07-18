'use strict';

// Regression: min_confidence_threshold = 0 was silently replaced by 55.
//
// _applyRecommendation resolved the setting with `|| 55`, which treats a legitimate 0 as
// "unset". The schema allows 0 (min: 0, driver.settings.compose.json), and 0 means "never
// gate on confidence" — a deliberate choice a user can make. With `||` that choice was
// discarded and the gate kept refusing at 55, while the caller's log line (which resolved
// the same setting with `?? 60`) reported a different threshold again.
//
// Two call sites, two different defaults (60 and 55), neither matching each other; the
// schema default is 55. Pin both the behaviour and the agreement.

const assert = require('assert');
const Module = require('module');
const fs = require('fs');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

let passed = 0;
let failed = 0;
const queue = [];

// Tests here are async (_applyRecommendation is), so they MUST be awaited — a fire-and-forget
// runner reports a pass before the assertions inside the promise have run, which is the same
// vacuous-green failure this file exists to prevent.
function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  });
}

// Minimal context: the confidence gate is the first thing _applyRecommendation does, and the
// missing p1Device right after it gives a distinguishable second exit. Which of the two fired
// tells us whether the gate rejected the call.
function makeCtx(thresholdSetting) {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    getSetting: () => thresholdSetting,
    log: (m) => logs.push(String(m)),
    error: (m) => errors.push(String(m)),
    p1Device: null,
  };
}

const applyRecommendation = BatteryPolicyDevice.prototype._applyRecommendation;

console.log('Confidence threshold resolution:');

test('threshold 0 means no gating — a low-confidence call is NOT refused', async () => {
  const ctx = makeCtx(0);
  await applyRecommendation.call(ctx, 'to_full', 30);
  const gated = ctx.logs.some(l => l.includes('below threshold'));
  assert.strictEqual(gated, false,
    `threshold 0 must not gate, but got: ${ctx.logs.join(' | ')}`);
  assert.ok(ctx.errors.some(e => e.includes('No P1 device')),
    'should have passed the gate and stopped at the missing P1 device instead');
});

test('an unset threshold falls back to the schema default (55)', async () => {
  const ctx = makeCtx(undefined);
  await applyRecommendation.call(ctx, 'to_full', 30);
  assert.ok(ctx.logs.some(l => l.includes('below threshold 55')),
    `expected the schema default 55, got: ${ctx.logs.join(' | ')}`);
});

test('a real threshold still gates below it and passes above it', async () => {
  const low = makeCtx(80);
  await applyRecommendation.call(low, 'to_full', 70);
  assert.ok(low.logs.some(l => l.includes('below threshold 80')), 'must gate at 70 < 80');

  const high = makeCtx(80);
  await applyRecommendation.call(high, 'to_full', 90);
  assert.ok(!high.logs.some(l => l.includes('below threshold')), 'must not gate at 90 > 80');
});

test('force bypasses the gate regardless of threshold', async () => {
  const ctx = makeCtx(99);
  await applyRecommendation.call(ctx, 'to_full', 10, { force: true });
  assert.ok(!ctx.logs.some(l => l.includes('below threshold')), 'force must skip the gate');
});

// The caller resolves the SAME setting a second time purely to phrase its log line. When the
// two disagree, the log explains a refusal with a threshold that did not cause it.
test('WIRING: both call sites resolve the setting with the same default', () => {
  const src = fs.readFileSync(require.resolve('../drivers/battery-policy/device.js'), 'utf8');
  const defaults = [...src.matchAll(/getSetting\('min_confidence_threshold'\)\s*(\?\?|\|\|)\s*(\d+)/g)]
    .map(m => ({ op: m[1], val: m[2] }));

  assert.ok(defaults.length >= 2, `expected both call sites, found ${defaults.length}`);
  const vals = new Set(defaults.map(d => d.val));
  assert.strictEqual(vals.size, 1,
    `call sites disagree on the default: ${[...vals].join(' vs ')}`);
  assert.strictEqual([...vals][0], '55', 'the default must match the schema (55)');
  assert.ok(defaults.every(d => d.op === '??'),
    '|| discards a legitimate 0 — use ?? so an explicit "never gate" survives');
});

// Fossil guard: getConfidenceAdjustment averaged the app's OWN past confidence values with no
// outcome feedback, and predates the DP by a month (added 2026-02-14, DP 2026-03-15, confidence
// hardcoded to 90 on 2026-04-13). On the DP path its input stopped varying, so it emitted a
// constant +2.2 into a gate that has never fired. Removed 2026-07-18 — do not reintroduce
// without real outcome feedback.
test('the circular confidence-learning loop stays removed', () => {
  // Match live code only — both files carry a comment naming the function to explain why it
  // went, and that comment is the point. Strip comments before asserting.
  const strip = (p) => fs.readFileSync(require.resolve(p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  assert.ok(!/\.getConfidenceAdjustment\s*\(/.test(strip('../drivers/battery-policy/device.js')),
    'device.js must not call the removed self-referential confidence loop');
  assert.ok(!/^\s*getConfidenceAdjustment\s*\(/m.test(strip('../lib/learning-engine.js')),
    'learning-engine.js must not redefine the removed self-referential confidence loop');
});

(async () => {
  for (const t of queue) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
