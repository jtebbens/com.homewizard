# Price Providers

- **MergedPriceProvider** combines Xadi + KwhPrice; 1-hour in-memory cache + persistent settings cache
- **XadiProvider / KwhPriceProvider**: fetch day-ahead prices; each has its own cache
- `fetchPrices(force = false)` respects cache; pass `force = true` to bypass
- 15-min prices: native when available, expanded from hourly as fallback
- Prices saved to `homey.settings` as `policy_all_prices` and `policy_all_prices_15min`

**`homey.settings` API:** `.get()`, `.set()`, `.unset()` are all **synchronous** — they do NOT return a Promise. Never call `.catch()` on them.

**`battery_group_charge_mode` capability:** `updateCapability()` has a self-healing guard — if the capability is missing when a battery event arrives, it calls `safeAddCapability()` before `setCapabilityValue()`. This handles devices where the capability was removed by the no-battery path and never re-added.

**`predictive` mode (HW Slim laden):** HomeWizard firmware exposes `mode: 'predictive'` in `GET /api/batteries` when HW's own Smart Charging is active. `getMode()` in `Api.js` detects this before the permissions switch and returns `'predictive'`. `_applyRecommendation()` in battery-policy skips the mode write entirely when `actualMode === 'predictive'`. The `battery_group_charge_mode` enum includes `'predictive'` as a valid value so `setCapabilityValue` does not fail.

**KwhPriceProvider scraping:** kwhprice.eu renders prices via Chart.js (JavaScript arrays), NOT an HTML table. `_parseHtml` extracts `labels: ["00:00-00:15", ...]` and `data: [0.057, ...]` arrays from the page source. Prices are raw EPEX spot (excl. VAT/markup) — `(spot + markup) × 1.21` is applied client-side. The page contains **two datasets**: today (96 slots) and tomorrow (96 slots, available all day). Both are parsed — `matchAll` extracts all `labels`/`data` occurrences.

- **Negative prices:** the `data:` regex must include `-` in the character class: `/\bdata:\s*\[([-\d.,\s\n]+)\]/g`. Without it, any dataset containing negative spot prices is not matched and the entire tomorrow dataset is silently dropped.
- **Zero/negative price filter:** use `!isNaN(spotEur)` as the slot inclusion guard, NOT `spotEur > 0`. Filtering out negatives/zeros drops valid market data and can cause tomorrow's dataset to appear empty.

## MergedPriceProvider Cache Race

- `_loadCache()` is async and not awaited in the constructor
- `fetchPrices()` must await `this._cacheLoadPromise` before checking `this.cache`, otherwise the settings cache is missed on every restart and both Xadi + KwhPrice are fetched unnecessarily
- Pattern: `this._cacheLoadPromise = this._loadCache()` in constructor, `await this._cacheLoadPromise; this._cacheLoadPromise = null` at start of `fetchPrices()`

## Import/Export price plumbing (post-2027 asymmetric tariffs)

Every price slot from all three providers (Xadi, KwhPrice, ENTSOE fallback) now carries two prices, both derived from the same raw spot (`originalPrice`) via `lib/price-formulas.js` — the single shared implementation, not duplicated per provider:

- **`price`** (import, unchanged): `(spot + markup) × 1.21`
- **`exportPrice`** (new): `(spot + export_addon) × export_multiplier`

`export_multiplier`/`export_addon` default to `1.0`/`0`, which reduces `exportPrice` to the bare spot price (current NL saldering assumption). They're read from settings `export_price_multiplier`/`export_price_addon` in `TariffManager._initializeDynamicProvider()` and passed through `MergedPriceProvider` to all three sub-providers — same pattern as the existing `dynamic_price_markup` passthrough. All three settings (plus `tariff_model`) have `driver.settings.compose.json` UI fields under "Tariff Configuration"; `export_price_multiplier`/`export_price_addon` are only visible when `tariff_model = asymmetric_2027`.

**Order of operations matters**: the multiplier applies to `(spot + addon)`, not to spot alone — confirmed against Zonneplan's own Zonnebonus formula ("(marktprijs + €0,02) + 10%"). A feed-in fee (terugleverkosten) can be modeled as a negative `export_addon` with `export_multiplier: 1.0` (flat per-kWh penalty, no tiered/staffel pricing).

`exportPrice` flows through unchanged to `TariffManager`'s `allPrices`, `allPrices15min`, `effectivePrices`, and `next24Hours` outputs, and into `OptimizationEngine._exportValue()` (both DP passes), `policy-engine.js` (runtime PV flags + planning chart mapper) and `explainability-engine.js` — the single `exportValue(priceSlot, tariffModel, ratio)` implementation in `lib/price-formulas.js` is the only place export value is computed, so every surface (DP, chart, explanation, and the battery-policy device's own cycle-profit/ROI ledger in `device.js#_updateBatteryCostModel`) reads the same number. `pv_cost_mode`/`feed_in_tariff` (the old flat scalar the ROI ledger used before this rework) have been removed in favor of `tariff_model`.
