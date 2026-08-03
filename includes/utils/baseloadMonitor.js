/*
 * HomeWizard Baseload Monitor (Sluipverbruik)
 * Copyright (C) 2025 Jeroen Tebbens
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

// Cached formatter: constructing Intl.DateTimeFormat per call is a known CPU hotspot
// elsewhere in this project. On Homey, Date.getHours()/setHours() resolve in UTC, not
// Amsterdam local (see lib/learning-engine.js:390-392) — always go through this.
const _amsterdamFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

class BaseloadMonitor {
  constructor(homey) {
    this.homey = homey;

    this.nightStartHour = 1;
    this.nightEndHour = 5;
    this.maxNights = 30;
    // Fraction of the night window a stored night's samples must span to count. See
    // _hasWindowCoverage(). Measured separation is wide: good nights span 173-240 min,
    // the two truncated ones 27 and 32 min.
    this.minWindowCoverage = 0.5;

    // Per-night samples live on disk, not in the settings blob: they are 99% of this
    // state's 260 kB, and every settings.set() re-serializes all 111 keys (~1338 kB).
    // Overridden in tests.
    this.stateDir = '/userdata';

    // Original thresholds - these work well for most households
    // The key insight: fridge cycles (50-300W, 30-120min) are normal and not tracked as invalid
    this.highPlateauThreshold = 800;
    this.highPlateauMinDuration = 900000;
    this.negativeMinDuration = 300000;
    this.nearZeroMargin = 80;
    this.nearZeroMinDuration = 600000;
    this.oscillationWindow = 300000;
    this.oscillationAmplitude = 500;
    this.pvStartupEarliest = 5;
    this.pvStartupLatest = 8;

    this.fridgeMinPower = 50;
    this.fridgeMaxPower = 300;
    this.fridgeMinDuration = 1800000;
    this.fridgeMaxDuration = 7200000;

    this.devices = new Set();
    this.master = null;
    this.enabled = false;

    this.currentNightSamples = [];
    this.nightInvalid = false;
    this.flags = {};
    this.nightHistory = [];
    this.currentBaseload = null;

    this._nightTimer = null;
    this._nightEndTimer = null;

    this.deviceNotificationPrefs = new Map();
    this.defaultNotificationsEnabled = false;
    this.invalidNightCounter = 0;

    this._loadState();
  }

  registerP1Device(device) {
    this.devices.add(device);
    if (!this.enabled) this.start();
  }

  unregisterP1Device(device) {
    this.devices.delete(device);
    if (this.master === device) this.master = null;
    if (this.devices.size === 0) this.stop();
  }

  trySetMaster(device) {
    if (!this.master) this.master = device;
  }

  updatePowerFromDevice(device, power, batteryPower = null) {
    if (device === this.master) this.updatePower(power, batteryPower);
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._scheduleNightWindow();
  }

  stop() {
    this.enabled = false;
    this._clearNightTimers();
    this._resetNightState();
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
  }

  updatePower(power, batteryPower = null) {
    if (!this.enabled || typeof power !== 'number') return;
    const now = new Date();
    if (!this._isInNightWindow(now)) return;
    
    // Battery-aware: subtract battery power from grid to get true household consumption.
    // batteryPower > 0 = charging (grid includes charge current → subtract)
    // batteryPower < 0 = discharging (grid reduced by discharge → subtract negative = add back)
    // In both cases: householdPower = gridPower - batteryPower
    let householdPower = power;
    if (typeof batteryPower === 'number' && batteryPower !== 0) {
      householdPower = power - batteryPower;
    }
    // Clamp: household power can never be negative (meter rounding / timing mismatch)
    if (householdPower < 0) householdPower = 0;

    this._processNightSample(now, householdPower, power, batteryPower);
  }

  _getAmsterdamHour(date) {
    const parts = {};
    for (const p of _amsterdamFormatter.formatToParts(date)) parts[p.type] = p.value;
    return parseInt(parts.hour, 10);
  }

  _getAmsterdamOffsetMs(now) {
    const parts = {};
    for (const p of _amsterdamFormatter.formatToParts(now)) parts[p.type] = p.value;
    const y = parseInt(parts.year, 10);
    const m = parseInt(parts.month, 10) - 1;
    const d = parseInt(parts.day, 10);
    const h = parseInt(parts.hour, 10);
    const min = parseInt(parts.minute, 10);
    const s = parseInt(parts.second, 10);
    const asIfUtc = Date.UTC(y, m, d, h, min, s);
    return now.getTime() - asIfUtc;
  }

  // Next absolute UTC instant at which Amsterdam-local time reads targetHour:00.
  // DST-transition edge case (2 nights/year): offset is computed from `now`, so a
  // boundary rolled to "tomorrow" could fire up to 1h off — acceptable for this feature.
  _getNextAmsterdamHourBoundary(targetHour, now) {
    const parts = {};
    for (const p of _amsterdamFormatter.formatToParts(now)) parts[p.type] = p.value;
    const y = parseInt(parts.year, 10);
    const m = parseInt(parts.month, 10) - 1;
    const d = parseInt(parts.day, 10);
    const offsetMs = this._getAmsterdamOffsetMs(now);
    let candidateUtcMs = Date.UTC(y, m, d, targetHour, 0, 0) + offsetMs;
    if (candidateUtcMs <= now.getTime()) {
      candidateUtcMs = Date.UTC(y, m, d + 1, targetHour, 0, 0) + offsetMs;
    }
    return new Date(candidateUtcMs);
  }

  _isInNightWindow(d) {
    const h = this._getAmsterdamHour(d);
    return h >= this.nightStartHour && h < this.nightEndHour;
  }

  // A stored night only counts once its samples span at least half the night window. Sample COUNT
  // is not enough: 39 samples over 32 minutes clear the >=10 bar just as easily as 300 over 4
  // hours, and a partially measured night reads artificially low -- which is exactly what
  // _computeSmartBaseload() selects for, since it averages the three LOWEST night medians.
  // (2026-07-09: samples ran 06:27-06:59 only, 18 of them at 0 W once PV covered the house, so
  // that night's median was 0 and dragged the baseload from 211 W down to 126 W.)
  _hasWindowCoverage(samples) {
    if (!Array.isArray(samples) || samples.length < 2) return false;
    const span = Number(samples[samples.length - 1].ts) - Number(samples[0].ts);
    return span >= (this.nightEndHour - this.nightStartHour) * 3600000 * this.minWindowCoverage;
  }

  _isWithinCurrentNightWindow(now = new Date()) {
    const parts = {};
    for (const p of _amsterdamFormatter.formatToParts(now)) parts[p.type] = p.value;
    const y = parseInt(parts.year, 10);
    const m = parseInt(parts.month, 10) - 1;
    const d = parseInt(parts.day, 10);
    const offsetMs = this._getAmsterdamOffsetMs(now);
    const s = new Date(Date.UTC(y, m, d, this.nightStartHour, 0, 0) + offsetMs);
    const e = new Date(Date.UTC(y, m, d, this.nightEndHour, 0, 0) + offsetMs);
    return now >= s && now < e;
  }

  _scheduleNightWindow() {
    this._clearNightTimers();
    const now = new Date();
    if (this._isWithinCurrentNightWindow(now)) return this._onNightStartFromRecovery(now);
    const next = this._getNextAmsterdamHourBoundary(this.nightStartHour, now);
    this._nightTimer = this.homey.setTimeout(()=>this._onNightStart(), next-now);
  }

  _onNightStartFromRecovery(now) {
    if (!this.enabled) return this._scheduleNightWindow();
    this._resetNightState();
    const end = this._getNextAmsterdamHourBoundary(this.nightEndHour, now);
    this._nightEndTimer = this.homey.setTimeout(()=>this._onNightEnd(), Math.max(0, end - now));
  }

  _clearNightTimers() {
    if (this._nightTimer) this.homey.clearTimeout(this._nightTimer);
    if (this._nightEndTimer) this.homey.clearTimeout(this._nightEndTimer);
    this._nightTimer = this._nightEndTimer = null;
  }

  _onNightStart() {
    if (!this.enabled) return this._scheduleNightWindow();
    this._resetNightState();
    const dur = (this.nightEndHour - this.nightStartHour)*3600000;
    this._nightEndTimer = this.homey.setTimeout(()=>this._onNightEnd(), dur);
  }

  _onNightEnd() {
    this.homey.clearTimeout(this._nightEndTimer);
    this._nightEndTimer = null;
    if (!this.enabled) return this._scheduleNightWindow();
    this._finalizeNight();
    this._scheduleNightWindow();
  }

  _resetNightState() {
    this.currentNightSamples = [];
    this.nightInvalid = false;
    this.flags = {
      sawHighPlateau:false,
      sawNegativeLong:false,
      sawNearZeroLong:false,
      sawOscillation:false,
      sawPVStartup:false,
    };
  }

  _processNightSample(ts, power, rawGridPower = null, batteryPower = null) {
    // Throttle: store at most 1 sample per 30 seconds.
    // Duration-based detection methods work correctly at any interval;
    // 30s resolution is more than enough for 5–15 min detection windows.
    const nowMs = ts && ts.getTime ? ts.getTime() : (typeof ts === 'number' ? ts : Date.now());
    const lastSample = this.currentNightSamples.at(-1);
    const lastMs = lastSample
      ? (lastSample.ts && lastSample.ts.getTime ? lastSample.ts.getTime() : lastSample.ts)
      : -Infinity;

    if (nowMs - lastMs >= 30000) {
      this.currentNightSamples.push({ ts, power, rawGridPower, batteryPower });
    }

    if (power < 0) return; // export: don't trigger plateau/zero detection

    // Only re-run expensive detections every 30 seconds to avoid CPU overhead
    // Each update would otherwise trigger full array scans
    const lastCheck = this._lastDetectionCheck || 0;
    
    if (nowMs - lastCheck >= 30000) {
      this._lastDetectionCheck = nowMs;
      this._detectHighPlateau();
      this._detectNegativeLong();
      this._detectNearZeroLong();
      this._detectOscillation();
      this._detectPVStartup();
    }
  }


  _detectHighPlateau() {
    if (this.currentNightSamples.length<2) return;
    const avg = this._avg(this.currentNightSamples.map(s=>s.power));
    const base = this.currentBaseload||100;
    if (avg>base+this.highPlateauThreshold &&
        this._durAbove(base+this.highPlateauThreshold)>=this.highPlateauMinDuration) {
      this.flags.sawHighPlateau=true; this.nightInvalid=true;
    }
  }

  _detectNegativeLong() {
    if (this._durBelow(0)>=this.negativeMinDuration) {
      this.flags.sawNegativeLong=true; this.nightInvalid=true;
    }
  }

  _detectNearZeroLong() {
    // Near-zero detection is meant to catch grid balancing, not normal low-baseload households
    // To avoid false positives from fridge cycles in low-baseload homes:
    // Only flag if CONTINUOUS near-zero for >= nearZeroMinDuration (10 minutes).
    // Time-based logic works correctly at any sample interval.

    let maxConsecutiveMs = 0;
    let currentStreakMs = 0;
    let lastTs = null;
    let skippedBatteryKnown = 0;

    for (const s of this.currentNightSamples) {
      const ts = s.ts && s.ts.getTime ? s.ts.getTime() : s.ts;
      // If no battery data was provided and grid is near-zero, skip this sample:
      // we cannot distinguish genuine near-zero from battery compensation.
      const unknownBattery = s.batteryPower === null || s.batteryPower === undefined;
      const rawNearZero = Math.abs(s.rawGridPower ?? s.power) < this.nearZeroMargin;
      if (unknownBattery && rawNearZero) {
        // Can't distinguish battery compensation from true near-zero — skip.
        lastTs = ts;
        continue;
      }
      if (!unknownBattery) {
        // Battery power is known → householdPower is a real measurement, not grid
        // balancing noise. Even a 50W baseload looks "near-zero" against the 80W
        // margin. Don't contribute to the near-zero streak.
        skippedBatteryKnown++;
        lastTs = ts;
        continue;
      }
      if (Math.abs(s.power) < this.nearZeroMargin) {
        if (lastTs !== null) currentStreakMs += ts - lastTs;
      } else {
        maxConsecutiveMs = Math.max(maxConsecutiveMs, currentStreakMs);
        currentStreakMs = 0;
      }
      lastTs = ts;
    }
    maxConsecutiveMs = Math.max(maxConsecutiveMs, currentStreakMs);

    if (maxConsecutiveMs >= this.nearZeroMinDuration) {
      this.flags.sawNearZeroLong = true;
      this.nightInvalid = true;
    }
  }

  _detectOscillation() {
    const w = this._lastSamples(this.oscillationWindow);
    if (w.length<4) return;

    // Trim 1 outlier from each end before computing range.
    // A single bad sample (e.g. battery mode-transition measurement lag) must not
    // invalidate the night; only sustained oscillation should.
    const sorted = w.map(s => s.power).sort((a, b) => a - b);
    const lo = sorted[1];
    const hi = sorted[sorted.length - 2];

    if (hi - lo >= this.oscillationAmplitude) {
      this.flags.sawOscillation=true;
      this.nightInvalid=true;
    }
  }

  _detectPVStartup() {
    const last = this.currentNightSamples.at(-1);
    if (!last) return;
    const h = this._getAmsterdamHour(last.ts);
    // last.power is already clamped to >=0 by updatePower() before it ever reaches here —
    // rawGridPower is the unclamped field that actually carries the export (negative) signal.
    if (h>=this.pvStartupEarliest && h<=this.pvStartupLatest && last.rawGridPower<0) {
      this.flags.sawPVStartup=true; this.nightInvalid=true;
    }
  }

  _detectFridgeCycles(samples) {
    let c=0,inC=false,start=null,last=null;
    for (const s of samples) {
      const w = s.power>=this.fridgeMinPower && s.power<=this.fridgeMaxPower;
      if (!inC && w) {inC=true; start=s.ts;}
      else if (inC && !w) {
        const d=s.ts-start;
        if (d>=this.fridgeMinDuration && d<=this.fridgeMaxDuration) c++;
        inC=false; start=null;
      }
      last=s.ts;
    }
    if (inC && start && last-start>=this.fridgeMinDuration && last-start<=this.fridgeMaxDuration) c++;
    return c;
  }

  _finalizeNight() {
    const dateKey = new Date().toISOString().slice(0,10);
    const cycles = this._detectFridgeCycles(this.currentNightSamples);

    // [DEBUG] One-line night summary for diagnosing battery correction
    {
      const total = this.currentNightSamples.length;
      const withBatt = this.currentNightSamples.filter(s => s.batteryPower !== null && s.batteryPower !== undefined).length;
      const avgGrid = total ? Math.round(this.currentNightSamples.reduce((a,s)=>(a + (s.rawGridPower ?? s.power)),0) / total) : null;
      const avgHousehold = total ? Math.round(this.currentNightSamples.reduce((a,s)=>a+s.power,0) / total) : null;
      console.log(`[BaseloadMonitor] night ${dateKey}: ${total} samples, ${withBatt} with battery data, avgGrid=${avgGrid}W, avgHousehold=${avgHousehold}W, invalid=${this.nightInvalid}${this.nightInvalid ? ` (${Object.entries(this.flags).filter(([,v])=>v).map(([k])=>k).join(',')})` : ''}`);
    }

    if (this.currentNightSamples.length===0) {
      this._push(dateKey,null,true,{fridgeCycles:cycles});
      this._notify('night_no_samples');
      return;
    }

    const labels = {
      sawHighPlateau:{nl:'hoog verbruik',en:'high consumption'},
      sawNegativeLong:{nl:'negatief vermogen',en:'negative power'},
      sawNearZeroLong:{nl:'balanceren rond 0W',en:'near-zero balancing'},
      sawOscillation:{nl:'fluctuaties',en:'oscillation'},
      sawPVStartup:{nl:'PV opstart',en:'PV startup'},
    };
    const lang = this._lang();

    if (this.nightInvalid) {
      this.invalidNightCounter++;
      const reasons = Object.entries(this.flags).filter(([,v])=>v)
        .map(([k])=>labels[k][lang]).join(', ') || (lang==='nl'?'onbekend':'unknown');

      if (this.invalidNightCounter>=3) {
        this._notify('night_invalid',{reasons});
        this.invalidNightCounter=0;
      }

      this._push(dateKey,null,true,{fridgeCycles:cycles});

      const valid = this.nightHistory.slice(-7).filter(n=>!n.invalid && typeof n.avg==='number');
      if (!valid.length) {
        const fb = this._fallback();
        if (fb!==null) {
          this.currentBaseload=fb;
          this._save();
          this._notify('baseload_fallback',{fallback:fb.toFixed(0)});
        }
      }
      return;
    }

    this.invalidNightCounter=0;

    // Detect nights where battery compensation masked consumption:
    // >50% of samples have no battery data and near-zero household power.
    // These are unreliable — skip silently without triggering notifications.
    const uncorrectedNearZero = this.currentNightSamples.filter(s =>
      (s.batteryPower === null || s.batteryPower === undefined) &&
      Math.abs(s.rawGridPower ?? s.power) < this.nearZeroMargin).length;
    if (uncorrectedNearZero / this.currentNightSamples.length > 0.5) {
      this._push(dateKey, null, true, { fridgeCycles: cycles, batteryMasked: true });
      return;
    }

    const valid = this.nightHistory.slice(-7).filter(n=>!n.invalid && typeof n.avg==='number');
    if (!valid.length) {
      const fb = this._fallback();
      if (fb!==null) {
        this.currentBaseload=fb;
        this._save();
        this._notify('baseload_fallback',{fallback:fb.toFixed(0)});
      }
    }

    const avg = this._avg(this.currentNightSamples.map(s=>s.power));
    this._push(dateKey,avg,false,{fridgeCycles:cycles});

    const old = this.currentBaseload;
    this.currentBaseload = this._computeSmartBaseload();
    this._save();

    if (old && this.currentBaseload) {
      const diff = Math.abs(this.currentBaseload-old);
      const pct = diff/old*100;
      if (diff>50 && pct>20) {
        this._notify('baseload_changed',{
          current:this.currentBaseload.toFixed(0),
          previous:old.toFixed(0)
        });
      }
    }
  }

  _lang() {
    try {return this.homey.i18n.getLanguage().startsWith('nl')?'nl':'en';}
    catch{return'en';}
  }

  _downsampleSamples(samples, intervalMs = 30000) {
    if (!samples.length) return [];
    const result = [];
    let lastKeptTs = -Infinity;
    for (const s of samples) {
      const ts = s.ts && s.ts.getTime ? s.ts.getTime() : (typeof s.ts === 'number' ? s.ts : 0);
      if (ts - lastKeptTs >= intervalMs) {
        // Strip rawGridPower/batteryPower from history — only power is needed for stats
        result.push({ ts, power: s.power });
        lastKeptTs = ts;
      }
    }
    return result;
  }

  _push(date,avg,invalid,meta={}) {
    // Downsample before storing: keep 1 sample per 30s instead of 1 per second.
    // currentNightSamples stays at full resolution for real-time detection;
    // history only needs statistical resolution (halved from ~14,400 → ~480/night).
    const samples = this._downsampleSamples(this.currentNightSamples, 30000);
    this.nightHistory.push({date,avg,invalid,samples,...meta});
    if (this.nightHistory.length>this.maxNights)
      this.nightHistory.splice(0,this.nightHistory.length-this.maxNights);
  }

  _compute() {
    const v = this.nightHistory.filter(n=>!n.invalid && typeof n.avg==='number').map(n=>n.avg);
    if (!v.length) {this._notify('baseload_unavailable'); return this.currentBaseload||null;}
    
    // Simple selection sort for first 3 values instead of full sort
    const count = Math.min(3, v.length);
    const sorted = [];
    
    for (let i = 0; i < count; i++) {
      let minIdx = 0;
      for (let j = 1; j < v.length; j++) {
        if (v[j] < v[minIdx] && !sorted.includes(j)) minIdx = j;
      }
      sorted.push(v[minIdx]);
    }
    
    return this._avg(sorted);
  }

  /**
   * Smart baseload calculation that filters out EV charging and heat pump cycles
   * Strategy: 
   * 1. Get all valid nights
   * 2. For each night, filter samples to exclude obvious non-baseload (>1kW)
   * 3. Take median of lowest 50% of filtered samples per night
   * 4. Average the 3 lowest night medians
   * 
   * This is robust against:
   * - EV charging (typically 1.4-7kW)
   * - Heat pump cycles (typically 2-3kW)
   * - Brief high consumption spikes
   */
  _computeSmartBaseload() {
    const validNights = this.nightHistory.filter(n => !n.invalid && Array.isArray(n.samples) && n.samples.length > 0);
    
    if (!validNights.length) {
      this._notify('baseload_unavailable');
      return this.currentBaseload || null;
    }

    const nightMedians = [];
    
    for (const night of validNights) {
      // A night measured for only part of the window reads low; skip it before it can win a
      // spot in the three-lowest average below.
      if (!this._hasWindowCoverage(night.samples)) continue;

      // Filter out obvious non-baseload consumption (EV charging, heat pumps, etc.)
      // Keep only samples that look like true baseload (<1000W)
      const baseloadSamples = night.samples
        .map(s => s.power)
        .filter(p => typeof p === 'number' && p >= 0 && p < 1000);
      
      if (baseloadSamples.length < 10) continue; // Need at least 10 samples for reliable median
      
      // Sort to find median of lowest 50%
      baseloadSamples.sort((a, b) => a - b);
      const halfPoint = Math.floor(baseloadSamples.length / 2);
      const lowestHalf = baseloadSamples.slice(0, halfPoint);
      
      if (lowestHalf.length > 0) {
        // Median of lowest half
        const medianIdx = Math.floor(lowestHalf.length / 2);
        nightMedians.push(lowestHalf[medianIdx]);
      }
    }
    
    if (!nightMedians.length) {
      // Fallback to old method if smart filtering yields nothing
      return this._compute();
    }
    
    // Take average of 3 lowest night medians
    nightMedians.sort((a, b) => a - b);
    const count = Math.min(3, nightMedians.length);
    const lowest = nightMedians.slice(0, count);
    
    return this._avg(lowest);
  }

  _avg(a) {return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}

  _durAbove(t) {
    let ms=0;
    for (let i=1;i<this.currentNightSamples.length;i++) {
      const p=this.currentNightSamples[i-1],c=this.currentNightSamples[i];
      if (p.power>t && c.power>t) ms+=c.ts-p.ts;
    }
    return ms;
  }

  _durBelow(t) {
    let ms=0;
    for (let i=1;i<this.currentNightSamples.length;i++) {
      const p=this.currentNightSamples[i-1],c=this.currentNightSamples[i];
      if (p.power<t && c.power<t) ms+=c.ts-p.ts;
    }
    return ms;
  }

  _lastSamples(ms) {
    if (!this.currentNightSamples.length) return [];
    const last = this.currentNightSamples.at(-1).ts;
    const threshold = last - ms;
    
    // Use reverse iteration + early exit for efficiency
    const result = [];
    for (let i = this.currentNightSamples.length - 1; i >= 0; i--) {
      const s = this.currentNightSamples[i];
      if (s.ts <= threshold) break;
      result.unshift(s);
    }
    return result;
  }

  _fallback() {
    const r=[];
    // Same coverage rule as _computeSmartBaseload(): a truncated night's near-zero samples would
    // otherwise dominate the bottom-10% slice below.
    for (const n of this.nightHistory.slice(-7)) if (this._hasWindowCoverage(n.samples)) r.push(...n.samples);
    const p=[];
    for (const s of r) {
      // Filter: only non-negative values < 1000W (same logic as _computeSmartBaseload)
      if (typeof s.power === 'number' && s.power >= 0 && s.power < 1000) p.push(s.power);
    }
    if (!p.length) return null;
    
    // Partial sort for bottom 10% instead of full sort
    const take=Math.max(3,Math.floor(p.length*0.1));
    const minVals = [];
    
    for (let i = 0; i < take && i < p.length; i++) {
      let minIdx = i;
      for (let j = i + 1; j < p.length; j++) {
        if (p[j] < p[minIdx]) minIdx = j;
      }
      [p[i], p[minIdx]] = [p[minIdx], p[i]];
      minVals.push(p[i]);
    }
    
    return this._avg(minVals);
  }

  _save() {
    // Debounce 5min — homey.settings.set allocates ~30 MB V8 heap per call
    // (framework-internal). Baseload state lives in-memory anyway; only this
    // nightly/rare persistence exists for restart recovery.
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeState();
    }, 5 * 60 * 1000);
  }

  get _samplesFile() {
    return `${this.stateDir}/baseload-samples.json`;
  }

  // Samples to disk, everything else to settings. A failed file write must not cost us the
  // slim state, so the settings.set() runs either way — the samples are a display detail,
  // the nightly averages are what the baseload calculation restarts from.
  _writeState() {
    const fs = require('fs');
    const samples = {};
    for (const n of this.nightHistory) {
      if (n.date && Array.isArray(n.samples)) samples[n.date] = n.samples;
    }
    try {
      fs.writeFileSync(this._samplesFile, JSON.stringify(samples));
    } catch (e) {
      this.homey.error?.(`[Baseload] sample file write failed: ${e.message}`);
    }

    this.homey.settings.set('baseload_state',{
      nightHistory:this.nightHistory.map(({ samples: _s, ...rest }) => rest),
      currentBaseload:this.currentBaseload,
      // Published so the settings chart can apply the same coverage rule as _hasWindowCoverage()
      // instead of hard-coding the window a second time.
      nightStartHour:this.nightStartHour,
      nightEndHour:this.nightEndHour,
      minWindowCoverage:this.minWindowCoverage,
      deviceNotificationPrefs:Array.from(this.deviceNotificationPrefs.entries()),
      invalidNightCounter:this.invalidNightCounter
    });
  }

  _loadState() {
    const s=this.homey.settings.get('baseload_state');
    if (!s) return;
    if (Array.isArray(s.nightHistory)) this.nightHistory=this._restoreSamples(s.nightHistory);
    if (typeof s.currentBaseload==='number') this.currentBaseload=s.currentBaseload;
    // The stored value is derived, not a source: it is only ever recomputed at _finalizeNight().
    // Re-derive it here so a changed filter takes effect at startup instead of at the next 05:00.
    if (this.nightHistory.length) {
      const recomputed = this._computeSmartBaseload();
      if (typeof recomputed === 'number' && recomputed !== this.currentBaseload) {
        this.currentBaseload = recomputed;
        // Persist it: the settings page renders this blob, and without a write it would show the
        // superseded value until _finalizeNight() next runs at 05:00 while the DP already uses the
        // new one. Debounced by 5 min, and only reached when the value actually moved, so this
        // costs one extra settings.set() per app start at most.
        this._save();
      }
    }
    if (Array.isArray(s.deviceNotificationPrefs)) this.deviceNotificationPrefs=new Map(s.deviceNotificationPrefs);
    if (typeof s.invalidNightCounter==='number') this.invalidNightCounter=s.invalidNightCounter;
  }

  // Nights keep whatever samples the old settings blob still holds (first start after the
  // split); otherwise they come from the file. A missing or corrupt file costs the samples,
  // not the nights.
  _restoreSamples(nightHistory) {
    const fs = require('fs');
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(this._samplesFile, 'utf8')) || {};
    } catch (e) { /* no file yet, or unreadable — fall through to inline/empty */ }

    return nightHistory.map(n => ({
      ...n,
      samples: Array.isArray(n.samples) ? n.samples
        : (Array.isArray(stored[n.date]) ? stored[n.date] : []),
    }));
  }

  setNotificationsEnabledForDevice(device,enabled) {
    this.deviceNotificationPrefs.set(device.getId(),enabled);
    this._save();
  }

  async _notify(key,vars={}) {
    if (!this.master) return;
    const pref=this.deviceNotificationPrefs.get(this.master.getId());
    const enabled=(pref!==undefined)?pref:this.defaultNotificationsEnabled;
    if (!enabled) return;

    const lang=this._lang();
    const msg={
      night_invalid:{
        nl:`Sluipverbruik niet bijgewerkt: afgelopen nacht te veel schommelingen (${vars.reasons}).`,
        en:`Standby usage not updated: too many fluctuations last night (${vars.reasons}).`
      },
      night_no_samples:{
        nl:`Sluipverbruik niet bijgewerkt: geen meetgegevens vannacht.`,
        en:`Standby usage not updated: no measurements last night.`
      },
      baseload_changed:{
        nl:`Sluipverbruik aangepast: ${vars.current} W (was ${vars.previous} W).`,
        en:`Standby usage changed: ${vars.current} W (was ${vars.previous} W).`
      },
      baseload_unavailable:{
        nl:`Sluipverbruik nog onbekend: wacht op eerste rustige nacht.`,
        en:`Standby usage still unknown: waiting for first quiet night.`
      },
      baseload_fallback:{
        nl:`Sluipverbruik geschat op ${vars.fallback} W (nog geen volledige nacht gemeten).`,
        en:`Standby usage estimated at ${vars.fallback} W (no full night measured yet).`
      }
    }[key]?.[lang];

    if (!msg) return;
    try {await this.homey.notifications.createNotification({excerpt:msg});}
    catch(e){this.homey.error('Notification failed:',e);}
  }
}

module.exports = BaseloadMonitor;
