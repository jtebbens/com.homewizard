'use strict';

/**
 * dailyBias must not multiply a slot that carries a fresh satellite nowcast.
 *
 * Why this exists: on 2026-08-17 the OM+sat blend put 08:00 UTC at 1250 W (the roof did 1403 W)
 * and the daily weather-type factor 0.440 — classified on OM cloud cover, because KNMI kt was
 * still null that early — handed the optimizer 550 W. The factor is a per-weather-TYPE residual;
 * a slot whose sky has actually been observed should not be corrected by a guess about the type.
 *
 * The freshness predicate is the shared one (`_satSlotIsFresh`); the exemption itself is the
 * two map branches in device.js that consult it, mirrored here as `applyBias` so the branch
 * semantics are pinned without booting a Homey device.
 */

const assert = require('assert');
const Module = require('module');

// Stub 'homey' + heavy device-deps so battery-policy/device.js loads outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-17T08:15:00.000Z');

const slot = (over = {}) => ({
  timestamp: '2026-08-17T08:00:00.000Z',
  pvPowerW: 1250,
  satPanelW: 1781,
  satIssueMs: NOW - 15 * 60_000,
  ...over,
});

// Mirrors the two branches in device.js around the dailyBias map.
function applyBias(slots, factor, { satExempt, nowMs, simplified = false, todayKey = null }) {
  return slots.map(s => {
    const skip = satExempt && BatteryPolicyDevice._satSlotIsFresh(s, nowMs);
    if (simplified && todayKey && s.timestamp.startsWith(todayKey)) return s;
    if (skip) return s;
    return { ...s, pvPowerW: Math.round(s.pvPowerW * factor) };
  });
}

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok - ${name}`); };

console.log('dailyBias satellite exemption');

check('fresh sat slot with the setting ON keeps its blended value', () => {
  const [out] = applyBias([slot()], 0.440, { satExempt: true, nowMs: NOW });
  assert.strictEqual(out.pvPowerW, 1250, 'exempt slot must not be scaled');
});

check('same slot with the setting OFF is scaled — current live behaviour', () => {
  const [out] = applyBias([slot()], 0.440, { satExempt: false, nowMs: NOW });
  assert.strictEqual(out.pvPowerW, 550, 'this is the 2026-08-17 number the DP actually got');
});

check('stale sat issue is scaled even with the setting ON', () => {
  const stale = slot({ satIssueMs: NOW - 2 * HOUR });
  const [out] = applyBias([stale], 0.440, { satExempt: true, nowMs: NOW });
  assert.strictEqual(out.pvPowerW, 550, 'past SAT_MAX_AGE_MS the slot is not a nowcast');
});

check('slot without a satellite value is scaled', () => {
  const noSat = slot({ satPanelW: null, satIssueMs: null });
  const [out] = applyBias([noSat], 0.440, { satExempt: true, nowMs: NOW });
  assert.strictEqual(out.pvPowerW, 550);
});

check('clear-day uplift (>1.0) is exempt too — a guess either direction', () => {
  const [out] = applyBias([slot()], 1.225, { satExempt: true, nowMs: NOW });
  assert.strictEqual(out.pvPowerW, 1250, 'observed sky needs no weather-type uplift');
  const [ref] = applyBias([slot()], 1.225, { satExempt: false, nowMs: NOW });
  assert.strictEqual(ref.pvPowerW, 1531);
});

check('simplified branch: today is skipped anyway, tomorrow honours the exemption', () => {
  const tomorrow = slot({ timestamp: '2026-08-18T08:00:00.000Z' });
  const [t] = applyBias([tomorrow], 0.440, {
    satExempt: true, nowMs: NOW, simplified: true, todayKey: '2026-08-17',
  });
  assert.strictEqual(t.pvPowerW, 1250);
  const [t2] = applyBias([tomorrow], 0.440, {
    satExempt: false, nowMs: NOW, simplified: true, todayKey: '2026-08-17',
  });
  assert.strictEqual(t2.pvPowerW, 550);
});

check('_satSlotIsFresh rejects junk without throwing', () => {
  assert.strictEqual(BatteryPolicyDevice._satSlotIsFresh(null, NOW), false);
  assert.strictEqual(BatteryPolicyDevice._satSlotIsFresh({}, NOW), false);
  assert.strictEqual(BatteryPolicyDevice._satSlotIsFresh({ satPanelW: 100 }, NOW), false);
});

console.log(`\n${passed} passed`);
