const assert = require('assert');
const { importPrice, exportPrice, storeValue, effectiveRte } = require('../lib/price-formulas');

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

// ── storeValue(): the round-trip worth of storing one kWh instead of exporting.
//    Wear is priced per kWh IN (user decision 2026-09-02), so it is subtracted
//    AFTER the efficiency multiply, not before it. 3 engines call this and it
//    had zero tests. ──

// ── Test L: peak × rte − wear, wear applied per kWh charged ──
{
  const v = storeValue(0.437, 0.732, 0.075);
  assert.ok(Math.abs(v - (0.437 * 0.732 - 0.075)) < 1e-12, `storeValue mismatch: got ${v}`);
  // Guard the UNIT, not the algebra: charging wear per kWh-in must not be
  // discounted by the efficiency. The per-kWh-out variant would give 0.265.
  const perKwhOut = (0.437 - 0.075) * 0.732;
  assert.ok(Math.abs(v - perKwhOut) > 0.01,
    `Wear must be per kWh IN, not per kWh out (got ${v}, per-kWh-out ${perKwhOut})`);
  console.log('Test L (storeValue prices wear per kWh IN): PASSED');
}

// ── Test M: wear defaults to 0 — the raw round-trip value ──
{
  assert.ok(Math.abs(storeValue(0.40, 0.75) - 0.30) < 1e-12, 'default cycle cost must be 0');
  console.log('Test M (storeValue default cycle cost = 0): PASSED');
}

// ── Test N: absent peak yields null, never a number a gate could compare ──
{
  assert.strictEqual(storeValue(null, 0.75, 0.075), null, 'null peak must stay null');
  assert.strictEqual(storeValue(undefined, 0.75, 0.075), null, 'undefined peak must stay null');
  console.log('Test N (storeValue null-safe): PASSED');
}

// ── Test O: storeValue is monotone in the peak — a higher peak can never be
//    worth less to store. Property, not a formula mirror. ──
{
  let prev = -Infinity;
  for (let peak = 0; peak <= 1.0; peak += 0.05) {
    const v = storeValue(peak, 0.732, 0.075);
    assert.ok(v >= prev, `storeValue must not decrease with the peak (peak ${peak})`);
    prev = v;
  }
  console.log('Test O (storeValue monotone in peak): PASSED');
}

// ── effectiveRte(): one guard for the measured round-trip efficiency, shared by
//    the policy gate, the DP and the explanation so they cannot pick different
//    numbers. Same [0.50, 0.97] window device.js applies before feeding the DP. ──

// ── Test P: a measured value inside the window wins over the configured one ──
{
  assert.strictEqual(effectiveRte(0.732, 0.718), 0.732, 'measured RTE must win inside the window');
  console.log('Test P (measured RTE wins): PASSED');
}

// ── Test Q: window edges are inclusive ──
{
  assert.strictEqual(effectiveRte(0.50, 0.718), 0.50, '0.50 must be inside the window');
  assert.strictEqual(effectiveRte(0.97, 0.718), 0.97, '0.97 must be inside the window');
  console.log('Test Q (window edges inclusive): PASSED');
}

// ── Test R: outside the window, or unusable, falls back to configured ──
{
  for (const bad of [0.49, 0.98, 0, -1, null, undefined, NaN, 'x', {}]) {
    assert.strictEqual(effectiveRte(bad, 0.718), 0.718,
      `Unusable measured RTE ${String(bad)} must fall back to configured`);
  }
  console.log('Test R (unusable measured RTE falls back): PASSED');
}

// ── Test S: no configured value given → the 0.75 default, never NaN ──
{
  assert.strictEqual(effectiveRte(null), 0.75, 'missing configured must default to 0.75');
  console.log('Test S (configured default 0.75): PASSED');
}

console.log('price-formulas.test.js: all assertions passed');
