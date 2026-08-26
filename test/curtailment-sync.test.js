'use strict';

/**
 * Chunk 6 sub-chunk 3 — curtailment formule-sync: the runtime PV OVERSCHOT gate,
 * the chart mapper and the explainability text must value NOT-storing the surplus
 * with the SAME floored figure the DP uses (OptimizationEngine._disposalValue),
 * so they store PV exactly when the DP does — no DP==chart==uitleg divergence.
 *
 * Single source of truth: lib/price-formulas.js disposalValue(). With
 * pv_curtailment_enabled off (default) it returns exportValue() unchanged → every
 * path stays bit-identical to old.
 *
 * Scenario — the only band where the floor can flip anything: a positive retail
 * price with a NEGATIVE per-slot export price, and a store value in between.
 *   price 0.10, exportPrice -0.03, storeValue -0.010 (maxFuture 0.0867 x RTE 0.75
 *   - cycle 0.075). Storing is worth less than nothing, but exporting is worth
 *   even less, so without the floor every surface banks the surplus.
 *   curtailment off → dispose = -0.03 < store -0.010 → STORE
 *   curtailment on  → dispose =  0    > store -0.010 → THROW AWAY (standby/export)
 * The DP already decides the second way (commit c765d94); these three surfaces
 * still decide the first way, which is the sync debt this test pins.
 */

const assert = require('assert');
const { exportValue, disposalValue } = require('../lib/price-formulas');
const PolicyEngine = require('../lib/policy-engine');
const ExplainabilityEngine = require('../lib/explainability-engine');

const homey = { log() {} };

const PRICE       = 0.10;
const EXPORT      = -0.03;
const MAX_FUTURE  = 0.0867;   // x RTE 0.75 - cycle 0.075 = -0.010 store value
const RTE         = 0.75;
const CYCLE       = 0.075;

const baseSettings = {
  tariff_type: 'dynamic',
  tariff_model: 'asymmetric_2027',
  battery_efficiency: RTE,
  cycle_cost_per_kwh: CYCLE,
  min_soc: 0,
  max_soc: 95,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  respect_minmax: true,
  policy_mode: 'balanced',
};

let passed = 0, failed = 0;
function test(name, fn) {
  process.stdout.write(`[${name}] ... `);
  try { fn(); console.log('PASS'); passed++; }
  catch (err) { console.log('FAIL'); console.error(`   ${String(err.message || err)}`); failed++; }
}

// _computePvFlags gates on daylight via new Date() — pin the clock at 15:10Z (17:10 Amsterdam).
const RealDate = Date;
function atMidday(fn) {
  const fixed = new RealDate('2026-08-26T13:10:00.000Z');
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
      if (!args.length) return new RealDate(fixed.getTime());
    }

    static now() { return fixed.getTime(); }
  };
  try { return fn(); } finally { global.Date = RealDate; }
}

// ── Section 1: disposalValue is the floored twin of exportValue ───────────────
test('disposalValue floors a negative export price only when curtailment is available', () => {
  const slot = { price: PRICE, exportPrice: EXPORT };
  assert.strictEqual(exportValue(slot, 'asymmetric_2027'), EXPORT);
  assert.strictEqual(disposalValue(slot, 'asymmetric_2027', 1.0, false), EXPORT,
    'without curtailment the grid is the only route → unchanged');
  assert.strictEqual(disposalValue(slot, 'asymmetric_2027', 1.0, true), 0,
    'with curtailment throttling is free → floor at 0');
  assert.strictEqual(disposalValue({ price: 0.20, exportPrice: 0.05 }, 'asymmetric_2027', 1.0, true), 0.05,
    'no-op above zero');
  assert.strictEqual(disposalValue(slot, 'saldering', 1.0, true), PRICE,
    'saldering untouched: export offsets import 1:1');
});

// ── Section 2: runtime PV OVERSCHOT gate (_computePvFlags → _pvStoreWins) ─────
function runFlags(curtail) {
  const eng = new PolicyEngine(homey, { ...baseSettings, pv_curtailment_enabled: curtail });
  const inputs = {
    battery: { stateOfCharge: 60 },
    p1: { resolved_gridPower: -1500, battery_power: 0, pv_power_estimated: 2500, avg_consumption_w: 400 },
    tariff: {
      currentPrice: PRICE,
      currentExportPrice: EXPORT,
      slotHours: 1,
      allPrices: [
        { index: 0, price: PRICE },
        { index: 1, price: MAX_FUTURE },
        { index: 2, price: MAX_FUTURE },
      ],
    },
  };
  atMidday(() => eng._computePvFlags(inputs));
  return inputs;
}

