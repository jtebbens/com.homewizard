# Planning Chart Camera Images

Two camera images are registered on the battery-policy device: **"Batterij Vandaag"** and **"Batterij Morgen"** (`planning_today` / `planning_tomorrow`). Generated via [quickchart.io](https://quickchart.io) POST API after every `_saveWidgetData()` call.

**Architecture (`device.js`):**

- `_saveWidgetData()` → builds `compact` (slots = past + future) → calls `_updatePlanningChart(compact)`
- `_updatePlanningChart()` splits slots by Amsterdam calendar day → stores as `_chartToday` / `_chartTomorrow`
- `image.setStream()` callback calls `_streamQuickChart()` when Homey UI requests the image
- `image.update()` signals new data available; stream fires lazily on next UI request

**`_configToJs(val)`** — custom serializer that preserves JS function values (unlike `JSON.stringify` which drops them). Required because quickchart.io evaluates the `chart` field as a JS expression string, not JSON. Pass `chart: this._configToJs(chartCfg)` in the POST body.

- **Do NOT use `generateLabels`** in legend config — `Chart.defaults` is not available in quickchart.io's eval context and breaks rendering entirely. Use `filter: function(item) { ... }` instead.

**Chart structure (Chart.js 4, mixed):**

- Bar dataset `_prijs`: price bars colored by mode (hidden from legend via `filter` on `_` prefix)
- Line `SoC (%)`: white dashed, right axis 0–100%
- Line `PV` (solid yellow): past slots only (`ts < now`), `fill: true`
- Line `_pv_forecast` (dashed yellow): future slots only, first point = last past slot for seamless join (hidden from legend)
- Phantom bar datasets per mode present: empty `data: []`, used only for legend color swatches
- Scale `yPrice` (left), `ySoc` (right, white), `yPv` (right, yellow, max = `pv_capacity_w` setting)

**`_schedulePriceRefresh` timezone:** uses `toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' })` — NOT `new Date().getHours()` which returns UTC on Homey.

---

# Battery Planning Dashboard Widget

Widget lives in `widgets/battery-planning/`. Renders price step chart + PV area + SoC strip + mode icon bar inside an inline SVG. Data comes from `policy_widget_data` (settings) and `planning-update` (realtime).

**SVG theme-aware colors:** SVG `stroke` and `fill` attributes are strings — they cannot use CSS variables directly. Detect the color scheme in JS before building the SVG:

```js
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const priceLineColor = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
const nowMarkerColor = isDark ? 'white' : '#333';
```

- **Do NOT hardcode `stroke="white"`** for the price line or "now" marker — invisible on light background.
- `currentColor` works for SVG elements that inherit CSS `color`, but not for explicit `stroke=` attributes on path/line elements.
- CSS `@media (prefers-color-scheme: dark)` only applies to elements using `currentColor` or CSS classes, not inline SVG attribute values.
