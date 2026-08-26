'use strict';

/**
 * Shared retail-price formulas — single implementation used by every price
 * provider that receives raw spot prices (entsoe-fallback) so import/export
 * math can never drift between them. NOT used by pbth-provider — PBTH already
 * serves final retail prices.
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

/**
 * €/kWh the surplus is worth when it is NOT stored — the value of the best
 * disposal route, and the single source of truth for the forgone-revenue side of
 * every store-vs-dispose comparison (DP passes, runtime mapper, chart, explainability).
 * Without curtailment the only route is the grid, so this equals exportValue().
 * With curtailment the inverter can be throttled instead, which costs nothing, so a
 * negative export price is never actually paid: the floor at 0 is that alternative.
 * Flooring matters because the DP books export only as forgone revenue — an unfloored
 * negative value reads as a payment for charging (optimization-engine.js
 * effectiveChargeCost / vPreserve).
 */
function disposalValue(priceSlot, tariffModel, ratio = 1.0, canCurtail = false) {
  const ev = exportValue(priceSlot, tariffModel, ratio);
  return canCurtail ? Math.max(0, ev) : ev;
}

/**
 * €/kWh that storing PV now is worth, instead of exporting it — the single source
 * of truth for the store-vs-export comparison across every surface (DP forward
 * overlay, runtime PV OVERSCHOT gate, explainability text).
 * Storing is a round trip: the kWh pays cycle cost on the way in AND on the way
 * out, so the FULL cycle cost nets off here. The backward DP splits it in halves
 * (optimization-engine.js vCharge/vPreserve) because it prices those two actions
 * separately; this comparison weighs the whole trip at once, like
 * _getDynamicChargePrice (policy-engine.js) already does for grid charging.
 * Live 2026-07-31 08:45Z: 0.376 × 0.7326 = €0.275 beat export €0.259 on the raw
 * formula, but netted −€0.059/kWh once wear was priced.
 */
function storeValue(maxFuturePrice, rte, cycleCostPerKwh = 0) {
  if (maxFuturePrice === null || maxFuturePrice === undefined) return null;
  return maxFuturePrice * rte - cycleCostPerKwh;
}

module.exports = { importPrice, exportPrice, exportValue, disposalValue, storeValue };
