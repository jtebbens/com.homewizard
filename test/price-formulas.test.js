const assert = require('assert');
const { importPrice, exportPrice } = require('../lib/price-formulas');

// ── Test A: import formula unchanged — (spot + markup) × 1.21 ──
{
  const price = importPrice(0.05, 0.11);
  assert.ok(Math.abs(price - 0.1936) < 1e-9, `Import price mismatch: got ${price}`);
  console.log('Test A (import formula): PASSED');
}

// ── Test B: Zonneplan Zonnebonus — (spot + €0.02) × 1.10, addon bonused too ──
{
  const price = exportPrice(0.05, 0.02, 1.10);
  assert.ok(Math.abs(price - 0.077) < 1e-9, `Zonneplan export price mismatch: got ${price}`);
  console.log('Test B (Zonneplan export formula): PASSED');
}

// ── Test C: neutral default (addon=0, multiplier=1.0) reduces to bare spot ──
{
  const spot = 0.1234;
  const price = exportPrice(spot, 0, 1.0);
  assert.strictEqual(price, spot, 'Neutral default must reduce to bare spot price');
  console.log('Test C (neutral default = kale spot): PASSED');
}

// ── Test D: negative spot handled (order of operations matters) ──
{
  const price = exportPrice(-0.02, 0.02, 1.10);
  assert.ok(Math.abs(price - 0) < 1e-9, `Negative spot case mismatch: got ${price}`);
  console.log('Test D (negative spot + addon offset): PASSED');
}

// ── Test E: feed-in fee modeled as negative addon, multiplier=1.0 ──
{
  const price = exportPrice(0.20, -0.11, 1.0);
  assert.ok(Math.abs(price - 0.09) < 1e-9, `Feed-in-fee case mismatch: got ${price}`);
  console.log('Test E (feed-in fee as negative addon): PASSED');
}

console.log('price-formulas.test.js: all assertions passed');
