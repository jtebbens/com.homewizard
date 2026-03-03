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

class BaseloadMonitor {
  constructor(homey) {
    this.homey = homey;

    this.nightStartHour = 1;
    this.nightEndHour = 5;
    this.maxNights = 30;

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
  }

  updatePower(power, batteryPower = null) {
    if (!this.enabled || typeof power !== 'number') return;
    const now = new Date();
    if (!this._isInNightWindow(now)) return;
    
    // Battery-aware: if battery is discharging, subtract it from grid power
    // to get true household baseload (not including battery contribution)
    let householdPower = power;
    if (typeof batteryPower === 'number' && batteryPower < 0) {
      // Battery discharging (negative value), add to grid power to get household consumption
      householdPower = power - batteryPower;
    }
    
    this._processNightSample(now, householdPower, power, batteryPower);
  }

  _isInNightWindow(d) {
    const h = d.getHours();
    return h >= this.nightStartHour && h < this.nightEndHour;
  }

  _isWithinCurrentNightWindow(now = new Date()) {
    const s = new Date(now), e = new Date(now);
    s.setHours(this.nightStartHour,0,0,0);
    e.setHours(this.nightEndHour,0,0,0);
    return now >= s && now < e;
  }

  _scheduleNightWindow() {
    this._clearNightTimers();
    const now = new Date();
    if (this._isWithinCurrentNightWindow(now)) return this._onNightStartFromRecovery(now);
    const next = new Date(now);
    next.setHours(this.nightStartHour,0,0,0);
    if (next <= now) next.setDate(next.getDate()+1);
    this._nightTimer = this.homey.setTimeout(()=>this._onNightStart(), next-now);
  }

  _onNightStartFromRecovery(now) {
    if (!this.enabled) return this._scheduleNightWindow();
    this._resetNightState();
    const end = new Date(now);
    end.setHours(this.nightEndHour,0,0,0);
    this._nightEndTimer = this.homey.setTimeout(()=>this._onNightEnd(), Math.max(0,end-now));
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

    for (const s of this.currentNightSamples) {
      const ts = s.ts && s.ts.getTime ? s.ts.getTime() : s.ts;
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
    
    // Avoid spread operators, use simple loop for min/max
    let minPower = w[0].power;
    let maxPower = w[0].power;
    for (let i = 1; i < w.length; i++) {
      const p = w[i].power;
      if (p < minPower) minPower = p;
      if (p > maxPower) maxPower = p;
    }
    
    if (maxPower - minPower >= this.oscillationAmplitude) {
      this.flags.sawOscillation=true; 
      this.nightInvalid=true;
    }
  }

  _detectPVStartup() {
    const last = this.currentNightSamples.at(-1);
    if (!last) return;
    const h = last.ts.getHours();
    if (h>=this.pvStartupEarliest && h<=this.pvStartupLatest && last.power<0) {
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

  /**
   * Calculate monthly and yearly cost estimate for current baseload
   * @param {number} avgPricePerKwh - Average electricity price in €/kWh
   * @returns {object} { baseloadW, monthlyKwh, monthlyCost, yearlyCost }
   */
  getMonthlyEstimate(avgPricePerKwh = 0.25) {
    if (!this.currentBaseload || typeof avgPricePerKwh !== 'number') {
      return { baseloadW: null, monthlyKwh: null, monthlyCost: null, yearlyCost: null };
    }
    
    const baseloadW = this.currentBaseload;
    const monthlyKwh = (baseloadW / 1000) * 24 * 30; // W to kW, 24h/day, 30 days
    const monthlyCost = monthlyKwh * avgPricePerKwh;
    const yearlyCost = monthlyCost * 12;
    
    return {
      baseloadW: Math.round(baseloadW),
      monthlyKwh: Math.round(monthlyKwh * 10) / 10,
      monthlyCost: Math.round(monthlyCost * 100) / 100,
      yearlyCost: Math.round(yearlyCost * 100) / 100
    };
  }

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

  _durAbsBelow(m) {
    let ms=0;
    for (let i=1;i<this.currentNightSamples.length;i++) {
      const p=this.currentNightSamples[i-1],c=this.currentNightSamples[i];
      if (Math.abs(p.power)<m && Math.abs(c.power)<m) ms+=c.ts-p.ts;
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
    for (const n of this.nightHistory.slice(-7)) if (Array.isArray(n.samples)) r.push(...n.samples);
    const p=[];
    for (const s of r) {
      if (typeof s.power === 'number') p.push(s.power);
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
    this.homey.settings.set('baseload_state',{
      nightHistory:this.nightHistory,
      currentBaseload:this.currentBaseload,
      deviceNotificationPrefs:Array.from(this.deviceNotificationPrefs.entries()),
      invalidNightCounter:this.invalidNightCounter
    });
  }

  _loadState() {
    const s=this.homey.settings.get('baseload_state');
    if (!s) return;
    if (Array.isArray(s.nightHistory)) this.nightHistory=s.nightHistory;
    if (typeof s.currentBaseload==='number') this.currentBaseload=s.currentBaseload;
    if (Array.isArray(s.deviceNotificationPrefs)) this.deviceNotificationPrefs=new Map(s.deviceNotificationPrefs);
    if (typeof s.invalidNightCounter==='number') this.invalidNightCounter=s.invalidNightCounter;
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
        nl:`Baseload niet bijgewerkt: nacht bevatte fluctuaties (${vars.reasons}).`,
        en:`Baseload not updated: night contained fluctuations (${vars.reasons}).`
      },
      night_no_samples:{
        nl:`Baseload niet bijgewerkt: geen gegevens ontvangen.`,
        en:`Baseload not updated: no data received.`
      },
      baseload_changed:{
        nl:`Baseload gewijzigd: ${vars.current} W (was ${vars.previous} W).`,
        en:`Baseload changed: ${vars.current} W (was ${vars.previous} W).`
      },
      baseload_unavailable:{
        nl:`Baseload niet beschikbaar: geen geldige nachten.`,
        en:`Baseload unavailable: no valid nights.`
      },
      baseload_fallback:{
        nl:`Baseload (fallback): ${vars.fallback} W.`,
        en:`Fallback baseload: ${vars.fallback} W.`
      }
    }[key]?.[lang];

    if (!msg) return;
    try {await this.homey.notifications.createNotification({excerpt:msg});}
    catch(e){this.homey.error('Notification failed:',e);}
  }
}

module.exports = BaseloadMonitor;
