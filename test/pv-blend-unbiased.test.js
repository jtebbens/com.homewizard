'use strict';

// Property suite for BatteryPolicyDevice._blendOmScSlot (device.js PV blend, Lever A).
//
// Lever A replaces the accuracy-weighted OM↔Solcast blend with a fixed 50/50 of the raw
// forecasts. On the 300-sample accuracy buffer (2026-06-15) the unbiased average measured
// MAE 369 vs 412 for the weighted blend (~10%), because OM under-forecasts (bias −144W) and
// Solcast over-forecasts (+90W) — averaging cancels the two. These invariants pin the two
// economic properties that win must rest on:
//   1. unbiased output is EXACTLY the raw 50/50 average — independent of the learned weights
//      and never lowered by the p10 cloud-miss guard (so a drifting weight can't sneak bias
//      back in);
//   2. the biased path is unchanged (regression guard for the toggle-off fallback).

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
const wOMArb = fc.double({ min: 0.2, max: 0.8, noNaN: true });

let passed = 0;

// 1. Unbiased = exact raw 50/50 average of OM and Solcast p50.
fc.assert(fc.property(omArb, scArb, scArb, wOMArb, (omW, scP50, scP10, wOM) => {
  const r = blend({ omW, scP50, scP10, wOM, wSC: 1 - wOM, unbiased: true });
  return r.blendedW === Math.round((omW + scP50) / 2) && r.useP10 === false && r.scAvg === scP50;
}));
passed++;

// 2. Unbiased is weight-invariant: the learned weights cannot move the output.
fc.assert(fc.property(omArb, scArb, scArb, wOMArb, wOMArb, (omW, scP50, scP10, wA, wB) => {
  const a = blend({ omW, scP50, scP10, wOM: wA, wSC: 1 - wA, unbiased: true });
  const b = blend({ omW, scP50, scP10, wOM: wB, wSC: 1 - wB, unbiased: true });
  return a.blendedW === b.blendedW;
}));
passed++;

// 3. Unbiased never applies the p10 pessimism (raw p50 won on measured MAE).
fc.assert(fc.property(omArb, scArb, scArb, (omW, scP50, scP10) => {
  return blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased: true }).useP10 === false;
}));
passed++;

// 4. Biased path keeps the learned weights (regression guard for toggle-off fallback).
fc.assert(fc.property(omArb, scArb, scArb, wOMArb, (omW, scP50, scP10, wOM) => {
  const r = blend({ omW, scP50, scP10, wOM, wSC: 1 - wOM, unbiased: false });
  const scAvg = (scP50 > 0 && scP10 > 0 && scP50 > omW * 1.10) ? scP10 : scP50;
  return r.blendedW === Math.round(wOM * omW + (1 - wOM) * scAvg) && r.scAvg === scAvg;
}));
passed++;

// 5. Biased p10 guard fires exactly when SC p50 sits ≥10% above OM (and p10 is usable).
fc.assert(fc.property(omArb, scArb, scArb, (omW, scP50, scP10) => {
  const r = blend({ omW, scP50, scP10, wOM: 0.5, wSC: 0.5, unbiased: false });
  const expect = scP50 > 0 && scP10 > 0 && scP50 > omW * 1.10;
  return r.useP10 === expect && r.scAvg === (expect ? scP10 : scP50);
}));
passed++;

// 6. Blend always lands within [min, max] of the two inputs actually used.
fc.assert(fc.property(omArb, scArb, scArb, wOMArb, fc.boolean(), (omW, scP50, scP10, wOM, unbiased) => {
  const r = blend({ omW, scP50, scP10, wOM, wSC: 1 - wOM, unbiased });
  const lo = Math.min(omW, r.scAvg);
  const hi = Math.max(omW, r.scAvg);
  return r.blendedW >= lo - 1 && r.blendedW <= hi + 1; // ±1 for Math.round
}));
passed++;

console.log(`✅ pv-blend-unbiased: ${passed}/6 properties hold`);
