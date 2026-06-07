'use strict';

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');

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

// Build 24 hourly price slots starting 1h from now.
function makePrices(n = 24, basePrice = 0.20) {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(start.getTime() + i * 3_600_000).toISOString(),
    price: basePrice
  }));
}

const CAPACITY_KWH = 2.688;
const MAX_POWER_W  = 800;
const SETTINGS = { battery_efficiency: 0.90, min_soc: 0, max_soc: 95, cycle_cost_per_kwh: 0 };

function profit(pvKwhTomorrow, soc = 50) {
  const eng = new OptimizationEngine(SETTINGS);
  const result = eng.computeExpectedProfit(
    makePrices(), soc, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, pvKwhTomorrow
  );
  return result.profit;
}

console.log('\nOptimizationEngine — terminal value\n');

// ── Empty battery + flat prices → no arbitrage, no terminal value ────────────
// SoC = 0: nothing stored, flat prices = no spread → profit = 0.
test('SoC 0, flat prices, no PV tomorrow → profit = 0', () => {
  const p = profit(0, 0);
  assert.ok(Math.abs(p) < 0.01, `Expected ~0 profit on empty battery + flat prices, got ${p}`);
});

// ── Terminal value lifts profit when tomorrow has little PV ──────────────────
// Prices: cheap first half, expensive second half → DP should charge low, discharge high.
test('cheap/expensive price pattern → positive profit', () => {
  const eng = new OptimizationEngine(SETTINGS);
  const prices = makePrices(24).map((p, i) => ({
    ...p,
    price: i < 8 ? 0.10 : i >= 16 ? 0.30 : 0.20
  }));
  const result = eng.computeExpectedProfit(
    prices, 10, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, 0
  );
  assert.ok(result.profit > 0, `Expected positive profit, got ${result.profit}`);
});

// ── pvKwhTomorrow ≥ 80% capacity → terminal value discounted to 0 ────────────
// When tomorrow's PV can fully refill the battery, stored energy has no residual
// value — DP should empty the battery by end of horizon.
// With expensive discharge prices, profit with full PV refill ≥ profit without.
test('full PV tomorrow → profit >= no PV tomorrow (battery can be emptied freely)', () => {
  const eng1 = new OptimizationEngine(SETTINGS);
  const eng2 = new OptimizationEngine(SETTINGS);
  const prices = makePrices(24).map((p, i) => ({
    ...p, price: i >= 18 ? 0.35 : 0.15
  }));
  const pNoPv = eng1.computeExpectedProfit(prices, 50, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, 0).profit;
  const pFullPv = eng2.computeExpectedProfit(prices, 50, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, CAPACITY_KWH).profit;
  assert.ok(pFullPv >= pNoPv - 0.001,
    `Expected full-PV profit (${pFullPv}) >= no-PV profit (${pNoPv})`);
});

// ── pvKwhTomorrow = 0 → terminal value active, held charge has value ──────────
// SoC 90%, flat low price: no discharge opportunity in horizon, but stored energy
// retains value via terminal → projected profit should be positive.
test('high SoC, flat low price, no PV tomorrow → terminal value > 0', () => {
  const eng = new OptimizationEngine({ ...SETTINGS, cycle_cost_per_kwh: 0 });
  const prices = makePrices(24, 0.15);
  const result = eng.computeExpectedProfit(
    prices, 90, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, 0
  );
  assert.ok(result.profit > 0, `Expected positive terminal value, got ${result.profit}`);
});

// ── pvKwhTomorrow at 80% threshold → terminal factor ≈ 0 ─────────────────────
// At exactly pvRefill = 0.8 × capacity, terminalFactor = 1 - 0.8/0.8 = 0.
test('pvKwhTomorrow = 80% capacity → terminal value ≈ 0', () => {
  const pvKwh80 = CAPACITY_KWH * 0.8;
  const pvKwh79 = CAPACITY_KWH * 0.79;
  const eng80 = new OptimizationEngine({ ...SETTINGS, cycle_cost_per_kwh: 0 });
  const eng79 = new OptimizationEngine({ ...SETTINGS, cycle_cost_per_kwh: 0 });
  const prices = makePrices(24, 0.15);
  const p80 = eng80.computeExpectedProfit(prices, 90, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, pvKwh80).profit;
  const p79 = eng79.computeExpectedProfit(prices, 90, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W,
    null, null, null, 0, 1.0, pvKwh79).profit;
  // At 80% threshold terminal = 0; just below 80% terminal > 0 → p79 >= p80
  assert.ok(p79 >= p80 - 0.001,
    `Expected p79 (${p79.toFixed(4)}) >= p80 (${p80.toFixed(4)})`);
});

