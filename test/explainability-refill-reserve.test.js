'use strict';

// Explainability: when the overnight refill-reserve floor holds the battery back from
// discharging (price ≥ min-discharge, SoC above min, refillReserveActive), the user-facing
// reason must explain WHY ("reserve aangehouden, PV onzeker") instead of the generic
// "DP gepland: bewaren". Guards the bias→confidence behaviour being visible to users.

const assert = require('assert');
const ExplainabilityEngine = require('../lib/explainability-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const eng = new ExplainabilityEngine({ log: () => {} }); // homey stub; _buildDpReasons only reads inputs

function build({ reserve, price, soc = 60 }) {
  const inputs = {
    dpDecision: { finalAction: 'preserve', exception: null, breakEven: 0.20, maxFuturePrice: 0.25 },
    effectivePrice: price,
    battery: { stateOfCharge: soc },
    settings: { min_soc: 10, max_soc: 100, min_discharge_price: 0.22 },
    effectiveMinDischarge: 0.22,
    refillReserveActive: reserve,
    refillConfidence: reserve ? 0.5 : 1,
  };
  return eng._buildDpReasons({ hwMode: 'standby' }, inputs);
}

const hasReserve = (reasons) => reasons.some(r => r.icon === '🛡️' && /reserve/i.test(r.text));

// ── Reserve active + discharge-worthy price → reserve reason shown ───────────
test('reserve active, price ≥ min-discharge → 🛡️ reserve reason', () => {
  const r = build({ reserve: true, price: 0.26 });
  assert.ok(hasReserve(r), `expected reserve reason, got: ${JSON.stringify(r)}`);
});

// ── Reserve inactive → generic preserve, no reserve reason ───────────────────
test('reserve inactive → no reserve reason', () => {
  assert.ok(!hasReserve(build({ reserve: false, price: 0.26 })), 'reserve reason must not appear');
});

// ── Reserve active but price below min-discharge → not a reserve hold ─────────
test('reserve active, price < min-discharge → no reserve reason', () => {
  assert.ok(!hasReserve(build({ reserve: true, price: 0.15 })), 'price below min-discharge is not reserve-held');
});

// ── Reserve active but SoC at floor → nothing to preserve, no reserve reason ──
test('reserve active, soc ≤ min_soc → no reserve reason', () => {
  assert.ok(!hasReserve(build({ reserve: true, price: 0.26, soc: 10 })), 'no charge to hold → not reserve');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
