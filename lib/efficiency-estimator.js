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

    // ✅ Battery-side RTE: use battery_power directly
    if (power > 50) {
      const chargeKw = power / 1000;
      this.state.totalChargeKwh += chargeKw * dtHours;
    }

    if (power < -50) {
      const dischargeKw = Math.abs(power) / 1000;
      this.state.totalDischargeKwh += dischargeKw * dtHours;
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

    // Learn after enough data (≥1.0 kWh each way — ~75min at 800W)
    if (
      this.state.totalChargeKwh >= 1.0 &&
      this.state.totalDischargeKwh >= 1.0
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