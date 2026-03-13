'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      totalChargeKwh: 0,
      totalDischargeKwh: 0,
      efficiency: 0.75,  // Default 75% RTE
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

    // ✅ FIX: Reset counters on SoC=0 but PRESERVE learned efficiency
    // Hysteresis: only trigger if SoC drops from >2% to 0% (prevents glitches)
    if (soc === 0 && this.state.lastSoc > 2) {
      this.homey.log(
        `[Efficiency] SoC dropped to 0% (from ${this.state.lastSoc}%) → ` +
        `clearing charge/discharge counters (preserving learned RTE ${(this.state.efficiency * 100).toFixed(1)}%)`
      );
      this.state.totalChargeKwh = 0;
      this.state.totalDischargeKwh = 0;
      // ✅ DO NOT reset efficiency - only reset counters for new cycle
      this.state.lastSoc = soc;
      this.save();
      return;
    }

    // ✅ Battery-side RTE: use battery_power directly
    let accumulated = false;
    if (power > 50) {
      const chargeKw = power / 1000;
      // If we're starting a fresh charge from near-empty but have orphaned discharge
      // data from a previous cycle (no paired charge), clear it to avoid cross-cycle
      // contamination (e.g. 1100Wh discharge / 1000Wh charge → bogus 110% RTE).
      // NOTE: soc must be a real number (not null) for this guard to fire.
      if (this.state.totalDischargeKwh > 0 && this.state.totalChargeKwh === 0
          && typeof soc === 'number' && soc <= 5) {
        this.homey.log(`[Efficiency] Clearing orphaned discharge data (${(this.state.totalDischargeKwh * 1000).toFixed(0)}Wh) from previous cycle`);
        this.state.totalDischargeKwh = 0;
      }
      this.state.totalChargeKwh += chargeKw * dtHours;
      accumulated = true;
    }

    if (power < -50) {
      const dischargeKw = Math.abs(power) / 1000;
      this.state.totalDischargeKwh += dischargeKw * dtHours;
      accumulated = true;
    }

    // Persist counters periodically so a restart doesn't lose partial-cycle progress.
    // ~1 min cadence (every 4th update at 15s polling interval) to avoid excess writes.
    if (accumulated) {
      this._saveCounter = (this._saveCounter || 0) + 1;
      if (this._saveCounter % 4 === 0) this.save();
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

      if (newEff >= 0.50 && newEff <= 0.85) {
        // Valid RTE — apply slow learning and reset counters
        this.state.efficiency = (oldEff * 0.95) + (newEff * 0.05);
        
        // ✅ FIX: Log cycle completion with detailed stats
        const chargedWh = (this.state.totalChargeKwh * 1000).toFixed(0);
        const dischargedWh = (this.state.totalDischargeKwh * 1000).toFixed(0);
        this.homey.log(
          `[Efficiency] ✅ Learning cycle complete: ` +
          `charged=${chargedWh}Wh, discharged=${dischargedWh}Wh, ` +
          `measured=${(newEff * 100).toFixed(1)}%, ` +
          `learned RTE: ${(oldEff * 100).toFixed(1)}% → ${(this.state.efficiency * 100).toFixed(1)}%`
        );
        
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;

      } else if (newEff > 0.85) {
        // Unrealistically high (measurement error) — reset and discard
        this.homey.log(
          `[Efficiency] ⚠️ RTE measurement ${(newEff * 100).toFixed(1)}% too high → ` +
          `discarding cycle (charged=${(this.state.totalChargeKwh * 1000).toFixed(0)}Wh, ` +
          `discharged=${(this.state.totalDischargeKwh * 1000).toFixed(0)}Wh)`
        );
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
      } else if (this.state.totalChargeKwh > 10.0 || this.state.totalDischargeKwh > 10.0) {
        // Counters very stale (>10 kWh) without valid result — prevent unbounded growth
        this.homey.log(
          `[Efficiency] ⚠️ RTE counters stale (charge=${this.state.totalChargeKwh.toFixed(1)}kWh, ` +
          `discharge=${this.state.totalDischargeKwh.toFixed(1)}kWh) → resetting`
        );
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
      }
      // else: RTE too low (<0.50) — cycle not complete yet, keep accumulating

      this.save();
    }
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.75;
  }

  // ✅ Reset to configured value
  reset(configuredEff = 0.75) {
    this.homey.log(
      `[Efficiency] Manual reset: ${(this.state.efficiency * 100).toFixed(1)}% → ${(configuredEff * 100).toFixed(0)}%`
    );
    this.state.totalChargeKwh = 0;
    this.state.totalDischargeKwh = 0;
    this.state.efficiency = configuredEff;
    this.save();
  }
}

module.exports = EfficiencyEstimator;