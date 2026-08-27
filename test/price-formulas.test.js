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

// ── Test D: negative spot pays the bare spot — the bonus is gated off there,
//    so the addon no longer offsets it to zero (see Test F/G). ──
{
  const price = exportPrice(-0.02, 0.02, 1.10);
  assert.ok(Math.abs(price - -0.02) < 1e-9, `Negative spot case mismatch: got ${price}`);
  console.log('Test D (negative spot pays bare spot): PASSED');
}

// ── Test E: feed-in fee modeled as negative addon, multiplier=1.0 ──
{
  const price = exportPrice(0.20, -0.11, 1.0);
  assert.ok(Math.abs(price - 0.09) < 1e-9, `Feed-in-fee case mismatch: got ${price}`);
  console.log('Test E (feed-in fee as negative addon): PASSED');
}

// ── Test F: bonus lapses at non-positive spot — supplier bonuses (Zonneplan,
//    NextEnergy) are paid on positive prices only, so a negative hour pays the
//    bare (negative) spot: you pay per exported kWh. ──
{
  const price = exportPrice(-0.03, 0.02, 1.10);
  assert.ok(Math.abs(price - -0.03) < 1e-9, `Bonus must lapse below zero: got ${price}`);
  console.log('Test F (bonus lapses below zero): PASSED');
}

// ── Test G: same inside the band where the addon used to mask the sign ──
{
  const price = exportPrice(-0.01, 0.02, 1.10);
  assert.ok(Math.abs(price - -0.01) < 1e-9, `Bonus must lapse in the -addon..0 band: got ${price}`);
  console.log('Test G (bonus lapses in the -0.02..0 band): PASSED');
}

// ── Test H: boundary — spot exactly 0 is not a positive price ──
{
  const price = exportPrice(0, 0.02, 1.10);
  assert.ok(Math.abs(price - 0) < 1e-9, `Spot 0 must pay 0: got ${price}`);
  console.log('Test H (boundary spot = 0): PASSED');
}

// ── Test I: just above the boundary the full bonus applies again ──
{
  const price = exportPrice(0.001, 0.02, 1.10);
  assert.ok(Math.abs(price - 0.0231) < 1e-9, `Bonus must be whole above zero: got ${price}`);
  console.log('Test I (full bonus just above zero): PASSED');
}

// ── Test J: a feed-in FEE is not a bonus — it keeps applying at negative spot
//    (Tibber/Eneco form: spot − fixed). ──
{
  const price = exportPrice(-0.03, -0.0248, 1.0);
  assert.ok(Math.abs(price - -0.0548) < 1e-9, `Feed-in fee must survive the gate: got ${price}`);
  console.log('Test J (feed-in fee unaffected by the gate): PASSED');
}

// ── Test K: a multiplier alone counts as a bonus too (NextEnergy: spot + 50%) ──
{
  const price = exportPrice(-0.01, 0, 1.10);
  assert.ok(Math.abs(price - -0.01) < 1e-9, `Multiplier-only bonus must lapse: got ${price}`);
  console.log('Test K (multiplier-only bonus lapses): PASSED');
}

console.log('price-formulas.test.js: all assertions passed');
