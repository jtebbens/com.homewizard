'use strict';

// Property tests for price_forecast_fill (estimated prices filling the part of tomorrow the
// day-ahead auction has not published yet). The hand-written cases in price-forecast-merge
// and price-forecast-ceiling confirm the author's scenarios; these throw random tables at the
// same code so the guarantees the fill leans on are challenged, not just illustrated.
//
// M1  merge   — a real price always beats an estimate, estimates only fill gaps, nothing
//               estimated leaves tariff-manager unless the mode is 'on', and nothing estimated
//               is ever persisted.
// C1  ceiling — estimates can only raise the charge ceiling, a lower shade never raises it,
//               and slots beyond the 24h window cannot move it.

const fc = require('fast-check');
const TariffManager = require('../lib/tariff-manager');
const PolicyEngine = require('../lib/policy-engine');
const PriceForecastProvider = require('../lib/price-forecast-provider');

const SEED = 12345;
const RUNS = 1000;
const SLOT_MS = 900_000;

let passed = 0;
let failed = 0;
function property(name, arb, pred) {
  try {
    fc.assert(fc.property(arb, pred), { numRuns: RUNS, seed: SEED });
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n${e.message}`);
    failed++;
  }
}

const price = fc.double({ min: -0.20, max: 0.90, noNaN: true, noDefaultInfinity: true });

// ─── M1: merge ──────────────────────────────────────────────────────────────────────────
console.log('\nprice-forecast merge properties');

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);
const UNIVERSE = 40;
/** One source's slots: unique slot indices within a small universe so sources collide often. */
const sourceArb = fc.uniqueArray(
  fc.record({ i: fc.integer({ min: 0, max: UNIVERSE - 1 }), p: price }),
  { selector: s => s.i, maxLength: UNIVERSE },
);
const mergeArb = fc.record({
  mode: fc.constantFrom('off', 'shadow', 'on'),
  expanded: sourceArb,
  entsoe: sourceArb,
  pbth: sourceArb,
  forecast: sourceArb,
});

const toSlots = (src, extra = {}) => src.map(s => ({
  timestamp: new Date(T0 + s.i * SLOT_MS), price: s.p, exportPrice: s.p, ...extra,
}));

function mergeOf({ mode, expanded, entsoe, pbth, forecast }) {
  const homey = { log() {}, settings: { get: () => null, set() {} } };
  const tm = new TariffManager(homey, { enable_dynamic_pricing: false, price_forecast_fill: mode });
  tm.settings.price_forecast_fill = mode;
  tm._expandHourlyTo15Min = () => toSlots(expanded);
  tm.dynamicProvider = { entsoe: { getAll15MinPrices: () => toSlots(entsoe) }, getAllHourlyPrices: () => [] };
  tm.pbthProvider = { getAll15MinPrices: () => toSlots(pbth) };
  tm.forecastProvider = {
    hasPrices: () => forecast.length > 0,
    getAll15MinPrices: () => toSlots(forecast, { estimated: true }),
  };
  return tm.getAll15MinPrices();
}

property('M1: real beats estimate, estimates only fill gaps, only in mode on', mergeArb, (c) => {
  const out = mergeOf(c);
  // Highest-priority real price per slot: pbth > entsoe > expanded.
  const real = new Map();
  for (const src of [c.expanded, c.entsoe, c.pbth]) for (const s of src) real.set(s.i, s.p);
  const est = new Map(c.forecast.map(s => [s.i, s.p]));

  for (let k = 1; k < out.length; k++) {
    if (!(out[k].timestamp > out[k - 1].timestamp)) return false;       // unique + ascending
  }
  const byIdx = new Map(out.map(p => [Math.round((p.timestamp.getTime() - T0) / SLOT_MS), p]));
  for (const [i, p] of real) {
    const o = byIdx.get(i);
    if (!o || o.estimated || o.source === 'forecast' || o.price !== p) return false;
  }
  for (const [i, p] of est) {
    if (real.has(i)) continue;
    const o = byIdx.get(i);
    if (c.mode === 'on') {
      if (!o || !o.estimated || o.source !== 'forecast' || o.price !== p) return false;
    } else if (o) {
      return false;
    }
  }
  if (c.mode !== 'on' && out.some(p => p.estimated)) return false;
  return out.length === new Set([...real.keys(), ...(c.mode === 'on' ? est.keys() : [])]).size;
});

property('M1: nothing estimated is ever persisted', mergeArb, (c) => {
  const out = mergeOf({ ...c, mode: 'on' });
  const written = {};
  const homey = { log() {}, settings: { get: () => null, set: (k, v) => { written[k] = v; } } };
  const tm = new TariffManager(homey, { enable_dynamic_pricing: false });
  tm._schedulePricesPersist({ all15min: out, allPrices: out });
  if (!tm._pricesPersistTimer) return out.every(p => !p.estimated) || out.length === 0;
  tm._pricesPersistTimer._onTimeout();
  clearTimeout(tm._pricesPersistTimer);
  const blobs = [written.policy_all_prices_15min, written.policy_all_prices].filter(Array.isArray);
  const realCount = out.filter(p => !p.estimated).length;
  return blobs.every(b => !b.some(p => p.estimated) && b.length === realCount);
});

// ─── C1: charge ceiling ─────────────────────────────────────────────────────────────────
console.log('\nprice-forecast ceiling properties');

const homey = { log() {}, error() {} };
const engine = new PolicyEngine(homey, { max_charge_price: 0.15, cycle_cost_per_kwh: 0.075, battery_efficiency: 0.75 });
const NOW = Date.now();

const ceilingArb = fc.record({
  real: fc.array(price, { minLength: 1, maxLength: 80 }),          // slots 1.. from now
  hourlyMwh: fc.array(fc.double({ min: -100, max: 600, noNaN: true, noDefaultInfinity: true }),
    { minLength: 1, maxLength: 12 }),                               // estimated tail, EUR/MWh
  shadeHigh: fc.double({ min: 0.5, max: 1.0, noNaN: true, noDefaultInfinity: true }),
  shadeDrop: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
  rte: fc.double({ min: 0.6, max: 0.95, noNaN: true, noDefaultInfinity: true }),
  markup: fc.double({ min: 0.05, max: 0.20, noNaN: true, noDefaultInfinity: true }),
});

const realTable = (real) => real.map((p, k) => ({ timestamp: new Date(NOW + (k + 1) * SLOT_MS), price: p }));
/** Estimated hours starting right after the real table, through the provider's own expansion. */
function estimates(c, shade, startSlot) {
  const firstHour = Math.ceil((NOW + startSlot * SLOT_MS) / 3_600_000) * 3_600_000;
  const rows = c.hourlyMwh.map((mwh, h) => ({ time: new Date(firstHour + h * 3_600_000).toISOString(), price: mwh }));
  return new PriceForecastProvider(homey, { markup: c.markup, shade })._expandToSlots(rows);
}
const ceil = (table, rte) => engine.chargeCeilingFrom(table, rte, true);
const EPS = 1e-12;

property('C1a: adding estimated slots never lowers the ceiling', ceilingArb, (c) => {
  const real = realTable(c.real);
  const filled = real.concat(estimates(c, c.shadeHigh, c.real.length + 1));
  return ceil(filled, c.rte) >= ceil(real, c.rte) - EPS;
});

property('C1b: a lower shade never raises the ceiling', ceilingArb, (c) => {
  const real = realTable(c.real);
  const start = c.real.length + 1;
  const high = ceil(real.concat(estimates(c, c.shadeHigh, start)), c.rte);
  const low = ceil(real.concat(estimates(c, c.shadeHigh - c.shadeDrop, start)), c.rte);
  return low <= high + EPS;
});

property('C1c: estimated slots beyond 24h never move the ceiling', ceilingArb, (c) => {
  const real = realTable(c.real);
  const far = estimates(c, c.shadeHigh, 24 * 4 + 2);
  return Math.abs(ceil(real.concat(far), c.rte) - ceil(real, c.rte)) <= EPS;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
