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
      sessionChargeKwhByBucket: { low: 0, mid: 0, high: 0 }, // energy by instantaneous power (300/600W splits)
      // Pending charge session (paired with the upcoming discharge session)
      pendingChargeKwh: 0,
      pendingChargePowerSum: 0,
      pendingChargePowerSamples: 0,
      pendingChargeMode: null,
      pendingChargeKwhByBucket: { low: 0, mid: 0, high: 0 },
      // Current discharge session accumulator
      sessionDischargeKwh: 0,
      sessionDischargePowerSum: 0,
      sessionDischargePowerSamples: 0,
      sessionDischargeKwhByBucket: { low: 0, mid: 0, high: 0 },
      cycles: [] // last 60 completed cycles
    };
  }

  save() {
    this.homey.settings.set('efficiency_state', this.state);
  }

  // Instantaneous-power bucket — same 300/600W splits used by getEfficiencyInsights().
  _bucketOf(absPower) {
    return absPower < 300 ? 'low' : absPower < 600 ? 'mid' : 'high';
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

    // Reset session counters on a genuine drain to SoC=0, preserving learned efficiency.
    // Guard: only when SoC=0 is reached GRADUALLY from a low, non-zero SoC. A battery-device
    // WebSocket re-init briefly reports SoC=0 while the real SoC is high (88→0 / 97→0 in one
    // sample); the old `lastSoc > 2` let those glitches through and wiped the charge counters,
    // breaking RTE booking. `lastSoc > 0` also debounces (no re-fire once already at 0).
    if (soc === 0 && this.state.lastSoc > 0 && this.state.lastSoc <= 10) {
      // Evaluate cycle before clearing — battery drained to 0% without a charge transition
      const pendingCharge = this.state.pendingChargeKwh || 0;
      const sessionDischarge = this.state.sessionDischargeKwh || 0;
      if (pendingCharge >= 0.3 && sessionDischarge >= 0.3) {
        const newEff = sessionDischarge / pendingCharge;
        if (newEff >= 0.70 && newEff <= 0.97) {
          const oldEff = this.state.efficiency;
          this.state.efficiency = (oldEff * 0.95) + (newEff * 0.05);
          const avgChargePower = this.state.pendingChargePowerSamples > 0
            ? Math.round(this.state.pendingChargePowerSum / this.state.pendingChargePowerSamples) : 0;
          const avgDischargePower = this.state.sessionDischargePowerSamples > 0
            ? Math.round(this.state.sessionDischargePowerSum / this.state.sessionDischargePowerSamples) : 0;
          this.homey.log(
            `[Efficiency] ✅ SoC=0% cycle: ` +
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
            chargeKwhByBucket: { ...(this.state.pendingChargeKwhByBucket || { low: 0, mid: 0, high: 0 }) },
            dischargeKwhByBucket: { ...(this.state.sessionDischargeKwhByBucket || { low: 0, mid: 0, high: 0 }) },
            mode: this.state.pendingChargeMode || null,
            month: new Date().getMonth() + 1,
            ts: Date.now()
          });
          if (this.state.cycles.length > 60) this.state.cycles = this.state.cycles.slice(-60);
        } else {
          this.homey.log(
            `[Efficiency] ⚠️ SoC=0% cycle RTE ${(newEff * 100).toFixed(1)}% out of range [70–97%] → discarding`
          );
        }
      }
      this.homey.log(
        `[Efficiency] SoC dropped to 0% (from ${this.state.lastSoc}%) → ` +
        `clearing session counters (preserving learned RTE ${(this.state.efficiency * 100).toFixed(1)}%)`
      );
      this.state.sessionChargeKwh = 0;
      this.state.sessionChargePowerSum = 0;
      this.state.sessionChargePowerSamples = 0;
      this.state.sessionChargeModeVotes = {};
      this.state.sessionChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
      this.state.pendingChargeKwh = 0;
      this.state.pendingChargePowerSum = 0;
      this.state.pendingChargePowerSamples = 0;
      this.state.pendingChargeMode = null;
      this.state.pendingChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
      this.state.sessionDischargeKwh = 0;
      this.state.sessionDischargePowerSum = 0;
      this.state.sessionDischargePowerSamples = 0;
      this.state.sessionDischargeKwhByBucket = { low: 0, mid: 0, high: 0 };
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
        this.state.pendingChargeKwhByBucket = this.state.sessionChargeKwhByBucket || { low: 0, mid: 0, high: 0 };
        this.homey.log(
          `[Efficiency] 🔄 Charge→Discharge: pending=${(this.state.pendingChargeKwh * 1000).toFixed(0)}Wh mode=${dominantMode}`
        );
        // Reset session counters for the discharge session
        this.state.sessionChargeKwh = 0;
        this.state.sessionChargePowerSum = 0;
        this.state.sessionChargePowerSamples = 0;
        this.state.sessionChargeModeVotes = {};
        this.state.sessionChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
        this.state.sessionDischargeKwh = 0;
        this.state.sessionDischargePowerSum = 0;
        this.state.sessionDischargePowerSamples = 0;
        this.state.sessionDischargeKwhByBucket = { low: 0, mid: 0, high: 0 };

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

            const dBk = this.state.sessionDischargeKwhByBucket || { low: 0, mid: 0, high: 0 };
            this.homey.log(
              `[Efficiency] ✅ Session cycle: ` +
              `charged=${(pendingCharge * 1000).toFixed(0)}Wh @ avg ${avgChargePower}W, ` +
              `discharged=${(sessionDischarge * 1000).toFixed(0)}Wh @ avg ${avgDischargePower}W ` +
              `(low/mid/high=${(dBk.low * 1000).toFixed(0)}/${(dBk.mid * 1000).toFixed(0)}/${(dBk.high * 1000).toFixed(0)}Wh), ` +
              `measured=${(newEff * 100).toFixed(1)}%, ` +
              `learned RTE: ${(oldEff * 100).toFixed(1)}% → ${(this.state.efficiency * 100).toFixed(1)}%`
            );

            this.state.cycles = this.state.cycles || [];
            this.state.cycles.push({
              rte: newEff,
              avgChargePower,
              avgDischargePower,
              chargedWh: Math.round(pendingCharge * 1000),
              chargeKwhByBucket: { ...(this.state.pendingChargeKwhByBucket || { low: 0, mid: 0, high: 0 }) },
              dischargeKwhByBucket: { ...dBk },
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
        this.state.pendingChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
        this.state.sessionChargeKwh = 0;
        this.state.sessionChargePowerSum = 0;
        this.state.sessionChargePowerSamples = 0;
        this.state.sessionChargeModeVotes = {};
        this.state.sessionChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
        this.state.sessionDischargeKwhByBucket = { low: 0, mid: 0, high: 0 };
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
      this.state.sessionChargeKwhByBucket = this.state.sessionChargeKwhByBucket || { low: 0, mid: 0, high: 0 };
      this.state.sessionChargeKwhByBucket[this._bucketOf(power)] += chargeKw * dtHours;
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
      this.state.sessionDischargeKwhByBucket = this.state.sessionDischargeKwhByBucket || { low: 0, mid: 0, high: 0 };
      this.state.sessionDischargeKwhByBucket[this._bucketOf(Math.abs(power))] += dischargeKw * dtHours;
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
    this.state.sessionChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
    this.state.pendingChargeKwh = 0;
    this.state.pendingChargePowerSum = 0;
    this.state.pendingChargePowerSamples = 0;
    this.state.pendingChargeMode = null;
    this.state.pendingChargeKwhByBucket = { low: 0, mid: 0, high: 0 };
    this.state.sessionDischargeKwh = 0;
    this.state.sessionDischargePowerSum = 0;
    this.state.sessionDischargePowerSamples = 0;
    this.state.sessionDischargeKwhByBucket = { low: 0, mid: 0, high: 0 };
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

    // Same split, but by average DISCHARGE power — tests whether a peak-shaving discharge
    // (e.g. covering an oven/cooking spike at the ~800W inverter ceiling) costs more RTE than
    // a gentler discharge, independent of how the charge side of the same cycle behaved.
    const dischargeBuckets = { low: [], mid: [], high: [] };
    for (const c of cycles) {
      if (c.avgDischargePower == null) continue;
      if (c.avgDischargePower < 300)      dischargeBuckets.low.push(c.rte);
      else if (c.avgDischargePower < 600) dischargeBuckets.mid.push(c.rte);
      else                                dischargeBuckets.high.push(c.rte);
    }

    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

    const rteByPower = {
      low:  avg(buckets.low)  ? { rte: +(avg(buckets.low)  * 100).toFixed(1), n: buckets.low.length }  : null,
      mid:  avg(buckets.mid)  ? { rte: +(avg(buckets.mid)  * 100).toFixed(1), n: buckets.mid.length }  : null,
      high: avg(buckets.high) ? { rte: +(avg(buckets.high) * 100).toFixed(1), n: buckets.high.length } : null,
    };

    const rteByDischargePower = {
      low:  avg(dischargeBuckets.low)  ? { rte: +(avg(dischargeBuckets.low)  * 100).toFixed(1), n: dischargeBuckets.low.length }  : null,
      mid:  avg(dischargeBuckets.mid)  ? { rte: +(avg(dischargeBuckets.mid)  * 100).toFixed(1), n: dischargeBuckets.mid.length }  : null,
      high: avg(dischargeBuckets.high) ? { rte: +(avg(dischargeBuckets.high) * 100).toFixed(1), n: dischargeBuckets.high.length } : null,
    };

    // Composition split — groups whole cycles by how much of their charge/discharge ENERGY
    // ran at high power (>20% above 600W = "burst"), from the per-cycle energy histogram.
    // Unlike the average-power buckets above, a short 800W burst inside a gentle session is
    // NOT diluted away — this is what surfaces whether hard 800W workloads cost RTE.
    const composition = (key) => {
      const burst = [], gentle = [];
      for (const c of cycles) {
        const h = c[key];
        if (!h) continue; // legacy cycle without a histogram
        const tot = (h.low || 0) + (h.mid || 0) + (h.high || 0);
        if (tot <= 0) continue;
        ((h.high || 0) / tot > 0.2 ? burst : gentle).push(c.rte);
      }
      const pack = arr => ({ rte: arr.length ? +(avg(arr) * 100).toFixed(1) : null, n: arr.length });
      return { burst: pack(burst), gentle: pack(gentle) };
    };
    const rteByDischargeComposition = composition('dischargeKwhByBucket');
    const rteByChargeComposition = composition('chargeKwhByBucket');

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

    return { rteByPower, rteByDischargePower, rteByDischargeComposition, rteByChargeComposition, rteByMode, rteBySeason, recommendation, cycleCount: cycles.length };
  }
}

module.exports = EfficiencyEstimator;