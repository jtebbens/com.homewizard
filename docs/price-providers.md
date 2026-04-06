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
