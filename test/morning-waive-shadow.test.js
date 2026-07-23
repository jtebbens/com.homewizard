'use strict';

// Morning-waive shadow metric (project_morning_reserve_floor_holds_through_peak). The refill-reserve
// floor can hold morning kWh through the day's most expensive hours while midday PV refills the
// battery anyway — a per-day waste on sunny days, but genuinely needed on cloudy/uncertain days.
// _morningWaiveShadowMetrics quantifies this per policy-run from the live plan (floor ON) vs a
// counterfactual with refillConfidence=1.0 (floor OFF).
//
// CRITICAL — anti-tautology: removing a DP constraint can only raise forecast profit
// (profit_OFF >= profit_ON by construction), so a Δ-profit metric can NEVER be negative and proves
// nothing (feedback_metric_must_allow_negative; device.js spreadband note). This suite proves the
// metric is TWO-SIDED: positive when the floor was redundant, NEGATIVE when the floor was needed.
//
// WINDOW ANCHORING: the metric anchors the morning-trough / midday-refill / evening-peak window on
// the PV block (slots carry pvForecastW), NOT on wall-clock hour — the forward horizon starts at NOW,
// so an evening run has slot[0] mid-cycle and tomorrow's morning sits mid-horizon. The evening-run
// regression below is the case the old `localHour>=16 break` returned null on.
//
// device.js does require('homey'), so stub that module before loading the class to reach its
// prototype method. We never instantiate the Homey lifecycle.

const assert = require('assert');
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'homey') return { Device: class {}, App: class {}, FlowCardTrigger: class {} };
  return _origLoad.call(this, req, ...a);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module._load = _origLoad;
