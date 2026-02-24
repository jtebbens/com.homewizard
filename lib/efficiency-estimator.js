'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      totalChargeKwh: 0,
      totalDischargeKwh: 0,
      efficiency: 0.80,
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

    // Ignore idle noise
    if (Math.abs(power) <= 50) return;

    // Ignore PV export or PV-assisted charging
    const pvLikely =
      grid < -75 ||                      // exporting
      (p1.pv_power_estimated ?? 0) > 50; // PV estimate

    if (power > 50 && pvLikely) return;

    // Ignore grid-assisted discharging (house load)
    if (power < -50 && grid > 150) return;

    // Charging
    if (power > 50) {
      this.state.totalChargeKwh += (power / 1000) * dtHours;
    }

    // Discharging
    if (power < -50) {
      this.state.totalDischargeKwh += (Math.abs(power) / 1000) * dtHours;
    }

    // ------------------------------------------------------
    // SMART RESET: reset when battery is truly empty
    // ------------------------------------------------------
    if (soc === 0 && this.state.lastSoc !== 0) {
      this.state.totalChargeKwh = 0;
      this.state.totalDischargeKwh = 0;
      this.state.efficiency = 0.80;
      this.state.lastSoc = soc;
      this.save();
      return;
    }

    this.state.lastSoc = soc;

    // ------------------------------------------------------
    // Only learn after meaningful cycle (≥1.5 kWh)
    // ------------------------------------------------------
    if (
      this.state.totalChargeKwh >= 1.5 &&
      this.state.totalDischargeKwh >= 1.5
    ) {
      const newEff =
        this.state.totalDischargeKwh / this.state.totalChargeKwh;

      const oldEff = this.state.efficiency;

      // Accept only realistic values
      if (newEff >= 0.65 && newEff <= 0.95) {
        // Smooth learning
        this.state.efficiency = (oldEff * 0.85) + (newEff * 0.15);
      }

      // Reset cycle window after learning
      this.state.totalChargeKwh = 0;
      this.state.totalDischargeKwh = 0;

      // Debug only when changed
      if (Math.abs(this.state.efficiency - oldEff) >= 0.001) {
        this.homey.log(
          `[Efficiency] UPDATED → eff=${this.state.efficiency.toFixed(3)} (was ${oldEff.toFixed(3)})`
        );
      }

      this.save();
    }
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.80;
  }
}

module.exports = EfficiencyEstimator;
