'use strict';

// Weather-type buckets for the clearness index kt.
//
// Its own module on purpose: both `learning-engine.js` and `weather-forecaster.js` need it, and
// learning-engine already requires weather-forecaster for ENSEMBLE_MODELS — putting the
// classifier on either of them closes a require cycle and silently empties that import.
// This file must therefore stay dependency-free.
//
// The thresholds were the real duplication: they sat inline at three call sites (the daily-bias
// getter, the EMA write path, and _groundClear in the battery-policy device), so any change to
// the kt scale moved two gates nobody was looking at.

const KT_CLEAR_MIN = 0.65;
const KT_OVERCAST_MAX = 0.30;

/**
 * @param {number|null} kt - clearness index (measured GHI / clear-sky GHI)
 * @returns {'clear'|'mixed'|'overcast'|null} null when there is no kt to classify
 */
function classifyKt(kt) {
  if (kt == null || !Number.isFinite(kt)) return null;
  if (kt >= KT_CLEAR_MIN) return 'clear';
  if (kt < KT_OVERCAST_MAX) return 'overcast';
  return 'mixed';
}

module.exports = { classifyKt, KT_CLEAR_MIN, KT_OVERCAST_MAX };
