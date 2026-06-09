'use strict';

// Refill-reserve confidence derivation: maps the same-day PV forecast error
// (consistency `cv` + bias-corrected magnitude `ratio` = actual/post-bias) to a
// 0–1 confidence. Low confidence engages the overnight reserve floor (see
// dp-refill-reserve.test.js for the floor behaviour given a confidence value).
//
// The bug this guards: a CONSISTENTLY over-optimistic PV forecast (ratio≈0.5,
// low cv) used to yield confidence 1.0 → no reserve → battery drained to 0%
// overnight → forced expensive morning grid top-up. The ratio downside term
// now lowers confidence so the floor engages.

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

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

const f = OptimizationEngine.refillConfidenceFromForecast.bind(OptimizationEngine);
const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

// ── Bug reproduction: consistent over-optimistic forecast → low confidence ───
test('low cv + PV under-delivery (ratio 0.5) → confidence ~0.5 (floor engages)', () => {
  const c = f(0.10, 0.50);
  assert.ok(approx(c, 0.50), `expected ~0.50, got ${c.toFixed(3)}`);
});

// ── Over-delivery is upside, never penalised ─────────────────────────────────
test('PV over-delivery (ratio 1.2) → confidence 1.0 (no floor)', () => {
  assert.strictEqual(f(0.10, 1.20), 1.0);
});

// ── Cold start (no ratio yet) → full confidence, no floor ────────────────────
test('ratio undefined → confidence from cv only', () => {
  assert.strictEqual(f(0.10, undefined), 1.0);
});

// ── CV term unchanged when PV met forecast (ratio 1.0) ── regression ──────────
test('cv 0.50, ratio 1.0 → confidence ~0.29 (cv term intact)', () => {
  const c = f(0.50, 1.0);
  assert.ok(approx(c, (0.60 - 0.50) / 0.35), `expected ~0.29, got ${c.toFixed(3)}`);
});

// ── Cold start: cv and ratio co-set, both absent → full confidence ───────────
test('cv & ratio undefined (cold start) → confidence 1.0', () => {
  assert.strictEqual(f(undefined, undefined), 1.0);
});

// ── Compound: volatile AND under-delivering → both terms multiply ────────────
test('cv 0.40, ratio 0.5 → cv-term × ratio', () => {
  const cvTerm = (0.60 - 0.40) / 0.35; // ≈0.571
  const c = f(0.40, 0.50);
  assert.ok(approx(c, cvTerm * 0.50), `expected ~${(cvTerm * 0.5).toFixed(3)}, got ${c.toFixed(3)}`);
});

// ── Tomorrow-PV lift: abundant forecast waives reserve despite sunset cv ──────
// The bug this guards: same-day cv spikes on low-light sample noise every sunset
// → confidence collapsed → overnight floor held SoC through a high-priced evening
// even though tomorrow's forecast abundantly refills the battery for free.
test('high cv (0.55) but tomorrow PV ≥ usable span → confidence 1.0 (no floor)', () => {
  const cvOnly = f(0.55, undefined);            // ≈0.14 — sunset noise
  assert.ok(cvOnly < 0.2, `precondition: cv-only low, got ${cvOnly.toFixed(3)}`);
  const c = f(0.55, undefined, 8.0, 2.69);      // 8kWh surplus vs 2.69kWh span
  assert.strictEqual(c, 1.0);
});

test('high cv + tomorrow PV refills half the span → confidence ~0.5', () => {
  const c = f(0.55, undefined, 1.345, 2.69);    // exactly 50% of span
  assert.ok(approx(c, 0.50), `expected ~0.50, got ${c.toFixed(3)}`);
});

test('tomorrow-PV haircut by under-delivery ratio (0.5) → half lift', () => {
  // 4kWh forecast × ratio 0.5 = 2kWh effective vs 2.69 span → ~0.74
  const c = f(0.55, 0.50, 4.0, 2.69);
  assert.ok(approx(c, Math.min(1, 2.0 / 2.69)), `expected ~0.74, got ${c.toFixed(3)}`);
});

test('no tomorrow PV (0 kWh) → confidence unchanged from same-day terms', () => {
  assert.strictEqual(f(0.55, undefined, 0, 2.69), f(0.55, undefined));
});

test('tomorrow-PV lift never lowers confidence below same-day terms', () => {
  // weak tomorrow PV must not drag down an already-confident same-day signal
  assert.strictEqual(f(0.10, undefined, 0.1, 2.69), 1.0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
