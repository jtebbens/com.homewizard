'use strict';

/**
 * Regression: the store-vs-export economics were skipped in the 50–100W net-surplus band.
 *
 * Two places ask "is there PV surplus?" with different numbers:
 *   - _computePvFlags (policy-engine.js): `grid < -200 || (pvEst - cons) > 100`, else early
 *     return — _pvStoreWins stays undefined and the whole economics block never runs.
 *   - the preserve/trickle mappers: act on `estimatedNetPvSurplusW >= 50`.
 * Between 50W and 100W the mapper charges while the economics were never consulted.
 *
 * Live 2026-08-20, three consecutive runs at the same price (€0.280) and same verdict
 * (store €0.209 < export €0.280, margin €0.071):
 *   15:00:00.365Z  netSurplus ≈587W  → gate ran      → standby            (correct)
 *   15:10:54.466Z  netSurplus ≈ 58W  → gate SKIPPED  → zero_charge_only   (the bug: charged)
 *   15:15:00.409Z  netSurplus ≈ 47W  → gate skipped  → standby            (below the 50W floor)
 *
 * The chart mapper carries the same hole on a different threshold: its _exportBeatsStoring
 * veto only applies under `pvStrong && netSurplusW >= 400`, so weak surplus falls through to
 * pv_trickle with no economics test and the plan diverges from the runtime.
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  process.stdout.write(`[${name}] ... `);
  try { fn(); console.log('✓ PASS'); passed++; }
  catch (err) { console.log('✗ FAIL'); console.error(`   ${String(err.message || err)}`); failed++; }
}

// _computePvFlags gates on daylight via new Date(), so pin the clock at the live timestamp
// (15:10Z = 17:10 Amsterdam) for the duration of each call.
const RealDate = Date;
function atLiveRun(fn) {
  const fixed = new RealDate('2026-08-20T15:10:54.000Z');
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

const CYCLE = 0.075;
const RTE   = 0.7326; // live [RTE] session value that produced store €0.209 in the log

// The live 15:10 P1 shape: PV 469W, learned load 411W → net surplus 58W, grid at the
// net-0 boundary (not exporting hard enough to trip the old `grid < -200` leg).
function runFlags({ maxFuture = 0.387, currentPrice = 0.280, p1 = null, soc = 3 } = {}) {
  const ctx = {
    settings: { max_soc: 95, cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering' },
    BATTERY_EFFICIENCY: RTE,
    _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
    _disposalValue: PolicyEngine.prototype._disposalValue,
    log: () => {},
  };
  const inputs = {
    battery: { stateOfCharge: soc, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: p1 ?? { resolved_gridPower: 0, pv_power_estimated: 469, avg_consumption_w: 411 },
    tariff: {
      currentPrice,
      allPrices: [{ timestamp: '2026-08-20T18:00:00.000Z', price: maxFuture }],
      slotHours: 0.25,
    },
  };
  atLiveRun(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
  return inputs;
}

// ─── The gate: economics must run in the 50–100W band ─────────────────────────

test('gate: 58W surplus gets a store-vs-export verdict', () => {
  const out = runFlags();
  assert.strictEqual(out._pvStoreWins, false,
    `store €${out._pvStoreValue?.toFixed(3)} < export €0.280 → verdict must be false, got ${out._pvStoreWins}`);
});

test('gate: verdict reproduces the logged store value €0.209', () => {
  const out = runFlags();
  assert.ok(Math.abs(out._pvStoreValue - 0.2085) < 0.001,
    `must match the live log's €0.209, got ${out._pvStoreValue}`);
});

test('gate: two-sided — fat spread still stores', () => {
  const out = runFlags({ maxFuture: 0.60 });
  assert.strictEqual(out._pvStoreWins, true,
    'a genuinely profitable spread at 58W surplus must still bank the PV');
});

// The containment that keeps this change bounded: _delayCharge has 8 consumers (scores.charge=0,
// explainability) and must NOT start firing in a band it was never exercised in.
test('gate: delay-charge stays behind the old stricter threshold', () => {
  const out = runFlags();
  assert.notStrictEqual(out._delayCharge, true,
    'sub-100W surplus must not newly trigger delay-charge');
});

// The 2026-07-02 regression this gate was built for must stay closed: PV below house load with
// the grid importing is not a surplus at any threshold.
test('gate: PV < load while importing still no-ops', () => {
  const out = runFlags({ p1: { resolved_gridPower: 187, pv_power_estimated: 261, avg_consumption_w: 448 } });
  assert.strictEqual(out._pvExporting, undefined, 'no real surplus → block must no-op');
  assert.strictEqual(out._pvStoreWins, undefined, 'no real surplus → no verdict written');
});

// ─── Runtime mapper: the verdict must be honoured ─────────────────────────────

const SETTINGS = {
  tariff_type: 'dynamic',
  min_soc: 5,
  max_soc: 95,
  max_charge_price: 0.215,
  min_discharge_price: 0.10,
  respect_minmax: true,
  cycle_cost_per_kwh: CYCLE,
  battery_efficiency: RTE,
  min_profit_margin: 0.01,
  policy_mode: 'balanced',
  tariff_model: 'saldering',
};

function runtimeCtx(pvStoreWins, over = {}) {
  const now = Date.now();
  return {
    policyMode: 'balanced',
    battery: { stateOfCharge: 30, maxChargePowerW: 800 },
    tariff: { currentPrice: 0.280 },
    evCharging: false,
    _delayCharge: false,
    _pvStoreWins: pvStoreWins,
    _chargeUrgent: false,
    p1: {
      resolved_gridPower: 0,
      battery_power: 0,
      pv_power_estimated: 469,
      avg_consumption_w: 411,
    },
    batteryCost: { avgCost: 0.1, energyKwh: 1 },
    batteryEfficiency: RTE,
    weather: { todaySunset: new Date(now + 2 * 3_600_000), todaySunrise: new Date(now - 9 * 3_600_000) },
    ...over,
  };
}

// Already correct today (branch at :1528) — pinned so the gate fix demonstrably lands here.
test('runtime preserve: export wins → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('preserve', runtimeCtx(false));
  assert.strictEqual(mode, 'standby',
    `58W surplus with export winning must idle, got '${mode}'`);
});

test('runtime preserve: store wins → zero_charge_only', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('preserve', runtimeCtx(true));
  assert.strictEqual(mode, 'zero_charge_only',
    `storing beats exporting → PV must still be banked, got '${mode}'`);
});

// The trickle branch reads no verdict at all today — it charges on surplus alone.
test('runtime trickle: export wins → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('trickle', runtimeCtx(false));
  assert.strictEqual(mode, 'standby',
    `trickle must honour the same export verdict as preserve, got '${mode}'`);
});

test('runtime trickle: store wins → zero_charge_only', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const mode = eng._mapPolicyToHwMode('trickle', runtimeCtx(true));
  assert.strictEqual(mode, 'zero_charge_only',
    `trickle must still bank PV when storing wins, got '${mode}'`);
});

// ─── Planning mapper (chart) — must not diverge from the runtime ──────────────

function planningArgs(pvStoreValue, over = {}) {
  return {
    price: 0.280,
    soc: 30,
    pvW: 469,
    consumptionW: 411,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.215,
    minDischargePrice: 0.10,
    minSoc: 5,
    maxSoc: 95,
    futurePrices: [],
    battChargePowerW: 800,
    pvStoreValue,
    exportPrice: null,
    battCapKwh: 2.688,
    pvKwhTomorrow: 0,
    refillConfidence: 1,
    ...over,
  };
}

test('chart preserve: weak surplus + export wins → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('preserve', planningArgs(0.209));
  assert.strictEqual(hwMode, 'standby',
    `chart must project the idle-and-export the runtime performs, got '${hwMode}'`);
});

test('chart preserve: weak surplus + store wins → pv_trickle', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('preserve', planningArgs(0.45));
  assert.strictEqual(hwMode, 'pv_trickle',
    `storing beats exporting → chart must keep the PV capture, got '${hwMode}'`);
});

test('chart trickle: export wins → standby', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('trickle', planningArgs(0.209));
  assert.strictEqual(hwMode, 'standby',
    `chart trickle must honour the export verdict, got '${hwMode}'`);
});

test('chart trickle: store wins → pv_trickle', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('trickle', planningArgs(0.45));
  assert.strictEqual(hwMode, 'pv_trickle',
    `storing beats exporting → chart must keep the trickle, got '${hwMode}'`);
});

// No store value at all (night grid slots) must keep today's behaviour — the chart may not
// veto charges the battery does perform.
test('chart: no store value → unchanged behaviour', () => {
  const eng = new PolicyEngine({ log() {} }, SETTINGS);
  const { hwMode } = eng._mapActionToHwModeForPlanning('trickle', planningArgs(null));
  assert.strictEqual(hwMode, 'pv_trickle',
    `without a store value the economics cannot veto, got '${hwMode}'`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
