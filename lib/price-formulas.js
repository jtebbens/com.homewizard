'use strict';

/**
 * Shared retail-price formulas — single implementation used by every price
 * provider (xadi, kwhprice, entsoe-fallback) so import/export math can never
 * drift between them.
 */

/** Import retail price: (spot + markup) × 1.21 VAT. */
function importPrice(spotEur, markup) {
  return (spotEur + markup) * 1.21;
}

/**
 * Export price: (spot + addon) × multiplier.
 * Matches Zonneplan's Zonnebonus formula "(marktprijs + €0,02) + 10%" —
 * the bonus multiplier applies over (spot + addon), not spot alone.
 * Neutral default (addon=0, multiplier=1.0) reduces to the bare spot price.
 */
function exportPrice(spotEur, addon, multiplier) {
  return (spotEur + addon) * multiplier;
}

/**
 * €/kWh credited for exporting PV in a given slot — the single source of truth
 * for export value across every surface (DP passes, runtime mapper, chart
 * projection, explainability). Mirrors OptimizationEngine._exportValue so the
 * store-vs-export decision can never drift between layers.
 * Saldering: export offsets import 1:1, so it equals the retail import price.
 * asymmetric_2027: post-saldering per-slot export price (falls back to the
 * legacy scalar ratio when the exportPrice field is absent).
 */
function exportValue(priceSlot, tariffModel, ratio = 1.0) {
  if (tariffModel !== 'asymmetric_2027') return priceSlot.price;
  return priceSlot.exportPrice ?? priceSlot.price * ratio;
}

module.exports = { importPrice, exportPrice, exportValue };
