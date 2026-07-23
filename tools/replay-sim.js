'use strict';
/**
 * Shared replay physics for the offline calibration + regret harnesses.
 *
 * simulateSlot / scoreSocDelta / physicalWh were duplicated inside replay-calibration.js
 * with a comment explaining the copy was deliberate until the replay was proven. Phase 0
 * passed (2026-07-23, MAE 21.1%, VERDICT PASS after the √RTE loss split), so the copies are
 * now extracted here and BOTH tools import them — one implementation, one meetlat. Extending
 * this to the live optimization-engine.js core is still deferred: that is the fragile
 * backward-induction path CLAUDE.md flags, and these tools don't need it.
 *
 * The round-trip loss is split evenly across charge and discharge (√RTE per side) rather than
 * loaded entirely onto the discharge draw — see calibration note in replay-calibration.js.
 *
 * Factory rather than module constants because RTE and battery config are per-run inputs
 * (the --rte negative control needs to vary RTE without touching the physics).
 */

function createSim({
  rte = 0.72,
  capacityKwh = 2.69,
  maxChargeW = 800,
  maxDischargeW = 800,
  minSoc = 0,
  maxSoc = 100,
  slotH = 0.25,
} = {}) {
  const RTE = rte;
  const ETA = Math.sqrt(RTE);
  const capWh = capacityKwh * 1000;

  /**
   * Per-slot battery power the hardware mode implies, given realized PV and load.
   * positive = charging, negative = discharging (matches measured battW / _computeDailyProfit).
   * The loss splits √RTE per side: charge stores ETA*surplus, discharge draws deficit/ETA.
   */
  function simulateSlot(hwMode, pvW, consW, socPct) {
    const surplusW = Math.max(0, pvW - consW);
    const deficitW = Math.max(0, consW - pvW);

    let physW = 0;
    switch (hwMode) {
      case 'zero_charge_only':                        // PV surplus only, never from grid
        physW = ETA * Math.min(maxChargeW, surplusW);
        break;
      case 'to_full':                                 // grid charging allowed
        physW = ETA * maxChargeW;
        break;
      case 'zero_discharge_only':                     // cover net load, never export
        physW = -Math.min(maxDischargeW, deficitW / ETA);
        break;
      case 'standby':
      default:
        physW = 0;
    }

    // Clamp against remaining headroom / stored energy (both cell-side).
    if (physW > 0) {
      physW = Math.min(physW, ((maxSoc - socPct) / 100 * capWh) / slotH);
    } else if (physW < 0) {
      physW = -Math.min(-physW, ((socPct - minSoc) / 100 * capWh) / slotH);
    }

    const deliveredW = physW >= 0 ? physW : physW * RTE;
    const nextSoc = Math.max(minSoc, Math.min(maxSoc, socPct + ((physW * slotH) / capWh) * 100));

    return { battW: Math.round(deliveredW), nextSoc };
  }

  /**
   * € accounting from a SoC delta rather than measured battW (battW lags mode by one slot).
   * Charge: energy into the pack billed at slot price. Discharge: pack loses |ΔSoC|, of which
   * RTE reaches the house. RTE lives on the € side here; the SoC physics above already split it.
   */
  function scoreSocDelta(deltaSocPct, price) {
    const wh = (deltaSocPct / 100) * capacityKwh * 1000;
    if (wh > 1)  return { revenue: 0, cost: (wh / 1000) * price };
    if (wh < -1) return { revenue: (Math.abs(wh) * RTE / 1000) * price, cost: 0 };
    return { revenue: 0, cost: 0 };
  }

  /** Physical energy moved in a slot, Wh at the cells — RTE-free calibration target. */
  function physicalWh(deltaSocPct) {
    return (deltaSocPct / 100) * capacityKwh * 1000;
  }

  return { simulateSlot, scoreSocDelta, physicalWh, RTE, ETA, capacityKwh, maxChargeW, maxDischargeW };
}

module.exports = { createSim };
