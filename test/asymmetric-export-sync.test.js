'use strict';

/**
 * Chunk 3 — formule-sync: the runtime mapper, chart projection and explainability
 * must value exporting PV with the SAME per-slot export value the DP uses
 * (OptimizationEngine._exportValue), so under tariff_model:'asymmetric_2027'
 * they store PV whenever the DP does — no DP==chart==uitleg divergence.
 *
 * Single source of truth: lib/price-formulas.js exportValue(). Under saldering
 * (default) it returns the retail price → every path stays bit-identical to old.
 *
 * Scenario mirrors the chunk-2 flip: a pvStrong preserve slot with retail price
 * 0.20, export price 0.05, and a store value 0.135 (evening peak 0.15 × RTE 0.9)
 * strictly between them:
 *   saldering  → exportValue 0.20 > store 0.135 → EXPORT (standby, export_wins)
 *   asymmetric → exportValue 0.05 < store 0.135 → STORE  (zero_charge_only)
 */

const assert = require('assert');
const { exportValue } = require('../lib/price-formulas');
const PolicyEngine = require('../lib/policy-engine');

const homey = { log() {} };

// ── Section 1: exportValue single source of truth ─────────────────────────────
{
  const slot = { price: 0.20, exportPrice: 0.05 };

  // saldering: export offsets import 1:1 → retail price, exportPrice ignored.
  assert.strictEqual(exportValue(slot, 'saldering'), 0.20, 'saldering must return retail price');
  assert.strictEqual(exportValue(slot, undefined), 0.20, 'default (no model) behaves as saldering');

  // asymmetric_2027: per-slot export price.
  assert.strictEqual(exportValue(slot, 'asymmetric_2027'), 0.05, 'asymmetric must return exportPrice');

  // asymmetric fallback: no exportPrice field → legacy scalar ratio × price.
  assert.ok(Math.abs(exportValue({ price: 0.20 }, 'asymmetric_2027', 0.5) - 0.10) < 1e-9,
    'asymmetric falls back to price × ratio when exportPrice absent');
  assert.strictEqual(exportValue({ price: 0.20 }, 'asymmetric_2027'), 0.20,
    'asymmetric ratio defaults to 1.0 when omitted');

  console.log('Section 1 (exportValue single source of truth): PASSED');
}

// ── Section 2: planning mapper store-vs-export flip ───────────────────────────
const baseSettings = {
  tariff_type: 'dynamic',
  battery_efficiency: 0.9,
  min_soc: 0,
  max_soc: 95,
  cycle_cost_per_kwh: 0.0,
  max_charge_price: 0.12,
  min_discharge_price: 0.25,
  respect_minmax: true,
  policy_mode: 'balanced',
};

// pvStrong preserve slot, no future prices (isolates the export_wins branch).
const flipCtx = {
  price: 0.20, exportPrice: 0.05, pvStoreValue: 0.135,
  soc: 60, pvW: 2500, consumptionW: 0,
  tariffType: 'dynamic', userPolicyMode: 'balanced',
  maxChargePrice: 0.12, minDischargePrice: 0.25, minSoc: 0, maxSoc: 95,
  futurePrices: [], battChargePowerW: 800,
};

{
  const eng = new PolicyEngine(homey, { ...baseSettings, tariff_model: 'saldering' });
  const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx });
  assert.strictEqual(hwMode, 'standby', `saldering should export (standby), got ${hwMode} (${reason})`);
  assert.ok(reason.includes('export_wins'), `saldering reason should be export_wins, got ${reason}`);
  console.log('Section 2a (saldering mapper exports PV): PASSED');
}

{
  const eng = new PolicyEngine(homey, { ...baseSettings, tariff_model: 'asymmetric_2027' });
  const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx });
  assert.strictEqual(hwMode, 'zero_charge_only', `asymmetric should store PV (zero_charge_only), got ${hwMode} (${reason})`);
  assert.ok(!reason.includes('export_wins'), `asymmetric reason must not be export_wins, got ${reason}`);
  console.log('Section 2b (asymmetric mapper stores PV — the flip): PASSED');
}

// ── Section 3: no regression — saldering ignores exportPrice ──────────────────
{
  const eng = new PolicyEngine(homey, { ...baseSettings, tariff_model: 'saldering' });
  const withField    = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx });
  const withoutField = eng._mapActionToHwModeForPlanning('preserve', { ...flipCtx, exportPrice: null });
  assert.strictEqual(withField.hwMode, withoutField.hwMode,
    'saldering hwMode must be identical whether or not exportPrice is present');
  console.log('Section 3 (saldering ignores exportPrice field): PASSED');
}

// ── Section 4: economic-dominance invariant (asymmetric) ──────────────────────
// The mapper must never report export-wins when storing beats exporting, i.e.
// when pvStoreValue > exportValue(slot). Challenge with randomized prices.
{
  const eng = new PolicyEngine(homey, { ...baseSettings, tariff_model: 'asymmetric_2027' });
  let checks = 0;
  let seed = 7919;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const price       = 0.05 + rnd() * 0.35;      // retail 0.05..0.40
    const exportPrice = rnd() * price;            // export 0..price
    const pvStoreValue = rnd() * 0.5;             // 0..0.50
    const { hwMode, reason } = eng._mapActionToHwModeForPlanning('preserve', {
      ...flipCtx, price, exportPrice, pvStoreValue,
    });
    const exportWon = hwMode === 'standby' && reason.includes('export_wins');
    if (pvStoreValue > exportPrice + 1e-9) {
      assert.ok(!exportWon,
        `INVARIANT: store (${pvStoreValue.toFixed(3)}) > export (${exportPrice.toFixed(3)}) but mapper reported export_wins`);
    }
    if (exportWon) {
      assert.ok(pvStoreValue <= exportPrice + 1e-9,
        `INVARIANT: export_wins implies store ≤ export, got store ${pvStoreValue.toFixed(3)} > export ${exportPrice.toFixed(3)}`);
    }
    checks++;
  }
  console.log(`Section 4 (asymmetric mapper never exports when store wins, ${checks} cases): PASSED`);
}

console.log('\nAll asymmetric-export-sync tests passed.');