test('runtime gate: curtailment off keeps banking the surplus (unchanged)', () => {
  const inputs = runFlags(false);
  assert.strictEqual(inputs._pvStoreWins, true,
    'export -0.03 is worse than store -0.010 → store still wins without curtailment');
});

test('runtime gate: curtailment on stops banking a surplus worth less than free disposal', () => {
  const inputs = runFlags(true);
  assert.strictEqual(inputs._pvStoreWins, false,
    'throttling is free (0) and beats store -0.010 → must not force charge');
});

// ── Section 3: chart mapper (_mapActionToHwModeForPlanning) ───────────────────
const flipCtx = {
  price: PRICE, exportPrice: EXPORT, pvStoreValue: -0.010,
  soc: 60, pvW: 2500, consumptionW: 0,
  tariffType: 'dynamic', userPolicyMode: 'balanced',
  maxChargePrice: 0.12, minDischargePrice: 0.25, minSoc: 0, maxSoc: 95,
  futurePrices: [], battChargePowerW: 800,
};

test('chart mapper: curtailment off projects a charge (unchanged)', () => {
  const eng = new PolicyEngine(homey, { ...baseSettings, pv_curtailment_enabled: false });
  const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx });
  assert.ok(!reason.includes('export_wins'),
    `store -0.010 beats export -0.03 → chart must not project export, got ${hwMode} (${reason})`);
});

test('chart mapper: curtailment on projects the throw-away, like the DP', () => {
  const eng = new PolicyEngine(homey, { ...baseSettings, pv_curtailment_enabled: true });
  const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx });
  assert.strictEqual(hwMode, 'standby',
    `free disposal (0) beats store -0.010 → chart must project standby, got ${hwMode} (${reason})`);
  assert.ok(reason.includes('export_wins'), `expected export_wins reason, got ${reason}`);
});

// ── Section 4: explainability (_addPVReasons) ─────────────────────────────────
function pvReasons(curtail) {
  const eng = new ExplainabilityEngine(homey);
  const reasons = [];
  eng._addPVReasons(reasons, {
    p1: { resolved_gridPower: -1500, battery_power: 0 },
    effectivePrice: PRICE,
    battery: { stateOfCharge: 60 },
    tariff: {
      currentExportPrice: EXPORT,
      allPrices: [{ index: 1, price: MAX_FUTURE }, { index: 2, price: MAX_FUTURE }],
    },
    settings: {
      tariff_model: 'asymmetric_2027',
      battery_efficiency: RTE,
      cycle_cost_per_kwh: CYCLE,
      pv_curtailment_enabled: curtail,
    },
  });
  return reasons.map(r => r.text).join(' | ');
}

test('uitleg: curtailment off does not claim export is more profitable (unchanged)', () => {
  const texts = pvReasons(false);
  assert.ok(!texts.includes('export naar net winstgevender'),
    'export -0.03 loses to store -0.010 → the export-wins reason must stay absent');
  assert.ok(texts.includes('opslaan winstgevender'),
    'without curtailment the surplus is still banked');
});

test('uitleg: curtailment on explains the surplus is not worth storing', () => {
  assert.ok(pvReasons(true).includes('export naar net winstgevender'),
    'free disposal beats store -0.010 → the explanation must match the DP decision');
});

// ── Section 5: economic-dominance invariant, randomized ──────────────────────
// With curtailment available the mapper must never project a stored surplus that is
// worth less than throwing it away for free, and never project a throw-away that is
// worth less than storing. Challenged across the whole negative-export band.
test('invariant: chart mapper follows max(0, exportPrice) vs storeValue (2000 cases)', () => {
  const eng = new PolicyEngine(homey, { ...baseSettings, pv_curtailment_enabled: true });
  let seed = 7919;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const price        = 0.01 + rnd() * 0.35;
    const exportPrice  = -0.15 + rnd() * 0.40;      // -0.15 .. 0.25
    const pvStoreValue = -0.10 + rnd() * 0.40;      // -0.10 .. 0.30
    const dispose = Math.max(0, exportPrice);
    const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', {
      ...flipCtx, price, exportPrice, pvStoreValue,
    });
    const exportWon = hwMode === 'standby' && reason.includes('export_wins');
    if (pvStoreValue > dispose + 1e-9) {
      assert.ok(!exportWon,
        `store ${pvStoreValue.toFixed(3)} > dispose ${dispose.toFixed(3)} but mapper reported export_wins`);
    }
    if (exportWon) {
      assert.ok(pvStoreValue <= dispose + 1e-9,
        `export_wins implies store <= dispose, got store ${pvStoreValue.toFixed(3)} > ${dispose.toFixed(3)}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
