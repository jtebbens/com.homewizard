'use strict';

/**
 * Property-based test suite for PolicyEngine._mapPolicyToHwMode.
 * The mapper may gate or soften a DP action (EV gate, PV hysteresis, price
 * floors) but must never REVERSE it: a discharge decision must never become
 * grid charging, a charge decision must never become discharging. Hand-written
 * scenario tests confirm the author's mental model; this suite challenges it
 * with randomized contexts (missing fields included).
 */

const fc = require('fast-check');
const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

const RUNS = 1000;
const SEED = 4242;

const MODES = new Set(['standby', 'zero_charge_only', 'zero_discharge_only', 'zero', 'to_full']);
const DISCHARGE_MODES = new Set(['zero_discharge_only', 'zero']);

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const sampleArb = fc.record({
  dpAction:        fc.constantFrom('charge', 'discharge', 'preserve', 'standby'),
  userPolicyMode:  fc.constantFrom('balanced', 'balanced-dynamic', 'profit'),
  tariffType:      fc.constantFrom('dynamic', 'fixed'),
  soc:             fc.option(fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  price:           fc.option(fc.double({ min: -0.25, max: 0.6, noNaN: true, noDefaultInfinity: true }), { nil: null }),
  dynMax:          fc.option(fc.double({ min: 0.05, max: 0.35, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
  minSoc:          fc.integer({ min: 0, max: 30 }),
  maxSoc:          fc.integer({ min: 70, max: 100 }),
  minDischargePrice: fc.double({ min: 0, max: 0.4, noNaN: true, noDefaultInfinity: true }),
  respectMinMax:   fc.boolean(),
  evCharging:      fc.boolean(),
  delayCharge:     fc.boolean(),
  pvStoreWins:     fc.constantFrom(true, false, undefined),
  chargeUrgent:    fc.boolean(),
  gridPower:       fc.integer({ min: -4000, max: 4000 }),
  batteryPower:    fc.integer({ min: -800, max: 800 }),
  pvEstimate:      fc.integer({ min: 0, max: 4000 }),
  avgConsumptionW: fc.integer({ min: 0, max: 3000 }),
  avgCost:         fc.double({ min: -0.1, max: 0.4, noNaN: true, noDefaultInfinity: true }),
  energyKwh:       fc.double({ min: 0, max: 3, noNaN: true, noDefaultInfinity: true }),
  batteryEfficiency: fc.double({ min: 0.5, max: 0.98, noNaN: true, noDefaultInfinity: true }),
  afterSunset:     fc.boolean(),
  hasWeather:      fc.boolean(),
  hasP1:           fc.boolean(),
});

function runMapper(s) {
  const settings = {
    tariff_type: s.tariffType,
    min_soc: s.minSoc,
    max_soc: s.maxSoc,
    max_charge_price: 0.15,
    min_discharge_price: s.minDischargePrice,
    respect_minmax: s.respectMinMax,
    cycle_cost_per_kwh: 0.075,
    battery_efficiency: 0.85,
    min_profit_margin: 0.01,
    policy_mode: s.userPolicyMode,
  };
  const eng = new PolicyEngine({ log() {} }, settings);
  const now = Date.now();
  const ctx = {
    policyMode: s.userPolicyMode,
    battery: s.soc === undefined ? undefined : { stateOfCharge: s.soc, maxChargePowerW: 800 },
    tariff: { currentPrice: s.price },
    dynamicMaxChargePrice: s.dynMax,
    evCharging: s.evCharging,
    _delayCharge: s.delayCharge,
    _pvStoreWins: s.pvStoreWins,
    _chargeUrgent: s.chargeUrgent,
    p1: s.hasP1 ? {
      resolved_gridPower: s.gridPower,
      battery_power: s.batteryPower,
      pv_power_estimated: s.pvEstimate,
      avg_consumption_w: s.avgConsumptionW,
    } : undefined,
    batteryCost: { avgCost: s.avgCost, energyKwh: s.energyKwh },
    batteryEfficiency: s.batteryEfficiency,
    weather: s.hasWeather
      ? { todaySunset: new Date(now + (s.afterSunset ? -3 : 3) * 3_600_000) }
      : undefined,
  };
  return eng._mapPolicyToHwMode(s.dpAction, ctx);
}

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function testInvariant(name, arb, predFn, runs = RUNS) {
  process.stdout.write(`[${name}] ... `);
  try {
    fc.assert(fc.property(arb, predFn), { numRuns: runs, seed: SEED, verbose: false });
    console.log('✓ PASS');
    passed++;
  } catch (err) {
    console.log('✗ FAIL');
    console.error(`   ${String(err.message || err).split('\n').slice(0, 12).join('\n   ')}`);
    failed++;
  }
}

// ─── Invariants ───────────────────────────────────────────────────────────────

// INVARIANT M1 — Totality: mapper never throws, output is always a known HW mode.
testInvariant('M1 mapper total + known mode', sampleArb, (s) => {
  const mode = runMapper(s);
  assert.ok(MODES.has(mode), `unknown mode '${mode}'`);
  return true;
});

// INVARIANT M2 — DP discharge is never reversed into grid charging.
testInvariant('M2 discharge never → to_full', sampleArb, (s) => {
  if (s.dpAction !== 'discharge') return true;
  const mode = runMapper(s);
  assert.notStrictEqual(mode, 'to_full', 'DP discharge reversed into grid charge');
  return true;
});

// INVARIANT M3 — DP charge is never reversed into a discharging mode.
testInvariant('M3 charge never → discharge mode', sampleArb, (s) => {
  if (s.dpAction !== 'charge') return true;
  const mode = runMapper(s);
  assert.ok(!DISCHARGE_MODES.has(mode), `DP charge reversed into '${mode}'`);
  return true;
});

// INVARIANT M4 — preserve/standby never discharge (top-up to to_full is allowed).
testInvariant('M4 preserve/standby never discharge', sampleArb, (s) => {
  if (s.dpAction !== 'preserve' && s.dpAction !== 'standby') return true;
  const mode = runMapper(s);
  assert.ok(!DISCHARGE_MODES.has(mode), `DP ${s.dpAction} became '${mode}'`);
  return true;
});

// INVARIANT M5 — EV gate: while the EV charges, the battery never discharges
// and never grid-charges; only PV top-up or idle.
testInvariant('M5 EV gate → {standby, zero_charge_only}', sampleArb, (s) => {
  if (!s.evCharging) return true;
  const mode = runMapper(s);
  assert.ok(mode === 'standby' || mode === 'zero_charge_only',
    `EV charging but mapper returned '${mode}'`);
  return true;
});

// INVARIANT M6 — Strict price floor: in strict balanced-dynamic-tariff mode a
// price below min_discharge_price never yields a discharging mode.
testInvariant('M6 strict floor blocks discharge below min price', sampleArb, (s) => {
  if (s.tariffType !== 'dynamic' || s.userPolicyMode !== 'balanced') return true;
  if (!s.respectMinMax || s.price === null || s.price >= s.minDischargePrice) return true;
  const mode = runMapper(s);
  assert.ok(!DISCHARGE_MODES.has(mode),
    `price €${s.price.toFixed(3)} < floor €${s.minDischargePrice.toFixed(3)} but mode '${mode}'`);
  return true;
});

// INVARIANT M7 — Grid-charge ceiling: on dynamic tariff to_full only fires at
// a price at or below the (dynamic) max charge price.
testInvariant('M7 to_full only at/below charge ceiling', sampleArb, (s) => {
  if (s.tariffType !== 'dynamic') return true;
  const mode = runMapper(s);
  if (mode !== 'to_full') return true;
  const ceiling = s.dynMax ?? 0.15;
  assert.ok(s.price !== null && s.price <= ceiling,
    `to_full at price ${s.price} > ceiling ${ceiling}`);
  return true;
});

// INVARIANT M8 — SoC floor: below user min_soc (and no EV gate) the mapper
// forces standby.
testInvariant('M8 below min_soc → standby', sampleArb, (s) => {
  if (s.evCharging || s.soc === undefined || s.soc >= s.minSoc) return true;
  const mode = runMapper(s);
  assert.strictEqual(mode, 'standby', `SoC ${s.soc} < min ${s.minSoc} but mode '${mode}'`);
  return true;
});

// INVARIANT M9 — 'zero' user policy respects SoC bounds: no discharge at/below
// min_soc, no charge at/above max_soc.
testInvariant('M9 zero-policy SoC bounds', sampleArb, (s) => {
  if (s.evCharging) return true;
  const settingsOverride = { ...s, userPolicyMode: 'zero' };
  const mode = runMapper(settingsOverride);
  const soc = s.soc ?? 50;
  if (soc < s.minSoc) return true; // standby guard fires first
  if (soc <= s.minSoc) assert.ok(!DISCHARGE_MODES.has(mode), `SoC at min but '${mode}'`);
  if (soc >= s.maxSoc) assert.ok(mode !== 'to_full' && mode !== 'zero' && mode !== 'zero_charge_only', `SoC at max but '${mode}'`);
  return true;
});

console.log('\n══════════════════════════════');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('══════════════════════════════');
if (failed > 0) process.exit(1);
