'use strict';

/**
 * One "export now, charge from cheaper PV later" rule for the runtime and the planning chart.
 *
 * Live 2026-09-26 07:40Z (09:40 NL): SoC 10%, surplus ~260W, price €0.299, and PV slots at
 * €0.19–0.20 from ~09:15Z. The battery stored the €0.299 surplus anyway. The runtime delay test
 * (_computePvFlags) only ran when weather.pvSurplusRemaining could fill the pack — a whole-day
 * net (7.8 kWh PV − 8.9 kWh consumption during PV hours = 0.0) that lets deficit hours cancel
 * the midday surplus. The chart had its own copy (pvDelayMin) with other candidates, hour-based
 * slot counts on 15-min slots and the import price where the runtime uses the export value.
 *
 * Both now call _pvDelayCheaperAvg, which counts storable PV per DP slot (pvCoverage).
 */

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  process.stdout.write(`[${name}] ... `);
  try {
    fn();
    passed++;
    console.log('ok');
  } catch (e) {
    failed++;
    console.log(`FAIL\n  ${e.message}`);
  }
}

const RealDate = Date;
const NOW_MS = new RealDate('2026-09-26T07:45:00.000Z').getTime(); // 09:45 NL
const atFixedClock = fn => {
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [NOW_MS]));
      if (!args.length) return new RealDate(NOW_MS);
    }

    static now() { return NOW_MS; }
  };
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
};

// 15-min DP slots after now: an hour of weak PV at €0.29–0.26, then four hours of full-rate
// PV at €0.19–0.20 (16 × 0.2 kWh = 3.2 kWh storable, room at SoC 10% = 2.28 kWh).
function morningSlots(slotMin = 15) {
  const slots = [];
  const n = 60 / slotMin;
  const push = (h, price, pvCoverage) => {
    for (let k = 0; k < n; k++) {
      slots.push({
        timestamp: new RealDate(NOW_MS + (h * 60 + (k + 1) * slotMin) * 60_000).toISOString(),
        price, pvCoverage, action: 'preserve',
      });
    }
  };
  push(0, 0.285, 0.4);
  push(1, 0.200, 1.0);
  push(2, 0.195, 1.0);
  push(3, 0.190, 1.0);
  push(4, 0.195, 1.0);
  return slots;
}

const ctxBase = () => ({
  settings: { max_soc: 95, cycle_cost_per_kwh: 0.075, tariff_model: 'saldering', pv_capacity_w: 3000, max_charge_price: 0.15 },
  BATTERY_EFFICIENCY: 0.73,
  _netPvSurplusW: PolicyEngine.prototype._netPvSurplusW,
  _disposalValue: PolicyEngine.prototype._disposalValue,
  _pvDelayCheaperAvg: PolicyEngine.prototype._pvDelayCheaperAvg,
  log: () => {},
});

const helperArgs = (over = {}) => ({
  soc: 10, maxSoc: 95, battCapKwh: 2.688, battChargePowerW: 800, slotHours: 0.25,
  futureSlots: morningSlots(), ...over,
});

test('helper: 26-09 morning — €0.299 now vs PV at ~€0.195 later → delay', () => {
  const avg = PolicyEngine.prototype._pvDelayCheaperAvg(0.299, helperArgs());
  assert.ok(typeof avg === 'number', `expected a delay avg, got ${avg}`);
  assert.ok(avg > 0.189 && avg < 0.2, `avg should be the €0.19–0.20 PV block, got ${avg}`);
});

test('helper: not enough storable PV in 8h to fill the pack → no delay', () => {
  const weak = morningSlots().map(s => ({ ...s, pvCoverage: 0.2 }));
  assert.strictEqual(PolicyEngine.prototype._pvDelayCheaperAvg(0.299, helperArgs({ futureSlots: weak })), null);
});

test('helper: later PV less than 3 ct cheaper → no delay', () => {
  assert.strictEqual(PolicyEngine.prototype._pvDelayCheaperAvg(0.22, helperArgs()), null);
});

test('helper: same energy in 60-min slots gives the same verdict (unit guard)', () => {
  const hourly = PolicyEngine.prototype._pvDelayCheaperAvg(0.299,
    helperArgs({ slotHours: 1, futureSlots: morningSlots(60) }));
  const quarter = PolicyEngine.prototype._pvDelayCheaperAvg(0.299, helperArgs());
  assert.ok(typeof hourly === 'number' && Math.abs(hourly - quarter) < 1e-9,
    `hourly ${hourly} vs 15-min ${quarter}`);
});

function runtimeInputs() {
  return {
    battery: { stateOfCharge: 10, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    p1: { resolved_gridPower: -260, pv_power_estimated: 655, avg_consumption_w: 400 },
    dynamicMaxChargePrice: 0.243,
    tariff: {
      currentPrice: 0.299, slotHours: 0.25,
      allPrices: morningSlots().map(s => ({ timestamp: s.timestamp, price: s.price })),
    },
    // The whole-day net that blocked the live run: deficit hours cancel the midday surplus.
    weather: { pvKwhRemaining: 7.8, pvSurplusRemaining: 0 },
    optimizer: { _schedule: { slots: morningSlots() }, getSlotMeta: () => null },
  };
}

test('runtime: whole-day net 0 no longer blocks the delay → _delayCharge', () => {
  const inputs = runtimeInputs();
  atFixedClock(() => PolicyEngine.prototype._computePvFlags.call(ctxBase(), inputs));
  assert.strictEqual(inputs._delayCharge, true, `_delayCharge=${inputs._delayCharge}`);
});

test('chart: same inputs → preserve:pv_delay, marked as override of the DP', () => {
  const out = PolicyEngine.prototype._mapActionToHwModeForPlanning.call(ctxBase(), 'preserve', {
    price: 0.299, soc: 10, pvW: 655, consumptionW: 400, tariffType: 'dynamic', userPolicyMode: 'balanced',
    maxChargePrice: 0.243, minDischargePrice: 0.3, minSoc: 0, maxSoc: 95, battCapKwh: 2.688,
    futurePrices: morningSlots(), battChargePowerW: 800,
  });
  assert.strictEqual(out.hwMode, 'standby', `hwMode=${out.hwMode} reason=${out.reason}`);
  assert.ok(out.reason.startsWith('preserve:pv_delay'), `reason=${out.reason}`);
  assert.strictEqual(out.override, true, 'DP planned a charge here; the chart must re-simulate');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
