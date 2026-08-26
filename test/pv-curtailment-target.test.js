const assert = require('assert');
const { computeCurtailmentTarget } = require('../lib/curtailment');

// Post-saldering (2027) the app must be able to tell the user's own inverter flow
// how far to throttle PV: never below what the house draws plus what the battery
// still wants to charge, because storing a kWh always beats throwing it away.
// This suite pins the two halves of that target — the measured house load and the
// per-slot economic trigger — before any DP wiring exists.

// ── Test A: house load comes from the energy balance, not from currentLoad ──
// policy-engine.js clamps its own currentLoad at 0 (Math.max(0, grid + discharge)),
// so during PV surplus — exactly when curtailment applies — it reads 0. The target
// must survive that: 2000W PV, 1200W exported, battery idle => 800W in the house.
{
  const r = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(r.houseLoadW, 800, `House load from balance mismatch: got ${r.houseLoadW}`);
  console.log('Test A (house load from energy balance): PASSED');
}

// ── Test B: battery discharge counts as supply, not as house load ──
// PV 0W, 300W imported while the battery discharges 500W => the house draws 800W.
{
  const r = computeCurtailmentTarget({
    pvW: 0, gridPowerW: 300, battPowerW: -500,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(r.houseLoadW, 800, `Discharge-as-supply mismatch: got ${r.houseLoadW}`);
  console.log('Test B (discharge counts as supply): PASSED');
}

// ── Test C: charge demand is added only when the chosen mode actually charges ──
// Storing beats curtailing, so the target must leave room for the charge the DP
// still wants. On a non-charging mode that room does not exist.
{
  const charging = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'to_full', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(charging.targetW, 1600, `Charging target mismatch: got ${charging.targetW}`);

  const idle = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'zero_discharge_only', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(idle.targetW, 800, `Non-charging target mismatch: got ${idle.targetW}`);
  console.log('Test C (charge demand only on charging modes): PASSED');
}

// ── Test D: the trigger is per slot — only a negative export value curtails ──
{
  const positive = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(positive.shouldCurtail, false, 'Positive export value must not curtail');

  const negative = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: -0.03, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(negative.shouldCurtail, true, 'Negative export value must curtail');
  assert.ok(Math.abs(negative.exportValue - (-0.03)) < 1e-9,
    `Export value must be the per-slot one: got ${negative.exportValue}`);
  console.log('Test D (per-slot negative export triggers): PASSED');
}

// ── Test E: under saldering export offsets import 1:1, so curtailing never pays ──
// exportValue() returns the import price there, which is not negative in practice.
{
  const r = computeCurtailmentTarget({
    pvW: 2000, gridPowerW: -1200, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: -0.03, tariffModel: 'saldering',
  });
  assert.strictEqual(r.shouldCurtail, false, 'Saldering must ignore the export price');
  assert.ok(Math.abs(r.exportValue - 0.25) < 1e-9,
    `Saldering export value must equal the import price: got ${r.exportValue}`);
  console.log('Test E (saldering never curtails): PASSED');
}

// ── Test F: the target is never negative and never below the house load ──
// A rounding or sign slip that pushes the target under the house load would tell
// the user's flow to throttle into their own consumption — importing to make up
// the difference at the very moment export is worthless.
{
  const r = computeCurtailmentTarget({
    pvW: 0, gridPowerW: -50, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: -0.03, tariffModel: 'asymmetric_2027',
  });
  assert.ok(r.houseLoadW >= 0, `House load must not go negative: got ${r.houseLoadW}`);
  assert.ok(r.targetW >= r.houseLoadW, `Target must never undercut the house: got ${r.targetW}`);
  console.log('Test F (target never undercuts the house): PASSED');
}

// ── Test G: missing live readings degrade to null, never to a bogus 0W target ──
// A 0W target would be read by the user's flow as "throttle to nothing".
{
  const r = computeCurtailmentTarget({
    pvW: null, gridPowerW: null, battPowerW: 0,
    hwMode: 'standby', maxChargePowerW: 800,
    price: 0.25, exportPrice: 0.14, tariffModel: 'asymmetric_2027',
  });
  assert.strictEqual(r.targetW, null, `Missing readings must yield null: got ${r.targetW}`);
  assert.strictEqual(r.shouldCurtail, false, 'Missing readings must never curtail');
  console.log('Test G (missing readings degrade to null): PASSED');
}

console.log('pv-curtailment-target.test.js: all assertions passed');
