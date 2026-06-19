# HomeWizard Battery Planning — Setup & Settings Guide

This guide explains how to add the **Battery Planning** device and configure every
setting. The device builds a 24-hour optimization plan (charge / discharge / hold)
for your HomeWizard Plug-In Battery using dynamic prices, a PV forecast and your
house consumption.

---

## 1. Prerequisites

- A **HomeWizard P1 meter** added via the **Energy (v2)** API.
- One or more **HomeWizard Plug-In Batteries** in the same Homey.
- (Optional) A dynamic energy contract for price arbitrage.

## 2. Add the device

1. Homey → **Devices → + (Add) → HomeWizard → Battery Planning**.
2. **Select battery** — pick the P1 meter / battery this planner controls.
3. **Configure policy** — finish pairing. You can change everything later in settings.

## 3. Device tile controls (no menu needed)

These live on the device tile / controls, not in the settings page:

- **Policy Enabled** — master on/off for the whole planner.
- **Auto-Apply** — *on* = the plan is applied to the battery automatically. *Off* = advice only (the recommended mode is shown but not enforced).
- **Policy Mode** — `Off` · **`Dynamic Pricing`** (default, dynamic contract) · `Fixed Pricing` (fixed contract) · `Dynamic Pricing (V2 — post-saldering)` · `Peak Shaving`.

> Quick start: set **Policy Mode = Dynamic Pricing**, **Policy Enabled = on**, and
> **Auto-Apply = on** once you trust the plan.

## 4. Feed live PV production (flow)

The planner works best when it knows your **current** solar production. If your
inverter/panels are in Homey, push the value with a flow:

- **Action card:** *Update PV production* (`power`, in Watts).
- **Example flow:** *When* PV power changed → *Then* Battery Planning: **Update PV production** = `[current PV watts]`.

This live value also trains the PV-estimation learning over time.

---

## 5. Settings reference

Open the device → **Settings (⚙)**. Settings are grouped exactly as below.
Default and range are shown in brackets.

### Battery Device

- **Linked P1 (Energy v2)** — shows the bound P1 meter. Set during pairing.

### Policy Behavior

- **Policy Check Interval** *(15 min · 5–60)* — how often the plan is recomputed.
- **Minimum Confidence** *(55 % · 0–100)* — below this forecast confidence the planner stays conservative.

### Tariff Configuration

- **Tariff Type** *(`fixed`)* — `fixed` or `dynamic`. Pick `dynamic` for hourly/quarterly market prices.
- **Peak Hours** *(`17:00-21:00`)* — used for fixed/peak logic.
- **Enable Dynamic Pricing Provider** *(off)* — turn on to fetch live dynamic prices.
- **Strictly respect min/max prices** *(off)* — *on* = never charge above *Max Charge Price* / discharge below *Min Discharge Price*, even if the optimizer would. *Off* = the optimizer may override when it's clearly profitable.
- **Opportunistic charge spread multiplier** *(2.0× · 1.0–5.0)* — how aggressively to grab extra-cheap charge slots.
- **Opportunistic discharge spread threshold** *(−0.05 €/kWh · −0.1…−0.01)* — spread needed before opportunistic discharge.
- **Max Charge Price** *(0.12 €/kWh)* — ceiling for grid charging.
- **Min Discharge Price** *(0.22 €/kWh)* — floor for discharging to the grid/house.
- **Min Arbitrage Profit** *(0.01 €/kWh · 0–0.15)* — minimum spread per kWh before a charge→discharge cycle is worth it.
- **Battery Efficiency (RTE)** *(0.78 · 0.5–0.97)* — round-trip efficiency; affects break-even.

### Weather Forecasting

- **Latitude** *(0 · −90…90)* — **set to your home latitude** (e.g. 52.020). Needed for the PV/solar forecast.
- **Longitude** *(0 · −180…180)* — **set to your home longitude** (e.g. 5.040).
- **Weather Update Interval** *(3 h · 1–24)* — how often the forecast refreshes.

### Battery Limits

- **Minimum Battery %** *(0 % · 0–50)* — reserve floor.
- **Maximum Battery %** *(100 % · 80–100)* — charge ceiling.
- **Preserve Battery Cycles** *(on)* — avoids low-value cycling to extend battery life.
- **Battery Cycle Cost** *(0.075 €/kWh · 0–0.15)* — wear cost per kWh cycled; the optimizer must beat this to act.
- **Peak Shaving Threshold (W)** *(0 · 0–10000)* — discharge to keep grid import below this (0 = off).
- **PV Charging Cost** *(`free`)* — `free` = solar charging costs nothing. `feedin` = value solar at the export tariff (it has an opportunity cost).
- **Net Export Value** *(0.08 €/kWh · 0–0.3)* — used when *PV Charging Cost* = `feedin`.

### PV Estimation

- **Enable PV Estimation** *(off)* — turn on to forecast your solar yield.
- **PV Peak Capacity (W)** *(0 · 0–20000)* — total panel Wp (e.g. 3600).
- **Panel Tilt (°)** *(35 · 0–90)* — roof angle (0 = flat, 90 = vertical).
- **Panel Azimuth (°)** *(0 · −90…90)* — orientation: **0 = South**, negative = East, positive = West.
- **Performance Ratio (PR)** *(0.75 · 0.5–0.9)* — system losses factor (inverter, wiring, soiling).

### Solcast PV Forecast (optional)

- **Use Solcast for PV forecast** *(off)* — optional second forecast source.
- **Unbiased OM+Solcast blend (50/50)** *(on)* — blends Open-Meteo and Solcast evenly (recommended). *Off* = weighted/legacy behaviour.
- **Solcast Resource ID** — from your free Solcast account.
- **Solcast API Key** — from your free Solcast account. Leave blank to use Open-Meteo only.

### KNMI Station Data

- **KNMI API Key** — optional free KNMI Open-Data key; adds nearest-station ground-truth to improve forecast accuracy.

### Advanced

- **Enable Detailed Logging** *(off)* — verbose diagnostics (for troubleshooting only).
- **Post policy decisions to timeline** *(off)* — writes each decision to the Homey timeline.

### 24-Hour Planning

- **Price Resolution** *(`15min`)* — `15min` or `1h`. Match your contract: quarterly markets → `15min`, hourly → `1h`. Prices are always fetched at 15-min internally.

---

## 6. Recommended starting point (dynamic contract + solar)

1. **Policy Mode** = Dynamic Pricing · **Policy Enabled** = on · **Auto-Apply** = off (until trusted).
2. **Tariff Type** = `dynamic` · **Enable Dynamic Pricing Provider** = on · **Price Resolution** = match your contract.
3. **Latitude / Longitude** = your home coordinates.
4. **Enable PV Estimation** = on · set **PV Peak Capacity**, **Tilt**, **Azimuth**, **PR**.
5. Add the **Update PV production** flow so live solar is fed in.
6. Leave **Max Charge Price**, **Min Discharge Price**, **Cycle Cost**, **Battery Efficiency** at defaults first; tune after watching the plan a few days.
7. (Optional) Add **Solcast** keys and/or a **KNMI** key for sharper forecasts.
8. Once the plan looks right, switch **Auto-Apply = on**.

> Tip: the device's **diagnostic page** shows the full 24-hour plan, the price range,
> the PV forecast and the reason for each slot — use it to understand and tune the
> settings above.
