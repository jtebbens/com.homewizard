'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      totalChargeKwh: 0,
      totalDischargeKwh: 0,
      efficiency: 0.80,
      lastTimestamp: null
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
      return;
    }

    const dtHours = (now - this.state.lastTimestamp) / 3600000;
    this.state.lastTimestamp = now;

    if (dtHours <= 0 || dtHours > 1) return;

    const grid = p1.gridPower ?? 0;
    const power = battery.battery_power ?? 0;

    // Ignore idle noise
    if (Math.abs(power) <= 50) return;

    // Ignore PV export (not real battery charging)
    if (grid < -150) return;

    // Ignore PV-assisted charging
    if (power > 50 && grid < 0) return;

    // Ignore grid-assisted discharging
    if (power < -50 && grid > 100) return;

    // Charging
    if (power > 50) {
      this.state.totalChargeKwh += (power / 1000) * dtHours;
    }

    // Discharging
    if (power < -50) {
      this.state.totalDischargeKwh += (Math.abs(power) / 1000) * dtHours;
    }

    // Need enough data
    if (this.state.totalChargeKwh > 0.5 && this.state.totalDischargeKwh > 0.5) {
      const newEff = this.state.totalDischargeKwh / this.state.totalChargeKwh;

      const oldEff = this.state.efficiency;

      // Only update if within realistic battery efficiency range (50-100%)
      // Prevents corrupt state from skewed charge/discharge data after restart
      if (newEff >= 0.5 && newEff <= 1.0) {
        this.state.efficiency = (oldEff * 0.9) + (newEff * 0.1);
      }

      if (this.state.efficiency < 0.5 || this.state.efficiency > 1.0) {
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
        this.state.efficiency = 0.80;
      }

      // Debug ONLY when efficiency changes
      if (Math.abs(this.state.efficiency - oldEff) >= 0.0005) {
        this.homey.log(
          `[Efficiency] UPDATED → eff=${this.state.efficiency.toFixed(3)} (was ${oldEff.toFixed(3)})`
        );
      }

      // Reset after enough data
      if (this.state.totalChargeKwh > 10 || this.state.totalDischargeKwh > 10) {
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
      }

      this.save();
    }
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.80;
  }
}

module.exports = EfficiencyEstimator;
