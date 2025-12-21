'use strict';

/**
 * BaseloadMonitor
 *
 * Purpose:
 * - Collect P1 power samples during a defined night window
 * - Detect invalid nights (EV charging, battery activity, PV startup, oscillation, etc.)
 * - Compute a stable household baseload using only valid nights
 * - Maintain a rolling history
 * - Persist state in Homey settings
 *
 * Design:
 * - No hardware assumptions
 * - Pattern-based detection only
 * - Driver-agnostic
 * - Restart-safe and deletion-safe
 */

class BaseloadMonitor {

  constructor(homey) {
    this.homey = homey;

    //
    // Configuration
    //
    this.nightStartHour = 1;
    this.nightEndHour = 5;
    this.maxNights = 30;
    this.sampleIntervalMs = 10000;

    //
    // Detection thresholds
    //
    this.highPlateauThreshold = 500;
    this.highPlateauMinDuration = 10 * 60 * 1000;

    this.negativeMinDuration = 5 * 60 * 1000;
    this.nearZeroMargin = 50;
    this.nearZeroMinDuration = 20 * 60 * 1000;

    this.oscillationWindow = 5 * 60 * 1000;
    this.oscillationAmplitude = 300;

    this.pvStartupEarliest = 4;
    this.pvStartupLatest = 6;

    //
    // Runtime state
    //
    this.devices = new Set();
    this.master = null;
    this.enabled = false;

    this.currentNightSamples = [];
    this.nightInvalid = false;

    this.flags = {
      sawHighPlateau: false,
      sawNegativeLong: false,
      sawNearZeroLong: false,
      sawOscillation: false,
      sawPVStartup: false,
    };

    this.nightHistory = [];
    this.currentBaseload = null;

    this._nightTimer = null;
    this._nightEndTimer = null;

    // Per-device notification preferences
    this.deviceNotificationPrefs = new Map();

    // Load persisted state
    this._loadState();
  }