const OptimizationEngine = require('../lib/optimization-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const CAP = 2.69;
const H = 3_600_000;
// Bare object carrying only what the metric method reads via `this`.
function makeDev() {
  const dev = { getSettings: () => ({ max_soc: 100 }) };
  dev._morningWaiveShadowMetrics = BatteryPolicyDevice.prototype._morningWaiveShadowMetrics;
  return dev;
}

// Build ON/OFF slot arrays from hourly rows [price, socON, socOFF, pvW] starting at startIso. Slots
// carry the real forward-horizon timestamps (starting at "now" = startIso) so the PV-anchored window
// logic is exercised exactly as live. Metric reads {timestamp, price, socProjected, pvForecastW}.
function build(startIso, rows) {
  const base = new Date(startIso).getTime();
  const mk = (r, i, soc) => ({
    timestamp: new Date(base + i * H).toISOString(),
    price: r[0], socProjected: soc, pvForecastW: r[3] ?? 0, action: 'x',
  });
  const on = rows.map((r, i) => mk(r, i, r[1]));
  const off = rows.map((r, i) => mk(r, i, r[2]));
  return { on, off };
}

// ── Scenario A: sunny/redundant, MORNING run (starts 06:00 CEST = 04:00Z). ON holds at the 16% floor
// through the €0.33-0.34 morning peak; OFF drains to 5%. Midday PV refills BOTH to 100%; evening peak
// served identically. The held morning kWh was refilled cheaply → waive would have profited →
// eurAtStake POSITIVE. ───────────────────────────────────────────────────────────────────────────
test('redundant floor (sunny): positive eurAtStake, held>0, bothMax, offEvening served', () => {
  const { on, off } = build('2026-07-23T04:00:00.000Z', [
    // price  socON  socOFF  pvW
    [0.34, 16, 40, 0],    // 06h
    [0.34, 16, 20, 0],    // 07h
    [0.33, 16,  5, 0],    // 08h  OFF trough; floor holds ON 11% above
    [0.20, 16,  5, 0],    // 09h
    [0.14, 40, 30, 900],  // 10h  midday PV refill
    [0.14, 70, 60, 1500], // 11h
    [0.13, 100, 100, 1600], // 12h  both reach max
    [0.14, 100, 100, 1400], // 13h
    [0.16, 100, 100, 800],  // 14h
    [0.22, 100, 100, 0],    // 15h
    [0.30, 100, 100, 0],    // 16h
    [0.36, 70, 70, 0],    // 17h  evening peak, discharged identically
    [0.36, 40, 40, 0],    // 18h
    [0.35, 20, 20, 0],    // 19h
    [0.30, 10, 10, 0],    // 20h
  ]);
  const m = makeDev()._morningWaiveShadowMetrics(on, off, CAP);
  assert.ok(m, 'metric returned');
  assert.ok(Math.abs(m.heldKwh - (11 / 100 * CAP)) < 1e-9, `heldKwh ${m.heldKwh}`);
  assert.strictEqual(m.bothReachMax, true);
  assert.strictEqual(m.offServesEvening, true);
  assert.ok(m.eurAtStake > 0, `expected positive eurAtStake, got ${m.eurAtStake}`);
});

// ── Scenario B: cloudy/stranded, MORNING run. OFF drains the morning to 5% and the weak midday PV
// only partially refills it, so at the evening peak OFF has far less to give than ON (held at 16%).
// Waiving the floor would have stranded the evening → the floor was NEEDED → eurAtStake NEGATIVE.
// This is the case a Δ-profit metric could never surface. ──────────────────────────────────────────
test('needed floor (cloudy/stranded): NEGATIVE eurAtStake, offEvening NOT served', () => {
  const { on, off } = build('2026-07-23T04:00:00.000Z', [
    [0.34, 16, 40, 0],    // 06h
    [0.34, 16, 20, 0],    // 07h
    [0.33, 16,  5, 0],    // 08h  OFF trough
    [0.20, 16,  5, 0],    // 09h
    [0.18, 30,  8, 800],  // 10h  weak PV — partial refill only
    [0.16, 45, 12, 900],  // 11h
    [0.15, 55, 16, 900],  // 12h
    [0.16, 60, 18, 700],  // 13h
    [0.20, 62, 20, 400],  // 14h  PV ends
    [0.26, 60, 19, 0],    // 15h
    [0.30, 55, 15, 0],    // 16h
    [0.36, 40, 10, 0],    // 17h  evening peak: ON serves far more than the drained OFF
    [0.36, 25,  6, 0],    // 18h
    [0.35, 15,  4, 0],    // 19h
  ]);
  const m = makeDev()._morningWaiveShadowMetrics(on, off, CAP);
  assert.ok(m, 'metric returned');
  assert.ok(m.heldKwh > 0, `heldKwh ${m.heldKwh}`);
  assert.strictEqual(m.offServesEvening, false);
  assert.ok(m.eurAtStake < 0, `expected NEGATIVE eurAtStake, got ${m.eurAtStake}`);
});

// ── Regression: EVENING run (starts 17:00 CEST = 15:00Z). Tonight's evening peak discharges first,
// then an overnight flat, then TOMORROW's morning drain and midday PV sit mid-horizon. The old code
// hit `localHour>=16` on slot[0] → break → tMin=-1 → null on every such run. The PV anchor must (1)
// return a metric and (2) locate tMin on tomorrow's morning trough (held≈12%), NOT on tonight's
// evening low (which would give held≈8%). ──────────────────────────────────────────────────────────
test('evening-anchored horizon: returns metric, tMin on tomorrow morning not tonight low', () => {
  const { on, off } = build('2026-07-23T15:00:00.000Z', [
    // price  socON  socOFF  pvW
    [0.36, 70, 60, 0],    // 17h  tonight's evening peak — both discharge
    [0.36, 50, 35, 0],    // 18h
    [0.35, 35, 20, 0],    // 19h
    [0.30, 28, 12, 0],    // 20h
    [0.24, 20, 10, 0],    // 21h  tonight low: ON held ~18 (floor), OFF at ~10 → gap 8%
    [0.22, 18, 10, 0],    // 22h
    [0.20, 18, 10, 0],    // 23h
    [0.19, 18, 10, 0],    // 00h  overnight flat
    [0.18, 18, 10, 0],    // 01h
    [0.18, 18, 10, 0],    // 02h
    [0.19, 18, 10, 0],    // 03h
    [0.20, 18, 10, 0],    // 04h
    [0.22, 18,  9, 0],    // 05h  tomorrow morning drain begins
    [0.28, 18,  7, 0],    // 06h
    [0.32, 18,  6, 0],    // 07h  morning peak: OFF drains to 6, ON held 18 → gap 12%
    [0.30, 18,  6, 100],  // 08h  dawn PV below threshold
    [0.20, 30, 10, 700],  // 09h  midday PV refill onset
    [0.16, 50, 25, 1200], // 10h
    [0.14, 70, 45, 1500], // 11h  PV peak
    [0.13, 90, 65, 1400], // 12h
    [0.14, 100, 85, 1000],// 13h
    [0.16, 100, 95, 500], // 14h  PV ends
    [0.22, 100, 100, 0],  // 15h
    [0.30, 85, 85, 0],    // 16h  tomorrow evening starts
  ]);
  const m = makeDev()._morningWaiveShadowMetrics(on, off, CAP);
  assert.ok(m, 'metric returned on evening-anchored horizon (old code returned null here)');
  // tMin on tomorrow's morning trough (08h, gap 12%) — NOT tonight's low (gap 8%).
  assert.ok(Math.abs(m.heldKwh - (12 / 100 * CAP)) < 1e-9,
    `expected held≈${(12 / 100 * CAP).toFixed(3)} (morning trough), got ${m.heldKwh.toFixed(3)}`);
});

test('null on empty / mismatched slot arrays / no PV in horizon', () => {
  const dev = makeDev();
  assert.strictEqual(dev._morningWaiveShadowMetrics([], [], CAP), null);
  assert.strictEqual(dev._morningWaiveShadowMetrics(null, null, CAP), null);
  assert.strictEqual(dev._morningWaiveShadowMetrics([{}], [{}, {}], CAP), null);
  // No PV block anywhere → the waive question is moot → null.
  const { on, off } = build('2026-07-23T04:00:00.000Z', [
    [0.34, 16, 40, 0], [0.33, 16, 5, 0], [0.20, 16, 5, 0], [0.36, 8, 2, 0],
  ]);
  assert.strictEqual(dev._morningWaiveShadowMetrics(on, off, CAP), null);
});

// ── Isolation: the shadow run uses a SEPARATE engine instance, so computing the OFF counterfactual
// must not touch the live engine's _schedule. Prove independence directly. ─────────────────────
test('separate engine instances do not cross-contaminate _schedule', () => {
  const SETTINGS = { battery_efficiency: 0.90, min_soc: 10, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };
  const base = new Date('2026-06-01T00:00:00+02:00').getTime();
  const prices = [], pv = [], cons = [];
  for (let t = 0; t < 24; t++) {
    let p = 0.15;
    if (t <= 6) p = 0.20;
    if (t >= 18 && t <= 22) p = 0.45;
    prices.push({ timestamp: new Date(base + t * H).toISOString(), price: p });
    pv.push({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: (t >= 9 && t <= 15) ? 3000 : 0 });
    cons.push(600);
  }
  const args = (rc) => [prices, 80, 5, 2000, 2000, pv, null, cons, 0, 1.0, 0, 0, 1.0, rc];
  const live = new OptimizationEngine(SETTINGS);
  const shadow = new OptimizationEngine(SETTINGS);
  live.compute(...args(0.0));                       // floor ON
  const liveSnapshot = JSON.stringify(live._schedule.slots);
  const liveRef = live._schedule;
  shadow.compute(...args(1.0));                     // floor OFF on the OTHER engine
  assert.strictEqual(live._schedule, liveRef, 'live _schedule reference replaced');
  assert.strictEqual(JSON.stringify(live._schedule.slots), liveSnapshot, 'live slots mutated by shadow compute');
});

console.log(`\nmorning-waive-shadow: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
