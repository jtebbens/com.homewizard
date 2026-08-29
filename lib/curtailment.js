'use strict';

const { exportValue } = require('./price-formulas');

/**
 * hwModes in which the battery can still absorb PV. Charging beats curtailing
 * on every slot — throttling throws the kWh away, the battery keeps it — so the
 * target has to leave room for the charge the DP still wants.
 * (device.js:2766 keeps its own copy of this list for the cycle-cost ledger.)
 */
const CHARGING_HW_MODES = ['to_full', 'zero_charge_only', 'pv_trickle'];

/**
 * House load from the energy balance: everything produced or imported that the
 * battery did not take. Signs follow the P1 convention — grid + = import,
 * battery + = charging. Unclamped on purpose: device.js polls this to feed the
 * learned consumption EMA and rejects negative readings as sensor lag, which a
 * clamp here would silently turn into a valid 0W sample.
 */
function houseLoadW(pvW, gridPowerW, battPowerW) {
  return pvW + gridPowerW - battPowerW;
}

/**
 * Is this a slot where the inverter should be switched off entirely?
 *
 * Below zero the grid pays per kWh drawn, so every kWh of own PV that serves the
 * house or the battery costs the user that payment. Maximum import — and thus no
 * PV at all — beats zero on the meter. The optimum jumps from house+charge to 0
 * the moment the import price crosses zero; there is nothing in between, so no
 * deadband either (prices are per slot, and device.js already has a 25W chatter
 * gate on the trigger).
 *
 * Reads the IMPORT price on purpose. Export value decides *whether* exporting
 * hurts (the zero-on-the-meter case); the import price decides whether producing
 * at all hurts. Under saldering exportValue() returns the import price, so a
 * negative import price is negative on both sides — this case is tariff-model
 * independent, unlike the zero-on-the-meter one.
 *
 * Deliberately NOT gated on pv_curtailment_enabled: callers that act on it add
 * that check themselves (the DP's `curtailmentAvailable`, shouldCurtail below),
 * while the shadow targetW keeps showing the honest answer with the setting off.
 *
 * @param {?{price: ?number}} priceSlot
 * @returns {boolean}
 */
function fullCurtailSlot(priceSlot) {
  return typeof priceSlot?.price === 'number' && priceSlot.price < 0;
}

/**
 * How far PV may be throttled this slot, in watts, and whether throttling pays.
 *
 * Post-saldering an exported kWh can be worth less than nothing. Curtailing is
 * the last resort for the surplus the battery can no longer take, so the target
 * is measured house load + charge demand — never lower, or the user's flow would
 * throttle into their own consumption and import the difference.
 *
 * House load comes from the energy balance rather than from
 * PolicyEngine.currentLoad: that one is Math.max(0, grid + discharge), which
 * reads 0 whenever PV is exporting — exactly the slots this decides.
 * `avg_consumption_w` is no substitute either; it is a learned prediction, not a
 * P1 reading (project_avg_consumption_w_is_prediction_not_measurement).
 *
 * @param {object}  o
 * @param {?number} o.pvW              live PV production (W)
 * @param {?number} o.gridPowerW       live meter power (W, + = import, − = export)
 * @param {?number} o.battPowerW       live battery power (W, + = charging, − = discharging)
 * @param {?string} o.hwMode           hardware mode chosen for this slot
 * @param {number}  o.maxChargePowerW  nominal charge ceiling (the app never commands a wattage)
 * @param {?number} o.price            current slot import price (€/kWh)
 * @param {?number} o.exportPrice      current slot export price (€/kWh)
 * @param {string}  o.tariffModel      'saldering' | 'asymmetric_2027'
 * @param {number}  [o.exportPriceRatio] legacy scalar fallback
 * @param {boolean} [o.canCurtail]     `pv_curtailment_enabled` setting — the user has
 *   confirmed a flow exists to act on the trigger. Gates shouldCurtail only; targetW
 *   is still returned so the capability keeps showing the shadow value for diagnosis.
 * @returns {{targetW: ?number, shouldCurtail: boolean, houseLoadW: ?number, exportValue: ?number}}
 */
function computeCurtailmentTarget({
  pvW, gridPowerW, battPowerW, hwMode, maxChargePowerW,
  price, exportPrice, tariffModel, exportPriceRatio = 1.0, canCurtail = false,
}) {
  const _ev = price == null
    ? null
    : exportValue({ price, exportPrice }, tariffModel, exportPriceRatio);

  // Negative import price: 0W, and house load and charge room drop out of the
  // formula entirely — so this answer needs no live reading and is checked before
  // the guard below. A dropped sensor must not restore full production during the
  // one slot where producing costs money.
  if (fullCurtailSlot({ price })) {
    return {
      targetW: 0, shouldCurtail: canCurtail, houseLoadW: null,
      exportValue: _ev, fullCurtail: true, importPrice: price,
    };
  }

  // A missing reading must not collapse into a 0W target — the user's flow would
  // read that as "throttle to nothing".
  if (pvW == null || gridPowerW == null || battPowerW == null) {
    return { targetW: null, shouldCurtail: false, houseLoadW: null, exportValue: _ev, fullCurtail: false };
  }

  const _houseW = Math.max(0, Math.round(houseLoadW(pvW, gridPowerW, battPowerW)));
  const chargeRoomW = CHARGING_HW_MODES.includes(hwMode) ? Math.max(0, maxChargePowerW ?? 0) : 0;

  return {
    targetW: _houseW + chargeRoomW,
    shouldCurtail: canCurtail && _ev != null && _ev < 0,
    houseLoadW: _houseW,
    exportValue: _ev,
    fullCurtail: false,
  };
}

module.exports = { computeCurtailmentTarget, houseLoadW, fullCurtailSlot, CHARGING_HW_MODES };