  _logTime(prefix) {
  const now = new Date();

  // UTC
  const utc = now.toISOString();

  // Local time (Homey timezone)
  const tz = this.homey.clock.getTimezone();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));

  this.homey.log(
    `${prefix} | Local: ${local.toISOString()} | UTC: ${utc} | TZ: ${tz}`
  );
}


  //
  // Device registration
  //

  registerP1Device(device) {
    this.devices.add(device);

    if (!this.enabled) {
      this.start();
    }
  }

  unregisterP1Device(device) {
    this.devices.delete(device);

    if (this.master === device) {
      this.master = null;
    }

    if (this.devices.size === 0) {
      this.stop();
    }
  }

  trySetMaster(device) {
    if (!this.master) {
      this.master = device;
    }
  }

  updatePowerFromDevice(device, power) {
    if (device !== this.master) return;
    this.updatePower(power);
  }

  //
  // Start/stop lifecycle
  //

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._scheduleNightWindow();
  }

  stop() {
    this.enabled = false;
    this._clearNightTimers();
    this._resetNightState();
  }

  //
  // Power ingestion
  //

  updatePower(power) {
    if (!this.enabled) return;
    if (typeof power !== 'number' || Number.isNaN(power)) return;

    const now = new Date();
    if (!this._isInNightWindow(now)) return;

    this._processNightSample(now, power);
  }

  //
  // Night scheduling
  //

  _scheduleNightWindow() {
    this._clearNightTimers();

    const now = new Date();
    const nextStart = new Date(now);
    nextStart.setHours(this.nightStartHour, 0, 0, 0);

    if (nextStart <= now) {
      nextStart.setDate(nextStart.getDate() + 1);
    }

    const ms = nextStart - now;

    this._nightTimer = this.homey.setTimeout(() => {
      this._onNightStart();
    }, ms);
  }

  _clearNightTimers() {
    if (this._nightTimer) {
      this.homey.clearTimeout(this._nightTimer);
      this._nightTimer = null;
    }
    if (this._nightEndTimer) {
      this.homey.clearTimeout(this._nightEndTimer);
      this._nightEndTimer = null;
    }
  }

  _onNightStart() {
    // this._logTime('NightStart');

    if (!this.enabled) {
      this._scheduleNightWindow();
      return;
    }

    this._resetNightState();

    const durationMs = (this.nightEndHour - this.nightStartHour) * 60 * 60 * 1000;

    this._nightEndTimer = this.homey.setTimeout(() => {
      this._onNightEnd();
    }, durationMs);
  }

  _onNightEnd() {
    // this._logTime('NightEnd');
    
    this.homey.clearTimeout(this._nightEndTimer);
    this._nightEndTimer = null;

    if (!this.enabled) {
      this._scheduleNightWindow();
      return;
    }

    this._finalizeNight();
    this._scheduleNightWindow();
  }

  //
  // Night state
  //

  _resetNightState() {
    this.currentNightSamples = [];
    this.nightInvalid = false;

    this.flags = {
      sawHighPlateau: false,
      sawNegativeLong: false,
      sawNearZeroLong: false,
      sawOscillation: false,
      sawPVStartup: false,
    };
  }

  _isInNightWindow(date) {
    const h = date.getHours();
    return h >= this.nightStartHour && h < this.nightEndHour;
  }

  _processNightSample(ts, power) {
    this.currentNightSamples.push({ ts, power });

    this._detectHighPlateau();
    this._detectNegativeLong();
    this._detectNearZeroLong();
    this._detectOscillation();
    this._detectPVStartup();
  }

  //
  // Invalid-night detectors
  //

  _detectHighPlateau() {
    if (this.currentNightSamples.length < 2) return;

    const avg = this._average(this.currentNightSamples.map(s => s.power));
    const baseline = this.currentBaseload || 100;

    if (avg > baseline + this.highPlateauThreshold) {
      const duration = this._durationAboveThreshold(baseline + this.highPlateauThreshold);
      if (duration >= this.highPlateauMinDuration) {
        this.flags.sawHighPlateau = true;
        this.nightInvalid = true;
      }
    }
  }

  _detectNegativeLong() {
    const duration = this._durationBelowThreshold(0);
    if (duration >= this.negativeMinDuration) {
      this.flags.sawNegativeLong = true;
      this.nightInvalid = true;
    }
  }

  _detectNearZeroLong() {
    const duration = this._durationAbsBelow(this.nearZeroMargin);
    if (duration >= this.nearZeroMinDuration) {
      this.flags.sawNearZeroLong = true;
      this.nightInvalid = true;
    }
  }

  _detectOscillation() {
    const windowSamples = this._samplesInLast(this.oscillationWindow);
    if (windowSamples.length < 4) return;

    const powers = windowSamples.map(s => s.power);
    const max = Math.max(...powers);
    const min = Math.min(...powers);

    if (max - min < this.oscillationAmplitude) {
      this.flags.sawOscillation = true;
      this.nightInvalid = true;
    }
  }

  _detectPVStartup() {
    const last = this.currentNightSamples[this.currentNightSamples.length - 1];
    if (!last) return;

    const h = new Date().getHours();
    if (h < this.pvStartupEarliest || h > this.pvStartupLatest) return;

    if (last.power < 0) {
      this.flags.sawPVStartup = true;
      this.nightInvalid = true;
    }
  }

  _computeFallbackBaseload() {
  const recentSamples = [];

  for (const night of this.nightHistory.slice(-7)) {
    if (Array.isArray(night.samples)) {
      recentSamples.push(...night.samples);
    }
  }

  const powers = recentSamples
    .map(s => s.power)
    .filter(p => typeof p === 'number');

  if (!powers.length) return null;

  const sorted = powers.slice().sort((a, b) => a - b);
  const takeCount = Math.max(3, Math.floor(sorted.length * 0.1));
  const take = sorted.slice(0, takeCount);

  return this._average(take);
}


  //
  // Night finalization
  //

  _finalizeNight() {
    const dateKey = new Date().toISOString().slice(0, 10);

      // No samples
      if (this.currentNightSamples.length === 0) {
        this._pushHistory(dateKey, null, true);
        this._notify('night_no_samples');
        return;
      }

      //
      // Reason label mapping (NL + EN)
      //
      const reasonLabels = {
        sawHighPlateau: {
          nl: 'hoog verbruik gedurende langere tijd',
          en: 'sustained high consumption'
        },
        sawNegativeLong: {
          nl: 'negatief vermogen (accu ontlading)',
          en: 'negative power (battery discharge)'
        },
        sawNearZeroLong: {
          nl: 'balanceren rond 0 watt (accu of load balancer)',
          en: 'near-zero balancing (battery or load balancer)'
        },
        sawOscillation: {
          nl: 'sterke fluctuaties in verbruik',
          en: 'strong consumption oscillation'
        },
        sawPVStartup: {
          nl: 'zonsopkomst / PV opstart',
          en: 'PV startup (sunrise)'
        }
      };

      const lang = this._getLang();

      // Invalid night
      if (this.nightInvalid) {
        const reasons = Object.entries(this.flags)
          .filter(([k, v]) => v)
          .map(([k]) => reasonLabels[k]?.[lang] || reasonLabels[k]?.en || k)
          .join(', ') || (lang === 'nl' ? 'onbekend' : 'unknown');

        this._notify('night_invalid', { reasons });
        this._pushHistory(dateKey, null, true);

        //
        // ✅ Fallback check bij ongeldige nacht
        //
        const recentValid = this.nightHistory
          .slice(-7)
          .filter(n => !n.invalid && typeof n.avg === 'number');

        if (recentValid.length === 0) {
          const fallback = this._computeFallbackBaseload();
          if (fallback !== null) {
            this.currentBaseload = fallback;
            this._saveState();
            this._notify('baseload_fallback', {
              fallback: fallback.toFixed(0)
            });
          }
        }

        return;
      }

      //
      // ✅ Fallback check bij geldige nacht (ongewijzigd)
      //
      const recentValid = this.nightHistory
        .slice(-7)
        .filter(n => !n.invalid && typeof n.avg === 'number');

      if (recentValid.length === 0) {
        const fallback = this._computeFallbackBaseload();
        if (fallback !== null) {
          this.currentBaseload = fallback;
          this._saveState();
          this._notify('baseload_fallback', {
            fallback: fallback.toFixed(0)
          });
        }
      }

      // Valid night
      const avg = this._average(this.currentNightSamples.map(s => s.power));
      this._pushHistory(dateKey, avg, false);

      const oldBaseload = this.currentBaseload;

      this.currentBaseload = this._computeBaseloadFromHistory();
      this._saveState();

      // Significant change
      if (oldBaseload && this.currentBaseload) {
        const diff = Math.abs(this.currentBaseload - oldBaseload);
        const pct = (diff / oldBaseload) * 100;

        if (diff > 50 && pct > 20) {
          this._notify('baseload_changed', {
            current: this.currentBaseload.toFixed(0),
            previous: oldBaseload.toFixed(0)
          });
        }
      }

  }

  //
  // Language helper
  //

  _getLang() {
    try {
      const lang = this.homey.i18n.getLanguage();
      return lang && lang.toLowerCase().startsWith('nl') ? 'nl' : 'en';
    } catch {
      return 'en';
    }
  }

  //
  // History
  //

  _pushHistory(date, avg, invalid) {
    this.nightHistory.push({
      date,
      avg,
      invalid,
      samples: this.currentNightSamples.slice()
    });
    if (this.nightHistory.length > this.maxNights) {
      this.nightHistory.splice(0, this.nightHistory.length - this.maxNights);
    }
  }


  //
  // Baseload computation
  //

  _computeBaseloadFromHistory() {
    const valid = this.nightHistory
      .filter(n => !n.invalid && typeof n.avg === 'number')
      .map(n => n.avg);

    if (!valid.length) {
      this._notify('baseload_unavailable');
      return this.currentBaseload || null;
    }

    const sorted = valid.slice().sort((a, b) => a - b);
    const take = sorted.slice(0, Math.min(3, sorted.length));

    return this._average(take);
  }

  //
  // Helpers
  //

  _average(list) {
    if (!list.length) return null;
    return list.reduce((a, b) => a + b, 0) / list.length;
  }

  _durationAboveThreshold(threshold) {
    let ms = 0;
    for (let i = 1; i < this.currentNightSamples.length; i++) {
      const prev = this.currentNightSamples[i - 1];
      const cur = this.currentNightSamples[i];
      if (prev.power > threshold && cur.power > threshold) {
        ms += cur.ts - prev.ts;
      }
    }
    return ms;
  }

  _durationBelowThreshold(threshold) {
    let ms = 0;
    for (let i = 1; i < this.currentNightSamples.length; i++) {
      const prev = this.currentNightSamples[i - 1];
      const cur = this.currentNightSamples[i];
      if (prev.power < threshold && cur.power < threshold) {
        ms += cur.ts - prev.ts;
      }
    }
    return ms;
  }

  _durationAbsBelow(margin) {
    let ms = 0;
    for (let i = 1; i < this.currentNightSamples.length; i++) {
      const prev = this.currentNightSamples[i - 1];
      const cur = this.currentNightSamples[i];
      if (Math.abs(prev.power) < margin && Math.abs(cur.power) < margin) {
        ms += cur.ts - prev.ts;
      }
    }
    return ms;
  }

  _samplesInLast(msWindow) {
    if (!this.currentNightSamples.length) return [];
    const lastTs = this.currentNightSamples[this.currentNightSamples.length - 1].ts;
    return this.currentNightSamples.filter(s => lastTs - s.ts <= msWindow);
  }

  //
  // Persistence
  //

  _saveState() {
    this.homey.settings.set('baseload_state', {
      nightHistory: this.nightHistory,
      currentBaseload: this.currentBaseload,
      deviceNotificationPrefs: Array.from(this.deviceNotificationPrefs.entries())
    });
  }

  _loadState() {
    const state = this.homey.settings.get('baseload_state');
    if (!state) return;

    if (Array.isArray(state.nightHistory)) {
      this.nightHistory = state.nightHistory;
    }

    if (typeof state.currentBaseload === 'number') {
      this.currentBaseload = state.currentBaseload;
    }

    if (Array.isArray(state.deviceNotificationPrefs)) {
      this.deviceNotificationPrefs = new Map(state.deviceNotificationPrefs);
    }
  }

  //
  // Notification preference setter
  //

  setNotificationsEnabledForDevice(device, enabled) {
    this.deviceNotificationPrefs.set(device.getId(), enabled);
    this._saveState();
  }

  //
  // Notifications
  //

  async _notify(key, vars = {}) {
    if (!this.master) return;

    const enabled = this.deviceNotificationPrefs.get(this.master.getId());
    if (!enabled) return;

    const lang = this._getLang();

    const messages = {
      night_invalid: {
        nl: `Sluipverbruik-nacht ongeldig: ${vars.reasons || 'onbekend'}`,
        en: `Baseload night invalid: ${vars.reasons || 'unknown'}`
      },
      night_no_samples: {
        nl: 'Sluipverbruik-nacht ongeldig: geen samples ontvangen',
        en: 'Baseload night invalid: no samples collected'
      },
      baseload_changed: {
        nl: `Sluipverbruik gewijzigd: ${vars.current} W (was ${vars.previous} W)`,
        en: `New baseload: ${vars.current} W (was ${vars.previous} W)`
      },
      baseload_unavailable: {
        nl: 'Sluipverbruik niet beschikbaar: geen geldige nachten in de afgelopen dagen',
        en: 'Baseload unavailable: no valid nights in recent days'
      },
      baseload_fallback: {
        nl: `Sluipverbruik (fallback): ${vars.fallback} W`,
        en: `Fallback baseload: ${vars.fallback} W`
      }

    };

    const msg = messages[key]?.[lang];
    if (!msg) return;

    try {
      await this.homey.notifications.createNotification({ excerpt: msg });
    } catch (err) {
      this.homey.error('Notification failed:', err);
    }
  }
}

module.exports = BaseloadMonitor;
