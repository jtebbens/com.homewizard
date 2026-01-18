'use strict';

class BaseloadMonitor {
  constructor(homey) {
    this.homey = homey;

    this.nightStartHour = 1;
    this.nightEndHour = 5;
    this.maxNights = 30;

    this.highPlateauThreshold = 500;
    this.highPlateauMinDuration = 600000;
    this.negativeMinDuration = 300000;
    this.nearZeroMargin = 50;
    this.nearZeroMinDuration = 1200000;
    this.oscillationWindow = 300000;
    this.oscillationAmplitude = 300;
    this.pvStartupEarliest = 4;
    this.pvStartupLatest = 6;

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

  updatePowerFromDevice(device, power) {
    if (device === this.master) this.updatePower(power);
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

  updatePower(power) {
    if (!this.enabled || typeof power !== 'number') return;
    const now = new Date();
    if (!this._isInNightWindow(now)) return;
    this._processNightSample(now, power);
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

  _processNightSample(ts, power) {
    // NEW: ignore export for baseload logic
    if (power < 0) {
      // mark as invalid sample but do NOT trigger nightInvalid
      this.currentNightSamples.push({ ts, power });
      return;
    }

    this.currentNightSamples.push({ ts, power });

    this._detectHighPlateau();
    this._detectNegativeLong();
    this._detectNearZeroLong();
    this._detectOscillation();
    this._detectPVStartup();
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
    if (this._durAbsBelow(this.nearZeroMargin)>=this.nearZeroMinDuration) {
      this.flags.sawNearZeroLong=true; this.nightInvalid=true;
    }
  }

  _detectOscillation() {
    const w = this._lastSamples(this.oscillationWindow);
    if (w.length<4) return;
    const p = w.map(s=>s.power);
    if (Math.max(...p)-Math.min(...p)>=this.oscillationAmplitude) {
      this.flags.sawOscillation=true; this.nightInvalid=true;
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
    this.currentBaseload = this._compute();
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

  _push(date,avg,invalid,meta={}) {
    this.nightHistory.push({date,avg,invalid,samples:this.currentNightSamples.slice(),...meta});
    if (this.nightHistory.length>this.maxNights)
      this.nightHistory.splice(0,this.nightHistory.length-this.maxNights);
  }

  _compute() {
    const v = this.nightHistory.filter(n=>!n.invalid && typeof n.avg==='number').map(n=>n.avg);
    if (!v.length) {this._notify('baseload_unavailable'); return this.currentBaseload||null;}
    const s = v.slice().sort((a,b)=>a-b);
    return this._avg(s.slice(0,Math.min(3,s.length)));
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
    return this.currentNightSamples.filter(s=>last-s.ts<=ms);
  }

  _fallback() {
    const r=[];
    for (const n of this.nightHistory.slice(-7)) if (Array.isArray(n.samples)) r.push(...n.samples);
    const p=r.map(s=>s.power).filter(n=>typeof n==='number');
    if (!p.length) return null;
    const s=p.slice().sort((a,b)=>a-b);
    const take=Math.max(3,Math.floor(s.length*0.1));
    return this._avg(s.slice(0,take));
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
