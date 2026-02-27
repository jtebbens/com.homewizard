'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      totalChargeKwh: 0,
      totalDischargeKwh: 0,
      efficiency: 0.75,  // ← Changed default to 0.75 RTE
      lastTimestamp: null,
      lastSoc: null
    };
  }

  save() {
    this.homey.settings.set('efficiency_state', this.state);
  }

  update(p1, battery) {
    if (!p1 || !battery) return;

    const now = Date.now();

    if (!this.state.lastTimestamp) {
      this.state.lastTimestamp = now;
      this.state.lastSoc = battery.stateOfCharge ?? null;
      return;
    }

    const dtHours = (now - this.state.lastTimestamp) / 3600000;
    this.state.lastTimestamp = now;

    if (dtHours <= 0 || dtHours > 1) return;

    const grid = p1.gridPower ?? 0;
    const power = battery.battery_power ?? 0;
    const soc = battery.stateOfCharge ?? null;

    if (Math.abs(power) <= 50) return;

    const pvLikely =
      grid < -75 ||
      (p1.pv_power_estimated ?? 0) > 50;

    if (power > 50 && pvLikely) return;
    if (power < -50 && grid > 150) return;

    // ✅ FIXED: Measure energy at AC side (grid power) for true RTE
    // This captures inverter + battery losses
    if (power > 50) {
      // Charging: measure what comes FROM the grid
      const gridCharge = Math.max(0, grid); // Only count import
      this.state.totalChargeKwh += (gridCharge / 1000) * dtHours;
    }

    if (power < -50) {
      // Discharging: measure what goes TO the grid (negative)
      const gridDischarge = Math.abs(Math.min(0, grid)); // Only count export
      this.state.totalDischargeKwh += (gridDischarge / 1000) * dtHours;
    }

    if (soc === 0 && this.state.lastSoc !== 0) {
      this.state.totalChargeKwh = 0;
      this.state.totalDischargeKwh = 0;
      this.state.efficiency = 0.75;  // ← Reset to configured RTE
      this.state.lastSoc = soc;
      this.save();
      return;
    }

    this.state.lastSoc = soc;

    // ✅ FIXED: Only learn after full round-trip cycle (≥2.5 kWh each way)
    if (
      this.state.totalChargeKwh >= 2.5 &&
      this.state.totalDischargeKwh >= 2.5
    ) {
      const newEff =
        this.state.totalDischargeKwh / this.state.totalChargeKwh;

      const oldEff = this.state.efficiency;

      // ✅ FIXED: Accept only realistic RTE values (50-85%)
      // Modern batteries: 70-85%, older/degraded: 50-70%
      if (newEff >= 0.50 && newEff <= 0.85) {
        // ✅ FIXED: Slower learning (0.95 old, 0.05 new) to avoid noise
        this.state.efficiency = (oldEff * 0.95) + (newEff * 0.05);
      }

      this.state.totalChargeKwh = 0;
      this.state.totalDischargeKwh = 0;

      if (Math.abs(this.state.efficiency - oldEff) >= 0.001) {
        this.homey.log(
          `[Efficiency] RTE updated → ${(this.state.efficiency * 100).toFixed(1)}% (was ${(oldEff * 100).toFixed(1)}%, measured ${(newEff * 100).toFixed(1)}%)`
        );
      }

      this.save();
    }
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.75;
  }

  // ✅ NEW: Reset to configured value
  reset(configuredEff = 0.75) {
    this.state.totalChargeKwh = 0;
    this.state.totalDischargeKwh = 0;
    this.state.efficiency = configuredEff;
    this.save();
    this.homey.log(`[Efficiency] Reset to configured ${(configuredEff * 100).toFixed(0)}%`);
  }
}

module.exports = EfficiencyEstimator;