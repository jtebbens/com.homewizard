'use strict';

// Property suite for the satellite full-override leg of BatteryPolicyDevice._blendOmScSlot
// (`pv_sat_full_override`, default OFF).
//
// Background. Commit 21209df dropped the old `satellite_dp_active` mode — a full 0-2h override of
// pvPowerW by satPanelW — on the stated ground that "F4 only supports sat replacing the Solcast
// leg, not displacing OM". F4 never tested that: it scored sat ≤ SC, explicitly not sat ≤ OM.
// The 7-day head-to-head of 2026-08-17 (85 daylight hours, raw sources against the roof in
// panel-W) measured OM MAE 912 W vs sat 566 W, sat ahead in every OM-forecast bin. This flag
// gives the satellite the whole slot back inside its fresh window, and these invariants pin the
// two things that decision rests on:
//   1. with the flag on, the output is EXACTLY the satellite — no learned weight leaks through;
//   2. with the flag off, or outside the fresh satellite window, nothing moves at all.
//
// Scope: this is an input-assembly change in device.js, not a DP constraint, and it ships
// default-off — hence no invariant in optimizer-properties.test.js (revisit at switch-on).
// The freshness / lead-time / elevation gates live in the caller (device.js blend loop,
// _satSlotIsFresh); this function only sees satActive + satW.

const assert = require('assert');
const fc = require('fast-check');
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

const blend = BatteryPolicyDevice._blendOmScSlot.bind(BatteryPolicyDevice);

const omArb  = fc.integer({ min: 0, max: 4000 });
const scArb  = fc.integer({ min: 0, max: 4000 });
const satArb = fc.integer({ min: 0, max: 4000 });
const wOMArb = fc.double({ min: 0.2, max: 0.8, noNaN: true });

let passed = 0;

// 1. Override = pure satellite. No weight — learned, unbiased or otherwise — survives it.
fc.assert(fc.property(omArb, satArb, wOMArb, fc.boolean(), (omW, satW, wOM, unbiased) => {
  const r = blend({ omW, wOM, wSC: 1 - wOM, unbiased, satW, satActive: true, satOverride: true });
  return r.blendedW === satW && r.scAvg === satW && r.satUsed === true && r.fullSat === true;
}));
passed++;

// 2. Weight-invariance under override: two different learned weight pairs give one answer.
fc.assert(fc.property(omArb, satArb, wOMArb, wOMArb, (omW, satW, wA, wB) => {
  const a = blend({ omW, wOM: wA, wSC: 1 - wA, unbiased: false, satW, satActive: true, satOverride: true });
  const b = blend({ omW, wOM: wB, wSC: 1 - wB, unbiased: false, satW, satActive: true, satOverride: true });
  return a.blendedW === b.blendedW;
}));
passed++;

// 3. Outside the fresh satellite window the flag is inert. satActive false, or an unusable
//    satW, must land on exactly the value the caller would have got without the flag —
//    this is what keeps the day-ahead plan (where satPanelW is null) untouched.
fc.assert(fc.property(omArb, scArb, scArb, fc.constantFrom(null, undefined, -1, NaN, '900', 1500),
  fc.boolean(), (omW, scP50, scP10, satW, unbiased) => {
    const on  = blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased, satW, satActive: false, satOverride: true });
    const off = blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased });
    return on.blendedW === off.blendedW && on.scAvg === off.scAvg
      && on.useP10 === off.useP10 && on.satUsed === false && on.fullSat === false;
  }));
passed++;

// 3b. Same, but with satActive true and an unusable satW: the gate is satUsed, not satActive.
fc.assert(fc.property(omArb, scArb, scArb, fc.constantFrom(null, undefined, -1, NaN, '900'),
  fc.boolean(), (omW, scP50, scP10, bad, unbiased) => {
    const on  = blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased, satW: bad, satActive: true, satOverride: true });
    const off = blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased });
    return on.blendedW === off.blendedW && on.satUsed === false && on.fullSat === false;
  }));
passed++;

// 4. Flag off = bit-identical to today. Regression guard for the default path: the new
//    parameter must not perturb any existing call, with or without a satellite leg.
fc.assert(fc.property(omArb, scArb, scArb, satArb, wOMArb, fc.boolean(), fc.boolean(),
  (omW, scP50, scP10, satW, wOM, unbiased, satActive) => {
    const explicit = blend({ omW, scP50, scP10, wOM, wSC: 1 - wOM, unbiased, satW, satActive, satOverride: false });
    const omitted  = blend({ omW, scP50, scP10, wOM, wSC: 1 - wOM, unbiased, satW, satActive });
    return explicit.blendedW === omitted.blendedW && explicit.scAvg === omitted.scAvg
      && explicit.useP10 === omitted.useP10 && explicit.satUsed === omitted.satUsed
      && explicit.fullSat === false;
  }));
passed++;

// 5. Direction. The override moves the slot toward the satellite and never past it: strictly
//    higher than the 50/50 blend where sat > OM, strictly lower where sat < OM, equal on a tie.
//    Pins that the flag works the way the 7-day measurement points, not the opposite way.
fc.assert(fc.property(omArb, satArb, (omW, satW) => {
  const base = { omW, wOM: 0.5, wSC: 0.5, unbiased: true, satW, satActive: true };
  const ovr = blend({ ...base, satOverride: true }).blendedW;
  const bl  = blend(base).blendedW;
  if (satW > omW) return ovr > bl && ovr === satW;
  if (satW < omW) return ovr < bl && ovr === satW;
  return ovr === bl;
}));
passed++;

// 6. The override never invents power the satellite did not report: output is bounded by satW
//    itself, so an OM spike cannot leak in through a rounding or summation slip.
fc.assert(fc.property(omArb, satArb, wOMArb, fc.boolean(), (omW, satW, wOM, unbiased) => {
  const r = blend({ omW, wOM, wSC: 1 - wOM, unbiased, satW, satActive: true, satOverride: true });
  return r.blendedW >= 0 && r.blendedW <= satW;
}));
passed++;

// 7. The p10 pessimism stays a Solcast property: it can never fire under the override,
//    which by construction has no Solcast leg to be pessimistic about.
fc.assert(fc.property(omArb, scArb, scArb, satArb, (omW, scP50, scP10, satW) => {
  return blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased: false, satW, satActive: true, satOverride: true })
    .useP10 === false;
}));
passed++;

// 8. Worked example from 2026-08-17 08:30 CEST — the run that started this. The satellite leg
//    read 1983 W, the blend the DP actually got read 796 W, realised was 2787 W.
{
  const omW = 621;
  const satW = 1983;
  const base = { omW, wOM: 0.5, wSC: 0.5, unbiased: true, satW, satActive: true };
  assert.strictEqual(blend(base).blendedW, 1302, 'blend leg = 50/50 of OM and sat');
  assert.strictEqual(blend({ ...base, satOverride: true }).blendedW, 1983, 'override leg = sat');
}
passed++;

console.log(`✅ pv-sat-full-override: ${passed}/9 properties hold`);
