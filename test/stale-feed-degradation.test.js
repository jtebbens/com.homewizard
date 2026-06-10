'use strict';

// Stale-feed degradation matrix: every external feed (prices, PV forecast,
// consumption profile, confidence factors) can fail or go stale. The DP must
// degrade safely in every case: never NaN in the schedule, never act on
// prices that are no longer current, never plan grid charging on broken
// price data. Provider reality: merged-price-provider returns a stale cache
// (valid prices, past timestamps) or throws; parse anomalies can yield
// null/NaN fields.

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

const H = 3_600_000;
const SETTINGS = { battery_efficiency: 0.90, min_soc: 10, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
const ACTIONS = new Set(['charge', 'discharge', 'preserve', 'standby', 'trickle']);

// 24h of plausible feeds anchored at `base` (default: top of the current hour,
// so getSlot(new Date()) lands inside the horizon).
function makeFeeds(base = Math.floor(Date.now() / H) * H) {
  const prices = [], pv = [], cons = [];
  for (let t = 0; t < 24; t++) {
    let p = 0.15;
    if (t >= 7 && t <= 9) p = 0.35;
    if (t >= 18 && t <= 21) p = 0.45;
    prices.push({ timestamp: new Date(base + t * H).toISOString(), price: p });
    pv.push({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: (t >= 10 && t <= 15) ? 2500 : 0 });
    cons.push(500);
  }
  return { prices, pv, cons };
}

function compute(eng, { prices, pv, cons }, refillConfidence = 1.0, pvCloudFactor = 1.0) {
  eng.compute(prices, 50, 5, 2000, 2000, pv, null, cons, 0, 1.0, 0, 0, pvCloudFactor, refillConfidence);
}

function assertScheduleSane(eng) {
  const sched = eng._schedule;
  assert.ok(sched, 'schedule built');
  assert.ok(Number.isFinite(sched.projectedProfit), `projectedProfit finite, got ${sched.projectedProfit}`);
  for (const s of sched.slots) {
    assert.ok(ACTIONS.has(s.action), `known action, got ${s.action}`);
    assert.ok(Number.isFinite(s.socProjected), `socProjected finite @${s.timestamp}, got ${s.socProjected}`);
    assert.ok(s.socProjected >= 0 && s.socProjected <= 100, `socProjected in range, got ${s.socProjected}`);
  }
}

// ── Feed: prijzen ────────────────────────────────────────────────────────────

test('prices missing (null / empty) → no schedule, getSlot null, isStale true', () => {
  const { pv, cons } = makeFeeds();
  for (const broken of [null, []]) {
    const eng = new OptimizationEngine(SETTINGS);
    compute(eng, { prices: broken, pv, cons });
    assert.strictEqual(eng._schedule, null, 'schedule stays null');
    assert.strictEqual(eng.getSlot(new Date()), null, 'getSlot null');
    assert.strictEqual(eng.isStale(), true, 'isStale true');
  }
});

test('stale price cache (yesterday) → schedule exists but getSlot(now) refuses', () => {
  const feeds = makeFeeds(Math.floor(Date.now() / H) * H - 26 * H);
  const eng = new OptimizationEngine(SETTINGS);
  compute(eng, feeds);
  assertScheduleSane(eng);
  assert.strictEqual(eng.getSlot(new Date()), null, 'no action from a horizon that ended yesterday');
  assert.strictEqual(eng.getSlotMeta(new Date()), null, 'no meta either');
});

test('non-finite price values (null/NaN slots) → compute refuses, no schedule', () => {
  for (const bad of [null, NaN]) {
    const feeds = makeFeeds();
    feeds.prices[5].price = bad;
    const eng = new OptimizationEngine(SETTINGS);
    compute(eng, feeds);
    assert.strictEqual(eng._schedule, null, `schedule refused on price=${bad}`);
    assert.strictEqual(eng.getSlot(new Date()), null, 'getSlot null');
  }
});

// ── Feed: PV-forecast ────────────────────────────────────────────────────────

test('PV forecast missing (null / empty) → sane schedule without PV', () => {
  for (const broken of [null, []]) {
    const feeds = makeFeeds();
    feeds.pv = broken;
    const eng = new OptimizationEngine(SETTINGS);
    compute(eng, feeds);
    assertScheduleSane(eng);
  }
});

test('PV forecast with NaN watts → sane schedule (bad samples ignored)', () => {
  const feeds = makeFeeds();
  feeds.pv[12].pvPowerW = NaN;
  feeds.pv[13].pvPowerW = null;
  const eng = new OptimizationEngine(SETTINGS);
  compute(eng, feeds);
  assertScheduleSane(eng);
});

// ── Feed: verbruiksprofiel ───────────────────────────────────────────────────

test('consumption profile missing or NaN entries → sane schedule (baseload floor)', () => {
  for (const mutate of [
    (f) => { f.cons = null; },
    (f) => { f.cons[3] = NaN; f.cons[4] = undefined; },
  ]) {
    const feeds = makeFeeds();
    mutate(feeds);
    const eng = new OptimizationEngine(SETTINGS);
    compute(eng, feeds);
    assertScheduleSane(eng);
  }
});

// ── Feed: confidence/cloud-factoren ──────────────────────────────────────────

test('NaN refillConfidence / pvCloudFactor → sane schedule (factor neutralized)', () => {
  for (const [conf, cloud] of [[NaN, 1.0], [1.0, NaN], [NaN, NaN]]) {
    const feeds = makeFeeds();
    const eng = new OptimizationEngine(SETTINGS);
    compute(eng, feeds, conf, cloud);
    assertScheduleSane(eng);
  }
});

console.log('\n══════════════════════════════');
console.log(`Passed: ${passed}, Failed: ${failed}`);
console.log('══════════════════════════════');
if (failed > 0) process.exit(1);
