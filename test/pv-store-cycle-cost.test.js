'use strict';

// Regression: "is storing own PV surplus better than exporting it?" ignored battery wear.
// Live 2026-07-31 08:45Z (10:45 Ams), PV 3611W / load 2119W / 1492W exporting:
//   PV OVERSCHOT: storing beats exporting (max €0.376 × 0.72 = €0.275 > export €0.259) → force charge
// The spread is +€0.0165/kWh, but the round trip costs €0.075 in cycle cost, so the stored kWh
// lost €0.059. Storing is a round trip — it pays the charge half AND the discharge half — so the
// full cycle cost nets off here, the same way _getDynamicChargePrice (policy-engine.js:62) does.

const assert = require('assert');
const { storeValue } = require('../lib/price-formulas.js');
const PolicyEngine = require('../lib/policy-engine.js');

const CYCLE = 0.075;

// --- shared formula -----------------------------------------------------------

// The live case: thin spread loses to wear.
assert.ok(storeValue(0.376, 0.7326, CYCLE) < 0.259,
  '31-07 case: max 0.376 × 0.7326 − 0.075 must lose to export 0.259');
assert.ok(Math.abs(storeValue(0.376, 0.7326, CYCLE) - 0.2005) < 0.001,
  '31-07 case: store value nets to ~€0.2005/kWh');

// Two-sided: a fat spread must still win, or the fix would just disable storing.
assert.ok(storeValue(0.45, 0.7326, CYCLE) > 0.13,
  'fat spread: 0.45 × 0.7326 − 0.075 must beat export 0.13');

// Cycle cost defaults to 0 so callers that pass nothing keep the old raw value.
assert.ok(Math.abs(storeValue(0.40, 0.75) - 0.30) < 1e-9, 'no cycle cost argument → raw maxFuture × rte');

// Null propagates (callers compare against null to mean "unknown").
assert.strictEqual(storeValue(null, 0.75, CYCLE), null, 'null maxFuture → null');

// --- policy-engine: the live hardware decision --------------------------------
// _computePvFlags gates on daylight via new Date(), so pin the clock at 10:45 Amsterdam
// (the real timestamp of the logged run) for the duration of each call.

const RealDate = Date;
function atAmsterdamMidday(fn) {
  const fixed = new RealDate('2026-07-31T08:45:00.000Z');
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

function runFlags({ currentPrice, maxFuture, slotMeta = undefined, settings = {} }) {
  const ctx = {
    settings: { max_soc: 95, cycle_cost_per_kwh: CYCLE, ...settings },
    BATTERY_EFFICIENCY: 0.72,
    _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
    _disposalValue: PolicyEngine.prototype._disposalValue,
    log: () => {},
  };
  // One future slot at the peak price, one cheap-but-not-negative slot so the
  // negative-price early return and the empty-array guard both stay out of the way.
  const allPrices = [
    { timestamp: '2026-07-31T18:00:00.000Z', price: maxFuture },
    { timestamp: '2026-07-31T12:00:00.000Z', price: currentPrice },
  ];
  const inputs = {
    battery: { stateOfCharge: 17, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: { resolved_gridPower: -1492, pv_power_estimated: 2097, avg_consumption_w: 2119 },
    tariff: { currentPrice, allPrices, slotHours: 0.25 },
    optimizer: slotMeta ? { getSlotMeta: () => slotMeta } : undefined,
  };
  atAmsterdamMidday(() => PolicyEngine.prototype._computePvFlags.call(ctx, inputs));
  return inputs;
}

{
  // The exact live case. Storing must no longer win.
  const out = runFlags({ currentPrice: 0.259, maxFuture: 0.376 });
  assert.strictEqual(out._pvExporting, true, 'surplus detected → block ran');
  assert.ok(out._pvStoreValue < 0.259,
    `31-07 case: store value ${out._pvStoreValue} must net below export 0.259`);
  assert.notStrictEqual(out._pvStoreWins, true,
    '31-07 case: thin spread must NOT force charge once wear is priced');
}

{
  // Two-sided: a genuinely profitable spread must still store.
  const out = runFlags({ currentPrice: 0.13, maxFuture: 0.45 });
  assert.strictEqual(out._pvStoreWins, true, 'fat spread must still beat exporting');
}

// --- double-count guard -------------------------------------------------------
// The middle branch reads pvStoreValue off the DP slot, which nets cycle cost itself.
// Subtracting again there would charge the round trip twice.

{
  const meta = { pvTrickleMaxValue: 0, action: 'preserve', pvStoreValue: 0.2005 };
  const out = runFlags({ currentPrice: 0.259, maxFuture: 0.376, slotMeta: meta });
  assert.ok(Math.abs(out._pvStoreValue - 0.2005) < 1e-9,
    `DP slot value must pass through unchanged, got ${out._pvStoreValue}`);
}

{
  // The trickle-capped branch is a raw price × rte and DOES need the deduction.
  const meta = { pvTrickleMaxValue: 0.376 * 0.72, action: 'preserve', pvStoreValue: 0.9 };
  const out = runFlags({ currentPrice: 0.259, maxFuture: 0.376, slotMeta: meta });
  assert.ok(out._pvStoreValue < 0.259,
    `trickle-capped branch must net cycle cost, got ${out._pvStoreValue}`);
}

console.log('pv-store-cycle-cost: all assertions passed');
