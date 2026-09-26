'use strict';

// Regression: "free PV ahead fills the battery" counted PV over the WHOLE horizon, including
// tomorrow's block, even when a price peak sits between now and that block.
//
// pvSaturatesAhead compared pvKwhFromT[t + 1] (a suffix sum to the end of the horizon) against
// the room left in the pack. Tomorrow's PV then "filled" the battery, the zeroed trickle cap
// bound, and the store value collapsed to −cycleCost — so surplus was exported even though the
// kWh could have served tonight's peak long before tomorrow's PV exists.
//
// Live 2026-09-15 13:00Z (15:00 Ams), dp_input_dump replay: SoC 20%, €0.209 (horizon low),
// pvCoverage 1.00, peak €0.461 at 19:45, ~4.3 kWh PV tomorrow. capBinds=1 at 15:00-16:00,
// store €-0.075 → "export €0.209 > store €-0.075 → standby". A second shape (09-08 12:26Z): the
// horizon maximum is TOMORROW evening, so bounding the PV to the global peak does not help —
// tomorrow's PV still lands before it. The fix values the store at the best price the pack can
// serve before PV actually fills it.

const assert = require('assert');
const OE = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine.js');
const { storeValue } = require('../lib/price-formulas.js');

const RTE = 0.73;
const CYCLE = 0.075;
const TONIGHT_PEAK = 0.46;

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

// Hourly slots, consumption 200 W, charge rate 800 W → pvCoverage = (pvW − 200) / 800,
// pvStrong threshold 400 W / 800 W = 0.50.
//            t0    t1    t2    t3            t4    t5..t8 night       t9..t13 tomorrow PV  t14   t15
const PV_W = [1000, 1000, 400, 0, 0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 0, 0];
// From t1: 0.80 + 0.20 = 1.00 kWh today, then 4.00 kWh tomorrow. Room at 20% of 2.688 kWh =
// 2.15 kWh → the pack only fills during tomorrow's block (t11), after tonight's peak at t3.
function prices(tomorrowPeak) {
  return [0.21, 0.24, 0.30, TONIGHT_PEAK, 0.44, 0.34, 0.34, 0.34, 0.34,
    0.20, 0.20, 0.20, 0.20, 0.20, tomorrowPeak, 0.30];
}

function runEngine(priceValues) {
  const oe = new OE({
    battery_efficiency: RTE,
    min_soc: 0,
    max_soc: 100,
    cycle_cost_per_kwh: CYCLE,
    tariff_model: 'saldering',
  });
  const base = Date.now();
  const ps = priceValues.map((price, h) => ({
    timestamp: new Date(base + h * 3600e3).toISOString(), price,
  }));
  const pvF = ps.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
  const cons = ps.map(() => 200);
  oe.compute(ps, 20, 2.688, 800, 800, pvF, RTE, cons, 0.220, 1.0, 4.0, 4.0, 1.0, 1.0, false, 0);
  return oe._schedule.slots;
}

const TONIGHT_VALUE = storeValue(TONIGHT_PEAK, RTE, CYCLE); // ≈ €0.261

test('tomorrow peak lower: surplus now is valued at tonight\'s peak, not zeroed by tomorrow\'s PV', () => {
  const s = runEngine(prices(0.40));
  assert.ok(Math.abs(s[0].pvStoreValue - TONIGHT_VALUE) < 1e-6,
    `expected €${TONIGHT_VALUE.toFixed(4)}, got €${s[0].pvStoreValue.toFixed(4)}`);
  assert.ok(s[0].pvStoreValue > s[0].price, 'storing must beat exporting at €0.21');
});

test('tomorrow peak higher: tomorrow\'s PV still lands before it, tonight\'s peak stays reachable', () => {
  const s = runEngine(prices(0.50));
  assert.ok(Math.abs(s[0].pvStoreValue - TONIGHT_VALUE) < 1e-6,
    `expected €${TONIGHT_VALUE.toFixed(4)} (tonight), got €${s[0].pvStoreValue.toFixed(4)}`);
  assert.ok(s[0].pvStoreValue > s[0].price, 'storing must beat exporting at €0.21');
});

// --- runtime follows the DP's store value on a bound cap -----------------------------------

