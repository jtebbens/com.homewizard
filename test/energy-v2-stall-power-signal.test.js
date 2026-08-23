'use strict';

// Regression test: near-100% SoC plateau false-triggered battery stall.
// Bug: stall detection judged progress by SoC-delta only. On 2026-08-23 SoC
// stayed pinned at exactly 100.0% for 12+ min while power_w tracked target_w
// almost exactly (-220..-297W, real discharge happening) — SoC-only detection
// would flag this as a stall even though the battery was working correctly.
// Fix: evaluateStallProgress() also treats power_w matching the commanded
// direction as progress, scoped to zero/zero_charge_only/zero_discharge_only
// (not to_full, whose power_w is a synthetic batteryCount*800 fallback).

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id.endsWith('/fetchWithTimeout') || id.endsWith('/Api') || id.endsWith('/Ws')
    || id.endsWith('/wsDebug') || id.endsWith('/baseloadMonitor')) return {};
  return origRequire.apply(this, arguments);
};

const { evaluateStallProgress } = require('../drivers/energy_v2/device.js');

function testSocPlateauNoFalsePositive() {
  // 2026-08-23 16:45-16:57 UTC: target=-220W discharge, SoC pinned 100.0%,
  // power_w tracking target almost exactly.
  const progressed = evaluateStallProgress({
    commandedCharge: false,
    avgSoC: 100,
    baselineSoc: 100,
    powerW: -220,
    normalizedMode: 'zero_discharge_only',
  });
  assert.strictEqual(progressed, true,
    'power_w tracking commanded discharge must count as progress despite flat SoC');
  console.log('✓ SoC-plateau near 100%: power_w-in-line-with-target avoids false stall');
}

function testRealStallStillDetected() {
  // June 2026 case: target=812W commanded charge, but power_w stuck at 0 →
  // genuine firmware stall must still be flagged.
  const progressed = evaluateStallProgress({
    commandedCharge: true,
    avgSoC: 82,
    baselineSoc: 82,
    powerW: 0,
    normalizedMode: 'zero',
  });
  assert.strictEqual(progressed, false,
    'power_w stuck at 0 despite commanded charge must NOT count as progress');
  console.log('✓ real stall (power_w=0 despite target) still detected');
}

function testToFullExcludedFromPowerSignal() {
  // to_full: power_w is a synthetic batteryCount*800 fallback when firmware
  // reports 0/null (see _handleBatteries), so it must never mask a real stall.
  const progressed = evaluateStallProgress({
    commandedCharge: true,
    avgSoC: 50,
    baselineSoc: 50,
    powerW: 800, // synthetic fallback value, not a real reading
    normalizedMode: 'to_full',
  });
  assert.strictEqual(progressed, false,
    'to_full must rely on SoC-delta only — synthetic power_w cannot signal progress');
  console.log('✓ to_full: synthetic power_w fallback excluded from progress signal');
}

function testSocDeltaStillWorksAlone() {
  // No power_w signal (idle/near-zero), but SoC genuinely moved → still progress.
  const progressed = evaluateStallProgress({
    commandedCharge: true,
    avgSoC: 51,
    baselineSoc: 50,
    powerW: 50, // below the 100W delivering threshold
    normalizedMode: 'zero_charge_only',
  });
  assert.strictEqual(progressed, true,
    'SoC-delta alone (>=1pp) must still count as progress');
  console.log('✓ SoC-delta path unaffected for genuine movement');
}

testSocPlateauNoFalsePositive();
testRealStallStillDetected();
testToFullExcludedFromPowerSignal();
testSocDeltaStillWorksAlone();
console.log('All energy-v2-stall-power-signal tests passed');
