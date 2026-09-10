'use strict';

// The morning blockade this feature exists for, as a regression test.
//
// Measured 09-09 (real saved compute() input, nearfloor_chatter_catch ring-0, SoC 5%): before
// the day-ahead auction published, the app only knew 42 slots. The highest price in view was
// €0.3852, giving a charge ceiling of €0.2072 — just under the €0.216-0.236 the morning
// actually cost, so charging was refused all morning. With tomorrow published the peak inside
// the ceiling's 24h window was €0.4321 → ceiling €0.2415, and charging started immediately.
//
// The ceiling formula (policy-engine chargeCeilingFrom) must therefore:
//   1. reproduce €0.2072 from the truncated table;
//   2. rise when estimated slots extend the table;
//   3. rise less when the confidence shade is below 1.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');
const PriceForecastProvider = require('../lib/price-forecast-provider');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

const homey = { log() {}, error() {} };
const RTE = 0.7329332984129295;                 // learned RTE that run
const SETTINGS = { max_charge_price: 0.15, cycle_cost_per_kwh: 0.075, battery_efficiency: 0.75 };
const engine = new PolicyEngine(homey, SETTINGS);

const NOW = Date.now();
const SLOT_MS = 900_000;
/** Real morning table: 42 slots to midnight, peak €0.3852 (the value that blocked charging). */
function truncatedTable() {
  const out = [];
  for (let i = 1; i <= 42; i++) {
    out.push({ timestamp: new Date(NOW + i * SLOT_MS), price: i === 30 ? 0.3852 : 0.22 });
  }
  return out;
}
const round4 = v => +v.toFixed(4);

console.log('\nprice-forecast charge ceiling');

test('truncated morning table reproduces the €0.2072 ceiling that blocked charging', () => {
  const ceiling = engine.chargeCeilingFrom(truncatedTable(), RTE, true);
  assert.strictEqual(round4(ceiling), 0.2073, `expected ~0.2073, got ${round4(ceiling)}`);
  assert.ok(ceiling < 0.216, 'ceiling must sit below the €0.216 morning price — that is the blockade');
});

test('estimated slots for tomorrow raise the ceiling above the morning price', () => {
  // Tomorrow's real peak inside the 24h window was €0.4321; an estimate near it must unblock.
  const estimated = [];
  for (let i = 43; i <= 90; i++) {
    estimated.push({ timestamp: new Date(NOW + i * SLOT_MS), price: i === 74 ? 0.4321 : 0.25, estimated: true });
  }
  const ceiling = engine.chargeCeilingFrom(truncatedTable().concat(estimated), RTE, true);
  assert.strictEqual(round4(ceiling), 0.2417, `expected ~0.2417, got ${round4(ceiling)}`);
  assert.ok(ceiling > 0.236, 'ceiling must clear the €0.216-0.236 morning prices');
});

test('slots beyond 24h cannot raise the ceiling', () => {
  const far = [{ timestamp: new Date(NOW + 121 * SLOT_MS), price: 0.8632, estimated: true }];
  const ceiling = engine.chargeCeilingFrom(truncatedTable().concat(far), RTE, true);
  assert.strictEqual(round4(ceiling), 0.2073, 'the 24h window must ignore the far evening peak');
});

test('confidence shade below 1 lowers the estimated prices, and with them the ceiling', () => {
  const hourly = [{ time: new Date(NOW + 4 * 3_600_000).toISOString(), price: 250 }];   // EUR/MWh
  const full = new PriceForecastProvider(homey, { markup: 0.11, shade: 1.0 });
  const shaded = new PriceForecastProvider(homey, { markup: 0.11, shade: 0.8 });

  const pFull = full._expandToSlots(hourly);
  const pShaded = shaded._expandToSlots(hourly);
  assert.strictEqual(pFull.length, 4, 'one hour must expand to 4 quarter slots');
  assert.ok(pShaded[0].price < pFull[0].price, 'shade < 1 must lower the estimated price');
  assert.ok(pFull.every(p => p.estimated), 'every produced slot must be flagged estimated');

  const ceilFull = engine.chargeCeilingFrom(truncatedTable().concat(pFull), RTE, true);
  const ceilShaded = engine.chargeCeilingFrom(truncatedTable().concat(pShaded), RTE, true);
  assert.ok(ceilShaded < ceilFull, `shaded ceiling ${round4(ceilShaded)} must be below ${round4(ceilFull)}`);
  assert.ok(ceilShaded >= 0.2073, 'shading may never push the ceiling below the real-price ceiling');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
