'use strict';

// target_power_mode van de plugin-batterij staat altijd op 'device': de
// firmware houdt de P1-meter op nul ("zero on meter"), er is geen vast
// setpoint dat Homey kan afdwingen. 'homey' moet dus geweigerd worden.

const assert = require('assert');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};

const Device = require('../drivers/plugin_battery/device.js');
const compose = require('../drivers/plugin_battery/driver.compose.json');

function stub({ has = true, value } = {}) {
  const s = {
    caps: new Set(has ? ['target_power_mode'] : []),
    value,
    added: [],
    listeners: {},
    log() {}, error() {},
    hasCapability(c) { return this.caps.has(c); },
    async addCapability(c) { this.caps.add(c); this.added.push(c); },
    getCapabilityValue() { return this.value; },
    async setCapabilityValue(c, v) { if (c === 'target_power_mode') this.value = v; },
    registerCapabilityListener(c, fn) { this.listeners[c] = fn; },
    getName() { return 'test'; },
  };
  return s;
}

(async () => {
  // 1. driver declareert de capability, maar geen target_power
  assert(compose.capabilities.includes('target_power_mode'), 'driver.compose.json mist target_power_mode');
  assert(!compose.capabilities.includes('target_power'), 'target_power hoort er niet in');

  // 2. bestaande devices krijgen de capability erbij
  const s1 = stub({ has: false });
  await Device.prototype._updateCapabilities.call(s1);
  assert(s1.added.includes('target_power_mode'), '_updateCapabilities voegt target_power_mode niet toe');

  // 3. init zet de waarde op 'device' (ook als er iets anders stond)
  const s2 = stub({ value: 'homey' });
  await Device.prototype._ensureTargetPowerModeDevice.call(s2);
  assert.strictEqual(s2.value, 'device');

  // 4. listener weigert 'homey', accepteert 'device'
  const s3 = stub({ value: 'device' });
  await Device.prototype._registerCapabilityListeners.call(s3);
  const fn = s3.listeners.target_power_mode;
  assert.strictEqual(typeof fn, 'function', 'geen listener voor target_power_mode');
  await assert.rejects(() => fn('homey'), /device/i);
  await fn('device');

  console.log('plugin-battery-target-power-mode: OK');
})().catch((e) => { console.error(e); process.exit(1); });
