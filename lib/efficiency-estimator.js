'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      efficiency: 0.75,
      lastTimestamp: null,
      lastSoc: null,
      lastPowerDirection: null,
      // Current charge session accumulator
      sessionChargeKwh: 0,
      sessionChargePowerSum: 0,
      sessionChargePowerSamples: 0,
      sessionChargeModeVotes: {},
      // Pending charge session (paired with the upcoming discharge session)
      pendingChargeKwh: 0,
      pendingChargePowerSum: 0,
      pendingChargePowerSamples: 0,
      pendingChargeMode: null,
      // Current discharge session accumulator
      sessionDischargeKwh: 0,
      sessionDischargePowerSum: 0,
      sessionDischargePowerSamples: 0,
      cycles: [] // last 60 completed cycles
    };
  }

  save() {
    this.homey.settings.set('efficiency_state', this.state);
  }

  update(p1, battery, activeMode = null) {
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

    const power = battery.battery_power ?? 0;
    const soc = battery.stateOfCharge ?? null;

    if (Math.abs(power) <= 100) return; // filter inverter standby draw

    // Reset session counters on SoC=0 but preserve learned efficiency
    if (soc === 0 && this.state.lastSoc > 2) {
      this.homey.log(
        `[Efficiency] SoC dropped to 0% (from ${this.state.lastSoc}%) → ` +
        `clearing session counters (preserving learned RTE ${(this.state.efficiency * 100).toFixed(1)}%)`
      );
      this.state.sessionChargeKwh = 0;
      this.state.sessionChargePowerSum = 0;
      this.state.sessionChargePowerSamples = 0;
      this.state.sessionChargeModeVotes = {};
      this.state.pendingChargeKwh = 0;
      this.state.pendingChargePowerSum = 0;
      this.state.pendingChargePowerSamples = 0;
      this.state.pendingChargeMode = null;
      this.state.sessionDischargeKwh = 0;
      this.state.sessionDischargePowerSum = 0;
      this.state.sessionDischargePowerSamples = 0;
      this.state.lastPowerDirection = null;
      this.state.lastSoc = soc;
      this.save();
      return;
    }

    const currentDirection = power > 100 ? 'charge' : 'discharge';
    const prevDirection = this.state.lastPowerDirection;

    // On direction transition: save pending charge or evaluate RTE
    if (prevDirection && currentDirection !== prevDirection) {
      if (prevDirection === 'charge' && currentDirection === 'discharge') {
        // Charge session ended — save as pending for the upcoming discharge session
        const votes = this.state.sessionChargeModeVotes || {};
        const dominantMode = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null;
        this.state.pendingChargeKwh = this.state.sessionChargeKwh || 0;
        this.state.pendingChargePowerSum = this.state.sessionChargePowerSum || 0;
        this.state.pendingChargePowerSamples = this.state.sessionChargePowerSamples || 0;
        this.state.pendingChargeMode = dominantMode;
        this.homey.log(
          `[Efficiency] 🔄 Charge→Discharge: pending=${(this.state.pendingChargeKwh * 1000).toFixed(0)}Wh mode=${dominantMode}`
        );
        // Reset session counters for the discharge session
        this.state.sessionChargeKwh = 0;
        this.state.sessionChargePowerSum = 0;
        this.state.sessionChargePowerSamples = 0;
        this.state.sessionChargeModeVotes = {};
        this.state.sessionDischargeKwh = 0;
        this.state.sessionDischargePowerSum = 0;
        this.state.sessionDischargePowerSamples = 0;

      } else if (prevDirection === 'discharge' && currentDirection === 'charge') {
        // Discharge session ended — measure RTE from pending charge vs actual discharge
        const pendingCharge = this.state.pendingChargeKwh || 0;
        const sessionDischarge = this.state.sessionDischargeKwh || 0;

        if (pendingCharge >= 0.3 && sessionDischarge >= 0.3) {
          const newEff = sessionDischarge / pendingCharge;
          const avgChargePower = this.state.pendingChargePowerSamples > 0
            ? Math.round(this.state.pendingChargePowerSum / this.state.pendingChargePowerSamples) : 0;
          const avgDischargePower = this.state.sessionDischargePowerSamples > 0
            ? Math.round(this.state.sessionDischargePowerSum / this.state.sessionDischargePowerSamples) : 0;

          if (newEff >= 0.70 && newEff <= 0.97) {
            const oldEff = this.state.efficiency;
            this.state.efficiency = (oldEff * 0.95) + (newEff * 0.05);

            this.homey.log(
              `[Efficiency] ✅ Session cycle: ` +
              `charged=${(pendingCharge * 1000).toFixed(0)}Wh @ avg ${avgChargePower}W, ` +
              `discharged=${(sessionDischarge * 1000).toFixed(0)}Wh @ avg ${avgDischargePower}W, ` +
              `measured=${(newEff * 100).toFixed(1)}%, ` +
              `learned RTE: ${(oldEff * 100).toFixed(1)}% → ${(this.state.efficiency * 100).toFixed(1)}%`
            );

            this.state.cycles = this.state.cycles || [];
            this.state.cycles.push({
              rte: newEff,
              avgChargePower,
              avgDischargePower,
              chargedWh: Math.round(pendingCharge * 1000),
              mode: this.state.pendingChargeMode || null,
              month: new Date().getMonth() + 1,
              ts: Date.now()
            });
            if (this.state.cycles.length > 60) this.state.cycles = this.state.cycles.slice(-60);

            const insights = this.getEfficiencyInsights();
            if (insights) {
              const m = insights.rteByMode;
              this.homey.log(
                `[Efficiency] 📊 Modus-vergelijking: ` +
                Object.entries(m).map(([k, v]) => `${k}=${v.rte}% (${v.n}x)`).join(', ')
              );
              this.homey.log(`[Efficiency] 💡 ${insights.recommendation}`);
            }
          } else {
            this.homey.log(
              `[Efficiency] ⚠️ Session RTE ${(newEff * 100).toFixed(1)}% out of range [70–97%] → discarding ` +
              `(charged=${(pendingCharge * 1000).toFixed(0)}Wh, discharged=${(sessionDischarge * 1000).toFixed(0)}Wh)`
            );
          }
        }

        // Reset pending + start fresh charge session
        this.state.pendingChargeKwh = 0;
        this.state.pendingChargePowerSum = 0;
        this.state.pendingChargePowerSamples = 0;
        this.state.pendingChargeMode = null;
        this.state.sessionChargeKwh = 0;
        this.state.sessionChargePowerSum = 0;
        this.state.sessionChargePowerSamples = 0;
        this.state.sessionChargeModeVotes = {};
        this.save();
      }
    }

    this.state.lastPowerDirection = currentDirection;

    // Accumulate session counters
    let accumulated = false;
    if (power > 100) {
      const chargeKw = power / 1000;
      this.state.sessionChargeKwh = (this.state.sessionChargeKwh || 0) + chargeKw * dtHours;
      this.state.sessionChargePowerSum = (this.state.sessionChargePowerSum || 0) + power;
      this.state.sessionChargePowerSamples = (this.state.sessionChargePowerSamples || 0) + 1;
      if (activeMode) {
        this.state.sessionChargeModeVotes = this.state.sessionChargeModeVotes || {};
        this.state.sessionChargeModeVotes[activeMode] = (this.state.sessionChargeModeVotes[activeMode] || 0) + chargeKw * dtHours;
      }
      accumulated = true;
    } else if (power < -100) {
      const dischargeKw = Math.abs(power) / 1000;
      this.state.sessionDischargeKwh = (this.state.sessionDischargeKwh || 0) + dischargeKw * dtHours;
      this.state.sessionDischargePowerSum = (this.state.sessionDischargePowerSum || 0) + Math.abs(power);
      this.state.sessionDischargePowerSamples = (this.state.sessionDischargePowerSamples || 0) + 1;
      accumulated = true;
    }

    // Persist periodically (~1 min cadence at 15s polling interval)
    if (accumulated) {
      this._saveCounter = (this._saveCounter || 0) + 1;
      if (this._saveCounter % 4 === 0) this.save();
    }

    this.state.lastSoc = soc;
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.75;
  }

  /**
   * Update RTE directly from cumulative hardware meter values.
   * More accurate than cycle-based estimation — uses authoritative import/export kWh.
   * Only updates if both values are large enough (>20 kWh) for statistical stability.
   */
  updateFromMeters(totalImportKwh, totalExportKwh) {
    if (!totalImportKwh || !totalExportKwh) return;
    if (totalImportKwh < 20 || totalExportKwh < 20) return; // not enough data yet

    const meterRte = totalExportKwh / totalImportKwh;
    if (meterRte < 0.50 || meterRte > 0.99) return; // sanity check

    const oldEff = this.state.efficiency;
    if (Math.abs(meterRte - oldEff) > 0.001) {
      this.state.efficiency = meterRte;
      this.save();
      this.homey.log(
        `[Efficiency] 📊 Meter-based RTE: import=${totalImportKwh.toFixed(1)}kWh, ` +
        `export=${totalExportKwh.toFixed(1)}kWh → ` +
        `${(oldEff * 100).toFixed(1)}% → ${(meterRte * 100).toFixed(1)}%`
      );
      return meterRte; // signal caller that value changed
    }
    return null; // no change
  }

  reset(configuredEff = 0.75) {
    this.homey.log(
      `[Efficiency] Manual reset: ${(this.state.efficiency * 100).toFixed(1)}% → ${(configuredEff * 100).toFixed(0)}%`
    );
    this.state.sessionChargeKwh = 0;
    this.state.sessionChargePowerSum = 0;
    this.state.sessionChargePowerSamples = 0;
    this.state.sessionChargeModeVotes = {};
    this.state.pendingChargeKwh = 0;
    this.state.pendingChargePowerSum = 0;
    this.state.pendingChargePowerSamples = 0;
    this.state.pendingChargeMode = null;
    this.state.sessionDischargeKwh = 0;
    this.state.sessionDischargePowerSum = 0;
    this.state.sessionDischargePowerSamples = 0;
    this.state.lastPowerDirection = null;
    this.state.efficiency = configuredEff;
    this.save();
  }
  /**
   * Analyse of lager laadvermogen betere RTE geeft.
   * Geeft inzicht per vermogensbucket en seizoen.
   */
  getCycleCount() {
    return (this.state.cycles || []).length;
  }

  getEfficiencyInsights() {
    const cycles = this.state.cycles || [];
    if (cycles.length < 5) return null;

    // Bucket cycles by average charge power: low (<300W), mid (300-600W), high (>600W)
    const buckets = { low: [], mid: [], high: [] };
    for (const c of cycles) {
      if (c.avgChargePower < 300)      buckets.low.push(c.rte);
      else if (c.avgChargePower < 600) buckets.mid.push(c.rte);
      else                             buckets.high.push(c.rte);
    }

    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    const rteByPower = {
      low:  avg(buckets.low)  ? { rte: +(avg(buckets.low)  * 100).toFixed(1), n: buckets.low.length }  : null,
      mid:  avg(buckets.mid)  ? { rte: +(avg(buckets.mid)  * 100).toFixed(1), n: buckets.mid.length }  : null,
      high: avg(buckets.high) ? { rte: +(avg(buckets.high) * 100).toFixed(1), n: buckets.high.length } : null,
    };

    // Seasonal: group by month (winter=nov-feb, spring=mar-may, summer=jun-aug, autumn=sep-oct)
    const season = m => m <= 2 || m === 12 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn';
    const bySeasonMap = {};
    for (const c of cycles) {
      const s = season(c.month);
      bySeasonMap[s] = bySeasonMap[s] || [];
      bySeasonMap[s].push(c.rte);
    }
    const rteBySeason = {};
    for (const [s, arr] of Object.entries(bySeasonMap)) {
      rteBySeason[s] = { rte: +(avg(arr) * 100).toFixed(1), n: arr.length };
    }

    // RTE per charge mode (zero_charge_only, to_full, standby, etc.)
    const byMode = {};
    for (const c of cycles) {
      if (!c.mode) continue;
      byMode[c.mode] = byMode[c.mode] || [];
      byMode[c.mode].push(c.rte);
    }
    const rteByMode = {};
    for (const [mode, arr] of Object.entries(byMode)) {
      rteByMode[mode] = { rte: +(avg(arr) * 100).toFixed(1), n: arr.length };
    }

    // Recommendation: mode-based first, power-based as fallback
    let recommendation = null;
    const zco = rteByMode['zero_charge_only'];
    const full = rteByMode['to_full'];
    if (zco && full && zco.n >= 3 && full.n >= 3) {
      const diff = zco.rte - full.rte;
      if (diff > 1.5) {
        recommendation = `zero_charge_only geeft ${diff.toFixed(1)}% hogere RTE dan to_full (${zco.rte}% vs ${full.rte}%). PV-overflow laden is efficiënter — prefereer dit boven vol nettarief laden.`;
      } else if (diff < -1.5) {
        recommendation = `to_full geeft ${(-diff).toFixed(1)}% hogere RTE dan zero_charge_only (${full.rte}% vs ${zco.rte}%). Geen voordeel bij langzamer laden in jouw situatie.`;
      } else {
        recommendation = `zero_charge_only (${zco.rte}%) en to_full (${full.rte}%) geven vergelijkbare RTE — laadstrategie heeft weinig effect op efficiëntie.`;
      }
    } else {
      const lowRte  = avg(buckets.low);
      const highRte = avg(buckets.high);
      if (lowRte && highRte && (lowRte - highRte) > 0.02) {
        recommendation = `Lager laadvermogen (<300W) geeft ${((lowRte - highRte) * 100).toFixed(1)}% hogere RTE. Nog onvoldoende modus-data (zco=${zco?.n || 0}x, full=${full?.n || 0}x).`;
      } else {
        recommendation = `Nog onvoldoende data voor modus-vergelijking (zco=${zco?.n || 0}x, full=${full?.n || 0}x — minimaal 3x elk nodig).`;
      }
    }

    return { rteByPower, rteByMode, rteBySeason, recommendation, cycleCount: cycles.length };
  }
}

module.exports = EfficiencyEstimator;