'use strict';

const fetch = require('node-fetch');

class SunMultiSource {
  constructor(homey) {
    this.homey = homey;
  }

  // -------------------------------------------------------
  // GFS (Open-Meteo)
  // -------------------------------------------------------
  async fetchGFS(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=sunshine_duration,shortwave_radiation`;

    return this._safeFetch(url, "GFS");
  }

  // -------------------------------------------------------
  // ICON-D2 (DWD high-resolution model)
  // -------------------------------------------------------
  async fetchHarmonie(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/dwd-icon?latitude=${lat}&longitude=${lon}` +
      `&hourly=sunshine_duration,shortwave_radiation`;

    return this._safeFetch(url, "ICON-D2");
  }

  // -------------------------------------------------------
  // SAFE FETCH WRAPPER
  // -------------------------------------------------------
  async _safeFetch(url, label) {
    try {
      const res = await fetch(url);
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return { error: true, reason: `${label} returned non-JSON`, raw: text };
      }

      if (!data.hourly || !Array.isArray(data.hourly.sunshine_duration)) {
        return { error: true, reason: `${label} missing sunshine_duration`, raw: data };
      }

      return data;

    } catch (err) {
      return { error: true, reason: err.message };
    }
  }

  // -------------------------------------------------------
  // SUN SCORE (0–100)
  // Based on sunshine duration in next 4 hours.
  //
  // Open-Meteo returns sunshine_duration in SECONDS per hour (0–3600).
  // Max possible over 4 hours = 4 × 3600 = 14400 seconds.
  // Score = total sunshine seconds / 14400 × 100
  //
  // Previously used 240 as baseline (minutes), causing scores to be
  // inflated by 60× — any minimal sunshine would score 100.
  // -------------------------------------------------------
  calculateSunScore(sunshineArray, hourlyTimes) {
    if (!sunshineArray || !hourlyTimes) return 0;

    const now = new Date();

    // Next full UTC hour
    const nextHour = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1,
      0, 0, 0
    ));

    // Find that hour in the forecast array
    const idx = hourlyTimes.findIndex(t => {
      const ts = new Date(t);
      return (
        ts.getUTCFullYear() === nextHour.getUTCFullYear() &&
        ts.getUTCMonth()    === nextHour.getUTCMonth()    &&
        ts.getUTCDate()     === nextHour.getUTCDate()     &&
        ts.getUTCHours()    === nextHour.getUTCHours()
      );
    });

    const start = idx !== -1 ? idx : 0;

    // Sum sunshine_duration (seconds) over next 4 hours
    const next4h        = sunshineArray.slice(start, start + 4);
    const totalSeconds  = next4h.reduce((a, b) => a + (b || 0), 0);

    // Max = 4 hours × 3600 seconds = 14400 seconds
    const MAX_SECONDS   = 4 * 3600;
    const score         = Math.min(100, Math.round((totalSeconds / MAX_SECONDS) * 100));

    return score;
  }

  // -------------------------------------------------------
  // COMPARE SCORES
  // -------------------------------------------------------
  compareScores(gfs, harmonie) {
    const diff = Math.abs(gfs - harmonie);
    return { consistent: diff < 10, diff };
  }
}

module.exports = SunMultiSource;