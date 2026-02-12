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
  // Replaces Harmonie (Buienradar/KNMI JSON does not exist)
  // -------------------------------------------------------
  async fetchHarmonie(lat, lon) {
    const url =
      `https://api.open-meteo.com/v1/dwd-icon?latitude=${lat}&longitude=${lon}` +
      `&hourly=sunshine_duration,shortwave_radiation`;

    return this._safeFetch(url, "ICON-D2");
  }

  // -------------------------------------------------------
  // SAFE FETCH WRAPPER
  // Handles:
  // - non-JSON responses
  // - network errors
  // - missing sunshine_duration
  // -------------------------------------------------------
  async _safeFetch(url, label) {
    try {
      const res = await fetch(url);
      const text = await res.text();

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return {
          error: true,
          reason: `${label} returned non-JSON`,
          raw: text
        };
      }

      if (!data.hourly || !Array.isArray(data.hourly.sunshine_duration)) {
        return {
          error: true,
          reason: `${label} missing sunshine_duration`,
          raw: data
        };
      }

      return data;

    } catch (err) {
      return { error: true, reason: err.message };
    }
  }

  // -------------------------------------------------------
  // SUN SCORE (0–100)
  // Based on sunshine duration in next 4 hours
  // -------------------------------------------------------
  calculateSunScore(sunshineArray, hourlyTimes) {
    if (!sunshineArray || !hourlyTimes) return 0;

    const now = new Date();

    // Bepaal het eerstvolgende volledige uur in UTC
    const nextHour = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours() + 1, // volgende uur
      0, 0, 0
    ));

    // Zoek exact dat uur in de forecast
    const idx = hourlyTimes.findIndex(t => {
      const ts = new Date(t);
      return (
        ts.getUTCFullYear() === nextHour.getUTCFullYear() &&
        ts.getUTCMonth() === nextHour.getUTCMonth() &&
        ts.getUTCDate() === nextHour.getUTCDate() &&
        ts.getUTCHours() === nextHour.getUTCHours()
      );

    });

    // Fallback: als het uur niet bestaat, pak het dichtstbijzijnde
    const start = idx !== -1 ? idx : 0;

    const next4h = sunshineArray.slice(start, start + 4);
    const minutes = next4h.reduce((a, b) => a + (b || 0), 0);

    return Math.min(100, Math.round((minutes / 240) * 100));
  }



  // -------------------------------------------------------
  // COMPARE SCORES
  // Returns:
  // - consistent: true/false
  // - diff: absolute difference
  // -------------------------------------------------------
  compareScores(gfs, harmonie) {
    const diff = Math.abs(gfs - harmonie);

    return {
      consistent: diff < 10,
      diff
    };
  }
}

module.exports = SunMultiSource;
