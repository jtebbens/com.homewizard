'use strict';

// New capability: any_power_fail_count (total outage count, incl. short dips).
// HomeWizard firmware sends it separately from long_power_fail_count on both
// P1 API v1 (/api/v1/data) and v2 (/api/measurement) — confirmed against a live
// meter payload on 2026-08-29, where any_power_fail_count=1 while
// long_power_fail_count=0. Neither driver read it before this change.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};

const EnergyDevice = require('../drivers/energy/device.js');
const EnergyDeviceV2 = require('../drivers/energy_v2/device.js');

function makeV1Stub() {
  const capValues = {};
  return {
    _lastSamples: {},
    _hasChanged: EnergyDevice.prototype._hasChanged,
    _phases: 1,
    homey: { flow: { getDeviceTriggerCard: () => ({ trigger: () => ({ catch: () => {} }) }) } },
    getCapabilityValue: (cap) => (cap in capValues ? capValues[cap] : null),
    hasCapability: () => true,
    addCapability: async () => {},
    setCapabilityValue: async (cap, value) => { capValues[cap] = value; },
    log: () => {},
    error: () => {},
    _capValues: capValues,
  };
}

async function testV1AnyPowerFailCountMapped() {
  const stub = makeV1Stub();
  const tasks = [];
  // Minimal single-phase payload slice, matching the live v1 shape confirmed
  // 2026-08-29: any_power_fail_count present and distinct from long_power_fail_count.
  const data = { any_power_fail_count: 1 };

  EnergyDevice.prototype._processPhase1MetricsAndOverload.call(
    stub, data, tasks, { phase_capacity: 40 }, 'en'
  );
  await Promise.all(tasks);

  assert.strictEqual(stub._capValues.any_power_fail_count, 1,
    'any_power_fail_count from raw data must reach the capability');
  console.log('✓ v1: any_power_fail_count mapped to capability');
}

async function testV2AnyPowerFailCountMapped() {
  const capValues = {};
  const device = {
    _lastVeryLowUpdate: 0,
    _lastMediumUpdate: 0,
    _lastLowUpdate: 0,
    getCapabilityValue: (cap) => (cap in capValues ? capValues[cap] : null),
    hasCapability: () => true,
    addCapability: async () => {},
    setCapabilityValue: async (cap, value) => { capValues[cap] = value; },
    log: () => {},
    error: () => {},
    _checkVoltageRestoration: () => {},
    _checkPowerRestoration: () => {},
  };

  // Live v2 payload confirmed 2026-08-29 to include any_power_fail_count.
  const m = { any_power_fail_count: 1, long_power_fail_count: 0 };

  await EnergyDeviceV2.applyMeasurementCapabilities(device, m);

  assert.strictEqual(capValues.any_power_fail_count, 1,
    'any_power_fail_count from raw measurement must reach the capability');
  console.log('✓ v2: any_power_fail_count mapped to capability');
}

(async () => {
  await testV1AnyPowerFailCountMapped();
  await testV2AnyPowerFailCountMapped();
  console.log('All p1-any-power-fail-count tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
