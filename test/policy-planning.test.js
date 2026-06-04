'use strict';

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
const SETTINGS = {
  tariff_type: 'dynamic',
  battery_efficiency: 0.7415781214938163,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  respect_minmax: true,
  policy_mode: 'balanced',
};

function makeEngine() {
  return new PolicyEngine(homey, { ...SETTINGS });
}

console.log('\nPolicyEngine — charge/planning regressions\n');

test('runtime charge uses dynamic max and keeps to_full when PV does not provide net surplus', () => {
  const engine = makeEngine();
  const mode = engine._mapPolicyToHwMode('charge', {
    policyMode: 'balanced',
    dynamicMaxChargePrice: 0.175,
    battery: {
      stateOfCharge: 11,
      maxChargePowerW: 1600,
    },
    tariff: {
      currentPrice: 0.164,
    },
    p1: {
      resolved_gridPower: 15,
      battery_power: 0,
      pv_power_estimated: 1974,
      avg_consumption_w: 1989,
    },
  });
  assert.strictEqual(mode, 'to_full');
});

test('planning mapping keeps charge as to_full on cheap hours with PV but no surplus', () => {
  const engine = makeEngine();
  const mapped = engine._mapActionToHwModeForPlanning('charge', {
    price: 0.164,
    soc: 11,
    pvW: 1974,
    consumptionW: 1989,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.175,
    minDischargePrice: 0.25,
    minSoc: 0,
    maxSoc: 100,
    futurePrices: [],
    battChargePowerW: 1600,
  });
  assert.strictEqual(mapped.hwMode, 'to_full');
});

test('planning does not grid-charge (to_full) on low SoC when PV forecast is strong', () => {
  // Regression: 12:30 slot — DP preserve, soc 8%, cheap flat price, but PV is strong
  // while consumption nearly cancels it (netSurplus≈0). lowSocGridTopUp fired → to_full,
  // diverging from the live runtime which peak-shaves from PV. With strong PV the chart
  // must not project a grid pull.
  const engine = makeEngine();
  const futurePrices = [0.133, 0.133, 0.135, 0.163].map((p, i) => ({
    timestamp: new Date(Date.now() + (i + 1) * 1800_000).toISOString(),
    price: p,
    pvW: 1900,
    consumptionW: 500,
  }));
  const mapped = engine._mapActionToHwModeForPlanning('preserve', {
    price: 0.133,
    soc: 8,
    pvW: 553,
    consumptionW: 673,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.151,
    minDischargePrice: 0.22,
    minSoc: 0,
    maxSoc: 100,
    futurePrices,
    battChargePowerW: 800,
  });
  assert.notStrictEqual(mapped.hwMode, 'to_full',
    `Strong PV (553W) at low SoC must not project grid charge, got ${mapped.hwMode} (${mapped.reason})`);
  assert.strictEqual(mapped.hwMode, 'pv_trickle',
    `Expected pv_trickle (PV-only peak-shave), got ${mapped.hwMode} (${mapped.reason})`);
});

test('planning still grid-charges (to_full) on low SoC when PV forecast is weak', () => {
  // Guard: the topup must still fire when PV is genuinely absent/weak (no peak-shave possible).
  const engine = makeEngine();
  const mapped = engine._mapActionToHwModeForPlanning('preserve', {
    price: 0.133,
    soc: 8,
    pvW: 120,
    consumptionW: 400,
    tariffType: 'dynamic',
    userPolicyMode: 'balanced',
    maxChargePrice: 0.151,
    minDischargePrice: 0.22,
    minSoc: 0,
    maxSoc: 100,
    futurePrices: [],
    battChargePowerW: 800,
  });
  assert.strictEqual(mapped.hwMode, 'to_full',
    `Weak PV (120W) at low SoC should still grid-charge, got ${mapped.hwMode} (${mapped.reason})`);
});

test('planning schedule uses actual battery capacity for SoC projection', () => {
  const engine = makeEngine();
  const start = new Date('2026-05-12T13:00:00.000Z');
  const slots = [
    {
      timestamp: start.toISOString(),
      action: 'preserve',
      price: 0.21,
      socProjected: 0,
      consumptionW: 0,
    },
    {
      timestamp: new Date(start.getTime() + 3_600_000).toISOString(),
      action: 'preserve',
      price: 0.22,
      socProjected: 0,
      consumptionW: 0,
    },
  ];
  const pvForecast = [
    { timestamp: slots[0].timestamp, pvPowerW: 1600 },
    { timestamp: slots[1].timestamp, pvPowerW: 1600 },
  ];
  const schedule = engine.buildPlanningSchedule(
    slots,
    pvForecast,
    null,
    1600,
    0.175,
    5.376
  );
  assert.ok(schedule[1].socProjected > 29 && schedule[1].socProjected < 31,
    `Expected ~30% SoC after 1h @ 1600W on 5.376kWh, got ${schedule[1].socProjected}%`);
});

test('dynamic charge ceiling tracks the known future peak, not the min-discharge break-even', () => {
  // Regression: a known day-ahead evening peak (€0.36) makes charging at €0.18 profitable
  // (0.36 × RTE − margin ≈ €0.257 break-even). The old maxByDischarge clamp pinned the
  // ceiling to (min_discharge_price × RTE − margin) ≈ €0.175 regardless of the peak,
  // blocking certain arbitrage. Ceiling must now follow the peak.
  const engine = makeEngine();
  const now = Date.now();
  const allPrices = [0.20, 0.18, 0.22, 0.31, 0.36, 0.33].map((p, i) => ({
    timestamp: new Date(now + (i + 1) * 3600_000).toISOString(),
    price: p,
  }));
  const ceiling = engine._getDynamicChargePrice({ allPrices }, 0.20);
  const eff = SETTINGS.battery_efficiency;
  // True break-even nets out cycle cost too: ((peak − cycleCost) × RTE − margin).
  const expected = (0.36 - SETTINGS.cycle_cost_per_kwh) * eff - 0.01;
  assert.ok(Math.abs(ceiling - expected) < 0.001,
    `Expected ceiling ≈ €${expected.toFixed(3)} (peak break-even net of cycle cost), got €${ceiling.toFixed(3)}`);
  assert.ok(ceiling > 0.18,
    `Charging at €0.18 into a €0.36 peak must be allowed, ceiling €${ceiling.toFixed(3)}`);
  // Old clamp would have capped at min_discharge break-even — assert we moved past it.
  const oldClamp = SETTINGS.min_discharge_price * eff - 0.01;
  assert.ok(ceiling > oldClamp,
    `Ceiling €${ceiling.toFixed(3)} must exceed old min-discharge clamp €${oldClamp.toFixed(3)}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
