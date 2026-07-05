'use strict';

// Regression: the PV OVERSCHOT block (policy-engine.js _computePvFlags) gated its
// export/store override on `pv_power_estimated >= 100` — PV *present*, not PV
// *surplus*. Live 2026-07-02: PV 261W < house load 448W (grid +187W import) still
// tripped the block, which logged "export wins → PV to grid" and thrashed the HW
// mode standby↔charge at SoC 15% with nothing to export. Fix: require real net
// surplus — grid genuinely exporting, or PV exceeding the learned house load.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine.js');

// --- predicate mirror ---------------------------------------------------------
// Mirrors the live gate at policy-engine.js:305. Kept in sync by hand (2 lines);
// the direct-call test below exercises the real method for the no-op path.
function surplusDetected(grid, pvEstW, consW) {
  return grid < -200 || (pvEstW - consW) > 100;
}

// PV below house load, grid importing → NO surplus (the 2026-07-02 false trigger).
assert.strictEqual(surplusDetected(187, 261, 448), false, 'PV<load, importing → no surplus');

// Old code fired here (pvEst 150 >= 100); new code must not (150-448 < 100).
assert.strictEqual(surplusDetected(0, 150, 448), false, 'PV present but < load → no surplus (the fix)');

// PV clearly exceeds house load by > 100W → real surplus.
assert.strictEqual(surplusDetected(0, 900, 450), true, 'PV > load by >100W → surplus');

// Grid genuinely exporting → surplus regardless of PV estimate.
assert.strictEqual(surplusDetected(-800, 50, 400), true, 'grid exporting → surplus even at low pvEst');

// Boundary: exactly +100W over load is not enough (> 100 required).
assert.strictEqual(surplusDetected(0, 550, 450), false, 'PV exactly +100W → not surplus');
assert.strictEqual(surplusDetected(0, 551, 450), true, 'PV +101W → surplus');

// --- direct call: no-op path (time-independent) -------------------------------
// When the predicate is false the whole `&&` short-circuits, so _computePvFlags
// returns before setting any flag REGARDLESS of daylight/soc — no Date mocking
// needed. _pvExporting (first write after the gate, line 343) staying undefined
// proves the block no-opped.
function runFlags(p1) {
  const ctx = { settings: { max_soc: 95 }, log: () => {} };
  const inputs = { battery: { stateOfCharge: 15 }, p1 };
  PolicyEngine.prototype._computePvFlags.call(ctx, inputs);
  return inputs;
}

{
  // PV 261W < load 448W, importing — the exact live false-trigger. Must no-op.
  const out = runFlags({ resolved_gridPower: 187, pv_power_estimated: 261, avg_consumption_w: 448 });
  assert.strictEqual(out._pvExporting, undefined, 'no real surplus → block no-op, no _pvExporting');
  assert.strictEqual(out._pvStoreValue, undefined, 'no real surplus → no _pvStoreValue written');
  assert.strictEqual(out._pvStoreWins, undefined, 'no real surplus → no _pvStoreWins override');
}

{
  // Old-trigger case (pvEst >= 100 but below load) must also no-op now.
  const out = runFlags({ resolved_gridPower: 0, pv_power_estimated: 150, avg_consumption_w: 448 });
  assert.strictEqual(out._pvExporting, undefined, 'PV present but < load → block no-op');
}

console.log('pv-surplus-gate: all assertions passed');
