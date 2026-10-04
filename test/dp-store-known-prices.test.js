'use strict';

/**
 * Regression: the store-vs-export verdict priced PV against an ESTIMATED peak.
 *
 * Live 2026-09-30 06:30:10Z (08:30 CEST), price_forecast_fill = 'on':
 *   [PRICE-FC on] +192 estimated slots: horizon 15.2h → 63.2h
 *   [MAPPING] policyMode=preserve, soc=13, pvEst=328W, netSurplus≈57W, price=0.362
 *   PV OVERSCHOT: storing beats exporting (max €0.609 × 0.732 − cycle €0.075 = €0.371 > export €0.362)
 *   → zero_charge_only.
 * €0.609 was an estimated slot two days out (t236, Friday ~19:30 CEST); the highest PUBLISHED
 * price ahead was tonight's €0.448 → store €0.253 < export €0.362 → exporting wins.
 * The estimate reached the verdict through the DP's reachPrice / suffix max (slot pvStoreValue),
 * which the runtime takes over on a preserve slot.
 *
 * Decision (user 2026-09-30): the store-vs-export question counts published prices only.
 * The DP's own valuation and the grid charge ceiling keep the estimates (they exist to stop the
 * morning horizon from truncating — project_price_forecast_fill_0909).
 */

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');
const { storeValue } = require('../lib/price-formulas');

const RTE = 0.732;
const CYCLE = 0.075;
const NOW_PRICE = 0.362;
const KNOWN_PEAK = 0.448;
const EST_PEAK = 0.609;
const KNOWN_VALUE = storeValue(KNOWN_PEAK, RTE, CYCLE); // ≈ €0.253
const EST_VALUE = storeValue(EST_PEAK, RTE, CYCLE);     // ≈ €0.371

const T0 = '2026-09-30T06:30:00.000Z';
// Hourly slots from T0. Tonight's peak is published; the last two slots are the estimated tail.
const PRICES = [NOW_PRICE, 0.300, 0.280, KNOWN_PEAK, 0.250, 0.220, EST_PEAK, 0.300];
const ESTIMATED = [false, false, false, false, false, false, true, true];
// Weak PV now (cov 0.16), nothing strong anywhere — the PV ahead never saturates the pack.
const PV_W = [328, 300, 200, 0, 0, 0, 0, 0];

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function priceTable({ flagEstimated }) {
  const base = new Date(T0).getTime();
  return PRICES.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(),
    price,
    ...(flagEstimated && ESTIMATED[h] ? { estimated: true } : {}),
  }));
}

function runEngine({ flagEstimated }) {
  const oe = new OE({
    battery_efficiency: RTE, min_soc: 0, max_soc: 100,
    cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering',
  });
  const prices = priceTable({ flagEstimated });
  const pvF = prices.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = prices.map(() => 200);
  oe.compute(prices, 13, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 0, 0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

const RealDate = Date;
function atLiveRun(fn) {
  const fixed = new RealDate('2026-09-30T06:30:10.000Z');
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
      if (!args.length) return new RealDate(fixed.getTime());
    }

    static now() { return fixed.getTime(); }
  };
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

// Runtime: _computePvFlags + the preserve mapper, fed the engine's slot-0 meta (the DP planned
// preserve there live) or no meta at all (fallback path on the price table).
function runRuntime({ flagEstimated, slotMeta }) {
  const settings = {
    tariff_type: 'dynamic', min_soc: 0, max_soc: 100, max_charge_price: 0.15,
    min_discharge_price: 0.22, respect_minmax: false, cycle_cost_per_kwh: CYCLE,
    battery_efficiency: RTE, min_profit_margin: 0.01, policy_mode: 'balanced', tariff_model: 'saldering',
  };
  const eng = new PolicyEngine({ log() {} }, settings);
  const inputs = {
    policyMode: 'balanced',
    battery: { stateOfCharge: 13, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    tariff: { currentPrice: NOW_PRICE, allPrices: priceTable({ flagEstimated }).slice(1), slotHours: 1 },
    dynamicMaxChargePrice: KNOWN_VALUE,
    evCharging: false,
    _chargeUrgent: false,
    p1: { resolved_gridPower: -57, battery_power: 0, pv_power_estimated: 328, avg_consumption_w: 271 },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: RTE,
    effectiveRte: RTE,
    optimizer: { getSlotMeta: () => slotMeta },
  };
  return atLiveRun(() => {
    inputs.weather = { todaySunset: new Date(Date.now() + 8 * 3_600_000) };
    eng._computePvFlags(inputs);
    return { flags: inputs, mode: eng._mapPolicyToHwMode('preserve', inputs) };
  });
}

console.log('dp-store-known-prices');

test('DP: store value is priced at the published peak, not the estimated one', () => {
  const s0 = runEngine({ flagEstimated: true })[0];
  assert.ok(Math.abs(s0.pvStoreValue - KNOWN_VALUE) < 1e-6,
    `expected €${KNOWN_VALUE.toFixed(4)} (peak €${KNOWN_PEAK}), got €${s0.pvStoreValue.toFixed(4)}`);
});

test('runtime on the DP meta (live shape): export €0.362 beats store €0.253 → standby', () => {
  const s0 = runEngine({ flagEstimated: true })[0];
  const { flags, mode } = runRuntime({ flagEstimated: true, slotMeta: { ...s0, action: 'preserve' } });
  assert.strictEqual(flags._pvStoreWins, false, `_pvStoreWins=${flags._pvStoreWins}, store=${flags._pvStoreValue}`);
  assert.strictEqual(mode, 'standby', `got '${mode}'`);
});

test('control: the same peak published (no estimate) still stores — €0.371 > €0.362', () => {
  const s0 = runEngine({ flagEstimated: false })[0];
  assert.ok(Math.abs(s0.pvStoreValue - EST_VALUE) < 1e-6,
    `expected €${EST_VALUE.toFixed(4)}, got €${s0.pvStoreValue.toFixed(4)}`);
  const { flags, mode } = runRuntime({ flagEstimated: false, slotMeta: { ...s0, action: 'preserve' } });
  assert.strictEqual(flags._pvStoreWins, true, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.strictEqual(mode, 'zero_charge_only', `got '${mode}'`);
});

test('runtime fallback without DP meta ignores estimated slots too', () => {
  const { flags, mode } = runRuntime({ flagEstimated: true, slotMeta: null });
  assert.ok(Math.abs(flags._pvStoreValue - KNOWN_VALUE) < 1e-6,
    `expected €${KNOWN_VALUE.toFixed(4)}, got ${flags._pvStoreValue}`);
  assert.strictEqual(mode, 'standby', `got '${mode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
