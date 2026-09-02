'use strict';

// The grid-charge ceiling used to be implemented twice with two different answers:
// policy-engine's _getDynamicChargePrice said €0.250 on 2026-09-02 while the DP's own
// round-trip test (optimization-engine.js arbAhead) said €0.245 on the same inputs.
// The gate feeds the DP as maxChargePrice (device.js:4329), so a stricter gate silently
// vetoes charges the DP would have planned.
//
// These tests deliberately do NOT restate the ceiling formula — a test that mirrors the
// implementation can never reject the formula's SHAPE (feedback_test_mirrors_implementation).
// They assert the two properties that actually matter:
//   1. the ceiling is exactly the price at which the DP's own arbitrage inequality flips;
//   2. the ceiling uses the measured RTE, the same number device.js hands the DP.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

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

const homey = { log() {} };

function makeEngine(overrides = {}) {
  return new PolicyEngine(homey, {
    tariff_type: 'dynamic',
    battery_efficiency: 0.718,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: 0.075,
    max_charge_price: 0.05, // low, so the dynamic ceiling is the binding one
    min_discharge_price: 0.25,
    respect_minmax: true,
    policy_mode: 'balanced',
    min_profit_margin: 0.01,
    ...overrides,
  });
}

/** Price series whose highest future value is `peak`. */
function tariffWithPeak(peak) {
  const now = Date.now();
  const series = [0.10, 0.12, peak * 0.5, peak, peak * 0.8];
  return {
    allPrices: series.map((p, i) => ({
      timestamp: new Date(now + (i + 1) * 3600_000).toISOString(),
      price: p,
    })),
  };
}

/**
 * The DP's round-trip test, copied from optimization-engine.js:1556 in its own terms:
 * a charge at `p` followed by a discharge at `peak` pays for itself when the recovered
 * value beats the full cycle wear. This is the reference the gate must agree with.
 */
function dpRoundTripProfitable(p, peak, rte, cycleCost) {
  return peak * rte - p > cycleCost;
}

console.log('\nCharge ceiling — policy gate vs DP break-even\n');

test('ceiling sits exactly on the DP round-trip flip point', () => {
  // Sweep peaks, RTEs and wear levels: at every combination the gate must let through
  // the prices the DP calls profitable and reject the ones it does not.
  for (const peak of [0.20, 0.30, 0.437, 0.60, 0.95]) {
    for (const rte of [0.55, 0.718, 0.732, 0.90]) {
      for (const cycleCost of [0, 0.02, 0.075, 0.15]) {
        const engine = makeEngine({ cycle_cost_per_kwh: cycleCost });
        const ceiling = engine._getDynamicChargePrice(tariffWithPeak(peak), 0.20, rte);
        const eps = 1e-4;

        if (ceiling > engine.settings.max_charge_price + eps) {
          assert.ok(dpRoundTripProfitable(ceiling - eps, peak, rte, cycleCost),
            `peak ${peak} rte ${rte} wear ${cycleCost}: gate allows €${(ceiling - eps).toFixed(4)} `
            + 'but the DP calls that round trip unprofitable');
        }
        assert.ok(!dpRoundTripProfitable(ceiling + eps, peak, rte, cycleCost),
          `peak ${peak} rte ${rte} wear ${cycleCost}: gate rejects €${(ceiling + eps).toFixed(4)} `
          + 'while the DP would still charge there');
      }
    }
  }
});

test('gate is never stricter than the DP — no hidden profit margin', () => {
  // The old gate subtracted MIN_PROFIT_MARGIN (€0.01) on top of the break-even, so a slot
  // the DP had planned could be vetoed one layer down. Any price the DP calls profitable
  // must clear the gate.
  const peak = 0.437;
  const rte = 0.732;
  const cycleCost = 0.075;
  const engine = makeEngine({ cycle_cost_per_kwh: cycleCost });
  const ceiling = engine._getDynamicChargePrice(tariffWithPeak(peak), 0.20, rte);

  for (let p = 0.10; p <= 0.40; p += 0.001) {
    if (dpRoundTripProfitable(p, peak, rte, cycleCost)) {
      assert.ok(p <= ceiling + 1e-9,
        `DP would charge at €${p.toFixed(3)} but the gate caps at €${ceiling.toFixed(3)}`);
    }
  }
});

test('ceiling follows the measured RTE, not the configured setting', () => {
  // device.js hands the DP the measured round-trip efficiency; the gate must read the same
  // number or the two ceilings drift apart again.
  const engine = makeEngine({ battery_efficiency: 0.718 });
  const tariff = tariffWithPeak(0.437);
  const measured = engine._getDynamicChargePrice(tariff, 0.20, 0.732);
  const configured = engine._getDynamicChargePrice(tariff, 0.20, 0.718);

  assert.ok(measured > configured,
    `A higher measured RTE must raise the ceiling (measured €${measured.toFixed(4)}, `
    + `configured €${configured.toFixed(4)})`);
  assert.ok(Math.abs(measured - configured - 0.437 * (0.732 - 0.718)) < 1e-9,
    'The whole difference must come from the RTE, nothing else');
});

test('static max_charge_price stays the floor of the ceiling', () => {
  // A flat/cheap day must never push the ceiling below what the user configured.
  const engine = makeEngine({ max_charge_price: 0.30 });
  const ceiling = engine._getDynamicChargePrice(tariffWithPeak(0.20), 0.10, 0.732);
  assert.strictEqual(ceiling, 0.30, `Static max must floor the ceiling, got €${ceiling}`);
});

test('unusable RTE falls back to the configured efficiency', () => {
  // The measured estimator can return null before it has cycles; the gate must still
  // produce the configured-RTE ceiling instead of NaN.
  const engine = makeEngine();
  const tariff = tariffWithPeak(0.437);
  const fallback = engine._getDynamicChargePrice(tariff, 0.20, null);
  const configured = engine._getDynamicChargePrice(tariff, 0.20, 0.718);
  assert.ok(Number.isFinite(fallback), `Ceiling must stay a number, got ${fallback}`);
  assert.strictEqual(fallback, configured, 'null RTE must reduce to the configured ceiling');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
