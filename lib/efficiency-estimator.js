'use strict';

class EfficiencyEstimator {
  constructor(homey) {
    this.homey = homey;

    this.state = this.homey.settings.get('efficiency_state') || {
      totalChargeKwh: 0,
      totalDischargeKwh: 0,
      efficiency: 0.78,  // Default 78% RTE (conservative start, learning engine corrects this)
      lastTimestamp: null,
      lastSoc: null,
      // Per-cycle metadata for insight analysis
      chargePowerSum: 0,
      chargePowerSamples: 0,
      dischargePowerSum: 0,
      dischargePowerSamples: 0,
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

    const grid = p1.gridPower ?? 0;
    const power = battery.battery_power ?? 0;
    const soc = battery.stateOfCharge ?? null;

    if (Math.abs(power) <= 100) return; // filter inverter standby draw (~50-80W) that doesn't charge cells

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
    if (power > 100) {
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
      this.state.chargePowerSum = (this.state.chargePowerSum || 0) + power;
      this.state.chargePowerSamples = (this.state.chargePowerSamples || 0) + 1;
      // Track dominant charge mode (by energy weight: more Wh in a mode = more votes)
      if (activeMode) {
        this.state.chargeModeVotes = this.state.chargeModeVotes || {};
        this.state.chargeModeVotes[activeMode] = (this.state.chargeModeVotes[activeMode] || 0) + (chargeKw * dtHours);
      }
      accumulated = true;
    }

    if (power < -100) {
      const dischargeKw = Math.abs(power) / 1000;
      this.state.totalDischargeKwh += dischargeKw * dtHours;
      this.state.dischargePowerSum = (this.state.dischargePowerSum || 0) + Math.abs(power);
      this.state.dischargePowerSamples = (this.state.dischargePowerSamples || 0) + 1;
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

      if (newEff >= 0.70 && newEff <= 0.97) {
        // Valid RTE for LFP battery (AC-AC typically 85-95%, allow 70-97% window)
        this.state.efficiency = (oldEff * 0.95) + (newEff * 0.05);

        const avgChargePower = this.state.chargePowerSamples > 0
          ? Math.round(this.state.chargePowerSum / this.state.chargePowerSamples) : 0;
        const avgDischargePower = this.state.dischargePowerSamples > 0
          ? Math.round(this.state.dischargePowerSum / this.state.dischargePowerSamples) : 0;

        // Dominant charge mode = mode with most kWh during this cycle
        const votes = this.state.chargeModeVotes || {};
        const dominantMode = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || null;

        const chargedWh = (this.state.totalChargeKwh * 1000).toFixed(0);
        const dischargedWh = (this.state.totalDischargeKwh * 1000).toFixed(0);
        this.homey.log(
          `[Efficiency] ✅ Learning cycle complete: ` +
          `charged=${chargedWh}Wh @ avg ${avgChargePower}W, ` +
          `discharged=${dischargedWh}Wh @ avg ${avgDischargePower}W, ` +
          `measured=${(newEff * 100).toFixed(1)}%, ` +
          `learned RTE: ${(oldEff * 100).toFixed(1)}% → ${(this.state.efficiency * 100).toFixed(1)}%`
        );

        // Store cycle for insight analysis
        this.state.cycles = this.state.cycles || [];
        this.state.cycles.push({
          rte: newEff,
          avgChargePower,
          avgDischargePower,
          chargedWh: Math.round(this.state.totalChargeKwh * 1000),
          mode: dominantMode,
          month: new Date().getMonth() + 1,
          ts: Date.now()
        });
        if (this.state.cycles.length > 60) {
          this.state.cycles = this.state.cycles.slice(-60);
        }

        // Log insights directly after each cycle (once enough data)
        const insights = this.getEfficiencyInsights();
        if (insights) {
          const m = insights.rteByMode;
          this.homey.log(
            `[Efficiency] 📊 Modus-vergelijking: ` +
            Object.entries(m).map(([k, v]) => `${k}=${v.rte}% (${v.n}x)`).join(', ')
          );
          this.homey.log(`[Efficiency] 💡 ${insights.recommendation}`);
        }

        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
        this.state.chargePowerSum = 0;
        this.state.chargePowerSamples = 0;
        this.state.dischargePowerSum = 0;
        this.state.dischargePowerSamples = 0;
        this.state.chargeModeVotes = {};

      } else if (newEff > 0.97) {
        // Unrealistically high for LFP (>97% AC-AC is physically impossible) — discard
        this.homey.log(
          `[Efficiency] ⚠️ RTE measurement ${(newEff * 100).toFixed(1)}% too high (>97% impossible for AC-AC) → ` +
          `discarding cycle (charged=${(this.state.totalChargeKwh * 1000).toFixed(0)}Wh, ` +
          `discharged=${(this.state.totalDischargeKwh * 1000).toFixed(0)}Wh)`
        );
        this.state.totalChargeKwh = 0;
        this.state.totalDischargeKwh = 0;
      } else if (newEff < 0.70 && this.state.totalChargeKwh > 2.0) {
        // Implausibly low for LFP (<70% AC-AC) — likely partial cycle or cross-cycle contamination, discard
        this.homey.log(
          `[Efficiency] ⚠️ RTE measurement ${(newEff * 100).toFixed(1)}% implausibly low for LFP after ${(this.state.totalChargeKwh * 1000).toFixed(0)}Wh → discarding`
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
      // else: still accumulating (ratio not yet in valid range)

      this.save();
    }
  }

  getEfficiency() {
    return this.state.efficiency ?? 0.78;
  }

  // ✅ Reset to configured value
  reset(configuredEff = 0.78) {
    this.homey.log(
      `[Efficiency] Manual reset: ${(this.state.efficiency * 100).toFixed(1)}% → ${(configuredEff * 100).toFixed(0)}%`
    );
    this.state.totalChargeKwh = 0;
    this.state.totalDischargeKwh = 0;
    this.state.efficiency = configuredEff;
    this.save();
  }
  /**
   * Analyse of lager laadvermogen betere RTE geeft.
   * Geeft inzicht per vermogensbucket en seizoen.
   */
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