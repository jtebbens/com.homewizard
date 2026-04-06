# BaseloadMonitor & Battery Correction

`BaseloadMonitor.updatePower(gridPower, batteryPower)` corrects for batteries holding the P1 meter at ~0W:

```text
householdPower = gridPower - batteryPower
// batteryPower > 0 = charging, batteryPower < 0 = discharging
```

**Per driver:**

- **`energy_v2`**: always uses `plugin_battery` as primary source (most accurate — reads directly from battery API). Falls back to `measure_power.battery_group_power_w` only when no `plugin_battery` devices are present. **Do NOT rely solely on the P1 capability** — `payload.power_w ?? 0` sets it to `0` when the P1 firmware doesn't report battery state, making it indistinguishable from a genuinely idle battery.
- **`energy`**: sums `measure_power` across all `plugin_battery` devices ✓
- **`SDM230-p1mode` / `SDM630-p1mode`**: register and feed the BaseloadMonitor directly

**Critical rule:** Never source battery power for BaseloadMonitor from `battery-policy` — that device is optional and not always active. Use `plugin_battery` driver directly:

```js
const battDriver = this.homey.drivers.getDriver('plugin_battery');
// sum dev.getCapabilityValue('measure_power') across getDevices()
```

**`plugin_battery` capability convention:** `measure_power` is watts, positive = charging, negative = discharging.

**Near-zero detection:** When `batteryPower` is known (not null), `_detectNearZeroLong()` skips those samples entirely — the corrected `householdPower` is a real measurement, not grid balancing noise. A 50W baseload house still looks near-zero on the raw grid when the battery is discharging.

**Oscillation detection:** `_detectOscillation()` trims 1 outlier from each end (sorts values, uses `sorted[1]` and `sorted[length-2]`) before computing the range. A single bad sample from a battery mode-transition measurement lag (polling at 10s, sample stored at 30s) must not invalidate an otherwise clean night.

**Multiple P1 meters:** `BaseloadMonitor` uses a single master device (`trySetMaster()` — first to register wins). All P1s call `updatePowerFromDevice()` but only the master's data is processed. Both P1s query `plugin_battery` but only master's result matters.

**Night diagnostics:** `_finalizeNight()` logs one summary line per night:

```text
[BaseloadMonitor] night 2026-03-28: 48 samples, 48 with battery data, avgGrid=2W, avgHousehold=387W, invalid=false
```

`0 with battery data` = battery not seen at night = no correction = likely `sawNearZeroLong` invalid.
