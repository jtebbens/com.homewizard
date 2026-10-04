'use strict';

// Regression: a charge stopped at 99% because the plan already counted the battery as full.
// Live 2026-09-17 14:30 CEST: SoC 98%, kwhNeeded=0.05 → the DP planned one charge slot at 800W,
// so the 14:45 slot started at socProjected=100 with action preserve. The BMS tapered the charge
// (716 → 120W) and the battery reached 99%. The 14:45 run logged
// "[SoC] actual=99% planned=100.0% drift=-1.0pp" — far under the 15 pp recompute trigger — kept
// the stale plan, read preserve with 0W surplus and went to standby. It stayed at 99%.
// A plan that says full while the battery is not must be recomputed from the real SoC.

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

const nowMs = Date.now();

function fakeDevice({ socProjected, maxSoc = 100 }) {
  const logs = [];
  return {
    logs,
    log: (m) => logs.push(m),
    getSetting: (k) => (k === 'max_soc' ? maxSoc : null),
    optimizationEngine: { _schedule: { slots: [{ timestamp: new Date(nowMs - 60_000).toISOString(), socProjected }] } },
    learningEngine: { data: { pv_predictions: [] } },
    _lastIntradayPvRatio: null,
  };
}

const check = (dev, soc) => BatteryPolicyDevice.prototype._shouldForceReoptimize.call(dev, soc);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log('\n_shouldForceReoptimize — plan full, battery not\n');

test('live 14:45: planned 100%, actual 99% → recompute', () => {
  const dev = fakeDevice({ socProjected: 100 });
  assert.strictEqual(check(dev, 99), true, `logs: ${dev.logs.join(' | ')}`);
  assert.ok(dev.logs.some(l => l.includes('[Reopt] plan full')), 'trigger is logged');
});

test('planned 100%, actual 100% → no recompute', () => {
  assert.strictEqual(check(fakeDevice({ socProjected: 100 }), 100), false);
});

test('user max_soc 90: planned 90%, actual 89% → recompute', () => {
  assert.strictEqual(check(fakeDevice({ socProjected: 90, maxSoc: 90 }), 89), true);
});

test('plan not full: planned 95%, actual 94% → no recompute', () => {
  assert.strictEqual(check(fakeDevice({ socProjected: 95 }), 94), false);
});

test('existing drift trigger: planned 60%, actual 40% → recompute', () => {
  assert.strictEqual(check(fakeDevice({ socProjected: 60 }), 40), true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