// ── Scalable refill normaliser: cap by overnight-dischargeable, not full cap ──
// Discharge is firmware-capped at 800 W regardless of pack size. A 4-battery pack
// (10.75 kWh) can only empty ~8 kWh overnight (800 W × ~10 h), so PV that refills
// that 8 kWh fully discounts the terminal value — even though 8 kWh is < 80% of the
// 10.75 kWh full capacity (old normaliser would still hoard).
test('large pack: PV ≥ overnight-dischargeable → terminal ≈ 0 (no over-hoard)', () => {
  const BIG_CAP = 10.75; // 4-battery pack
  const eng = new OptimizationEngine({ ...SETTINGS, cycle_cost_per_kwh: 0 });
  const prices = makePrices(24, 0.15); // flat → no arbitrage
  const noCons = Array(24).fill(0);    // zero consumption → no discharge value; leftover SoC valued only by terminal
  // 8 kWh = 800 W × 10 h overnight-dischargeable; = 8/10.75 = 0.74 of full capacity.
  const p = eng.computeExpectedProfit(prices, 90, BIG_CAP, MAX_POWER_W, MAX_POWER_W,
    null, null, noCons, 0, 1.0, 8.0).profit;
  // New normaliser: 8 / min(0.95×10.75, 800W×10h=8) = 1.0 → terminalFactor 0 → no residual value.
  // Old normaliser: 8 / 10.75 = 0.74 → terminalFactor 0.07 → residual value > 0.01.
  assert.ok(Math.abs(p) < 0.01, `Expected terminal≈0 on big pack with sufficient PV, got ${p}`);
});

// ── sumPvNetWindow: terminal (post-horizon) window excludes today's PV ────────
// Bug: terminal refill used a now→+24h window, double-counting today's PV that
// the DP forward pass already credits. Terminal window must start at horizon end.
test('sumPvNetWindow: post-horizon window excludes today PV (no double-count)', () => {
  const base = new Date();
  base.setMinutes(0, 0, 0);
  const t0 = base.getTime();
  // 48 hourly slots from t0+1h: big PV in first 12h (today), tiny PV after.
  const pv = Array.from({ length: 48 }, (_, i) => ({
    timestamp: new Date(t0 + (i + 1) * 3_600_000).toISOString(),
    pvPowerW: i < 12 ? 3000 : 100
  }));
  const maxCharge = 800;
  const horizonEnd = t0 + 12 * 3_600_000; // horizon ends 12h out

  const nowWin  = OptimizationEngine.sumPvNetWindow(pv, t0, t0 + 24 * 3_600_000, maxCharge, null);
  const termWin = OptimizationEngine.sumPvNetWindow(pv, horizonEnd, horizonEnd + 24 * 3_600_000, maxCharge, null);

  // now-window captures the big (clamped-to-800W) today slots → high
  assert.ok(nowWin > termWin, `now-window (${nowWin}) should exceed terminal-window (${termWin})`);
  // terminal-window sees only post-horizon tiny PV → today's PV not counted
  assert.ok(termWin < 2.5, `terminal window should exclude today PV, got ${termWin}`);
});

// ── computeExpectedProfit returns { profit, selfSufficiencyPct } ──────────────
test('return shape: { profit: number, selfSufficiencyPct: number }', () => {
  const eng = new OptimizationEngine(SETTINGS);
  const result = eng.computeExpectedProfit(makePrices(), 50, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W);
  assert.strictEqual(typeof result.profit, 'number');
  assert.strictEqual(typeof result.selfSufficiencyPct, 'number');
});

// ── Empty prices → returns { profit: 0, selfSufficiencyPct: 0 } ──────────────
test('empty prices → profit 0', () => {
  const eng = new OptimizationEngine(SETTINGS);
  const result = eng.computeExpectedProfit([], 50, CAPACITY_KWH, MAX_POWER_W, MAX_POWER_W);
  assert.strictEqual(result.profit, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
