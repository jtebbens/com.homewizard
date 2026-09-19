'use strict';

// The planning page showed '?' for every slot priced by the EPEX forecast: estimated prices are
// kept out of policy_all_prices_15min on purpose (ROI/history must not score them as real), and
// that list was the page's only price source. The DP did plan with them. The schedule the page
// already reads carries each slot's price; it must also say which of those prices are estimates.

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

const t0 = Date.parse('2026-09-19T20:00:00Z');
const ts = (i) => new Date(t0 + i * 900_000).toISOString();

const prices = [
  { timestamp: ts(0), price: 0.25 },
  { timestamp: new Date(t0 + 900_000), price: 0.26 },           // Date object, not a string
  { timestamp: ts(2), price: 0.30, estimated: true },
  { timestamp: ts(3), price: 0.31, estimated: true },
];
const schedule = [0, 1, 2, 3].map(i => ({ timestamp: ts(i), price: prices[i].price }));

BatteryPolicyDevice.prototype._markEstimatedPrices.call({}, schedule, prices);

assert.deepStrictEqual(schedule.map(s => s.priceEstimated), [false, false, true, true],
  'only slots whose DP input price was an estimate are flagged');
assert.strictEqual(schedule[2].price, 0.30, 'the price itself is left untouched');

// No estimates in the table (forecast off) → every slot flagged false, nothing thrown.
const plain = [{ timestamp: ts(0), price: 0.2 }];
BatteryPolicyDevice.prototype._markEstimatedPrices.call({}, plain, [{ timestamp: ts(0), price: 0.2 }]);
assert.strictEqual(plain[0].priceEstimated, false);

console.log('planning-estimated-price-flag: 3/3 passed');
