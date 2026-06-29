'use strict';

// Regression: fff7cd5 (2026-06-26) introduced a rawOM×dayCorr display override for
// today's chart, bypassing pvCapacityW cap and diverging from the DP forecast.
// This violated the chart=DP agreement: policy_pv_forecast_hourly must equal DP input.
//
// _buildPvChartByDay enforces:
//   1. All values ≤ pvCapacityW when pvCapacityW > 0.
//   2. Future hours come from pvForecast (DP-sourced), NOT from rawOM×dayCorr.
//   3. Past hours preserved from existing[0] (capped).

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const build = BatteryPolicyDevice._buildPvChartByDay.bind(BatteryPolicyDevice);

// --- helpers -----------------------------------------------------------------

// Amsterdam CEST = UTC+2. To place a slot at AMS hour H on `now`, emit UTC H-2.
function slot(now, dayOffset, amsHour, pvPowerW) {
  const d = new Date(now.getTime() + dayOffset * 86_400_000);
  const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  // Build a UTC timestamp that lands at `amsHour` in Amsterdam on that date.
  const utcHour = (amsHour - 2 + 24) % 24;  // CEST offset
  return { timestamp: `${dateStr}T${String(utcHour).padStart(2, '0')}:00:00.000Z`, pvPowerW };
}

const NOW        = new Date('2026-06-29T10:00:00.000Z');  // 12:00 CEST
const CAP        = 3600;
const EXISTING   = [{ 10: 1200, 11: 2800 }, { 10: 3100 }];  // past hours today + tomorrow base

// --- 1. cap invariant: all values ≤ pvCapacityW ------------------------------

const overCap = [
  slot(NOW, 0, 13, 4350),   // future today, would be 4350 without cap (fff7cd5 value)
  slot(NOW, 0, 14, 5000),
  slot(NOW, 1, 12, 4000),   // tomorrow
];
const resultCapped = build(EXISTING, overCap, CAP, NOW);

for (const [h, w] of Object.entries(resultCapped[0])) {
  assert.ok(w <= CAP, `today hour ${h}: ${w} exceeds cap ${CAP}`);
}
for (const [h, w] of Object.entries(resultCapped[1])) {
  assert.ok(w <= CAP, `tomorrow hour ${h}: ${w} exceeds cap ${CAP}`);
}

// --- 2. future hours come from pvForecast, not from an override --------------

// If pvForecast has 3200W at AMS 13:00, chart must show 3200 (capped), never dayCorr×rawOM.
const fc13 = [slot(NOW, 0, 13, 3200)];
const r = build(null, fc13, CAP, NOW);
assert.strictEqual(r[0][13], 3200, 'future hour 13 must equal pvForecast value');

// The fff7cd5 artifact: rawOM=3600×dayCorr=1.21 → 4356, displayed as 4350.
// With pvForecast=3000 at hour 13, chart must show 3000, not 4350.
const fc13dp = [slot(NOW, 0, 13, 3000)];
const rDp = build(null, fc13dp, CAP, NOW);
assert.strictEqual(rDp[0][13], 3000, 'future hour must use pvForecast, not rawOM×dayCorr');
assert.ok(rDp[0][13] !== 4350, 'fff7cd5 artifact 4350 must not appear');

// --- 3. past hours preserved from existing[0], capped ------------------------

// Hours 10 and 11 are in the past (NOW = 12:00 AMS); no pvForecast slot for them.
const rPast = build(EXISTING, [], CAP, NOW);
assert.strictEqual(rPast[0][10], 1200, 'past hour 10 preserved from existing');
assert.strictEqual(rPast[0][11], 2800, 'past hour 11 preserved from existing');

// Past hour with value above cap → must be clamped.
const highExisting = [{ 10: 5000 }, {}];
const rHighPast = build(highExisting, [], CAP, NOW);
assert.strictEqual(rHighPast[0][10], CAP, 'past hour above cap clamped to pvCapacityW');

// --- 4. pvCapacityW=0 disables cap (no pv_capacity_w configured) ------------

const rNoCap = build(null, [slot(NOW, 0, 13, 5000)], 0, NOW);
assert.strictEqual(rNoCap[0][13], 5000, 'pvCapacityW=0 disables cap');

// --- 5. tomorrow slots stored independently ----------------------------------

const fcTom = [slot(NOW, 1, 14, 2800)];
const rTom = build(null, fcTom, CAP, NOW);
assert.strictEqual(rTom[1][14], 2800, 'tomorrow slot stored at index 1');
assert.deepStrictEqual(rTom[0], {}, 'today untouched when no today slots');

// --- 6. multiple 15-min slots per hour → averaged + capped ------------------

const fc15min = [
  { timestamp: '2026-06-29T11:00:00.000Z', pvPowerW: 4000 },  // AMS 13:00
  { timestamp: '2026-06-29T11:15:00.000Z', pvPowerW: 4200 },  // AMS 13:15 → same hour
];
const rAvg = build(null, fc15min, CAP, NOW);
// avg = (4000+4200)/2 = 4100 → clamped to 3600
assert.strictEqual(rAvg[0][13], 3600, 'multi-slot average capped at pvCapacityW');

console.log('pv-chart-cap: all assertions passed');
