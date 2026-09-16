'use strict';

// Regression: _shouldForceReoptimize's PV-drift trigger compared a RAW 3h actual/forecast ratio
// against _lastIntradayPvRatio, which is the DAMPED ratio the DP actually applied (CV weight ×
// cloud gate). On a volatile day the damping pins the applied ratio at 1.00 while the raw ratio
// sits at ~0.80, so every policy run — including a PV-state-triggered run mid-slot — forced a
// full DP recompute. Live 2026-09-16 12:53 CEST: "[Reopt] PV ratio drift 0.20 (was 1.00, now
// 0.80)" next to "[PV intraday] … ratio=1.00 … no scaling", flipping a 12:45 to_full to
// zero_charge_only with unchanged prices. The trigger must compare damped with damped.

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

function preds(actuals, predicted = 1000) {
  return actuals.map((actual, i) => ({ timestamp: nowMs - (i + 1) * 15 * 60_000, predicted, actual }));
}

function fakeDevice({ actuals, lastRatio, gateInputs }) {
  const logs = [];
  return {
    logs,
    log: (m) => logs.push(m),
    optimizationEngine: { _schedule: { slots: [{ timestamp: new Date(nowMs - 60_000).toISOString(), socProjected: 4 }] } },
    learningEngine: { data: { pv_predictions: preds(actuals) } },
    _lastIntradayPvRatio: lastRatio,
    _lastIntradayPvGateInputs: gateInputs,
  };
}

const check = (dev) => BatteryPolicyDevice.prototype._shouldForceReoptimize.call(dev, 4);
const gateInputs = { biasCorrFactor: 1.0, cloud: 83, kt: null, okta: null };

// 1. The 12:53 case: volatile samples (raw ratio 0.80, CV ≈ 0.69 → damped to 1.00), last applied
//    ratio 1.00. Nothing the DP uses has drifted → no forced recompute.
{
  const volatile = [200, 1400, 250, 1350, 200, 1400];
  const raw = volatile.reduce((s, a) => s + a, 0) / (1000 * volatile.length);
  assert.ok(Math.abs(raw - 0.80) < 1e-9, 'fixture: raw ratio is 0.80');
  const dev = fakeDevice({ actuals: volatile, lastRatio: 1.0, gateInputs });
  assert.strictEqual(check(dev), false,
    `volatile day with damped ratio unchanged must not force recompute; logs: ${dev.logs.join(' | ')}`);
}

// 2. Real drift survives: steady under-production (ratio 0.50, CV 0 → full weight) vs last 1.00.
{
  const dev = fakeDevice({ actuals: [500, 500, 500, 500, 500, 500], lastRatio: 1.0, gateInputs });
  assert.strictEqual(check(dev), true, 'steady 0.50 vs applied 1.00 must still force recompute');
  assert.ok(dev.logs.some(l => l.includes('[Reopt] PV ratio drift')), 'drift is logged');
}

// 3. Same formula as the DP: feeding the corrector's own ratio back as the baseline never fires.
{
  const samples = preds([400, 900, 650, 700, 820]);
  const { ratio } = BatteryPolicyDevice._intradayPvRatio(samples, 1.0,
    (c) => BatteryPolicyDevice._knmiAwareCloudGate(c, gateInputs.cloud, gateInputs.kt, gateInputs.okta));
  const dev = fakeDevice({ actuals: [400, 900, 650, 700, 820], lastRatio: ratio, gateInputs });
  assert.strictEqual(check(dev), false, `baseline = corrector ratio ${ratio.toFixed(3)} must not drift`);
}

console.log('reopt-pv-drift-damped: 3/3 passed');