const RealDate = Date;
function atFixedTime(fn) {
  const fixed = new RealDate('2026-09-15T13:05:00.000Z');
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

test('runtime: a bound cap with a positive DP store value still forces the charge', () => {
  const ctx = {
    settings: { max_soc: 100, cycle_cost_per_kwh: CYCLE },
    BATTERY_EFFICIENCY: RTE,
    _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
    _disposalValue: PolicyEngine.prototype._disposalValue,
    _pvDelayCheaperAvg: PolicyEngine.prototype._pvDelayCheaperAvg,
    log: () => {},
  };
  const inputs = {
    battery: { stateOfCharge: 20, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: { resolved_gridPower: -600, pv_power_estimated: 800, avg_consumption_w: 200 },
    tariff: {
      currentPrice: 0.209,
      allPrices: [
        { timestamp: '2026-09-15T17:45:00.000Z', price: TONIGHT_PEAK },
        { timestamp: '2026-09-15T13:00:00.000Z', price: 0.209 },
      ],
      slotHours: 0.25,
    },
    optimizer: { getSlotMeta: () => ({
      pvTrickleMaxValue: 0, pvTrickleCapBinds: true, pvTrickleCapHonoured: true,
      action: 'preserve', pvStoreValue: TONIGHT_VALUE,
    }) },
  };
  atFixedTime(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
  assert.ok(Math.abs(inputs._pvStoreValue - TONIGHT_VALUE) < 1e-6,
    `runtime must land on the DP value €${TONIGHT_VALUE.toFixed(4)}, got ${inputs._pvStoreValue}`);
  assert.strictEqual(inputs._pvStoreWins, true, 'store €0.261 beats export €0.209');
});

// --- end-to-end guard: the REAL engine schedule drives the runtime ---------------------------
// Regression history: 2b3f02e8 (2026-05-15) fixed exactly this case in the runtime (DP says
// preserve on a pvStrong slot with the evening peak still ahead → honour the DP's store value).
// 72203a5f (2026-08-07) put a cap-binds branch IN FRONT of that fix, which went live when
// 126f26e6 (2026-09-10) defaulted the flag on — the old fix stayed in the code, unreachable, and
// 2026-09-15 exported PV at €0.209 at SoC 20% with €0.46 coming. The unit tests above feed the
// runtime a hand-made slotMeta, so a new branch that shadows the path would still pass them.
// This one does not fabricate anything between the layers: compute() → getSlotMeta() →
// _computePvFlags(). Any future branch that zeroes this store again turns it red.

test('end-to-end: engine schedule + runtime charge the surplus when tonight\'s peak beats export', () => {
  const T0 = Date.parse('2026-09-15T13:00:00.000Z');
  for (const tomorrowPeak of [0.40, 0.50]) {
    const oe = new OE({ battery_efficiency: RTE, min_soc: 0, max_soc: 100,
      cycle_cost_per_kwh: CYCLE, tariff_model: 'saldering' });
    const ps = prices(tomorrowPeak).map((price, h) => ({
      timestamp: new Date(T0 + h * 3600e3).toISOString(), price,
    }));
    const pvF = ps.map((p, h) => ({ timestamp: p.timestamp, pvPowerW: PV_W[h] }));
    oe.compute(ps, 20, 2.688, 800, 800, pvF, RTE, ps.map(() => 200), 0.220, 1.0, 4.0, 4.0, 1.0, 1.0, false, 0);

    const ctx = {
      settings: { max_soc: 100, cycle_cost_per_kwh: CYCLE },
      BATTERY_EFFICIENCY: RTE,
      _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
      _disposalValue: PolicyEngine.prototype._disposalValue,
      _pvDelayCheaperAvg: PolicyEngine.prototype._pvDelayCheaperAvg,
      log: () => {},
    };
    const inputs = {
      battery: { stateOfCharge: 20, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
      p1: { resolved_gridPower: -800, pv_power_estimated: 1000, avg_consumption_w: 200 },
      tariff: { currentPrice: ps[0].price, allPrices: ps, slotHours: 1 },
      optimizer: oe,
    };
    atFixedTime(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
    assert.strictEqual(inputs._pvExporting, true, `tomorrowPeak €${tomorrowPeak}: surplus detected → block ran`);
    assert.ok(inputs._pvStoreValue > ps[0].price,
      `tomorrowPeak €${tomorrowPeak}: runtime store €${inputs._pvStoreValue} must beat export €${ps[0].price}`);
    assert.strictEqual(inputs._pvStoreWins, true,
      `tomorrowPeak €${tomorrowPeak}: runtime must charge from PV, not export`);
  }
});

console.log(`\ndp-pv-saturation-window: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
