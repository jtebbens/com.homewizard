'use strict';

const Homey = require('homey');
const WeatherForecaster = require('../../lib/weather-forecaster');
const PolicyEngine = require('../../lib/policy-engine');
const TariffManager = require('../../lib/tariff-manager');
const LearningEngine = require('../../lib/learning-engine');
const EfficiencyEstimator = require('../../lib/efficiency-estimator');
const OptimizationEngine = require('../../lib/optimization-engine');

const debug = false;

function _memMB(label) {
  try {
    const hs = require('v8').getHeapStatistics();
    const heap = (hs.used_heap_size   / 1024 / 1024).toFixed(1);
    const tot  = (hs.total_heap_size  / 1024 / 1024).toFixed(1);
    console.log(`[MEM][BatteryPolicy] ${label}: heap=${heap}/${tot}MB`);
  } catch (_) {
    console.log(`[MEM][BatteryPolicy] ${label}: unavailable`);
  }
}

function _settingsFootprintKB(settings) {
  try {
    const all = settings.getAll();
    const entries = Object.entries(all)
      .map(([k, v]) => ({ k, bytes: JSON.stringify(v).length }))
      .sort((a, b) => b.bytes - a.bytes);
    const totalKB = (entries.reduce((s, e) => s + e.bytes, 0) / 1024).toFixed(1);
    const top = entries.slice(0, 8).map(e => `${e.k}=${(e.bytes / 1024).toFixed(1)}kB`).join(' | ');
    return `${totalKB}kB total | ${top}`;
  } catch (_) {
    return 'unavailable';
  }
}

class BatteryPolicyDevice extends Homey.Device {

  async onInit() {
    this.homey.app.bumpDeviceCount?.('battery-policy');
    this.log('BatteryPolicyDevice initialized');
    _memMB('onInit-start');

    // Components
    this.learningEngine = new LearningEngine(this.homey, this);
    await this.learningEngine.initialize();

    this.weatherForecaster = new WeatherForecaster(this.homey, this.learningEngine);
    this.policyEngine = new PolicyEngine(this.homey, this.getSettings());
    this.tariffManager = new TariffManager(this.homey, this.getSettings());
    this.explainabilityEngine = null; // lazy-loaded on first policy check
    this.chartGenerator = null;       // lazy-loaded on first chart request
    this.efficiencyEstimator = new EfficiencyEstimator(this.homey);
    this.optimizationEngine = new OptimizationEngine(this.getSettings());


    // State
    this.p1Device = null;
    this.weatherData = null;
    this.buienradarData = null;
    this.lastRecommendation = null;
    this._liveState = {}; // in-memory store for rebuildable UI state (served via api.js)
    this._lastPvEstimateW = 0; // For EMA smoothing
    this._pvProductionW = null; // User-provided PV production via flow card
    this._pvProductionTimestamp = null; // When the PV data was last updated
    this._pvActualHourly = null; // Accumulator for chart: {date, hourly[], sums[], counts[]}
    this._pvState = false; // Track PV state with hysteresis
    this._lastPvPolicyRun = null; // Debounce PV-triggered policy runs
    this._favorableWindowActive = false; // Tracks edge for favorable_consumption_window trigger
    this._todayDate = null;           // YYYY-MM-DD (Amsterdam) for daily reset
    this._todayGridImportKwh = 0;     // accumulated grid import today (kWh)
    this._todayConsumptionKwh = 0;    // accumulated house consumption today (kWh)
    this._lastSelfSuffWrite = 0;      // throttle: last settings write for today_self_sufficiency
    this._modeHistory = this.homey.settings.get(`batt_mode_hist_${this.getData().id}`) || [];
    this._isPredictiveMode = false;
    this._policyEnabledBeforePredictive = null; // saved state for auto-restore when predictive ends
    this._modeChartBody = null;
    this._modeChartImage = null;

    // Restore accumulators from last save so a restart doesn't reset to 0 mid-day
    try {
      const saved = this.homey.settings.get('today_self_sufficiency');
      const todayNL = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
      if (saved?.date === todayNL && saved.consumptionKwh > 0) {
        this._todayDate = todayNL;
        this._todayGridImportKwh = saved.gridImportKwh ?? 0;
        this._todayConsumptionKwh = saved.consumptionKwh ?? 0;
        this.log(`[SelfSuff] Restored from settings: ${saved.pct}% (${saved.consumptionKwh} kWh consumed)`);
      }
    } catch (e) { /* ignore */ }

    await this._initializeCapabilities();
    this._registerCapabilityListeners();

    // Connect P1 after short delay
    this.homey.setTimeout(() => {
      this._connectP1Device().catch(err => this.error(err));
    }, 1500);

    // Schedule periodic checks
    this._schedulePolicyCheck();

    // Mode history flush interval (15 min, offset 7.5 min from slot boundaries).
    // Slot boundaries (:00, :15, :30, :45) are when _saveWidgetData and price refresh
    // run — offsetting by 7.5 min avoids concurrent large allocations that together
    // push V8 into a major GC cycle peaking at ~60 MB.
    const _modeFlushFn = () => {
      if (this.p1Device) {
        const mode = this.p1Device._currentDetailedMode
          || this.p1Device.getCapabilityValue('battery_group_charge_mode')
          || 'unknown';
        const soc = this.p1Device.getCapabilityValue('battery_group_average_soc') ?? 50;
        this._recordModeHistory(mode);
        this._recordSoCHistory(soc);
      }
      if (!this._modeHistory?.length) return;
      this._queueSettingsPersist(`batt_mode_hist_${this.getData().id}`, this._modeHistory);
      // Guard: skip chart update when heap is elevated — quickchart HTTP + image data adds ~30 MB
      let _heapFlush = 99;
      try { _heapFlush = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (_heapFlush > 35) {
        this.log(`[MEM] Skipping mode chart update — heap ${_heapFlush.toFixed(1)} MB > 35 MB guard`);
      } else {
        this._updateModeChart().catch(e => this.error('Mode chart update failed:', e));
      }

      // Profit tracking — runs regardless of policy state so predictive-mode days
      // are never a blind spot. When Slim Laden is active, also refresh the DP
      // projection (read-only) so we know what our optimizer would have planned.
      if (this._isPredictiveMode) {
        const timeout = new Promise((_, reject) =>
          this.homey.setTimeout(() => reject(new Error('timeout')), 20_000));
        Promise.race([this._gatherInputs(), timeout]).then(inputs => {
          if (inputs?.tariff) {
            this.optimizationEngine.updateSettings({});
            return this._recomputeOptimizer(inputs).then(() => inputs);
          }
        }).then(inputs => {
          this._updateProfitTracking(null, true);
          // Patch live SoC into battery_policy_state so widget shows correct value
          const liveSoc = this.p1Device?.getCapabilityValue('battery_group_average_soc') ?? null;
          if (liveSoc != null) {
            const ps = this._liveState.battery_policy_state
              ?? this.homey.settings.get('battery_policy_state') ?? {};
            ps.batterySOC = liveSoc;
            ps.currentMode = 'predictive';
            this._setLive('battery_policy_state', ps);
          }
          // Record predictive mode in planning chart history
          try {
            const modeHistory = this.homey.settings.get('policy_mode_history') || [];
            const nowTs  = new Date();
            const bucket = Math.round(nowTs.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            const existing = modeHistory.findIndex(
              h => Math.round(new Date(h.ts).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000) === bucket
            );
            const entry = { ts: nowTs.toISOString(), hwMode: 'predictive', soc: liveSoc, price: null };
            if (existing >= 0) modeHistory[existing] = entry;
            else modeHistory.push(entry);
            if (modeHistory.length > 192) modeHistory.splice(0, modeHistory.length - 192);
            this._queueSettingsPersist('policy_mode_history', modeHistory);
          } catch (e) { this.error('Failed to save predictive mode history (flush):', e); }
          try { this._saveWidgetData({ skipChart: true }); } catch (e) { this.error('Widget save (predictive) failed:', e.message); }
        }).catch(e => this.error('Predictive profit tracking failed:', e.message));
      } else {
        this._updateProfitTracking(null, false);
      }
    };
    this.homey.setTimeout(() => {
      _modeFlushFn();
      this._modeHistoryFlushInterval = this.homey.setInterval(_modeFlushFn, 15 * 60 * 1000);
    }, 7.5 * 60 * 1000);

    // Register cameras — deferred to 60s so the startup memory spike has settled.
    // Sequential await prevents concurrent setCameraImage calls from racing in Homey's image manager.
    this.homey.setTimeout(async () => {
      await this._initModeHistoryCamera().catch(e => this.error('Mode camera init failed:', e));
      await this._initPvCamera().catch(e => this.error('PV camera init failed:', e));
    }, 60 * 1000);

    // Restore widget data from cached settings after startup peak has settled.
    // Delayed to 90s: _saveWidgetData loads large settings keys (optimizer schedule,
    // 15-min prices, mode history) which add ~18 MB to heap. energy_v2 alone peaks
    // at 41 MB; loading at T+3s pushed total to 71 MB → Memory Warning crash.
    // After T+10s the heap settles at ~29 MB, so 90s is safely past the danger window.
    this.homey.setTimeout(() => {
      try { this._saveWidgetData({ skipChart: true }); } catch (e) { this.error('Startup widget restore failed:', e); }
      this._logSettingsFootprint();
    }, 90 * 1000);

    // Set default for price_resolution if not yet saved (existing paired devices)
    if (!this.getSetting('price_resolution')) {
      await this.setSettings({ price_resolution: '15min' });
    }

    // Migrate legacy weather_location (city name) to weather_latitude/weather_longitude
    await this._migrateWeatherLocation();

    // Weather fetch only in dynamic.
    // Deferred 30s past onInit: Open-Meteo ensemble fetch + parsing allocates ~30 MB
    // and pushed peak heap to 71 MB on a user's setup with 15 devices, tripping the
    // Homey "Memory Warning Limit Reached" ceiling. After T+30s the parallel device
    // onInits + WS auth + first polls have settled, leaving headroom for the spike.
    // Cached weatherData (≤6 min old) is restored from settings, so the gap is invisible.
    if (this.getSettings().tariff_type === 'dynamic') {
      this.homey.setTimeout(() => {
        this._updateWeather()
          .then(() => _memMB('after-weather-fetch'))
          .catch(err => this.error('Initial weather fetch failed:', err));
      }, 30 * 1000);

      // Schedule periodic price refresh (every 30 minutes) — lightweight, keep immediate
      this._schedulePriceRefresh();
    }

    // Push device settings so planning page has correct values after restart
    // (normally pushed on every _runPolicyCheck, but that runs with a delay).
    // Queued via the batcher to avoid stacking a 30 MB settings.set spike
    // on top of the startup cascade.
    const s = this.getSettings();
    this._setLive('device_settings', {
      max_charge_price:    s.max_charge_price    || 0.19,
      min_discharge_price: s.min_discharge_price || 0.22,
      min_soc:             s.min_soc             || 10,
      max_soc:             s.max_soc             || 95,
      battery_efficiency:  s.battery_efficiency  || 0.75,
      min_profit_margin:   s.min_profit_margin   || 0.01,
      tariff_type:         s.tariff_type         || 'dynamic',
      policy_interval:     s.policy_interval     || 15,
      pv_capacity_w:       s.pv_capacity_w       || 0,
      pv_estimation_enabled: s.pv_estimation_enabled || false,
      price_resolution:    s.price_resolution    || '15min',
    });

    this.log('BatteryPolicyDevice ready');
    _memMB('onInit-done');
  }

  _logSettingsFootprint() {
    this.log(`[MEM] settings footprint: ${_settingsFootprintKB(this.homey.settings)}`);
  }

  // Queue a settings.set call for deferred, serialized execution.
  // Rationale: homey.settings.set allocates ~30 MB V8 heap per call (framework
  // internal, independent of payload size — measured with 8 KB payload). A single
  // policy run used to make 14+ such calls, cumulatively driving RSS over the
  // Homey ceiling. Most rebuildable UI state now lives in this._liveState (served
  // via api.js) so only genuinely persistent keys pass through this queue.
  // Spacing: 8s between writes so V8 can fully GC the previous 30 MB spike
  // before the next allocation — a single 60 MB peak alone trips the warning.
  _queueSettingsPersist(key, value) {
    if (!this._settingsQueue) this._settingsQueue = new Map();
    this._settingsQueue.set(key, value); // coalesces duplicates
    if (this._settingsFlushTimer) return;
    this._settingsFlushTimer = this.homey.setTimeout(() => {
      this._settingsFlushTimer = null;
      this._flushSettingsQueue();
    }, 8000);
  }

  _flushSettingsQueue() {
    if (!this._settingsQueue || this._settingsQueue.size === 0) return;

    // Heap-aware: each settings.set allocates ~30 MB transient. If we're already
    // elevated (e.g. weather fetch, widget broadcast, camera chart), another
    // 30 MB on top would trip the Memory Warning. Reschedule until heap settles.
    let heapMB = 0;
    try { heapMB = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
    if (heapMB > 40) {
      this._settingsFlushTimer = this.homey.setTimeout(() => {
        this._settingsFlushTimer = null;
        this._flushSettingsQueue();
      }, 8000);
      return;
    }

    const [key, value] = this._settingsQueue.entries().next().value;
    this._settingsQueue.delete(key);
    try {
      this.homey.settings.set(key, value);
    } catch (e) {
      this.error(`Failed to persist ${key}:`, e.message);
    }
    if (this._settingsQueue.size > 0) {
      this._settingsFlushTimer = this.homey.setTimeout(() => {
        this._settingsFlushTimer = null;
        this._flushSettingsQueue();
      }, 8000);
    }
  }

  // Store rebuildable UI state in-memory for fast internal reads (cameras, widget),
  // and queue a batched settings.set so the settings page (which reads via Homey.get)
  // sees the same data. The batcher spaces writes 8s apart so each ~30 MB spike
  // is fully GC'd before the next allocation.
  _setLive(key, value) {
    this._liveState[key] = value;
    this._queueSettingsPersist(key, value);
  }

  async _initializeCapabilities() {
    const tariffType = this.getSettings().tariff_type || 'dynamic';
    
    const defaults = {
      policy_mode: tariffType === 'dynamic' ? 'balanced' : 'balanced-fixed',
      auto_apply: true,
      recommended_mode: 'preserve',
      sun_score: 0,
      predicted_sun_hours: 0,
      confidence_score: 0,
      explanation_summary: 'Initializing policy engine...',
      policy_debug_price: '-',
      policy_debug_top3low: '-',
      policy_debug_top3high: '-',
      policy_debug_sun: '-',
      policy_debug_learning: '-',
      battery_soc_mirror: 50,
      grid_power_mirror: 0,
      battery_rte: 0.75,
      last_update: new Date().toISOString(),
      active_mode: 'unknown',
      override_until: null,
      weather_override: 'auto',
      presence_mode: this.learningEngine.isPaused() ? '🏖️ Away' : '🏠 Home'
    };

    for (const [capability, defaultValue] of Object.entries(defaults)) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(err => {
          if (err && err.code === 409) return;
          this.error(`Failed to add capability ${capability}:`, err);
        });
      }

      const current = this.getCapabilityValue(capability);

      if (capability === 'auto_apply' && current === false) {
        this.log('ℹ️ Forcing auto_apply to true (was false)');
        await this.setCapabilityValue(capability, true).catch(err =>
          this.error(`Failed to set ${capability}:`, err)
        );
      } else if (capability === 'policy_mode' && current === 'balanced') {
        // Migrate old 'balanced' to type-specific mode
        const newMode = tariffType === 'dynamic' ? 'balanced' : 'balanced-fixed';
        this.log(`ℹ️ Migrating policy_mode 'balanced' to '${newMode}' based on tariff type`);
        await this.setCapabilityValue(capability, newMode).catch(err =>
          this.error(`Failed to migrate ${capability}:`, err)
        );
      } else if (current === null || current === undefined) {
        await this.setCapabilityValue(capability, defaultValue).catch(err =>
          this.error(`Failed to set ${capability}:`, err)
        );
      }
    }
  }

  _registerCapabilityListeners() {

    // POLICY ENABLED / DISABLED
    this.registerCapabilityListener('policy_enabled', async (value) => {
      const current = this.getCapabilityValue('policy_enabled');

      if (current === value) {
        this.log(`Policy state unchanged (${value}), ignoring sync event`);
        return value;
      }

      this.log(`Policy ${value ? 'enabled' : 'disabled'}`);

      if (value) {
        // skipEnabledCheck: capability not yet persisted when listener fires (Homey SDK quirk)
        await this._runPolicyCheck({ skipEnabledCheck: true });
      }

      return value;
    });

    // POLICY MODE
    this.registerCapabilityListener('policy_mode', async (value) => {
      const current = this.getCapabilityValue('policy_mode');

      if (current === value) {
        this.log(`Policy mode unchanged (${value}), ignoring sync event`);
        return value;
      }

      this.log(`Policy mode changed to: ${value}`);
      this.policyEngine.updateSettings({ policy_mode: value });
      await this._runPolicyCheck();
      return value;
    });

    // AUTO APPLY
    this.registerCapabilityListener('auto_apply', async (value) => {
      const current = this.getCapabilityValue('auto_apply');

      if (current === value) {
        this.log(`Auto-apply unchanged (${value}), ignoring sync event`);
        return value;
      }

      this.log(`Auto-apply ${value ? 'enabled' : 'disabled'}`);

      if (value && this.lastRecommendation) {
        const applyMode = this.lastRecommendation.hwMode || this.lastRecommendation.policyMode;
        await this._applyRecommendation(applyMode, this.lastRecommendation.confidence);
      }

      return value;
    });

    // WEATHER OVERRIDE
    this.registerCapabilityListener('weather_override', async (value) => {
      const settings = this.getSettings();
      const current = this.getCapabilityValue('weather_override');

      if (current === value) {
        this.log(`Weather override unchanged (${value}), ignoring sync event`);
        return value;
      }

      if (settings.tariff_type !== 'dynamic') {
        this.log('Weather override ignored (fixed tariff)');
        return value;
      }

      this.log(`Weather override changed to: ${value}`);
      await this._runPolicyCheck();
      return value;
    });

  }

  /**
   * Connect to P1 (energy_v2)
   */
  async _connectP1Device() {
    const p1DeviceId = this.getSetting('p1_device_id');

    if (!p1DeviceId) {
      this.error('No P1 device configured');
      return;
    }

    try {
      const driver = this.homey.drivers.getDriver('energy_v2');
      if (!driver) {
        this.error('P1 driver (energy_v2) not found');
        return;
      }

      this.p1Device = driver.getDevice({ id: p1DeviceId });

      if (!this.p1Device) {
        this.error('P1 device not found');
        return;
      }

      this.log(`Connected to P1 device: ${this.p1Device.getName()}`);

      // Remove stale listeners from a previous connection (e.g. reconnect)
      this._cleanupP1Listeners();

      // Single battery_event handler
      this._onBatteryEvent = (payload) => {
        this._lastBatteryTargetW = payload.target_power_w ?? 0;
        this._lastBatteryEventTs = Date.now();
        this.log(`🔌 Battery target event → target=${this._lastBatteryTargetW}W`);
      };
      this.p1Device.on('battery_event', this._onBatteryEvent);

      this._setupP1Listeners();

      // Seed RTE from hardware meters immediately at startup
      try {
        const battDriver = this.homey.drivers.getDriver('plugin_battery');
        if (battDriver) {
          let totalImport = 0, totalExport = 0;
          for (const dev of battDriver.getDevices()) {
            totalImport += dev.getCapabilityValue('meter_power.import') || 0;
            totalExport += dev.getCapabilityValue('meter_power.export') || 0;
          }
          const newRte = this.efficiencyEstimator.updateFromMeters(totalImport, totalExport);
          if (newRte) this.policyEngine.updateSettings({ battery_efficiency: newRte });
        }
      } catch (e) { /* driver not available yet */ }

      // Restore last known mode immediately so the battery doesn't sit in firmware
      // default (zero_charge_only) during the gap between restart and first policy run.
      try {
        const modeHistory = this.homey.settings.get('policy_mode_history');
        if (Array.isArray(modeHistory) && modeHistory.length > 0) {
          const lastEntry = modeHistory[modeHistory.length - 1];
          const lastMode  = lastEntry?.hwMode;
          if (lastMode) {
            this.log(`🔄 Restoring last known mode on startup: ${lastMode}`);
            await this._applyRecommendation(lastMode, 100);
          }
        }
      } catch (e) {
        this.log('Could not restore last mode on startup:', e.message);
      }

      // Defer the initial policy check past the startup cascade (T+45s).
      // Reason: at this point the device cascade is still settling — 8 socket polls,
      // WS authorizations (energy_v2 + 2× plugin_battery on some setups), price/weather
      // fetches and the new device-settings push are all happening in parallel. Running
      // _runPolicyCheck() here pushed heap to ~70 MB on a user with 15 devices and a
      // fragile network, hitting the Homey "Memory Warning Limit Reached" ceiling.
      // Also: prices may still be loading, causing the policy run to see price=undefined.
      // Mode is already restored above, so the battery is in the correct state during
      // this gap. The next scheduled check at the slot boundary (≤15 min) takes over.
      this.homey.setTimeout(() => {
        this._runPolicyCheck().catch(err => this.error('Initial policy check failed:', err));
      }, 45 * 1000);

    } catch (error) {
      this.error('Failed to connect to P1 device:', error);
    }
  }

  /**
   * Listen for capability changes on P1 device and mirror them in real-time
   */
  _setupP1Listeners() {
    if (!this.p1Device) return;

    if (this._p1PollInterval) {
      this.homey.clearInterval(this._p1PollInterval);
    }

    this._p1PollInterval = this.homey.setInterval(async () => {
      if (!this.p1Device) return;

      try {

        // DEBUG: Log raw capability values from P1
const rawSoc = this.p1Device.getCapabilityValue('battery_group_average_soc');
const rawGrid = this.p1Device.getCapabilityValue('measure_power');
const rawBattCap = this.p1Device.getCapabilityValue('measure_power.battery_group_power_w');

if (debug) this.log(
  `🐛 [DEBUG/setup] Raw P1 caps → soc=${rawSoc}, grid=${rawGrid}, battCap=${rawBattCap}`
);


        const soc =
          this.p1Device.getCapabilityValue('battery_group_average_soc') ??
          50;

        const gridPower =
          this.p1Device.getCapabilityValue('measure_power') ?? 0;

        let batteryPower =
          this.p1Device.getCapabilityValue('measure_power.battery_group_power_w');

        if (batteryPower === null || batteryPower === undefined) {
          // fallback op target_power_w (als je die ooit krijgt)
          if (Date.now() - (this._lastBatteryEventTs ?? 0) < 10000) {
            batteryPower = this._lastBatteryTargetW;
          } else {
            batteryPower = 0;
          }
        }

        if (debug) this.log(`🐛 batteryPower resolved → ${batteryPower}W`);
        if (debug) this.log(`🐛 gridPower value → ${gridPower}W`);

        await this._updateBatteryCostModel({
          batteryPower,
          gridPower,
          pvState: this._pvState,
          soc: soc
        });

        // Efficiency learning — use soc from P1 (battery_group_average_soc), not measure_battery
        if (debug) this.log(`[Efficiency] About to update with grid=${gridPower}W, batt=${batteryPower}W, soc=${soc}`);
        this.efficiencyEstimator.update(
          { gridPower, batteryPower },
          { battery_power: batteryPower, stateOfCharge: soc },
          this.getCapabilityValue('active_mode') || null
        );

        // Add this logging every 5 minutes:
        if (this.efficiencyEstimator.state) {
          const s = this.efficiencyEstimator.state;
          // Log progress every 5 min (every 20th call at 15s interval)
          this._effLogCounter = (this._effLogCounter || 0) + 1;
          if (this._effLogCounter % 20 === 0) {
            const chargedWh   = (s.totalChargeKwh   * 1000).toFixed(0);
            const dischargedWh = (s.totalDischargeKwh * 1000).toFixed(0);
            const balance = s.totalDischargeKwh > 0
              ? (s.totalChargeKwh / s.totalDischargeKwh).toFixed(2) : '—';
            this.log(
              `[RTE] learning: charged=${chargedWh}Wh / 1000Wh, discharged=${dischargedWh}Wh / 1000Wh, ` +
              `balance=${balance} (>1.4 = wacht), current RTE=${( s.efficiency * 100).toFixed(1)}%`
            );
          }

          // Update RTE from hardware meters every hour (240 × 15s)
          if (this._effLogCounter % 240 === 0) {
            try {
              const battDriver = this.homey.drivers.getDriver('plugin_battery');
              if (battDriver) {
                let totalImport = 0, totalExport = 0;
                for (const dev of battDriver.getDevices()) {
                  totalImport += dev.getCapabilityValue('meter_power.import') || 0;
                  totalExport += dev.getCapabilityValue('meter_power.export') || 0;
                }
                const newRte = this.efficiencyEstimator.updateFromMeters(totalImport, totalExport);
                if (newRte) this.policyEngine.updateSettings({ battery_efficiency: newRte });
              }
            } catch (e) { /* driver not available */ }
          }

          // Log RTE insights every 4h (every 960th call at 15s interval)
          if (this._effLogCounter % 960 === 0) {
            const insights = this.efficiencyEstimator.getEfficiencyInsights();
            if (insights) {
              const pw = insights.rteByPower;
              const m = insights.rteByMode;
              this.log(
                `[RTE] Insights (${insights.cycleCount} cycli) per modus: ` +
                Object.entries(m).map(([k, v]) => `${k}=${v.rte}% (${v.n}x)`).join(', ')
              );
              this.log(`[RTE] Advies: ${insights.recommendation}`);
            }
          }
        }


        const currentSoc = this.getCapabilityValue('battery_soc_mirror');
        const currentPower = this.getCapabilityValue('grid_power_mirror');

        // Mirror SoC
        if (currentSoc !== soc) {
          await this.setCapabilityValue('battery_soc_mirror', soc);
          this.log(`🔄 SoC updated: ${currentSoc}% → ${soc}%`);
        }

        // Mirror grid power
        if (currentPower !== gridPower) {
          await this.setCapabilityValue('grid_power_mirror', gridPower);
        }

        // ------------------------------------------------------
        // 📊 LEARNING: Record consumption patterns
        // ------------------------------------------------------
        // Calculate TRUE house consumption: what the house actually uses,
        // regardless of where the power comes from (grid, PV, or battery).
        // gridPower: + = import, − = export
        // batteryPower: + = charging (consuming PV/grid), − = discharging (supplying house)
        // pvProductionW: always >= 0 (PV output)
        const pvW = this._pvProductionW ?? 0;
        const houseConsumptionW = gridPower - batteryPower + pvW;
        if (houseConsumptionW >= 0) {
          await this.learningEngine.recordConsumption(houseConsumptionW).catch(err =>
            this.error('Learning consumption recording failed:', err)
          );
        }

        // ------------------------------------------------------
        // 📊 SELF-SUFFICIENCY: Accumulate actual daily energy
        // ------------------------------------------------------
        const POLL_H = 15 / 3600; // poll interval (15s) expressed in hours
        const todayNL = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
        if (this._todayDate !== todayNL) {
          this._todayDate = todayNL;
          this._todayGridImportKwh = 0;
          this._todayConsumptionKwh = 0;
        }
        if (gridPower > 0) this._todayGridImportKwh += (gridPower * POLL_H) / 1000;
        if (houseConsumptionW > 0) this._todayConsumptionKwh += (houseConsumptionW * POLL_H) / 1000;

        // Write today_self_sufficiency to settings at most every 5 minutes
        const now = Date.now();
        if (this._todayConsumptionKwh > 0.01 && now - this._lastSelfSuffWrite > 5 * 60 * 1000) {
          this._lastSelfSuffWrite = now;
          const pct = Math.max(0, Math.min(100, Math.round(
            (1 - this._todayGridImportKwh / this._todayConsumptionKwh) * 100
          )));
          this._queueSettingsPersist('today_self_sufficiency', {
            pct,
            gridImportKwh:  +this._todayGridImportKwh.toFixed(3),
            consumptionKwh: +this._todayConsumptionKwh.toFixed(3),
            date: this._todayDate,
          });
        }

        // ------------------------------------------------------
        // ⭐ REALTIME PV STATE DETECTION (dual-mode)
        // ------------------------------------------------------
        // Detects PV in two scenarios:
        // 1. EXPORT MODE: Grid exporting surplus (gridPower < -200W)
        // 2. CONSUMPTION MODE: Active PV being consumed (sun ≥40% AND daytime AND grid balanced)
        //
        // This handles the zero_charge_only case with daytime loads where grid ~0W
        // but PV is actively producing and being consumed (washing machine, tumble dryer, etc.)
        //
        // CRITICAL: Account for battery charging when detecting PV state
        // If battery is charging, that power would be exported if battery was in standby
        const PV_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes between PV-triggered runs
        // ✅ HYSTERESIS THRESHOLDS: Different values for ON vs OFF to prevent bouncing
        const PV_EXPORT_ON = -200;            // Turn ON: Clear export < -200W
        const PV_EXPORT_OFF = -150;           // Turn OFF: Must rise above -150W to deactivate export mode
        const PV_GRID_MIN_ON = -100;          // Turn ON: Consumption mode starts at -100W
        const PV_GRID_MAX_ON = 200;           // Turn ON: Consumption mode ends at +200W
        const PV_GRID_MIN_OFF = -150;         // Turn OFF: Wider range to prevent bouncing (-150W)
        const PV_GRID_MAX_OFF = 250;          // Turn OFF: Wider range to prevent bouncing (+250W)
        const PV_SUN_THRESHOLD = 40;          // Sun score ≥40% indicates active PV
        const PV_DAYLIGHT_START = 7;          // 7 AM
        const PV_DAYLIGHT_END = 18;           // 6 PM

        // Get current hour (cached per minute to avoid toLocaleString overhead at 4×/min)
        const nowMin = Math.floor(Date.now() / 60_000);
        if (this._cachedHourMin !== nowMin) {
          this._cachedHour = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
          this._cachedHourMin = nowMin;
        }
        const currentHour = this._cachedHour;
        const isDaylight = currentHour >= PV_DAYLIGHT_START && currentHour < PV_DAYLIGHT_END;
        const sunScore = this.getCapabilityValue('sun_score') ?? 0;
        const hasSunlight = sunScore >= PV_SUN_THRESHOLD;

        // Calculate "virtual export" = what grid would be if battery was in standby.
        // Always subtract battery power (positive=charging, negative=discharging):
        //   Charging  (+800W): grid=-1100W → virtual=-1900W (true export potential)
        //   Discharging(-337W): grid=-220W → virtual=-220-(-337)=+117W (no real export)
        //   Idle         (0W): grid=-500W → virtual=-500W (direct PV export)
        // Without this correction, battery discharging more than house load creates
        // apparent grid export that falsely triggers PV detection.
        const virtualGridPower = gridPower - batteryPower;

        // ✅ HYSTERESIS LOGIC: Use different thresholds based on current state
        let hasExport, hasActivePVConsumption;
        
        if (this._pvState) {
          // Currently ON: Use wider thresholds to stay ON (prevent false OFF)
          hasExport = virtualGridPower < PV_EXPORT_OFF;
          hasActivePVConsumption = isDaylight && hasSunlight && 
                                   virtualGridPower >= PV_GRID_MIN_OFF && virtualGridPower <= PV_GRID_MAX_OFF;
        } else {
          // Currently OFF: Use stricter thresholds to turn ON (prevent false ON)
          hasExport = virtualGridPower < PV_EXPORT_ON;
          hasActivePVConsumption = isDaylight && hasSunlight && 
                                   virtualGridPower >= PV_GRID_MIN_ON && virtualGridPower <= PV_GRID_MAX_ON;
        }

        // PV is active if EITHER condition is true
        const pvNowActive = hasExport || hasActivePVConsumption;

        if (!this._pvState && pvNowActive) {
          // PV state OFF → ON
          this._pvState = true;
          const now = Date.now();
          const reason = hasExport 
            ? `export (virtual=${virtualGridPower.toFixed(1)}W [grid=${gridPower}W - batt=${batteryPower}W] < ${PV_EXPORT_ON}W)` 
            : `consumption (sun=${sunScore}%, virtual=${virtualGridPower.toFixed(1)}W, daytime=${isDaylight})`;
          
          if (!this._lastPvPolicyRun || now - this._lastPvPolicyRun > PV_DEBOUNCE_MS) {
            this._lastPvPolicyRun = now;
            this.log(`⚡ PV state changed (OFF → ON) via ${reason} → running policy`);
            this._runPolicyCheck().catch(err => this.error(err));
          } else {
            this.log(`⚡ PV state changed (OFF → ON) via ${reason} → debounced (last run ${Math.round((now - this._lastPvPolicyRun) / 1000)}s ago)`);
          }
        } else if (this._pvState && !pvNowActive) {
          // PV state ON → OFF
          this._pvState = false;
          const now = Date.now();
          const reason = !hasSunlight 
            ? `sun gone (${sunScore}% < ${PV_SUN_THRESHOLD}%)` 
            : !isDaylight 
            ? `night (${currentHour}:00, outside ${PV_DAYLIGHT_START}–${PV_DAYLIGHT_END})` 
            : `grid unbalanced (virtual=${virtualGridPower.toFixed(1)}W [grid=${gridPower}W - batt=${batteryPower}W], outside ${PV_GRID_MIN_OFF}–${PV_GRID_MAX_OFF}W)`;
          
          if (!this._lastPvPolicyRun || now - this._lastPvPolicyRun > PV_DEBOUNCE_MS) {
            this._lastPvPolicyRun = now;
            this.log(`⚡ PV state changed (ON → OFF) via ${reason} → running policy`);
            this._runPolicyCheck().catch(err => this.error(err));
          } else {
            this.log(`⚡ PV state changed (ON → OFF) via ${reason} → debounced (last run ${Math.round((now - this._lastPvPolicyRun) / 1000)}s ago)`);
          }
        }
        // Otherwise: no state change, no spam

        // Detect predictive mode transitions — uses live HW capability, not in-memory flag.
        // _isPredictiveMode can be false after an app restart even if predictive was already
        // active (in-memory state lost), so we check battery_group_charge_mode directly to
        // avoid explanation_summary and policy_enabled getting permanently stuck.
        {
          const hwModeNow = this.p1Device.getCapabilityValue('battery_group_charge_mode');
          if (hwModeNow === 'predictive') {
            if (!this._isPredictiveMode) {
              // Recover from restart: re-enter predictive state without touching policy_enabled
              // (it was already disabled before the restart; we don't know what the pre-predictive
              // value was, so we leave it as-is rather than guess).
              this._isPredictiveMode = true;
              this.log('[Policy] Predictive mode gedetecteerd (P1 poll) — explanation_summary live bijhouden');
            }
            // Keep explanation_summary + currentMode in sync while predictive is active
            await this.setCapabilityValue('explanation_summary', `Slim laden: actief - SoC ${soc}%`).catch(this.error);
            const ps = this._liveState.battery_policy_state
              ?? this.homey.settings.get('battery_policy_state')
              ?? {};
            if (ps.currentMode !== 'predictive') {
              ps.currentMode = 'predictive';
              this._setLive('battery_policy_state', ps);
            }
          } else if (this._isPredictiveMode) {
            // Predictive mode just ended
            this._isPredictiveMode = false;
            this.log('[Policy] Predictive mode beëindigd — battery-policy hersteld');
            if (this._policyEnabledBeforePredictive !== null) {
              await this.setCapabilityValue('policy_enabled', this._policyEnabledBeforePredictive).catch(this.error);
              this._policyEnabledBeforePredictive = null;
            }
          }
        }

      } catch (err) {
        this.error('Error polling P1 capabilities:', err);
      }
    // ✅ CPU FIX: Increased from 5s to 15s - heavy work (capability reads/writes, calculations)
    }, 15000);

    this.log('✅ P1 capability polling started (15s interval)');
  }

  _schedulePolicyCheck() {
    const intervalMinutes = this.getSetting('policy_interval') || 15;
    const intervalMs = intervalMinutes * 60 * 1000;

    // Clear any existing timers
    if (this.policyCheckInterval) {
      this.homey.clearInterval(this.policyCheckInterval);
      this.policyCheckInterval = null;
    }
    if (this._slotAlignTimeout) {
      this.homey.clearTimeout(this._slotAlignTimeout);
      this._slotAlignTimeout = null;
    }
    if (this._hourBoundaryTimeout) {
      this.homey.clearTimeout(this._hourBoundaryTimeout);
    }

    // Align to 15-min EPEX slot boundaries (:00, :15, :30, :45 UTC).
    // Price slots are keyed to UTC multiples of 15 min; running right at the
    // boundary ensures the full slot duration is covered by the correct action.
    // Without alignment the setInterval drifts to ~11 min into each slot,
    // leaving only ~4 min of discharge per slot.
    const now = Date.now();
    const msUntilNextSlot = intervalMs - (now % intervalMs) + 200; // 200ms grace

    this.log(`Policy check aligning to next slot boundary in ${Math.round(msUntilNextSlot / 1000)}s, then every ${intervalMinutes} min`);

    this._slotAlignTimeout = this.homey.setTimeout(() => {
      this._slotAlignTimeout = null;
      this._maybeRefreshWeatherOnly().catch(() => {});
      if (this.getCapabilityValue('policy_enabled')) {
        this._runPolicyCheck().catch(err => this.error('Slot-aligned policy check failed:', err));
      }
      this.policyCheckInterval = this.homey.setInterval(async () => {
        await this._maybeRefreshWeatherOnly().catch(() => {});
        if (this.getCapabilityValue('policy_enabled')) {
          await this._runPolicyCheck();
        } else if (this.p1Device) {
          // Policy disabled (predictive or user off): still record mode + SoC for the camera chart
          const mode = this.p1Device._currentDetailedMode
            || this.p1Device.getCapabilityValue('battery_group_charge_mode')
            || 'unknown';
          this._recordModeHistory(mode);
          this._recordSoCHistory(this.p1Device.getCapabilityValue('battery_group_average_soc') ?? 50);
        }
      }, intervalMs);
    }, msUntilNextSlot);

    // Hour-boundary run fires ~5s after each full hour as a belt-and-suspenders
    // safety net (e.g. when hourly prices change and no price refresh is pending).
    this._scheduleHourBoundary();

    this.log(`Policy check scheduled every ${intervalMinutes} minutes, aligned to slot boundaries`);
  }

  _scheduleHourBoundary() {
    const now = Date.now();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 5, 0); // 5 seconds past the hour
    nextHour.setHours(nextHour.getHours() + 1);
    const msUntilNextHour = nextHour.getTime() - now;

    this._hourBoundaryTimeout = this.homey.setTimeout(async () => {
      await this._maybeRefreshWeatherOnly().catch(() => {});
      if (this.getCapabilityValue('policy_enabled')) {
        this.log(`⏰ Hour boundary reached (${new Date().getHours()}:00) → running policy check`);
        await this._runPolicyCheck().catch(err => this.error('Hour-boundary policy check failed:', err));
      }
      // Schedule the next hour boundary
      this._scheduleHourBoundary();
    }, msUntilNextHour);
  }

  _schedulePriceRefresh() {
    // Adaptive interval: 15 min during price-release window (14:00–16:00 CET),
    // 30 min otherwise. kwhprice.eu publishes tomorrow's prices at ~13:15 CET.
    const getRefreshInterval = () => {
      const hour = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
      return (hour >= 14 && hour <= 16) ? 15 * 60 * 1000 : 30 * 60 * 1000;
    };

    const scheduleNext = () => {
      if (this.priceRefreshTimeout) {
        this.homey.clearTimeout(this.priceRefreshTimeout);
      }

      this.priceRefreshTimeout = this.homey.setTimeout(
        async () => {
          if (this._isPredictiveMode) {
            this.log('🔄 Price refresh skipped — predictive mode active');
            scheduleNext();
            return;
          }

          const settings = this.getSettings();

          if (settings.enable_dynamic_pricing && this.tariffManager.dynamicProvider) {
            const now = new Date();
            const nowAms = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            this.log(`🔄 Refreshing prices... (${nowAms} Amsterdam)`);

            try {
              // Force-refresh the merged provider (fetches Xadi + KwhPrice concurrently)
              await this.tariffManager.mergedProvider.fetchPrices(true);
              const priceCount = this.tariffManager.mergedProvider.cache?.length || 0;
              const sources    = this.tariffManager.mergedProvider.lastFetchSources.join('+');
              const days       = priceCount > 24 ? 'today + tomorrow' : 'today only';
              this.log(`✅ Prices refreshed: ${priceCount}h (${days}, sources: ${sources})`);

              if (priceCount > 0 && this.getCapabilityValue('policy_enabled')) {
                // Always recompute optimizer after price refresh — new data may include
                // tomorrow's prices (96→192 slots) that change the optimal schedule.
                this.optimizationEngine.updateSettings({});
                await this._runPolicyCheck();
              } else if (priceCount > 0) {
                // Policy disabled — run DP in read-only mode (no mode apply) so
                // projectedProfit stays current for tracking even on manual-control days.
                try {
                  const inputs = await this._gatherInputs();
                  if (inputs.battery && inputs.tariff) {
                    this.optimizationEngine.updateSettings({});
                    await this._recomputeOptimizer(inputs);
                  }
                } catch (e) {
                  this.error('Predictive DP (policy off) failed:', e.message);
                }
                this._updateProfitTracking();
              }
            } catch (err) {
              this.error('❌ Price refresh failed:', err);
            }
          }

          scheduleNext();
        },
        getRefreshInterval()
      );
    };

    scheduleNext();
    this.log(`Price refresh scheduled (adaptive: ${getRefreshInterval() / 60000}min, frequent 14:00–16:00)`);
  }

  async _updateWeather() {
    try {
      const settings = this.getSettings();

      if (settings.tariff_type !== 'dynamic') {
        this.weatherData = null;

        await this.setCapabilityValue('sun_score', 0).catch(this.error);
        await this.setCapabilityValue('predicted_sun_hours', 0).catch(this.error);

        this.log('Weather skipped (fixed tariff)');
        return;
      }

      const loc = this._getLocationFromSetting();
      if (!loc) return;

      const { latitude, longitude } = loc;

      const devSettings = this.getSettings();
      const pvTilt = devSettings.pv_estimation_enabled && typeof devSettings.pv_tilt === 'number' ? devSettings.pv_tilt : null;
      const pvAzimuth = devSettings.pv_estimation_enabled && typeof devSettings.pv_azimuth === 'number' ? devSettings.pv_azimuth : null;

      this.weatherData = await this.weatherForecaster.fetchForecast(latitude, longitude, pvTilt, pvAzimuth);

      // Buienradar: 5-min precipitation radar for next 2 hours (fire-and-forget, non-critical)
      this.weatherForecaster.fetchBuienradar(latitude, longitude)
        .then(data => {
          this.buienradarData = data;
          if (data.length > 0) {
            const rainingSlots = data.filter(s => s.mmPerHour >= 0.1);
            if (rainingSlots.length > 0) {
              const maxMmh = Math.max(...data.map(s => s.mmPerHour));
              this.log(`🌧️ Buienradar: ${rainingSlots.length}/24 slots met neerslag (max ${maxMmh.toFixed(1)} mm/u)`);
            }
          }
        })
        .catch(e => this.error('Buienradar update failed:', e));

      // Bereken verwachte PV-productie vandaag (kWh) op basis van straling + piekvermogen
      const pvCapW = devSettings.pv_capacity_w || 0;
      const PR     = devSettings.pv_performance_ratio || 0.75;
      if (Array.isArray(this.weatherData.dailyProfiles)) {
        const todayDate    = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
        const todayProfiles = this.weatherData.dailyProfiles.filter(h => h.time.toISOString().startsWith(todayDate));
        const yfs           = this.learningEngine?.getSolarYieldFactorsSmoothed();
        const learnedSlots  = this.learningEngine?.getSolarLearnedSlotCount() ?? 0;

        const now = new Date();
        const futureProfiles = todayProfiles.filter(h => h.time > now);

        let todayKwh, remainingKwh;
        if (learnedSlots >= 10) {
          // Learned model: sum(radiation × yieldFactor) / 1000 — no pvCapW or PR needed
          todayKwh = todayProfiles.reduce((sum, h) => {
            const slotIndex = h.time.getUTCHours() * 4;
            const yf = yfs[slotIndex] ?? 0;
            return sum + h.radiationWm2 * yf;
          }, 0) / 1000;
          remainingKwh = futureProfiles.reduce((sum, h) => {
            const slotIndex = h.time.getUTCHours() * 4;
            const yf = yfs[slotIndex] ?? 0;
            return sum + h.radiationWm2 * yf;
          }, 0) / 1000;
          this.log(`☀️ PV forecast (learned, ${learnedSlots} slots): ${todayKwh.toFixed(1)} kWh today, ${remainingKwh.toFixed(1)} kWh remaining`);
        } else if (pvCapW > 0) {
          // Fallback: configured capacity × performance ratio
          todayKwh     = todayProfiles.reduce((sum, h) => sum + pvCapW * PR * (h.radiationWm2 / 1000), 0) / 1000;
          remainingKwh = futureProfiles.reduce((sum, h) => sum + pvCapW * PR * (h.radiationWm2 / 1000), 0) / 1000;
          this.log(`☀️ PV forecast (fallback PR=${PR}, ${learnedSlots} slots learned): ${todayKwh.toFixed(1)} kWh today, ${remainingKwh.toFixed(1)} kWh remaining`);
        } else {
          todayKwh = null;
          remainingKwh = null;
        }
        this.weatherData.pvKwhToday     = todayKwh     !== null ? Math.round(todayKwh     * 10) / 10 : null;
        this.weatherData.pvKwhRemaining = remainingKwh !== null ? Math.round(remainingKwh * 10) / 10 : null;

        // Build per-hour PV forecast for the chart (today + tomorrow).
        // Uses dailyProfiles (all 24h, incl. past) so the chart line is complete and consistent.
        // Runs here — not in _recomputeOptimizer — so it updates even when the policy is disabled,
        // and chart values are NOT distorted by the accuracy-discount applied for optimizer planning.
        if (learnedSlots >= 10 || pvCapW > 0) {
          const nowFc          = new Date();
          const nowAmsDate     = nowFc.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
          const tomorrowAmsDate = new Date(nowFc.getTime() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
          const pvFcByDay      = [{}, {}];

          for (const h of this.weatherData.dailyProfiles) {
            const d     = h.time instanceof Date ? h.time : new Date(h.time);
            const hDate = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
            const dayIdx = hDate === nowAmsDate ? 0 : hDate === tomorrowAmsDate ? 1 : -1;
            if (dayIdx < 0) continue;
            const hHour = parseInt(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
            const s0    = d.getUTCHours() * 4;
            let pvPowerW;
            if (learnedSlots >= 10 && yfs) {
              const yf4 = [yfs[s0], yfs[s0+1], yfs[s0+2], yfs[s0+3]].filter(v => v != null && v > 0);
              const yf  = yf4.length > 0 ? yf4.reduce((a, b) => a + b, 0) / yf4.length : 0;
              const raw = Math.round(h.radiationWm2 * yf);
              pvPowerW  = pvCapW > 0 ? Math.min(raw, pvCapW) : raw;
            } else {
              pvPowerW  = pvCapW > 0 ? Math.min(pvCapW, Math.round(pvCapW * PR * (h.radiationWm2 / 1000))) : 0;
            }
            pvFcByDay[dayIdx][hHour] = pvPowerW;
          }

          // Only write chart if optimizer hasn't pushed a fresher blended forecast recently.
          // Prevents _updateWeather (1h cycle) from overwriting the 15-min optimizer chart.
          // Also skips the Solcast fetch — optimizer already blends Solcast, no extra API call needed.
          const blendAge = this._pvForecastBlendedAt ? Date.now() - this._pvForecastBlendedAt : Infinity;
          if (blendAge > 30 * 60 * 1000) {
            // Optimizer hasn't run recently (policy disabled or first startup): apply Solcast here.
            if (settings.solcast_enabled && settings.solcast_api_key && settings.solcast_resource_id) {
              if (!this._solcastProvider) {
                // eslint-disable-next-line global-require
                const SolcastProvider = require('../../lib/solcast-provider');
                this._solcastProvider = new SolcastProvider(this.homey);
              }
              try {
                const solcastForecast = await this._solcastProvider.getForecast(
                  settings.solcast_api_key,
                  settings.solcast_resource_id,
                );
                if (Array.isArray(solcastForecast) && solcastForecast.length > 0) {
                  let applied = 0;
                  for (const s of solcastForecast) {
                    const st = new Date(s.timestamp);
                    if (st <= nowFc) continue;
                    const sDate = st.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
                    const sIdx  = sDate === nowAmsDate ? 0 : sDate === tomorrowAmsDate ? 1 : -1;
                    if (sIdx < 0) continue;
                    const sHour = parseInt(st.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
                    pvFcByDay[sIdx][sHour] = s.pvPowerW;
                    applied++;
                  }
                  const scTodayKwh = Object.values(pvFcByDay[0]).reduce((s, w) => s + (w || 0), 0) / 1000;
                  const scTomKwh  = Object.values(pvFcByDay[1]).reduce((s, w) => s + (w || 0), 0) / 1000;
                  this.log(`[Solcast] Applied ${applied} future slots — chart forecast now: vandaag ${scTodayKwh.toFixed(1)} kWh, morgen ${scTomKwh.toFixed(1)} kWh`);
                }
              } catch (err) {
                this.log(`[Solcast] Chart forecast error: ${err.message}`);
              }
            }
            this._setLive('policy_pv_forecast_hourly', pvFcByDay);
          }
        }
      } else {
        this.weatherData.pvKwhToday = null;
      }

      const { sunshineNext4Hours: _s4, sunshineTodayRemaining: _st, sunshineTomorrow: _stom } = this.weatherData;
      const sunScore = Math.round(
        Math.min(50, (_s4 / 4) * 50) +
        Math.min(25, (_st / 8) * 25) +
        Math.min(25, (_stom / 10) * 25)
      );

      await this.setCapabilityValue('sun_score', sunScore);
      await this.setCapabilityValue(
        'predicted_sun_hours',
        parseFloat(this.weatherData.sunshineNext4Hours.toFixed(1))
      );

      this.log('Weather updated:', {
        sun4h: this.weatherData.sunshineNext4Hours,
        sunScore
      });

      if (this.learningEngine) {
        const ls  = this.learningEngine.getStatistics();
        const bF  = this.learningEngine.data?.radiation_bias_factor ?? 1.0;
        const yfs = this.learningEngine.getSolarLearnedSlotCount();
        this.log(`[Learning] days=${ls.days_tracking} samples=${ls.total_samples} coverage=${ls.pattern_coverage}% pv_acc=${ls.pv_accuracy}% | yield=${yfs}/96 slots bias=${bF.toFixed(3)}`);
        // Keep learning_status fresh even when policy/optimizer isn't running
        const rte = this.efficiencyEstimator?.getEfficiency();
        this._setLive('learning_status', {
          days:       ls.days_tracking,
          samples:    ls.total_samples,
          coverage:   ls.pattern_coverage,
          pvAccuracy: ls.pv_accuracy,
          rte:        rte != null ? +(rte * 100).toFixed(1) : null,
          cycles:     this.efficiencyEstimator?.getCycleCount() ?? 0,
          updatedAt:  new Date().toISOString(),
        });
      }

      if (this._isPredictiveMode) {
        // Predictive mode: alleen PV camera verversen, optimizer niet aanraken
        if (!this.planningImagePv) this._initPvCamera().catch(() => {});
        else this.planningImagePv.update().catch(() => {});
        return;
      }

      // When policy is disabled (user off, not predictive): refresh PV camera with fresh forecast.
      // After a restart planningImagePv is null (only _updatePlanningChart initialises it, which
      // only runs after a policy run). Call _initPvCamera so the camera is registered with Homey
      // and shows the correct today forecast rather than a stale cached image.
      if (!this.getCapabilityValue('policy_enabled')) {
        if (!this.planningImagePv) this._initPvCamera().catch(() => {});
        else this.planningImagePv.update().catch(() => {});
      }

      // Invalidate optimizer — new PV forecast may change the optimal charge schedule.
      this.optimizationEngine.updateSettings({});

    } catch (error) {
      this.error('Weather update failed:', error);
    }
  }

  async _migrateWeatherLocation() {
    const settings = this.getSettings();
    if (settings.weather_latitude && settings.weather_latitude !== 0) return; // already migrated

    const oldLoc = settings.weather_location;
    if (!oldLoc || oldLoc.trim() === '') return; // nothing to migrate

    try {
      let lat, lon;

      if (oldLoc.includes(',')) {
        const [a, b] = oldLoc.split(',').map(v => parseFloat(v.trim()));
        if (!isNaN(a) && !isNaN(b)) { lat = a; lon = b; }
      } else {
        const geo = await this.weatherForecaster.lookupCity(oldLoc.trim());
        if (geo) { lat = geo.latitude; lon = geo.longitude; }
      }

      if (lat != null && lon != null) {
        await this.setSettings({ weather_latitude: lat, weather_longitude: lon });
        this.log(`Migrated weather_location "${oldLoc}" → lat=${lat}, lon=${lon}`);
      } else {
        this.error(`Could not migrate weather_location "${oldLoc}" — user must re-enter coordinates`);
      }
    } catch (err) {
      this.error('Weather location migration failed:', err);
    }
  }

  _getLocationFromSetting() {
    const settings = this.getSettings();

    if (settings.tariff_type !== 'dynamic') {
      return null;
    }

    const lat = settings.weather_latitude;
    const lon = settings.weather_longitude;

    if (!lat || !lon || lat === 0 || lon === 0) {
      this.error('Weather location not set (dynamic mode)');
      return null;
    }

    return { latitude: lat, longitude: lon };
  }

  // Refresh weather + PV forecast when policy is disabled (no full policy run needed).
  async _maybeRefreshWeatherOnly() {
    const settings = this.getSettings();
    if (settings.tariff_type !== 'dynamic') return;
    const intervalMs = (settings.weather_update_interval || 1) * 3_600_000;
    const age = this.weatherData?.fetchedAt ? Date.now() - this.weatherData.fetchedAt : Infinity;
    if (age > intervalMs) {
      await this._updateWeather();
    }
  }

  async _runPolicyCheck({ skipEnabledCheck = false } = {}) {
    if (this._policyCheckRunning) {
      this.log('Policy check already in progress, skipping concurrent call');
      return;
    }
    this._policyCheckRunning = true;
    try {
      if (!skipEnabledCheck && !this.getCapabilityValue('policy_enabled')) {
        this.log('Policy disabled, skipping check');
        return;
      }

      const overrideUntil = this.getStoreValue('override_until');
      if (overrideUntil && new Date(overrideUntil) > new Date()) {
        this.log('Manual override active, skipping policy check');
        return;
      }

      // Record mode history + detect predictive mode (altijd, ook bij overrides)
      if (this.p1Device) {
        const currentHwMode = this.p1Device.getCapabilityValue('battery_group_charge_mode');
        const currentSoC = this.p1Device.getCapabilityValue('battery_group_average_soc') ?? 50;
        // Use detailed mode from energy_v2 when available (predictive sub-types)
        const detailedMode = this.p1Device._currentDetailedMode || currentHwMode || 'unknown';
        this._recordModeHistory(detailedMode);
        this._recordSoCHistory(currentSoC);

        // ⭐ HW Slim laden (predictive) actief → policy uitschakelen
        if (currentHwMode === 'predictive') {
          if (!this._isPredictiveMode) {
            this._isPredictiveMode = true;
            // Save current policy_enabled state and disable — the P1 poll restores it when predictive ends
            this._policyEnabledBeforePredictive = this.getCapabilityValue('policy_enabled') ?? false;
            await this.setCapabilityValue('policy_enabled', false).catch(this.error);
            this.log('🤖 HW Slim laden (predictive) actief — battery-policy uitgeschakeld');
            // Planning-webcams invalideren zodat ze leeg tonen
            this.planningImageToday?.update().catch(() => {});
            this.planningImageTomorrow?.update().catch(() => {});
            this.planningImagePv?.update().catch(() => {});
          }
          await this.setCapabilityValue('explanation_summary', `Slim laden: actief - SoC ${currentSoC}%`).catch(this.error);
          // Record predictive mode in planning chart history
          try {
            const modeHistory = this.homey.settings.get('policy_mode_history') || [];
            const nowTs  = new Date();
            const bucket = Math.round(nowTs.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
            const existing = modeHistory.findIndex(
              h => Math.round(new Date(h.ts).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000) === bucket
            );
            const entry = { ts: nowTs.toISOString(), hwMode: 'predictive', soc: currentSoC, price: null };
            if (existing >= 0) modeHistory[existing] = entry;
            else modeHistory.push(entry);
            if (modeHistory.length > 192) modeHistory.splice(0, modeHistory.length - 192);
            this._queueSettingsPersist('policy_mode_history', modeHistory);
          } catch (e) { this.error('Failed to save predictive mode history:', e); }
          // Still recompute DP + update widget so planning stays fresh
          try {
            const inputs = await this._gatherInputs();
            if (inputs?.tariff) {
              this.optimizationEngine.updateSettings({});
              await this._recomputeOptimizer(inputs);
              // Patch live SoC into battery_policy_state so widget shows correct value
              const ps = this._liveState.battery_policy_state
                ?? this.homey.settings.get('battery_policy_state') ?? {};
              ps.batterySOC = currentSoC;
              ps.currentMode = 'predictive';
              this._setLive('battery_policy_state', ps);
              this._saveWidgetData({ skipChart: true });
            }
          } catch (e) { this.error('Predictive recompute failed:', e.message); }
          return;
        }
      }

      const inputs = await this._gatherInputs();
      if (!inputs.battery || inputs.battery.stateOfCharge === undefined) {
        this.log('Skipping policy check — battery state not ready');
        return;
      }

      // Recompute optimizer schedule if stale (lazy, every ~90 min or after price update),
      // or when intra-day conditions have drifted significantly from the last DP run.
      const currentSoc = inputs.battery?.stateOfCharge ?? null;
      if ((this.optimizationEngine.isStale() || this._shouldForceReoptimize(currentSoc)) && inputs.tariff) {
        await this._recomputeOptimizer(inputs);
      }
      inputs.optimizer = this.optimizationEngine;
      inputs.optimizerSlots = this.optimizationEngine._schedule?.slots ?? null;

      const result = this.policyEngine.calculatePolicy(inputs);

      // Free large price arrays before loading the explainability engine.
      // generateExplanation() in the DP path only reads inputs.tariff.currentPrice
      // (a single number) — it never touches allPrices15min / effectivePrices / allPrices.
      // Nulling these here frees ~300–500 KB of V8 heap before the 10–15 MB engine load.
      if (inputs.tariff) {
        inputs.tariff.allPrices15min = null;
        inputs.tariff.effectivePrices = null;
        inputs.tariff.allPrices = null;
        inputs.tariff.next24Hours = null;
      }

      // ------------------------------------------------------
      // 📊 LEARNING: Apply confidence adjustment based on history
      // ------------------------------------------------------
      const confidenceAdjustment = this.learningEngine.getConfidenceAdjustment(
        result.hwMode || result.policyMode,
        {
          soc: inputs.battery?.stateOfCharge ?? 0,
          sun4h: inputs.weather?.sun4h ?? 0
        }
      );
      
      if (confidenceAdjustment !== 0) {
        const originalConfidence = result.confidence;
        result.confidence = Math.round(Math.max(0, Math.min(100, result.confidence + confidenceAdjustment)));
        this.log(`📊 Learning adjusted confidence: ${originalConfidence} → ${result.confidence} (${confidenceAdjustment > 0 ? '+' : ''}${confidenceAdjustment})`);
      }

      // Guard: skip explainability when heap is already high — the engine adds ~25 MB
      // which pushes total above the Homey memory ceiling (~65 MB heap).
      let _heapBeforeExplain = 50; // conservative default: skip
      try { _heapBeforeExplain = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      let explanation = null;
      if (_heapBeforeExplain > 35) {
        this.log(`[MEM] Skipping explainability — heap ${_heapBeforeExplain.toFixed(1)} MB > 35 MB guard`);
      } else {
        if (!this.explainabilityEngine) {
          this.explainabilityEngine = new (require('../../lib/explainability-engine'))(this.homey);
        }
        explanation = this.explainabilityEngine.generateExplanation(
          result,
          inputs,
          result.scores
        );
        this.homey.api.realtime('explainability_update', explanation);
        this._setLive('policy_explainability', explanation);
        this.log('Saving explainability length:', JSON.stringify(explanation).length);
      }
      
      const recommended = result.hwMode || result.policyMode || 'standby';
      
      // Push planning data to app settings for the settings page
      const batterySOC = inputs.battery?.stateOfCharge ?? 50;
      const policyMode = this.getCapabilityValue('policy_mode') || 'balanced';
      const dpAction = this.optimizationEngine?.getSlot(new Date()) ?? null;
      const planningData = {
        batterySOC,
        policyMode,
        recommendedMode: recommended,
        currentMode: recommended, // will be overwritten below with actual HW mode
        dpAction,                 // DP-planned action for current slot ('charge'|'discharge'|'preserve')
        maxDischargePowerW: inputs.battery?.maxDischargePowerW || 800,
        maxChargePowerW: inputs.battery?.maxChargePowerW || 800,
        totalCapacityKwh: inputs.battery?.totalCapacityKwh || null,
        batteryCount: Math.max(1, Math.round((inputs.battery?.totalCapacityKwh ?? 2.688) / 2.688)),
        pvLearnedSlots: this.learningEngine?.getSolarLearnedSlotCount() ?? 0,
        avgCost: inputs.batteryCost?.avgCost ?? 0,
        lastUpdate: new Date().toISOString()
      };
      this._setLive('battery_policy_state', planningData);

      // Push device settings to app settings so planning page can read them
      // (device settings are not accessible via Homey.get() in the settings page)
      this._setLive('device_settings', {
        max_charge_price:    this.getSetting('max_charge_price')    || 0.19,
        min_discharge_price: this.getSetting('min_discharge_price') || 0.22,
        min_soc:             this.getSetting('min_soc')             || 10,
        max_soc:             this.getSetting('max_soc')             || 95,
        battery_efficiency:  this.getSetting('battery_efficiency') || 0.75,
        min_profit_margin:   this.getSetting('min_profit_margin')   || 0.01,
        tariff_type:         this.getSetting('tariff_type')         || 'dynamic',
        policy_interval:     this.getSetting('policy_interval')     || 15,
        pv_capacity_w:          this.getSetting('pv_capacity_w')          || 0,
        pv_estimation_enabled:  this.getSetting('pv_estimation_enabled')  || false,
        pv_performance_ratio:   this.getSetting('pv_performance_ratio')   || 0.75,
        price_resolution:    this.getSetting('price_resolution')    || '15min',
      });
      // debug_top3 writes moved to _gatherInputs (single write)

      // Update battery RTE display
      // Use learned efficiency with safety bounds (learned can be from old data)
      let currentRte = this.efficiencyEstimator.getEfficiency();
      
      // Safety: Cap at realistic range for LFP batteries (AC-AC typically 70-97%)
      // If learned value is unrealistic, fall back to configured value
      const configuredRte = this.getSetting('battery_efficiency') || 0.75;
      if (currentRte < 0.50 || currentRte > 0.97) {
        this.log(`⚠️ Learned RTE ${(currentRte * 100).toFixed(1)}% outside realistic range for LFP, using configured ${(configuredRte * 100).toFixed(1)}%`);
        currentRte = configuredRte;
        // Reset the estimator to configured value
        this.efficiencyEstimator.reset(configuredRte);
      }
      
      await this.setCapabilityValue('battery_rte', parseFloat((currentRte * 100).toFixed(1))).catch(this.error);
      this._queueSettingsPersist('battery_efficiency_effective', currentRte);

      await this.setCapabilityValue('recommended_mode', recommended);

      await this.setCapabilityValue('confidence_score', result.confidence);
      // explanation_summary shows the ACTIVE mode, not the recommended mode
      const currentActiveMode = this.getCapabilityValue('active_mode') || recommended;
      const activeSummary = this.explainabilityEngine
        ? this.explainabilityEngine._generateShortSummary({ hwMode: currentActiveMode }, inputs)
        : currentActiveMode;
      await this.setCapabilityValue('explanation_summary', activeSummary);
      await this.setCapabilityValue('last_update', new Date().toISOString());

      const previousMode = this.lastRecommendation?.hwMode || this.lastRecommendation?.policyMode;
      const currentMode = result.hwMode || result.policyMode;
      const modeChanged = previousMode !== currentMode;

      if (modeChanged && this.getSetting('enable_policy_notifications')) {
        try {
          await this.homey.notifications.createNotification({
            excerpt: explanation?.summary || currentMode
          });
        } catch (err) {
          this.error('Failed to send policy notification:', err);
        }
      }

      this.lastRecommendation = result;

      this.log('Policy check complete:', {
        mode: currentMode,
        confidence: result.confidence,
        summary: explanation?.summary
      });

      // Store compact diagnostic for user-facing troubleshooting (settings page).
      if (result.debug) {
        result.debug.appVersion = require('../../app.json').version;
        this._setLive('policy_last_run_debug', result.debug);
      }

      // ------------------------------------------------------
      // 📊 LEARNING: Record policy decision
      // ------------------------------------------------------
      await this.learningEngine.recordPolicyDecision(currentMode, {
        soc: inputs.battery?.stateOfCharge ?? 0,
        price: inputs.tariff?.currentPrice ?? 0,
        sun4h: inputs.weather?.sun4h ?? 0,
        confidence: result.confidence
      }).catch(err => this.error('Learning policy recording failed:', err));

      // Chart generation disabled — skip to save memory

      this._lastTariffInfo = inputs.tariff ?? null;
      await this._triggerRecommendationChanged(result, explanation);
      this._checkFavorableWindow(inputs.tariff);

      const autoApplyEnabled = this.getCapabilityValue('auto_apply');
      this.log(`Auto-apply status: ${autoApplyEnabled ? 'ENABLED' : 'DISABLED'}`);

      if (autoApplyEnabled) {
        const applyMode = result.hwMode || result.policyMode;
        this.log(`📋 Policy recommendation: ${result.policyMode} → HW mode: ${applyMode}`);
        this.log(`📊 Scores: charge=${result.scores?.charge}, discharge=${result.scores?.discharge}, preserve=${result.scores?.preserve}`);
        this.log(`🎯 Attempting to apply: ${applyMode} (confidence: ${result.confidence}%)`);
        
        const minConfidence = this.getSetting('min_confidence_threshold') ?? 60;
        const applied = await this._applyRecommendation(applyMode, result.confidence);

        if (applied) {
          this.log(`✅ Successfully applied: ${applyMode}`);

          // Warn when real-time policy deviates from the DP's planned action.
          // Suppress when DP=preserve + PV active → zero_charge_only: not a real deviation,
          // DP prices the slot as neutral and PV charging happens automatically.
          const _dpAction = this.optimizationEngine?.getSlot(new Date()) ?? null;
          const _isPvCharge = applyMode === 'zero_charge_only' && this._pvState;
          if (_dpAction && _dpAction !== result.policyMode && !_isPvCharge) {
            this.log(`⚠️ PLAN AFWIJKING: DP gepland ${_dpAction} maar policy koos ${result.policyMode} → hwMode ${applyMode}`);
          }
        } else {
          if (result.confidence < minConfidence) {
            this.log(`⏸️ Not applied: confidence ${result.confidence.toFixed(1)}% below threshold ${minConfidence}%`);
          } else {
            this.log(`⚠️ Failed to apply recommendation — check P1 connection`);
          }
        }

        // Always track SOC + mode history for the planning chart, regardless of whether
        // the mode was successfully applied. This ensures the SOC line starts from
        // the beginning of the day even when the battery isn't responding yet.
        try {
          const modeHistory = this.homey.settings.get('policy_mode_history') || [];
          const currentPrice = result.tariff?.currentPrice ?? null;
          const currentSoc   = this.getCapabilityValue('battery_soc_mirror') ?? null;
          const nowTs   = new Date();
          const bucket  = Math.round(nowTs.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
          const existing = modeHistory.findIndex(
            h => Math.round(new Date(h.ts).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000) === bucket
          );
          const entry = {
            ts:     nowTs.toISOString(),
            hwMode: applyMode,
            price:  currentPrice,
            soc:    currentSoc,
            maxChargePrice: this.getSetting('max_charge_price'),
            minDischargePrice: this.getSetting('min_discharge_price')
          };
          if (existing >= 0) {
            // Update existing bucket — keep best SoC (non-null wins)
            if (entry.soc == null) entry.soc = modeHistory[existing].soc;
            modeHistory[existing] = entry;
          } else {
            modeHistory.push(entry);
          }
          // Keep last 192 entries (48h headroom — extra triggers won't push out early-morning data)
          if (modeHistory.length > 192) modeHistory.splice(0, modeHistory.length - 192);
          this._queueSettingsPersist('policy_mode_history', modeHistory);
        } catch (e) {
          this.error('Failed to save mode history:', e);
        }
      } else {
        this.log('Auto-apply disabled — recommendation not applied');
      }

      // Update active_mode to reflect the hardware's current actual mode
      if (this.p1Device) {
        const actualHwMode = this.p1Device.getCapabilityValue('battery_group_charge_mode');
        if (actualHwMode) {
          await this.setCapabilityValue('active_mode', actualHwMode).catch(this.error);
          // Patch currentMode in already-saved planningData
          planningData.currentMode = actualHwMode;
          this._setLive('battery_policy_state', planningData);

          // Always sync explanation_summary to the actual hardware mode
          if (this.explainabilityEngine) {
            const hwActiveSummary = this.explainabilityEngine._generateShortSummary(
              { hwMode: actualHwMode },
              inputs
            );
            await this.setCapabilityValue('explanation_summary', hwActiveSummary).catch(this.error);
          }
        }
      }

      // Release ExplainabilityEngine after use — module stays compiled in V8 cache,
      // re-instantiation next run is free. Frees ~10–15 MB on memory-constrained devices.
      this.explainabilityEngine = null;

      // Push compact data to the dashboard widget
      try { this._saveWidgetData(); } catch (e) { this.error('Widget data save failed:', e); }

    } catch (error) {
      this.error('Policy check failed:', error);
      await this.setCapabilityValue('explanation_summary',
        `Error: ${error.message}`
      );
    } finally {
      this._policyCheckRunning = false;
    }
  }

  _saveWidgetData({ skipChart = false } = {}) {
    const schedule  = this._liveState.policy_optimizer_schedule
      ?? this.homey.settings.get('policy_optimizer_schedule') ?? [];
    const state     = this._liveState.battery_policy_state
      ?? this.homey.settings.get('battery_policy_state') ?? {};
    const use1h     = this.getSetting('price_resolution') === '1h';
    const priceData = use1h
      ? (this.homey.settings.get('policy_all_prices') || [])
      : (this.homey.settings.get('policy_all_prices_15min') || []);
    const step      = use1h ? 3600 * 1000 : 15 * 60 * 1000;
    const now       = Date.now();

    // Midnight of today in Amsterdam time (used to include past hours of today)
    // Subtract Amsterdam time-of-day from now — avoids parsing locale strings (unreliable on Node.js)
    const todayStart = (() => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date(now));
      const amH = +parts.find(p => p.type === 'hour').value % 24;
      const amM = +parts.find(p => p.type === 'minute').value;
      const amS = +parts.find(p => p.type === 'second').value;
      return now - ((amH * 3600 + amM * 60 + amS) * 1000 + (now % 1000));
    })();

    // Helper: Amsterdam hour from timestamp
    const amhour = ts => parseInt(
      new Date(ts).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }),
      10
    );

    // Future slots from the optimizer schedule (include current slot via -15min buffer)
    // Use step as grace period so the current slot is never lost in the gap
    // between past-loop cutoff (now - step) and future filter (now - 15min)
    const currentSoc = state.batterySOC ?? null;
    const futureSlots = schedule
      .filter(s => new Date(s.timestamp).getTime() >= now - step)
      .slice(0, 192)
      .map(s => {
        const ts = new Date(s.timestamp).getTime();
        return {
          ts,
          hour:  amhour(ts),
          price: s.price        != null ? Math.round(s.price        * 10000) / 10000 : null,
          mode:  s.hwMode       || 'standby',
          soc:   s.socProjected != null ? Math.round(s.socProjected) : null,
          pvW:   Math.round(s.pvW ?? 0)
        };
      });

    // Re-simulate future SoC trajectory from the real current SoC.
    // The optimizer schedule may have been computed hours ago with a different starting SoC,
    // leading to a stale projection (e.g. showing 100% while battery is actually at 37%).
    // Instead of a simple delta-shift (breaks when all projected values are equal),
    // walk forward from the real SoC and simulate charge/discharge per slot using
    // the planned mode and PV power already stored in each slot.
    if (currentSoc != null && futureSlots.length > 0) {
      const capacityKwh  = state.totalCapacityKwh || this.getSetting('pv_capacity_w') ? null : 2.688;
      const capKwh       = state.totalCapacityKwh || 2.688;
      const maxChargeW   = state.maxChargePowerW  || 800;
      const maxDischargeW = state.maxDischargePowerW || 800;
      const rte          = this.efficiencyEstimator?.getEfficiency() ?? 0.75;
      const slotH        = step / 3_600_000; // 1 for hourly, 0.25 for 15-min
      const maxSoc       = this.getSetting('max_soc') ?? 95;
      const minSoc       = this.getSetting('min_soc') ?? 0;

      let simSoc = currentSoc;
      for (const slot of futureSlots) {
        slot.soc = Math.round(simSoc);
        const pvW = slot.pvW || 0;
        if (slot.mode === 'to_full') {
          // Charge at max rate from grid
          const deltaKwh = (maxChargeW / 1000) * slotH * rte;
          simSoc += (deltaKwh / capKwh) * 100;
        } else if (slot.mode === 'zero_charge_only') {
          // Charge from PV only — effective rate is min(pvW, maxChargeW)
          const chargeW = Math.min(pvW, maxChargeW);
          const deltaKwh = (chargeW / 1000) * slotH * rte;
          simSoc += (deltaKwh / capKwh) * 100;
        } else if (slot.mode === 'zero_discharge_only') {
          // Discharge at max rate
          const deltaKwh = (maxDischargeW / 1000) * slotH;
          simSoc -= (deltaKwh / capKwh) * 100;
        }
        // standby / zero: no SoC change
        simSoc = Math.max(minSoc, Math.min(maxSoc, simSoc));
      }
    }

    // Past slots from mode history (has real soc + mode) — keyed by rounded 15-min ts
    const modeHistory = this.homey.settings.get('policy_mode_history') || [];
    const historyMap  = new Map();
    for (const h of modeHistory) {
      const ts15 = Math.round(new Date(h.ts).getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
      if (!historyMap.has(ts15)) historyMap.set(ts15, h);
    }

    // Build price lookup from price cache (15min or hourly depending on resolution)
    const priceMap = new Map();
    for (const p of priceData) {
      const ts = new Date(p.timestamp).getTime();
      if (use1h) {
        // Hourly prices: cover the full hour (4 × 15min slots for backward compat)
        for (let q = 0; q < 4; q++) priceMap.set(ts + q * 15 * 60 * 1000, p.price);
      } else {
        priceMap.set(ts, p.price);
      }
    }

    // Actual PV per hour today (index = Amsterdam hour)
    const pvActual = this.homey.settings.get('policy_pv_actual_today');
    const pvHourly = Array.isArray(pvActual?.hourly) ? pvActual.hourly : [];

    const futureTs  = new Set(futureSlots.map(s => s.ts));
    const pastSlots = [];
    for (let ts = todayStart; ts < now - step; ts += step) {
      if (futureTs.has(ts)) continue;
      const h   = historyMap.get(ts);
      const hr  = amhour(ts);
      // Interpolate between adjacent hourly actual PV values for smooth bell curve
      const minInHour = Math.floor((ts % 3600000) / 60000);
      const frac = minInHour / 60;
      const v0 = pvHourly[hr]     ?? 0;
      const v1 = pvHourly[hr + 1] ?? 0;
      const pvW = Math.round(v0 + (v1 - v0) * frac);
      pastSlots.push({
        ts,
        hour:  hr,
        price: priceMap.has(ts) ? Math.round(priceMap.get(ts) * 10000) / 10000 : (h?.price ?? null),
        mode:  h?.hwMode || 'past',
        soc:   h?.soc    != null ? Math.round(h.soc) : null,
        pvW
      });
    }

    // If the optimizer ran hourly but the display step is 15-min, expand future slots
    // to 15-min resolution by interpolating between hourly entries. Without this the
    // future part of the chart is 4× coarser than the past, making a 4-hour SoC rise
    // look like it happens in 1 slot (visual distortion).
    const SLOT_15 = 15 * 60 * 1000;
    let expandedFuture = futureSlots;
    if (!use1h && futureSlots.length >= 2) {
      const slotGap = futureSlots[1].ts - futureSlots[0].ts;
      if (slotGap > SLOT_15) {
        expandedFuture = [];
        for (let i = 0; i < futureSlots.length; i++) {
          const cur  = futureSlots[i];
          const next = futureSlots[i + 1];
          expandedFuture.push(cur);
          if (next) {
            const steps = Math.round((next.ts - cur.ts) / SLOT_15);
            for (let q = 1; q < steps; q++) {
              const ts = cur.ts + q * SLOT_15;
              expandedFuture.push({
                ts,
                hour:  amhour(ts),
                price: cur.price,
                mode:  cur.mode,
                soc:   (cur.soc != null && next.soc != null)
                  ? Math.round(cur.soc + (next.soc - cur.soc) * q / steps)
                  : cur.soc,
                pvW:   cur.pvW,
              });
            }
          }
        }
      }
    }

    // For future slots that have already started (ts < now), use actual pvHourly data
    // so the chart doesn't drop to 0 when the optimizer reruns with stale/missing PV.
    if (pvHourly.length > 0) {
      for (const slot of expandedFuture) {
        if (slot.ts < now) {
          const hr = amhour(slot.ts);
          const minInHour = Math.floor((slot.ts % 3600000) / 60000);
          const v0 = pvHourly[hr]     ?? 0;
          const v1 = pvHourly[hr + 1] ?? 0;
          slot.pvW = Math.round(v0 + (v1 - v0) * (minInHour / 60));
        }
      }
    }

    const slots = [...pastSlots, ...expandedFuture]
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 192); // max 48h worth of 15-min slots
    const compact = {
      currentSoc:   state.batterySOC   ?? null,
      currentMode:  state.currentMode  ?? 'standby',
      currentPrice: futureSlots[0]?.price ?? null,
      pvCapacityW:  this.getSetting('pv_capacity_w') || 0,
      updatedAt:    new Date().toISOString(),
      slots
    };
    // In-memory cache — widget api.js reads via driver.getDevices()[0]._widgetData.
    // Avoids the ~30 MB heap spike that homey.settings.set allocates per call
    // (measured: 8 KB payload triggered 30 MB framework-internal allocation).
    this._widgetData = compact;
    this.homey.api.realtime('planning-update', compact);
    this.log(`[Widget] Data saved: ${slots.length} slots`);

    // Camera image in device UI (fire-and-forget)
    // skipChart=true at startup to avoid 3 concurrent HTTP requests during memory-critical boot.
    // Deferred 8s: policy runs push heap to ~60 MB; GC settles back to ~29 MB within 5s.
    // Calling immediately would always trip the 35 MB heap guard and never update the chart.
    if (!skipChart) {
      this.homey.setTimeout(
        () => this._updatePlanningChart(compact).catch(e => this.error('Camera image update failed:', e)),
        8000,
      );
    }
  }

  /**
   * Returns true when intra-day conditions have drifted enough from the last DP
   * run that a forced recompute is warranted — even if the schedule isn't stale yet.
   *
   * Two triggers:
   *  1. SoC deviation >15 pp from the projected SoC of the current slot.
   *  2. PV intraday ratio changed by >25% relative to the ratio used in the last run.
   */
  _shouldForceReoptimize(currentSoc) {
    const schedule = this.optimizationEngine._schedule;
    if (!schedule?.slots?.length) return false;

    // ── Trigger 1: SoC deviation ─────────────────────────────────────────────
    if (currentSoc != null) {
      const nowMs = Date.now();
      // Find the slot whose timestamp is closest to (and ≤) now.
      const currentSlot = schedule.slots
        .filter(s => new Date(s.timestamp).getTime() <= nowMs)
        .at(-1);
      if (currentSlot?.socProjected != null) {
        const socDelta = Math.abs(currentSoc - currentSlot.socProjected);
        if (socDelta > 15) {
          this.log(`[Reopt] SoC deviation ${socDelta.toFixed(1)} pp (actual ${currentSoc}% vs projected ${currentSlot.socProjected}%) → forcing recompute`);
          return true;
        }
      }
    }

    // ── Trigger 2: PV intraday ratio drift ───────────────────────────────────
    if (this._lastIntradayPvRatio != null &&
        this.learningEngine &&
        Array.isArray(this.learningEngine.data?.pv_predictions)) {
      const now = new Date();
      const nowMs = now.getTime();
      const cutoffMs = nowMs - 3 * 3_600_000;
      const preds = this.learningEngine.data.pv_predictions.filter(p =>
        p.timestamp >= cutoffMs && p.timestamp <= nowMs &&
        p.predicted > 50 && p.actual > 50
      );
      if (preds.length >= 4) {
        const sumF = preds.reduce((s, p) => s + p.predicted, 0);
        const sumA = preds.reduce((s, p) => s + p.actual,    0);
        const currentRatio = Math.min(2.5, Math.max(0.4, sumA / sumF));
        const ratioDelta = Math.abs(currentRatio - this._lastIntradayPvRatio);
        if (ratioDelta > 0.25) {
          this.log(`[Reopt] PV ratio drift ${ratioDelta.toFixed(2)} (was ${this._lastIntradayPvRatio.toFixed(2)}, now ${currentRatio.toFixed(2)}) → forcing recompute`);
          return true;
        }
      }
    }

    // Throttled diagnostic log — once per hour so you can verify the check is running
    // and see current values without flooding the log.
    const nowMs = Date.now();
    if (!this._lastReoptDiagLog || nowMs - this._lastReoptDiagLog > 3_600_000) {
      this._lastReoptDiagLog = nowMs;
      const schedule = this.optimizationEngine._schedule;
      const currentSlot = schedule?.slots?.filter(s => new Date(s.timestamp).getTime() <= nowMs).at(-1);
      const socDelta = (currentSoc != null && currentSlot?.socProjected != null)
        ? Math.abs(currentSoc - currentSlot.socProjected).toFixed(1) : '—';
      const pvRatio = this._lastIntradayPvRatio?.toFixed(2) ?? '—';
      this.log(`[Reopt] No trigger — SoC delta=${socDelta}pp, PV ratio at last run=${pvRatio}`);
    }
    return false;
  }

  /**
   * Update today's profit tracking entry in expansion_profit_history.
   * Compares DP projected profit with realized cycle profits.
   * Called from expansion analysis (inside _saveWidgetData), from price refresh
   * when policy is disabled, and from the mode-flush interval during predictive mode.
   *
   * @param {object|null} todayEntry     - Existing today-entry to mutate in-place, or null
   *   to load/create from settings (standalone call path).
   * @param {boolean}     predictiveActive - True when HW Slim Laden is controlling the battery.
   *   Stored in the entry so the UI can show a badge on those days.
   */
  _updateProfitTracking(todayEntry = null, predictiveActive = false) {
    try {
      const today = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
      let hist = null;
      let ownedEntry = false;

      if (!todayEntry) {
        hist = this.homey.settings.get('expansion_profit_history') || { entries: [] };
        if (!Array.isArray(hist.entries)) hist.entries = [];
        const last = hist.entries[hist.entries.length - 1];
        if (!last || last.date !== today) {
          todayEntry = { date: today };
          hist.entries.push(todayEntry);
          if (hist.entries.length > 30) hist.entries = hist.entries.slice(-30);
        } else {
          todayEntry = last;
        }
        ownedEntry = true;
      }

      const projectedProfit = this.optimizationEngine._schedule?.projectedProfit ?? 0;
      todayEntry.projectedProfit = +projectedProfit.toFixed(4);

      const cycleHistory = this.homey.settings.get('battery_cycle_history') || [];
      const actualProfit = cycleHistory
        .filter(c => c.date === today)
        .reduce((sum, c) => sum + (c.profitEur || 0), 0);
      todayEntry.actualProfit = +actualProfit.toFixed(4);

      if (projectedProfit > 0.001) {
        todayEntry.trackingError = +((actualProfit - projectedProfit) / projectedProfit * 100).toFixed(1);
      }

      if (predictiveActive) todayEntry.predictiveActive = true;

      if (ownedEntry) this._queueSettingsPersist('expansion_profit_history', hist);
    } catch (e) {
      this.error('_updateProfitTracking failed:', e.message);
    }
  }

  /**
   * (Re)compute the OptimizationEngine schedule from the current inputs.
   * Called lazily in _runPolicyCheck whenever the schedule is stale.
   */
  async _recomputeOptimizer(inputs) {
    // Use 15-min prices unless price_resolution is set to '1h'
    const now = new Date();
    const use15min = inputs.settings?.price_resolution !== '1h';
    const raw15min = use15min ? inputs.tariff?.allPrices15min : null;
    // Only keep future prices: DP forward pass starts at currentSoc, so including
    // past hours causes simulated SoC to diverge from reality by the current slot.
    const hourBoundary = new Date(now);
    hourBoundary.setMinutes(0, 0, 0);
    const rawPrices = (raw15min?.length > 0)
      ? raw15min.filter(p => new Date(p.timestamp) >= now)
      : (inputs.tariff?.allPrices || inputs.tariff?.next24Hours)?.filter(p => new Date(p.timestamp) >= hourBoundary);
    const prices = rawPrices;
    if (!prices || prices.length === 0) return;

    // Slot duration in ms (15 min = 900_000, 1 hour = 3_600_000)
    const slotMs = (prices.length >= 2)
      ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp))
      : 3_600_000;

    const soc = inputs.battery?.stateOfCharge ?? 50;
    const capacityKwh = inputs.battery?.totalCapacityKwh;
    if (!capacityKwh || capacityKwh <= 0) return;

    const maxChargePowerW    = inputs.battery?.maxChargePowerW    || 800;
    const maxDischargePowerW = inputs.battery?.maxDischargePowerW || 800;

    // Build per-slot PV power estimate from radiation forecast.
    // Prefer the learned per-slot yield factors (W per W/m²) — no pvCapW or PR needed.
    // Falls back to configured capacity × PR when insufficient data (<10 learned slots).
    let pvForecast = null;
    const pvCapacityW = inputs.settings?.pv_capacity_w || 0;
    const pvPR        = inputs.settings?.pv_performance_ratio || 0.75;
    const yfs          = this.learningEngine?.getSolarYieldFactorsSmoothed();
    const learnedSlots = this.learningEngine?.getSolarLearnedSlotCount() ?? 0;

    if (Array.isArray(inputs.weather?.hourlyForecast)) {

      pvForecast = inputs.weather.hourlyForecast
        .filter(h => typeof h.radiationWm2 === 'number')
        .map(h => {
          const d   = h.time instanceof Date ? h.time : new Date(h.time);
          // Average yield factor across all 4 × 15-min slots of this UTC hour.
          // Using only slot[0] (h*4) would underestimate the sunrise hour: the first
          // slot (e.g. 04:00–04:15) is often pre-sunrise with yf≈0, while slots
          // 04:15–04:59 carry the real production — causing forecast to start 1h late.
          const s0 = d.getUTCHours() * 4;
          const yf4 = [yfs[s0], yfs[s0+1], yfs[s0+2], yfs[s0+3]].filter(v => v != null && v > 0);
          const yf  = yf4.length > 0 ? yf4.reduce((a, b) => a + b, 0) / yf4.length : 0;
          const rawPvW = learnedSlots >= 10
            ? Math.round(h.radiationWm2 * yf)
            : pvCapacityW > 0 ? Math.round(pvCapacityW * pvPR * (h.radiationWm2 / 1000)) : 0;
          // Cap at installed system capacity — learned yield factors can overshoot on
          // exceptional days, but the inverter/system can never exceed its rated peak.
          const pvW = pvCapacityW > 0 ? Math.min(rawPvW, pvCapacityW) : rawPvW;
          return { timestamp: d.toISOString(), pvPowerW: pvW };
        })
        .filter(h => h.pvPowerW > 0 || pvCapacityW > 0);

      // Expose upcoming net PV kWh (after house consumption) to the policy engine.
      // Uses a rolling 24h window from now — NOT the next calendar day — to avoid
      // a strategy flip at midnight when "tomorrow" jumps to the next calendar date.
      // Net = sum of max(0, pvW - consW) per slot — only surplus goes into the battery.
      if (pvForecast && inputs.weather) {
        const nowMs = now.getTime();
        const windowEndMs = nowMs + 24 * 3600_000;
        let pvWhTomorrowNet = 0;
        for (const { timestamp, pvPowerW } of pvForecast) {
          const slotMs = new Date(timestamp).getTime();
          if (slotMs <= nowMs) continue;       // skip current and past slots
          if (slotMs > windowEndMs) continue;  // only next 24h
          const consW = this.learningEngine
            ? (this.learningEngine.getPredictedConsumption(new Date(timestamp)) ?? 0)
            : 0;
          // Surplus after house consumption, capped by battery group max charge rate.
          // Excess PV above the charge rate goes to the grid, not the battery.
          pvWhTomorrowNet += Math.min(maxChargePowerW, Math.max(0, pvPowerW - consW)); // W × 1h = Wh
        }
        inputs.weather.pvKwhTomorrow = Math.round(pvWhTomorrowNet / 100) / 10; // 1 decimal
      }
    }

    // Blend external PV forecasts into Open-Meteo pvForecast.
    // Sources: Solcast (satellite, 30-min, optional) + Forecast.Solar (weather model, hourly, always-on).
    // Each slot is averaged equally across available sources — more sources = more robust estimate.
    // Lazy-loaded; caches in homey.settings survive app restarts.
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      const blendSettings = inputs.settings;

      // ── Solcast (optional, 30-min → grouped to hourly) ──────────────────────
      let solcastByHourMs = null;
      if (blendSettings?.solcast_enabled && blendSettings.solcast_api_key && blendSettings.solcast_resource_id) {
        if (!this._solcastProvider) {
          const SolcastProvider = require('../../lib/solcast-provider');
          this._solcastProvider = new SolcastProvider(this.homey);
        }
        try {
          const solcastForecast = await this._solcastProvider.getForecast(
            blendSettings.solcast_api_key,
            blendSettings.solcast_resource_id,
          );
          if (Array.isArray(solcastForecast) && solcastForecast.length > 0) {
            solcastByHourMs = new Map();
            for (const s of solcastForecast) {
              const t = new Date(s.timestamp);
              const hourMs = t.getTime() - (t.getUTCMinutes() * 60_000) - (t.getUTCSeconds() * 1_000) - t.getUTCMilliseconds();
              if (!solcastByHourMs.has(hourMs)) solcastByHourMs.set(hourMs, []);
              solcastByHourMs.get(hourMs).push(s.pvPowerW);
            }
          }
        } catch (err) {
          this.log(`[Solcast] Error: ${err.message}`);
        }
      }

      // ── Blend all available sources per hourly slot ──────────────────────────
      if (solcastByHourMs) {
        const todayNLDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        const tomorrowNLDate = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        const byDay = { [todayNLDate]: { om: 0, sc: 0, bl: 0 }, [tomorrowNLDate]: { om: 0, sc: 0, bl: 0 } };

        pvForecast = pvForecast.map(slot => {
          const slotMs = new Date(slot.timestamp).getTime();
          const sources = [slot.pvPowerW];
          const dayKey = new Date(slot.timestamp).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });

          const scSlots = solcastByHourMs.get(slotMs);
          if (scSlots?.length > 0) {
            const avg = Math.round(scSlots.reduce((a, b) => a + b, 0) / scSlots.length);
            sources.push(avg);
            if (byDay[dayKey]) byDay[dayKey].sc += avg;
          }

          const blendedW = Math.round(sources.reduce((a, b) => a + b, 0) / sources.length);
          if (byDay[dayKey]) { byDay[dayKey].om += slot.pvPowerW; byDay[dayKey].bl += blendedW; }
          return { ...slot, pvPowerW: blendedW };
        });

        const fmt = wh => (wh / 1000).toFixed(1);
        const pct = (v, base) => (base > 0 ? `${v >= base ? '+' : ''}${((v - base) / base * 100).toFixed(0)}%` : '—');
        const td = byDay[todayNLDate], tm = byDay[tomorrowNLDate];
        const scToday    = td.sc > 0 ? ` SC=${fmt(td.sc)}kWh(${pct(td.sc, td.om)})` : '';
        const scTomorrow = tm.sc > 0 ? ` SC=${fmt(tm.sc)}kWh(${pct(tm.sc, tm.om)})` : '';
        this.log(`[PV blend] today:    OM=${fmt(td.om)}kWh${scToday} → blended=${fmt(td.bl)}kWh`);
        this.log(`[PV blend] tomorrow: OM=${fmt(tm.om)}kWh${scTomorrow} → blended=${fmt(tm.bl)}kWh`);
      }
    }

    // Sync chart with optimizer input (post-Solcast blend, pre-accuracy-discount).
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      this._pvForecastBlended   = pvForecast;
      this._pvForecastBlendedAt = Date.now();
      const _fcNow      = new Date();
      const _fcToday    = _fcNow.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
      const _fcTomorrow = new Date(_fcNow.getTime() + 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
      // Seed from existing chart (built by _updateWeather from dailyProfiles, all 24h) so
      // past hours aren't lost — pvForecast (hourlyForecast) only contains future slots.
      const _existing   = this._liveState.policy_pv_forecast_hourly
        ?? this.homey.settings.get('policy_pv_forecast_hourly')
        ?? [{}, {}];
      const pvFcByDay   = [{ ..._existing[0] }, { ..._existing[1] ?? {} }];
      for (const slot of pvForecast) {
        const st    = new Date(slot.timestamp);
        const sDate = st.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        const sIdx  = sDate === _fcToday ? 0 : sDate === _fcTomorrow ? 1 : -1;
        if (sIdx < 0) continue;
        const sHour = parseInt(st.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
        pvFcByDay[sIdx][sHour] = Math.round(slot.pvPowerW);
      }
      this._setLive('policy_pv_forecast_hourly', pvFcByDay);
    }

    // PV accuracy tracking: compare forecast for now vs actual from flow card.
    // Only when flow card provides fresh inverter data (< 20 min old) and at least one
    // side shows meaningful PV (> 50W) to avoid noisy night comparisons.
    // Skip at negative prices: users often disable their inverter to avoid export penalty,
    // so actual=0 with forecast>0 would wrongly degrade the PV accuracy score.
    const _currentPriceForPvAcc = inputs.tariff?.currentPrice ?? null;
    if (pvForecast && this.learningEngine && this._pvProductionW != null && this._pvProductionTimestamp
        && (_currentPriceForPvAcc === null || _currentPriceForPvAcc >= 0)) {
      const ageMs = Date.now() - this._pvProductionTimestamp;
      if (ageMs < 20 * 60 * 1000) {
        const predictedW = this.optimizationEngine._getPvForSlot(pvForecast, now.toISOString());
        const actualW    = this._pvProductionW;
        if (predictedW > 50 && actualW > 50) {
          this.learningEngine.recordPvAccuracy(predictedW, actualW).catch(e =>
            this.error('PV accuracy recording failed:', e)
          );
        }
      }
    }

    // PV conservatism: if accuracy score is low, discount pvForecast to avoid over-optimistic planning.
    // Discount kicks in below 0.80 accuracy, linear from 1.0 (at 0.80) to 0.80 (at 0).
    if (pvForecast && this.learningEngine) {
      const pvAcc = this.learningEngine.data?.pv_accuracy_score ?? 1.0;
      if (pvAcc < 0.80) {
        const factor = Math.max(0.80, 0.80 + 0.20 * (pvAcc / 0.80));
        pvForecast = pvForecast.map(s => ({ ...s, pvPowerW: Math.round(s.pvPowerW * factor) }));
        this.log(`[PV accuracy] score=${pvAcc.toFixed(2)} → conservatism factor=${factor.toFixed(2)} applied`);
      }
    }

    // Intraday PV scaling: correct today's remaining forecast from actual production.
    // Uses pv_predictions already tracked by learning engine — no new API calls.
    // Only scales today's future slots; tomorrow's forecast is unchanged.
    if (pvForecast && this.learningEngine && Array.isArray(this.learningEngine.data?.pv_predictions)) {
      const nowMs       = Date.now();
      const cutoffMs    = nowMs - 3 * 3600_000;
      const todayNLDate = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
      const todayPreds  = this.learningEngine.data.pv_predictions.filter(p =>
        p.timestamp >= cutoffMs && p.timestamp <= nowMs &&
        p.predicted > 50 && p.actual > 50
      );
      const avgActual = todayPreds.length
        ? todayPreds.reduce((s, p) => s + p.actual, 0) / todayPreds.length : 0;
      if (todayPreds.length >= 4 && avgActual >= 200) {
        const sumForecast = todayPreds.reduce((s, p) => s + p.predicted, 0);
        const sumActual   = todayPreds.reduce((s, p) => s + p.actual,    0);
        const rawRatio    = sumActual / sumForecast;
        const ratio       = Math.min(2.5, Math.max(0.4, rawRatio));
        this._lastIntradayPvRatio = ratio;
        if (Math.abs(ratio - 1.0) > 0.10) {
          const futureSlotsCount = pvForecast.filter(s => new Date(s.timestamp) > now).length;
          pvForecast = pvForecast.map(slot => {
            if (new Date(slot.timestamp) <= now) return slot;
            const slotDate = new Date(slot.timestamp).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
            if (slotDate !== todayNLDate) return slot; // don't scale tomorrow
            return { ...slot, pvPowerW: Math.round(slot.pvPowerW * ratio) };
          });
          this.log(`[PV intraday] ${todayPreds.length} samples, ratio=${rawRatio.toFixed(2)} (clamped=${ratio.toFixed(2)}) → scaled ${futureSlotsCount} future slots today`);
        } else {
          this.log(`[PV intraday] ${todayPreds.length} samples, ratio=${rawRatio.toFixed(2)} → within 10% threshold, no scaling`);
        }
      }
    }

    // Buienradar rain correction: cap near-term PV slots based on precipitation radar.
    // Only applies within the 2-hour Buienradar window; only reduces, never increases.
    if (pvForecast && Array.isArray(this.buienradarData) && this.buienradarData.length > 0) {
      const buienradarEndMs = this.buienradarData[this.buienradarData.length - 1].time.getTime();
      let correctedCount = 0;
      pvForecast = pvForecast.map(slot => {
        const slotMs = new Date(slot.timestamp).getTime();
        if (slotMs > buienradarEndMs) return slot;
        const nearest = this.buienradarData.reduce((a, b) =>
          Math.abs(b.time.getTime() - slotMs) < Math.abs(a.time.getTime() - slotMs) ? b : a
        );
        if (nearest.factor >= 1.0) return slot;
        correctedCount++;
        return { ...slot, pvPowerW: Math.round(slot.pvPowerW * nearest.factor) };
      });
      if (correctedCount > 0) {
        this.log(`🌧️ Buienradar: PV correctie op ${correctedCount} slots`);
      }
    }

    // Learned round-trip efficiency from efficiencyEstimator
    let learnedRte = this.efficiencyEstimator?.getEfficiency() ?? null;
    if (learnedRte != null && (learnedRte < 0.50 || learnedRte > 0.97)) learnedRte = null;

    // 24h consumption forecast from learning engine, floored by baseload when available.
    // BaseloadMonitor is optional (requires P1 baseload feature to be active).
    const baseloadW = this.homey.app?.baseloadMonitor?.currentBaseload ?? 0;
    let consumptionWPerSlot = null;
    if (this.learningEngine) {
      const now = new Date();
      consumptionWPerSlot = [];
      for (let h = 0; h < prices.length; h++) {
        // Use the actual price slot timestamp so consumption aligns with the right hour,
        // not now + h * slotMs which drifts when prices don't start exactly at 'now'.
        const futureTime = new Date(prices[h].timestamp);
        const learned = this.learningEngine.getPredictedConsumption(futureTime) ?? 0;
        // Floor by baseload: a learned value below the measured baseload is an
        // artefact of averaging quiet evenings — the house always consumes at least
        // baseload, so the optimizer should never plan slower discharge than that.
        consumptionWPerSlot.push(Math.max(learned, baseloadW));
      }
    }

    const slotLabel = slotMs === 900_000 ? '15-min' : '1h';
    this.log(`🔮 Optimizer: recomputing schedule (${prices.length} × ${slotLabel} slots, SoC ${soc}%, ${capacityKwh}kWh, PV ${pvCapacityW}W peak, RTE ${learnedRte != null ? (learnedRte * 100).toFixed(0) + '%' : 'default'})`);
    const respectMinMax = (inputs.settings?.policy_mode === 'balanced-dynamic')
      ? false
      : inputs.settings?.respect_minmax !== false;
    let minDischargePrice = respectMinMax
      ? (inputs.settings?.min_discharge_price ?? 0)
      : (inputs.settings?.cycle_cost_per_kwh ?? 0.075) / (inputs.settings?.battery_efficiency || 0.75);

    // PV headroom override: when tomorrow's PV will fill the battery regardless of tonight's SoC,
    // lower the discharge floor to the actual break-even so the DP can create headroom overnight.
    // Break-even = cycleCostPerKwh / effectiveRte (typically ~€0.10).
    // Only active when PV tomorrow ≥ 90% of battery capacity (near-certain full recharge).
    // Smooth pvKwhTomorrow over last 3 values to prevent a single weather-API update
    // from toggling the DP flattening strategy. Uses rolling minimum (conservative):
    // the DP only switches to "discharge freely" when PV availability is consistently high.
    const pvKwhTomorrowRaw = inputs.weather?.pvKwhTomorrow ?? 0;
    if (!this._pvKwhTomorrowHistory) this._pvKwhTomorrowHistory = [];
    if (pvKwhTomorrowRaw > 0) {
      this._pvKwhTomorrowHistory.push(pvKwhTomorrowRaw);
      if (this._pvKwhTomorrowHistory.length > 3) this._pvKwhTomorrowHistory.shift();
    }
    const pvKwhTomorrow = this._pvKwhTomorrowHistory.length > 0
      ? Math.min(...this._pvKwhTomorrowHistory)
      : pvKwhTomorrowRaw;
    if (pvKwhTomorrowRaw > 0 && pvKwhTomorrow !== pvKwhTomorrowRaw) {
      this.log(`☀️ pvKwhTomorrow smoothed: raw=${pvKwhTomorrowRaw}kWh → min3=${pvKwhTomorrow}kWh (history=[${this._pvKwhTomorrowHistory.map(v=>v.toFixed(2)).join(',')}])`);
    }
    if (pvKwhTomorrow >= capacityKwh * 0.9 && minDischargePrice > 0 && pvForecast) {
      const effectiveRte = learnedRte ?? 0.75;
      const cycleCostKwh = this.optimizationEngine.cycleCostPerKwh ?? 0.075;
      const actualBreakEven = Math.round(cycleCostKwh / effectiveRte * 1000) / 1000;
      // Night floor: when PV tomorrow comfortably exceeds capacity (≥150%), any overnight
      // discharge avoids clipping free PV tomorrow → floor = €0.00 (any positive price is profit).
      // When PV is 90-150% of capacity, use break-even + small margin as floor.
      // Day floor (pvW >= pvStrongW, zero_charge_only mode): PV opportunity cost applies —
      // discharging means PV recharges at the same price → round-trip loss → use min_discharge_price.
      // Weak PV floor (50W ≤ pvW < pvStrongW, standby mode): battery is NOT in zero_charge_only,
      // no real opportunity cost — use break-even + small margin so the DP can still discharge
      // at profitable transition-hour prices (e.g. 17:30 at €0.21 with 300W PV).
      const pvRatio = pvKwhTomorrow / capacityKwh;
      const nightFloor   = pvRatio >= 1.5 ? 0.00 : Math.max(actualBreakEven + 0.015, 0.115);
      const dayFloor     = inputs.settings?.min_discharge_price || 0.22;
      const weakPvFloor  = Math.max(actualBreakEven + 0.02, 0.115);
      const pvStrongW    = (inputs.battery?.maxChargePowerW || 800) * 0.5; // mirrors pvStrongCoverage=400/800
      const perSlotFloors = prices.map(p => {
        const pvW = this.optimizationEngine._getPvForSlot(pvForecast, p.timestamp);
        if (pvW >= pvStrongW) return dayFloor;
        if (pvW >= 50)        return weakPvFloor;
        return nightFloor;
      });
      this.log(`☀️ PV headroom: pvTomorrow=${pvKwhTomorrow}kWh ≥ ${(capacityKwh * 0.9).toFixed(1)}kWh → night floor €${nightFloor}, weak-PV floor €${weakPvFloor}, day floor €${dayFloor} (pvStrong≥${pvStrongW}W, break-even €${actualBreakEven})`);
      minDischargePrice = perSlotFloors;
    }
    // Negative tariff headroom: when strongly negative prices are coming (< -€0.10),
    // lower the discharge floor to €0.00 for all slots before the first negative window.
    // This lets the DP discharge at any positive price — using house load to drain the
    // battery passively and grid export for the remainder — maximising room for paid charging.
    // Applied after PV headroom so it can override the per-slot floor array if needed.
    const minFuturePrice = prices.length ? Math.min(...prices.map(p => p.price)) : 0;
    if (minFuturePrice < -0.10) {
      const firstNegIdx = prices.findIndex(p => p.price < -0.10);
      if (firstNegIdx > 0) {
        const preNegFloors = prices.map((_, t) => t < firstNegIdx ? 0.00
          : (Array.isArray(minDischargePrice) ? minDischargePrice[t] : minDischargePrice));
        this.log(`⚡ Negatief tarief headroom: min €${minFuturePrice.toFixed(3)} @ slot ${firstNegIdx} → discharge floor €0.00 voor slot 0–${firstNegIdx - 1}`);
        minDischargePrice = preNegFloors;
      }
    }

    // Per-slot consumption margin: scales with each slot's coefficient of variation.
    // Stable slots (CV~0, e.g. night) → tight margin 1.10.
    // Volatile slots (CV~1, e.g. cooking peak) → wide margin 1.35.
    // Falls back to uniform 1.20 when learning engine has no variance data yet.
    let consumptionMargin = 1.20;
    if (this.learningEngine && consumptionWPerSlot) {
      const perSlotMargins = [];
      let cvSum = 0, cvCount = 0;
      for (let h = 0; h < prices.length; h++) {
        const cv = this.learningEngine.getConsumptionCV(new Date(prices[h].timestamp));
        if (cv !== null) {
          perSlotMargins.push(Math.min(1.35, 1.10 + cv * 0.25));
          cvSum += cv; cvCount++;
        } else {
          perSlotMargins.push(1.20); // default for slots without enough data
        }
      }
      if (cvCount > 0) {
        const avgCV = cvSum / cvCount;
        consumptionMargin = perSlotMargins; // pass per-slot array to optimizer
        this.log(`📐 consumptionMargin=per-slot (avgCV=${avgCV.toFixed(2)}, ${cvCount}/${prices.length} slots with CV data)`);
      }
    }
    // ── PV surplus forecast ────────────────────────────────────────────────────
    // How much of the remaining battery capacity will be filled by net PV surplus today?
    // Uses the same per-slot interpolation as the DP so both agree on expected PV.
    if (pvForecast && consumptionWPerSlot) {
      const slotH = slotMs / 3_600_000;
      let netPvKwh = 0;
      for (let h = 0; h < prices.length; h++) {
        const pvW  = this.optimizationEngine._getPvForSlot(pvForecast, prices[h].timestamp);
        const consW = consumptionWPerSlot[h] ?? 0;
        netPvKwh += Math.max(0, pvW - consW) * slotH / 1000;
      }
      const remainingKwh  = Math.max(0, (1 - soc / 100) * capacityKwh);
      const rteForSurplus = learnedRte ?? 0.75;
      const fillFraction  = remainingKwh > 0.1
        ? Math.min(1, (netPvKwh * rteForSurplus) / remainingKwh)
        : 1;
      this.log(`☀️ PV-surplus: ${netPvKwh.toFixed(2)} kWh netto → ${(fillFraction * 100).toFixed(0)}% van restcapaciteit (${remainingKwh.toFixed(1)} kWh, SoC ${soc}%)`);
      this._setLive('pv_surplus_forecast', {
        netPvKwh:      Math.round(netPvKwh * 100) / 100,
        remainingKwh:  Math.round(remainingKwh * 100) / 100,
        fillFraction:  Math.round(fillFraction * 100) / 100,
        soc,
        updatedAt:     new Date().toISOString(),
      });
    }

    if (pvKwhTomorrow > 0) {
      const pvRefill = Math.min(1, pvKwhTomorrow / capacityKwh);
      const terminalFactor = pvRefill >= 0.8 ? 0 : Math.max(0, 1 - pvRefill / 0.8);
      this.log(`☀️ Terminal value: pvTomorrow=${pvKwhTomorrow}kWh, capacity=${capacityKwh}kWh, pvRefill=${(pvRefill*100).toFixed(0)}% → factor=${terminalFactor.toFixed(2)}${pvRefill >= 0.8 ? ' (ZERO — PV refills battery)' : ''}`);
    }
    this.optimizationEngine.compute(prices, soc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin, pvKwhTomorrow);

    // Persist planning schedule for the settings UI (single source of truth).
    // Frontend reads 'policy_optimizer_schedule' and renders it directly — no re-simulation.
    const slots = this.optimizationEngine._schedule?.slots;
    if (slots?.length > 0) {
      const planningSchedule = this.policyEngine.buildPlanningSchedule(slots, pvForecast ?? null, minDischargePrice);
      // Enrich with consumption sample count for confidence display in the UI
      if (this.learningEngine) {
        for (const slot of planningSchedule) {
          slot.sampleCount = this.learningEngine.getConsumptionSampleCount(new Date(slot.timestamp));
        }
      }
      this._setLive('policy_optimizer_schedule', planningSchedule);


      // ── SoC plan snapshot: first planned SoC per slot, never overwritten ──
      // Allows the frontend to show "planned XX%" alongside actual SoC for past slots.
      try {
        const nowTs = Date.now();
        let socPlan = this._liveState.policy_soc_plan || this.homey.settings.get('policy_soc_plan') || {};
        // Prune entries older than 48h
        for (const ts of Object.keys(socPlan)) {
          if (nowTs - new Date(ts).getTime() > 48 * 3600 * 1000) delete socPlan[ts];
        }
        // Add new timestamps only — never overwrite (first plan wins for past slots)
        let changed = false;
        for (const slot of planningSchedule) {
          if (slot.socProjected != null && !(slot.timestamp in socPlan)) {
            socPlan[slot.timestamp] = { soc: slot.socProjected, consumptionW: slot.consumptionW ?? null };
            changed = true;
          }
        }
        if (changed) this._setLive('policy_soc_plan', socPlan);
      } catch (e) { /* non-critical */ }

      // ── Battery expansion analysis (non-critical) ──────────────────────────
      // Runs DP for 1–4 battery scenarios to show the marginal value of each
      // additional unit. _schedule is NOT touched by computeExpectedProfit().
      // Skip if heap is already under pressure (4× DP runs = significant allocation).
      let heapUsedMB = 50; // conservative default: skip expansion if heap unreadable
      try { heapUsedMB = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (heapUsedMB > 45) {
        this.log(`[MEM] Skipping expansion analysis — heap ${heapUsedMB.toFixed(1)} MB > 45 MB guard`);
      }
      if (heapUsedMB <= 45) try {
        const KWH_PER_UNIT = 2.688; // HomeWizard Energy Battery per unit
        const W_PER_UNIT   = 800;

        const dischargeSlots = this.optimizationEngine._schedule?.slots ?? [];
        const slotH = prices.length >= 2
          ? (new Date(prices[1].timestamp) - new Date(prices[0].timestamp)) / 3_600_000
          : 1;

        const scenarios = [];
        for (let n = 1; n <= 4; n++) {
          const kwh    = +(n * KWH_PER_UNIT).toFixed(3);
          const powerW = n * W_PER_UNIT;

          const result = this.optimizationEngine.computeExpectedProfit(
            prices, soc, kwh, powerW, powerW,
            pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin, pvKwhTomorrow
          );
          const profit = +result.profit.toFixed(4);
          const selfSufficiencyPct = result.selfSufficiencyPct;

          // Power bottleneck: slots where house consumption exceeds battery discharge power,
          // so the battery is at full output but grid still imports the remainder.
          // Uses the current schedule's discharge slots as a proxy (good enough for diagnostics).
          let shortfallSlots = 0;
          let shortfallKwh   = 0;
          if (Array.isArray(consumptionWPerSlot)) {
            for (let t = 0; t < dischargeSlots.length; t++) {
              if (dischargeSlots[t]?.action !== 'discharge') continue;
              const consumption = consumptionWPerSlot[t];
              if (consumption == null) continue;
              const shortfall = Math.max(0, consumption - powerW);
              if (shortfall > 0) {
                shortfallSlots++;
                shortfallKwh += shortfall * slotH / 1000;
              }
            }
          }

          scenarios.push({ units: n, kwh, powerW, profit, selfSufficiencyPct,
            shortfallSlots, shortfallKwh: +shortfallKwh.toFixed(3) });
        }

        // Rolling daily profit history — one entry per day, max 30 days.
        // Used by the frontend to compute a seasonally-averaged payback period.
        // Also stores actual self-sufficiency, updated on every policy run.
        const today = new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
        let hist = this.homey.settings.get('expansion_profit_history') || { entries: [] };
        if (!Array.isArray(hist.entries)) hist.entries = [];
        const lastEntry = hist.entries[hist.entries.length - 1];
        let todayEntry;
        if (!lastEntry || lastEntry.date !== today) {
          todayEntry = { date: today };
          hist.entries.push(todayEntry);
          if (hist.entries.length > 30) hist.entries = hist.entries.slice(-30);
        } else {
          todayEntry = lastEntry;
        }
        for (const s of scenarios) todayEntry[`p${s.units}`] = s.profit;
        const todayActualSelfSufficiencyPct = this._todayConsumptionKwh > 0.01
          ? Math.max(0, Math.min(100, Math.round((1 - this._todayGridImportKwh / this._todayConsumptionKwh) * 100)))
          : null;
        if (todayActualSelfSufficiencyPct !== null) todayEntry.actualSelfSufficiencyPct = todayActualSelfSufficiencyPct;

        this._updateProfitTracking(todayEntry);
        this._queueSettingsPersist('expansion_profit_history', hist);

        // Augment scenarios with avgProfit + seasonally-corrected avgProfit.
        // Seasonal correction: normalize each day's profit by its monthly irradiance
        // factor (NL average, PVGIS kWh/m²/day) so that summer days don't inflate
        // the annual estimate. Result is a year-round daily average.
        const NL_IRRADIANCE = [0.62, 1.16, 2.28, 3.62, 4.71, 5.02, 4.92, 4.23, 2.84, 1.56, 0.67, 0.44];
        const NL_ANNUAL_AVG = NL_IRRADIANCE.reduce((a, b) => a + b, 0) / 12; // ~2.67

        const historyDays = hist.entries.length;
        for (const s of scenarios) {
          const vals = hist.entries.map(e => e[`p${s.units}`]).filter(v => v != null);
          s.avgProfit = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;

          // Seasonal correction: weight each day's profit by (annual_avg / month_irradiance)
          // so high-irradiance months are scaled down to the annual baseline.
          if (hist.entries.length >= 3) {
            let weightedSum = 0, weightSum = 0;
            for (const e of hist.entries) {
              const profit = e[`p${s.units}`];
              if (profit == null) continue;
              const month = new Date(e.date).getMonth(); // 0-based
              const irr   = NL_IRRADIANCE[month] || NL_ANNUAL_AVG;
              const weight = NL_ANNUAL_AVG / irr; // <1 in summer, >1 in winter
              weightedSum += profit * weight;
              weightSum   += weight;
            }
            s.seasonalAvgProfit = weightSum > 0 ? +(weightedSum / weightSum).toFixed(4) : null;
          } else {
            s.seasonalAvgProfit = null; // too few days for meaningful correction
          }
        }

        const currentUnits = Math.max(1, Math.min(4, Math.round(capacityKwh / KWH_PER_UNIT)));

        this._setLive('battery_expansion_analysis', {
          timestamp:    new Date().toISOString(),
          currentUnits,
          currentKwh:   capacityKwh,
          currentPowerW: maxChargePowerW,
          historyDays,
          scenarios,
          todayActualSelfSufficiencyPct,
          todayGridImportKwh:    +this._todayGridImportKwh.toFixed(3),
          todayConsumptionKwh:   +this._todayConsumptionKwh.toFixed(3),
        });
      } catch (e) {
        this.error('Battery expansion analysis failed (non-critical):', e);
      }

      // ── Consumption profile (for settings chart) ───────────────────────────
      // Written at most once per hour — data changes slowly, no need to
      // serialize 672 integers to settings on every 15-min optimizer run.
      try {
        const lastProfile = this.homey.settings.get('policy_consumption_profile');
        const ageMs = lastProfile?.timestamp ? Date.now() - new Date(lastProfile.timestamp).getTime() : Infinity;
        if (ageMs > 60 * 60 * 1000) {
          const days = {};
          for (let d = 0; d < 7; d++) {
            days[d] = this.learningEngine.getDailyProfile(d).map(s => s.avgW);
          }
          this._queueSettingsPersist('policy_consumption_profile', {
            timestamp: new Date().toISOString(),
            days,
          });
        }
      } catch (e) {
        this.error('Consumption profile save failed (non-critical):', e);
      }
    }

  }

  /**
   * Update PV production from flow card (user-provided data)
   * @param {number} powerW - PV production in watts
   */
  _updatePvProduction(powerW) {
    this._pvProductionW = powerW;
    this._pvProductionTimestamp = Date.now();

    // Check favorable window on PV update so the trigger fires immediately
    // when production crosses the threshold, without waiting for next policy cycle.
    if (this._lastTariffInfo) {
      this._checkFavorableWindow(this._lastTariffInfo);
    }

    // Feed live measurement into the solar yield-factor learner.
    // Requires radiation data from the latest weather fetch.
    const radiation = this._getInterpolatedRadiation(Date.now());
    if (radiation !== null && this.learningEngine) {
      this.learningEngine.updateSolarYieldFactor(new Date(), powerW, radiation);
    }

    // Accumulate actual PV per Amsterdam hour for planning chart display.
    const nowAms = new Date();
    const todayStr = nowAms.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
    const amsHour = parseInt(nowAms.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);

    if (!this._pvActualHourly || this._pvActualHourly.date !== todayStr) {
      const saved = this.homey.settings.get('policy_pv_actual_today');
      if (saved && saved.date === todayStr && Array.isArray(saved.hourly)) {
        this._pvActualHourly = {
          date: todayStr,
          hourly: saved.hourly,
          sums:   saved.sums   || new Array(24).fill(0),
          counts: saved.counts || new Array(24).fill(0),
        };
      } else {
        this._pvActualHourly = {
          date:   todayStr,
          hourly: new Array(24).fill(null),
          sums:   new Array(24).fill(0),
          counts: new Array(24).fill(0),
        };
      }
    }

    this._pvActualHourly.sums[amsHour]   += powerW;
    this._pvActualHourly.counts[amsHour] += 1;
    this._pvActualHourly.hourly[amsHour]  = Math.round(
      this._pvActualHourly.sums[amsHour] / this._pvActualHourly.counts[amsHour]
    );

    this._queueSettingsPersist('policy_pv_actual_today', {
      date:   this._pvActualHourly.date,
      hourly: this._pvActualHourly.hourly,
      sums:   this._pvActualHourly.sums,
      counts: this._pvActualHourly.counts,
    });

    // Refresh PV camera image when policy is disabled (otherwise _updatePlanningChart handles it).
    // Throttled: at most once per 15 minutes to avoid flooding quickchart.io.
    if (!this.getCapabilityValue('policy_enabled') && this.planningImagePv) {
      const now = Date.now();
      if (!this._pvCameraLastUpdate || now - this._pvCameraLastUpdate > 15 * 60 * 1000) {
        this._pvCameraLastUpdate = now;
        this.planningImagePv.update().catch(() => {});
      }
    }
  }

  /**
   * Interpolate radiation (W/m²) from hourly weather forecast at a given moment.
   * Returns null when no weather data is available.
   */
  _getInterpolatedRadiation(nowMs) {
    const forecast = this.weatherData?.hourlyForecast;
    if (!Array.isArray(forecast) || forecast.length === 0) return null;

    let prev = null, next = null;
    for (const h of forecast) {
      const t = h.time instanceof Date ? h.time.getTime() : new Date(h.time).getTime();
      if (t <= nowMs) prev = { t, r: h.radiationWm2 };
      else if (!next)  { next = { t, r: h.radiationWm2 }; break; }
    }
    if (!prev && !next) return null;
    if (!prev) return next.r;
    if (!next) return prev.r;

    const ratio = (nowMs - prev.t) / (next.t - prev.t);
    return prev.r + (next.r - prev.r) * ratio;
  }

  /**
   * Estimate PV production using grid power analysis + sun model
   * @param {Object} ctx - Context with gridPower, batteryPower, sunScore
   * @returns {number} Estimated PV production in watts
   */
  _estimatePvProduction(ctx) {
    const settings = this.getSettings();
    
    // Priority 1: User-provided data via flow card (most accurate)
    if (this._pvProductionW !== null && this._pvProductionTimestamp) {
      const age = Date.now() - this._pvProductionTimestamp;
      const maxAge = 5 * 60 * 1000; // 5 minutes
      
      if (age < maxAge) {
        // When flow card reports 0W, reset the EMA so the fallback estimator
        // doesn't keep returning stale high values after sunset.
        if (this._pvProductionW === 0 && this._lastPvEstimateW > 0) {
          this._lastPvEstimateW = 0;
        }
        if (settings.enable_logging) {
          this.log(`PV from flow card: ${this._pvProductionW}W (age: ${Math.round(age/1000)}s)`);
        }
        return this._pvProductionW;
      } else {
        // Data too old, clear it
        this._pvProductionW = null;
        this._pvProductionTimestamp = null;
      }
    }
    
    // Priority 2: Estimation (fallback when no flow data)
    // Feature disabled or no capacity configured
    if (!settings.pv_estimation_enabled || !settings.pv_capacity_w || settings.pv_capacity_w <= 0) {
      return 0;
    }

    const grid = ctx.gridPower ?? 0;           // positive = import, negative = export
    const batt = ctx.batteryPower ?? 0;        // positive = charging, negative = discharging
    const sunScore = ctx.sunScore ?? 0;        // 0..100
    const pvCap = settings.pv_capacity_w;
    const alpha = 0.4; // EMA smoothing factor

    // Sun-based model: scale capacity by sun intensity
    const sunFactor = Math.max(0, Math.min(1, sunScore / 100));
    const pvModel = Math.round(pvCap * sunFactor);

    let pvFromGrid = 0;
    const exportThreshold = -75; // Grid exporting when below this

    if (grid < exportThreshold) {
      // Grid is exporting: PV must be producing more than household consumption
      // Household load = export + any battery discharge
      const exportPower = Math.abs(grid);
      const batteryDischarge = batt < 0 ? Math.abs(batt) : 0;
      pvFromGrid = exportPower + batteryDischarge;
      
      // When exporting, PV must also be covering any battery charge
      const batteryCharge = batt > 0 ? batt : 0;
      pvFromGrid += batteryCharge;
    } else if (grid > 0 && batt > 100 && sunScore > 0) {
      // Grid importing + battery charging: PV might be contributing
      // This is conservative: only count if battery is actively charging
      // Real PV = battery charge power (assuming zero-charge-only mode)
      pvFromGrid = batt;
    }

    // Use the stronger signal (measured export trumps model)
    const rawEstimate = Math.max(pvModel, pvFromGrid);

    // EMA smoothing to avoid oscillation from clouds
    const estimate = this._lastPvEstimateW 
      ? Math.round((alpha * rawEstimate) + ((1 - alpha) * this._lastPvEstimateW))
      : rawEstimate;

    this._lastPvEstimateW = estimate;

    // ------------------------------------------------------
    // 📊 LEARNING: Apply learned PV accuracy adjustment
    // ------------------------------------------------------
    const learningMultiplier = this.learningEngine.getPvAdjustmentMultiplier();
    const adjustedEstimate = Math.round(estimate * learningMultiplier);
    
    if (settings.enable_logging && adjustedEstimate > 0) {
      this.log(`PV estimate: ${adjustedEstimate}W (raw: ${estimate}W, model: ${pvModel}W, fromGrid: ${pvFromGrid}W, sun: ${sunScore}%, learning: ${learningMultiplier.toFixed(2)}x)`);
    }

    return Math.max(0, adjustedEstimate);
  }

  async _gatherInputs() {
    const settings = { ...this.getSettings() };

    // Override battery_efficiency with learned meter-based RTE when available,
    // so policy engine, explainability, and settings page all use the same value.
    const learnedRte = this.efficiencyEstimator?.getEfficiency() ?? null;
    if (learnedRte && learnedRte > 0.50 && learnedRte < 0.99) {
      settings.battery_efficiency = learnedRte;
    }

    let weatherData = null;

    if (settings.tariff_type === 'dynamic') {
      if (
        !this.weatherData ||
        !this.weatherData.fetchedAt ||
        Date.now() - this.weatherData.fetchedAt > ((settings.weather_update_interval || 1) * 60 * 60 * 1000)
      ) {
        await this._updateWeather();
      }

      weatherData = this.weatherData || this.weatherForecaster._getDefaultForecast();

      const weatherOverride = this.getCapabilityValue('weather_override');
      if (weatherOverride !== 'auto') {
        this.log(`🌦️ Applying weather override: ${weatherOverride}`);
        weatherData = this._applyWeatherOverride(weatherData, weatherOverride);
      }
    }
    const batteryState = await this._getBatteryState();
    const tariffInfo = this.tariffManager.getCurrentTariff(batteryState.gridPower);

    const debugPrice = tariffInfo?.currentPrice != null ? tariffInfo.currentPrice.toFixed(3) : 'n/a';
    const debugTopLow = Array.isArray(tariffInfo?.top3Lowest)
      ? tariffInfo.top3Lowest.map(p => `${String(p.hour).padStart(2, '0')}:00€${p.price.toFixed(2)}`).join(', ')
      : 'n/a';
    const debugTopHigh = Array.isArray(tariffInfo?.top3Highest)
      ? tariffInfo.top3Highest.map(p => `${String(p.hour).padStart(2, '0')}:00€${p.price.toFixed(2)}`).join(', ')
      : 'n/a';
    const debugSun4h = Number(weatherData?.sunshineNext4Hours ?? 0).toFixed(1);
    const debugSun8h = Number(weatherData?.sunshineNext8Hours ?? 0).toFixed(1);
    const debugSunToday = Number(weatherData?.sunshineTodayRemaining ?? 0).toFixed(1);
    const debugSunTomorrow = Number(weatherData?.sunshineTomorrow ?? 0).toFixed(1);

    const debugRate = tariffInfo?.currentRate ?? 'n/a';
    const now = new Date().toISOString().slice(11, 16); // HH:MM format
    const debugPriceText = `price=${debugPrice} rate=${debugRate} @${now}`;
    const debugTopLowText = `low=[${debugTopLow}] @${now}`;
    const debugTopHighText = `high=[${debugTopHigh}] @${now}`;
    const debugSunText = `4h=${debugSun4h} 8h=${debugSun8h} today=${debugSunToday} tmw=${debugSunTomorrow} @${now}`;

    // Learning statistics
    const learningStats = this.learningEngine.getStatistics();
    const rteInsights = this.efficiencyEstimator.getEfficiencyInsights();
    const rteModeSummary = rteInsights
      ? Object.entries(rteInsights.rteByMode).map(([k, v]) => `${k}=${v.rte}%(${v.n}x)`).join(' ')
      : `rte=${(this.efficiencyEstimator.getEfficiency() * 100).toFixed(1)}% (<5 cycli)`;
    const debugLearningText = `days=${learningStats.days_tracking} samples=${learningStats.total_samples} coverage=${learningStats.pattern_coverage}% pv_acc=${learningStats.pv_accuracy}% | rte: ${rteModeSummary} @${now}`;

    await this.setCapabilityValue('policy_debug_price', debugPriceText).catch(this.error);
    await this.setCapabilityValue('policy_debug_top3low', debugTopLowText).catch(this.error);
    await this.setCapabilityValue('policy_debug_top3high', debugTopHighText).catch(this.error);
    await this.setCapabilityValue('policy_debug_sun', debugSunText).catch(this.error);
    await this.setCapabilityValue('policy_debug_learning', debugLearningText).catch(this.error);
    // Push debug data to app settings for planning view
    this._setLive('policy_debug_top3low', debugTopLowText);
    this._setLive('policy_debug_top3high', debugTopHighText);

    // Push structured learning stats for the UI status block
    const rte = this.efficiencyEstimator.getEfficiency();
    const rteInsightsObj = this.efficiencyEstimator.getEfficiencyInsights();
    this._setLive('learning_status', {
      days:       learningStats.days_tracking,
      samples:    learningStats.total_samples,
      coverage:   learningStats.pattern_coverage,
      pvAccuracy: learningStats.pv_accuracy,
      rte:        rte != null ? +(rte * 100).toFixed(1) : null,
      cycles:     this.efficiencyEstimator.getCycleCount(),
      updatedAt:  new Date().toISOString(),
    });
    
    // NOTE: policy_all_prices is written by TariffManager._getDynamicTariff() every 5 min
    // — no need to duplicate here
    
    // Push weather forecast with hourly radiation data for PV visualization.
    // Prefer dailyProfiles (full 24h including past hours) over hourlyForecast (future only).
    const weatherSource = weatherData?.dailyProfiles ?? weatherData?.hourlyForecast;
    if (weatherSource && Array.isArray(weatherSource)) {
      const nowAmsDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
      const hourlyWeather = weatherSource.map(h => {
        const t = new Date(h.time);
        const hAmsDate = t.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        return {
          hour: parseInt(t.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10),
          day: hAmsDate > nowAmsDate ? 1 : 0,
          sunshine: h.sunshine,
          cloudCover: h.cloudCover,
          radiationWm2: h.radiationWm2,
          weatherCode: h.weatherCode ?? 0
        };
      });
      this._setLive('policy_weather_hourly', hourlyWeather);
      if (weatherData.fetchedAt) {
        this._setLive('policy_weather_fetched_at', new Date(weatherData.fetchedAt).toISOString());
      }
    }

    // Estimate PV production using grid analysis + sun model
    // Use next-4h sunshine only — tomorrow's forecast must not inflate the current PV estimate.
    // Guard: before sunrise, sunshineNext4Hours already covers post-sunrise slots and would
    // produce a large fake estimate (e.g. 993W at 06:13 CEST before sunrise at ~07:10).
    // Zero out sunScore until the sun has actually risen.
    const _nowMs = Date.now();
    const _sunrise = weatherData?.todaySunrise;
    const _beforeSunrise = _sunrise instanceof Date && _nowMs < _sunrise.getTime();
    if (_beforeSunrise) this._lastPvEstimateW = 0; // reset EMA — sun not up yet
    const sunScore = (weatherData && !_beforeSunrise)
      ? Math.min(100, Math.round((weatherData.sunshineNext4Hours / 4) * 100))
      : 0;
    const sun = { gfs: sunScore, harmonie: sunScore };
    const pvEstimateW = this._estimatePvProduction({
      gridPower: batteryState.gridPower,
      batteryPower: batteryState.groupPower,
      sunScore
    });

    const p1 = {
      resolved_gridPower: batteryState.gridPower,
      battery_power: batteryState.groupPower,
      pv_power_estimated: pvEstimateW
    };

    // ------------------------------------------------------
    // ⭐ BATTERY COST MODEL INPUTS
    // ------------------------------------------------------
    const batteryAvgCost = this._costAvg ?? (await this.getStoreValue('battery_avg_cost') || 0);
    const batteryEnergyKwh = this._costEnergy ?? (await this.getStoreValue('battery_energy_kwh') || 0);

    const batteryEfficiency = Math.min(Math.max(this.efficiencyEstimator.getEfficiency() || 0.75, 0.5), 1.0);

    // Break-even prijs (€/kWh)
    const breakEven = batteryAvgCost > 0
      ? batteryAvgCost / batteryEfficiency
      : 0;


    return {
      weather: (settings.tariff_type === 'dynamic') ? weatherData : null,
      battery: batteryState,
      tariff: tariffInfo,
      time: new Date(),
      policyMode: this.getCapabilityValue('policy_mode'),
      settings,
      p1,
      sun,
      batteryEfficiency: this.efficiencyEstimator.getEfficiency(),

      // ⭐ NEW: Battery cost model
      batteryCost: {
        avgCost: batteryAvgCost,
        energyKwh: batteryEnergyKwh,
        breakEven
      },
      previousHwMode: this.lastRecommendation?.hwMode ?? null,
      consumptionW: this.learningEngine?.getPredictedConsumption(new Date()) ?? null,
    };

  }

  _applyWeatherOverride(weatherData, override) {
    const modified = { ...weatherData };

    switch (override) {
      case 'sunny':
        modified.sunshineNext4Hours = 4;
        modified.sunshineNext8Hours = 6;
        modified.sunshineTodayRemaining = 5;
        modified.sunshineTomorrow = 7;
        modified.cloudCover = 0;
        modified.precipitationProbability = 0;
        break;

      case 'cloudy':
        modified.sunshineNext4Hours = 0.5;
        modified.sunshineNext8Hours = 1;
        modified.sunshineTodayRemaining = 1;
        modified.sunshineTomorrow = 2;
        modified.cloudCover = 80;
        modified.precipitationProbability = 20;
        break;

      case 'rainy':
        modified.sunshineNext4Hours = 0;
        modified.sunshineNext8Hours = 0;
        modified.sunshineTodayRemaining = 0;
        modified.sunshineTomorrow = 0;
        modified.cloudCover = 100;
        modified.precipitationProbability = 90;
        break;

      default:
        return weatherData;
    }

    return modified;
  }

  async _getBatteryState() {
    const fallback = {
      stateOfCharge: 50,
      health: 100,
      cycles: 0,
      gridPower: 0,
      mode: 'standby',
      groupPower: 0,
      maxDischargePowerW: 800,
      maxChargePowerW: 800,
      battery_group_max_discharge_power_w: 800
    };

    if (!this.p1Device) {
      this.error('No P1 device available, using fallback battery state');
      return fallback;
    }

    try {
      const soc =
        this.p1Device.getCapabilityValue('battery_group_average_soc') ??
        50;

      const gridPower =
        this.p1Device.getCapabilityValue('measure_power') ?? 0;

      const groupMode =
        this.p1Device.getCapabilityValue('battery_group_charge_mode') ??
        'standby';

      const groupPower =
        this.p1Device.getCapabilityValue('measure_power.battery_group_power_w') ??
        0;

      const totalCapacity =
        this.p1Device.getCapabilityValue('battery_group_total_capacity_kwh') ??
        null;

      // Estimate number of units from total capacity (each unit = 2.688 kWh @ 800 W)
      const unitCount = totalCapacity ? Math.max(1, Math.round(totalCapacity / 2.688)) : 1;

      // ✅ FIX: HW firmware caps discharge at 800 W regardless of battery count
      // (e.g. 2 batteries: max_consumption_w=1600, max_production_w=800)
      // Charge scales linearly, discharge does not.
      const chargeFallbackW = unitCount * 800;
      const dischargeFallbackW = 800;

      // Use || instead of ?? so that 0 (from missing WS field) also triggers fallback
      const maxProduction =
        this.p1Device.getCapabilityValue('measure_power.battery_group_max_production_w') ||
        dischargeFallbackW;

      const maxConsumption =
        this.p1Device.getCapabilityValue('measure_power.battery_group_max_consumption_w') ||
        chargeFallbackW;

      await this.setCapabilityValue('battery_soc_mirror', soc).catch(this.error);
      await this.setCapabilityValue('grid_power_mirror', gridPower).catch(this.error);

      return {
        stateOfCharge: soc,
        health: 100,
        cycles: 0,
        gridPower,
        mode: groupMode,
        groupPower,
        totalCapacityKwh: totalCapacity,
        // ✅ NEW: Provide max discharge and charge power
        maxDischargePowerW: maxProduction,
        maxChargePowerW: maxConsumption,
        battery_group_max_discharge_power_w: maxProduction
      };

    } catch (error) {
      this.error('Failed to get battery state from P1:', error);
      return fallback;
    }
  }

  async _applyRecommendation(mode, confidence) {
    const minConfidence = this.getSetting('min_confidence_threshold') || 55;

    if (confidence < minConfidence) {
      this.log(`Confidence ${confidence}% below threshold ${minConfidence}%, not applying`);
      return false;
    }

    if (!this.p1Device) {
      this.error('No P1 device available to apply mode');
      return false;
    }

    try {
      // ⭐ Alleen echte HomeWizard modes
      let targetMode = null;

      if (mode === 'zero_charge_only') {
        targetMode = 'zero_charge_only';
      } else if (mode === 'zero_discharge_only') {
        targetMode = 'zero_discharge_only';
      } else if (mode === 'to_full') {
        targetMode = 'to_full';
      } else if (mode === 'standby') {
        targetMode = 'standby';
      } else if (mode === 'zero') {
        targetMode = 'zero';
      } else if (mode === 'predictive') {
        targetMode = 'predictive';
      } else {
        // Fallback: nooit niet‑bestaande modes sturen
        this.log(`⚠️ Unknown logical mode "${mode}", falling back to standby`);
        targetMode = 'standby';
      }

      // ⭐ Lees de ECHTE batterij-mode
      const actualMode = this.p1Device.getCapabilityValue('battery_group_charge_mode');

      this.log(`🔍 Actual HW mode: ${actualMode}, desired: ${targetMode}`);

      // ⭐ HW Slim laden actief → policy engine niet overrulen
      if (actualMode === 'predictive') {
        this.log('⏸️ HW Slim laden (predictive) actief — policy engine gepauzeerd, geen mode-wijziging');
        return true;
      }

      // ⭐ Als al correct → niets doen
      if (actualMode === targetMode) {
        this.log(`ℹ️ Battery already in correct HW mode (${actualMode}), no change needed`);
        return true;
      }

      // ⭐ Mode zetten
      this.log(`🔄 Changing battery mode: ${actualMode} → ${targetMode} (confidence: ${confidence}%)`);
      const result = await this.p1Device.setBatteryGroupMode(targetMode);

      if (result) {
        this.log(`✅ Battery mode successfully changed to: ${targetMode}`);
        await this._triggerModeApplied(targetMode, confidence);
        return true;
      } else {
        this.log(`❌ setBatteryGroupMode returned false`);
        return false;
      }

    } catch (error) {
      this.error('❌ Failed to apply recommendation to P1:', error);
      return false;
    }
  }

  async _triggerRecommendationChanged(result, explanation) {
    const trigger = this.homey.flow.getDeviceTriggerCard('policy_recommendation_changed');
    if (trigger) {
      await trigger.trigger(this, {
        mode: result.hwMode || result.policyMode,
        confidence: result.confidence,
        reason: explanation?.summary ?? ''
      }).catch(this.error);
    }
  }

  async _triggerModeApplied(mode, confidence) {
    const trigger = this.homey.flow.getDeviceTriggerCard('policy_mode_applied');
    if (trigger) {
      await trigger.trigger(this, {
        mode,
        confidence
      }).catch(this.error);
    }
  }

  async _triggerOverrideSet(duration) {
    const trigger = this.homey.flow.getDeviceTriggerCard('policy_override_set');
    if (trigger) {
      await trigger.trigger(this, {
        duration
      }).catch(this.error);
    }
  }

  /**
   * Check if the current moment is favorable for running appliances (cheap price or PV surplus).
   * Fires the favorable_consumption_window trigger on a false→true edge only.
   * @param {Object} tariff - tariff info from _gatherInputs()
   */
  _checkFavorableWindow(tariff) {
    if (!tariff) return;

    const currentPrice = tariff.currentPrice ?? null;
    const top3Lowest   = tariff.top3Lowest || [];

    // Cheap: current price is within the top-3 cheapest remaining slots of today
    const cheapThreshold = top3Lowest.length > 0
      ? Math.max(...top3Lowest.map(p => p.price)) + 0.001
      : null;
    const isCheap = cheapThreshold !== null && currentPrice !== null && currentPrice <= cheapThreshold;

    // PV surplus: significant solar production (>500W means PV is covering meaningful load)
    const isPvSurplus = (this._pvProductionW ?? 0) > 500;

    const isFavorable = isCheap || isPvSurplus;

    if (isFavorable && !this._favorableWindowActive) {
      this._favorableWindowActive = true;

      // Calculate how many minutes remain in this favorable window
      let durationMinutes = 60;
      if (isCheap && Array.isArray(tariff.effectivePrices)) {
        const futureSlots = tariff.effectivePrices
          .filter(p => p.index >= 0)
          .sort((a, b) => a.index - b.index);
        let count = 0;
        for (const slot of futureSlots) {
          if (slot.price <= cheapThreshold) count++;
          else break;
        }
        durationMinutes = Math.max(15, count * 15);
      } else if (isPvSurplus && Array.isArray(this.weatherData?.hourlyForecast)) {
        const now = Date.now();
        const futureHours = this.weatherData.hourlyForecast
          .filter(h => {
            const t = h.time instanceof Date ? h.time : new Date(h.time);
            return t.getTime() >= now;
          })
          .sort((a, b) => {
            const ta = a.time instanceof Date ? a.time : new Date(a.time);
            const tb = b.time instanceof Date ? b.time : new Date(b.time);
            return ta - tb;
          });
        let hours = 0;
        for (const h of futureHours) {
          if (h.radiationWm2 > 50) hours++;
          else break;
        }
        durationMinutes = Math.max(60, hours * 60);
      }

      const reason = isCheap && isPvSurplus
        ? (this.homey.i18n?.getLanguage?.() === 'nl' ? 'Goedkope stroom + zonnepanelen' : 'Cheap electricity + solar')
        : isCheap
          ? (this.homey.i18n?.getLanguage?.() === 'nl' ? 'Goedkope stroom' : 'Cheap electricity')
          : (this.homey.i18n?.getLanguage?.() === 'nl' ? 'Zonnepanelen produceren' : 'Solar production');

      const trigger = this.homey.flow.getDeviceTriggerCard('favorable_consumption_window');
      if (trigger) {
        trigger.trigger(this, {
          reason,
          duration_minutes: durationMinutes,
          price: Math.round((currentPrice ?? 0) * 10000) / 10000
        }).catch(err => this.error('favorable_consumption_window trigger failed:', err));
      }

      this.log(`⚡ Favorable consumption window started: ${reason}, ~${durationMinutes} min, €${currentPrice}`);
    } else if (!isFavorable && this._favorableWindowActive) {
      this._favorableWindowActive = false;
      this.log('⚡ Favorable consumption window ended');
      const endTrigger = this.homey.flow.getDeviceTriggerCard('favorable_consumption_window_ended');
      if (endTrigger) {
        endTrigger.trigger(this, {}).catch(err => this.error('favorable_consumption_window_ended trigger failed:', err));
      }
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    // Validate
    if (changedKeys.includes('max_charge_price')) {
      const maxCharge = newSettings.max_charge_price;
      const minDischarge = newSettings.min_discharge_price || oldSettings.min_discharge_price;
      
      if (maxCharge >= minDischarge) {
        throw new Error(`max_charge_price (€${maxCharge}) must be less than min_discharge_price (€${minDischarge})`);
      }
    }

    // Update timeline user notification if thresholds changed
    if (changedKeys.includes('max_charge_price') || changedKeys.includes('min_discharge_price')) {
      await this.homey.notifications.createNotification({
        excerpt: `Battery thresholds updated: charge ≤€${newSettings.max_charge_price}, discharge ≥€${newSettings.min_discharge_price}`
      });
    }

    // Invalidate Solcast cache when API key or resource ID changes
    if (changedKeys.includes('solcast_api_key') || changedKeys.includes('solcast_resource_id')) {
      this._solcastProvider?.invalidateCache();
    }

    // Update internal modules
    this.policyEngine.updateSettings(newSettings);
    this.tariffManager.updateSettings(newSettings);
    this.optimizationEngine.updateSettings(newSettings);

    // Push updated settings immediately so planning page reflects the change
    this.homey.settings.set('device_settings', {
      max_charge_price:    newSettings.max_charge_price    || 0.19,
      min_discharge_price: newSettings.min_discharge_price || 0.22,
      min_soc:             newSettings.min_soc             || 10,
      max_soc:             newSettings.max_soc             || 95,
      battery_efficiency:  newSettings.battery_efficiency  || 0.75,
      min_profit_margin:   newSettings.min_profit_margin   || 0.01,
      tariff_type:         newSettings.tariff_type         || 'dynamic',
      policy_interval:     newSettings.policy_interval     || 15,
      pv_capacity_w:       newSettings.pv_capacity_w       || 0,
      pv_estimation_enabled: newSettings.pv_estimation_enabled || false,
      price_resolution:    newSettings.price_resolution    || '15min',
    });

    // Handle interval change
    if (changedKeys.includes('policy_interval')) {
      this._schedulePolicyCheck();
    }

    // Rebuild schedule + refresh chart/widget immediately when resolution changes
    // Use setTimeout so the new setting is persisted before the policy check reads it
    if (changedKeys.includes('price_resolution')) {
      this.homey.setTimeout(() => {
        this._runPolicyCheck().catch(e => this.error('Policy recheck after resolution change failed:', e));
      }, 200);
    }

    // Weather update
    if (changedKeys.some(k => ['weather_latitude', 'weather_longitude', 'pv_tilt', 'pv_azimuth'].includes(k))) {
      this.weatherForecaster.invalidateCache();
      this.homey.setTimeout(() => {
        this._updateWeather().catch(err => this.error(err));
      }, 10);
    }

    // P1 reconnect
    if (changedKeys.includes('p1_device_id')) {
      this.homey.setTimeout(() => {
        this._connectP1Device().catch(err => this.error(err));
      }, 10);
    }

    // Dynamic pricing refresh
    if (
      changedKeys.includes('enable_dynamic_pricing') ||
      changedKeys.includes('tariff_type')
    ) {
      if (newSettings.tariff_type === 'dynamic' && newSettings.enable_dynamic_pricing) {
        this._schedulePriceRefresh();
      } else if (this.priceRefreshTimeout) {
        this.homey.clearTimeout(this.priceRefreshTimeout);
        this.priceRefreshTimeout = null;
        this.log('Price refresh stopped (dynamic pricing disabled)');
      }
    }

    // ✅ FIX: Add threshold settings to policy run triggers
    const requiresPolicyRun =
      changedKeys.includes('policy_interval') ||
      changedKeys.includes('weather_latitude') ||
      changedKeys.includes('weather_longitude') ||
      changedKeys.includes('p1_device_id') ||
      changedKeys.includes('enable_dynamic_pricing') ||
      changedKeys.includes('tariff_type') ||
      changedKeys.includes('max_charge_price') ||      // ← ADD THIS
      changedKeys.includes('min_discharge_price') ||   // ← ADD THIS
      changedKeys.includes('min_soc') ||               // ← ADD THIS (affects planning)
      changedKeys.includes('max_soc') ||               // ← ADD THIS (affects planning)
      changedKeys.includes('battery_efficiency') ||    // ← ADD THIS (affects break-even)
      changedKeys.includes('min_profit_margin');       // ← ADD THIS (affects spread calc)

    if (requiresPolicyRun) {
      // Push device_settings to app settings IMMEDIATELY (before policy run)
      // This ensures settings.html sees the new values when it refreshes
      this.homey.settings.set('device_settings', {
        max_charge_price:    newSettings.max_charge_price    || 0.19,
        min_discharge_price: newSettings.min_discharge_price || 0.22,
        min_soc:             newSettings.min_soc             || 10,
        max_soc:             newSettings.max_soc             || 95,
        battery_efficiency:  newSettings.battery_efficiency || 0.75,
        min_profit_margin:   newSettings.min_profit_margin   || 0.01,
        tariff_type:         newSettings.tariff_type         || 'dynamic',
        policy_interval:     newSettings.policy_interval     || 15,
        pv_capacity_w:       newSettings.pv_capacity_w       || 0,
        pv_estimation_enabled: newSettings.pv_estimation_enabled || false,
      });

      // Then run policy with new settings
      this.homey.setTimeout(() => {
        this._runPolicyCheck().catch(err => this.error(err));
      }, 500);
    }
}


  /**
   * Remove event listeners from the P1 device to prevent leaks on reconnect/uninit.
   */
  _cleanupP1Listeners() {
    if (this.p1Device && this._onBatteryEvent) {
      this.p1Device.removeListener('battery_event', this._onBatteryEvent);
    }
    this._onBatteryEvent = null;
  }

  async onUninit() {
    // Cleanup event listeners
    this._cleanupP1Listeners();

    // Cleanup intervals and timers when app stops/crashes
    if (this.policyCheckInterval) {
      this.homey.clearInterval(this.policyCheckInterval);
      this.policyCheckInterval = null;
    }

    if (this._slotAlignTimeout) {
      this.homey.clearTimeout(this._slotAlignTimeout);
      this._slotAlignTimeout = null;
    }

    if (this._hourBoundaryTimeout) {
      this.homey.clearTimeout(this._hourBoundaryTimeout);
      this._hourBoundaryTimeout = null;
    }

    if (this.priceRefreshTimeout) {
      this.homey.clearTimeout(this.priceRefreshTimeout);
      this.priceRefreshTimeout = null;
    }

    if (this._p1PollInterval) {
      this.homey.clearInterval(this._p1PollInterval);
      this._p1PollInterval = null;
    }

    if (this._modeHistoryFlushInterval) {
      this.homey.clearInterval(this._modeHistoryFlushInterval);
      this._modeHistoryFlushInterval = null;
    }

    if (this._settingsFlushTimer) {
      this.homey.clearTimeout(this._settingsFlushTimer);
      this._settingsFlushTimer = null;
    }
    // Final flush — write pending queued settings synchronously on shutdown
    // so the last policy run's state is not lost on restart.
    if (this._settingsQueue && this._settingsQueue.size > 0) {
      for (const [key, value] of this._settingsQueue) {
        try { this.homey.settings.set(key, value); } catch (_) {}
      }
      this._settingsQueue.clear();
    }

    this._modeChartImage = null;
  }

  async onDeleted() {
    this.log('BatteryPolicyDevice deleted');

    // Call onUninit to cleanup timers
    await this.onUninit();

    // Clear app-level settings written by this device
    // (prevents stale data if device is re-added)
    const settingsToClean = [
      'battery_policy_state',
      'policy_explainability',
      'policy_all_prices',
      'policy_all_prices_15min',
      'policy_debug_top3low',
      'policy_debug_top3high',
      'policy_weather_hourly',
      'policy_mode_history',
      'policy_optimizer_schedule',
      'policy_widget_data',
      'device_settings',
      'battery_expansion_analysis',
      'expansion_investment',
      'policy_consumption_profile',
      'battery_cycle_history',
      'learning_status',
      'pv_surplus_forecast',
      'policy_pv_forecast_hourly',
      'policy_pv_actual_today',
      `batt_mode_hist_${this.getData().id}`,
    ];
    for (const key of settingsToClean) {
      try { this.homey.settings.unset(key); } catch (_) {}
    }

    // Clear p1Device reference
    this.p1Device = null;

    this.log('BatteryPolicyDevice cleanup complete');
  }

  /**
   * Update two planning chart camera images (today + tomorrow) via quickchart.io.
   * Called from _saveWidgetData() after every policy run.
   */
  async _updatePlanningChart(compact) {
    // Guard: prevent concurrent calls (each call makes 3 HTTPS requests; a second concurrent
    // call while the first is mid-stream doubles memory pressure during an already-elevated
    // heap period and is the primary cause of nightly Memory Warning crashes).
    if (this._planningChartUpdating) {
      this.log('[MEM] Chart update skipped — previous still in progress');
      return;
    }
    // Guard: quickchart HTTP + image buffer adds ~30 MB; skip when heap is already elevated.
    let _heapChart = 0;
    try { _heapChart = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
    if (_heapChart > 35) {
      this.log(`[MEM] Planning chart update skipped — heap ${_heapChart.toFixed(1)} MB > 35 MB guard`);
      return;
    }
    this._planningChartUpdating = true;
    try {
      const slots = compact?.slots || [];

      // Split slots by Amsterdam calendar day
      const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }); // YYYY-MM-DD
      const today    = dayKey(Date.now());
      const tomorrow = dayKey(Date.now() + 86400000);

      const todaySlots    = slots.filter(s => dayKey(s.ts) === today);
      const tomorrowSlots = slots.filter(s => dayKey(s.ts) === tomorrow);

      this._chartToday    = { ...compact, slots: todaySlots };
      this._chartTomorrow = { ...compact, slots: tomorrowSlots };

      // Only call image.update() when chart data has materially changed.
      // Each update() fires a Homey realtime event that can override another app's
      // camera view on the mobile client — avoid spurious updates.
      const hashSlots = slots => JSON.stringify(slots.map(s => `${s.ts}:${s.mode}:${s.price}`));
      const hashToday    = hashSlots(todaySlots);
      const hashTomorrow = hashSlots(tomorrowSlots);

      // Today image
      if (!this.planningImageToday) {
        this.planningImageToday = await this.homey.images.createImage();
        this.planningImageToday.setStream(async (stream) => {
          if (this._isPredictiveMode) { stream.end(); return; }
          if (!this._chartToday || !this._chartToday.slots?.length) { stream.end(); return; }
          let _h = 0; try { _h = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
          if (_h > 38) { this.log(`[MEM] Today chart stream skipped — heap ${_h.toFixed(1)} MB > 38 MB`); stream.end(); return; }
          await this._streamQuickChart(stream, this._chartToday);
        });
        await this.setCameraImage('planning_today', 'Batterij Vandaag', this.planningImageToday);
        this._chartHashToday = null; // force first update
      }
      if (hashToday !== this._chartHashToday) {
        await this.planningImageToday.update();
        this._chartHashToday = hashToday;
      }

      // Tomorrow image — always registered so the webcam shows up in Homey even before
      // tomorrow's prices arrive (before ~14:00). Stream returns empty when no slots yet.
      if (!this.planningImageTomorrow) {
        this.planningImageTomorrow = await this.homey.images.createImage();
        this.planningImageTomorrow.setStream(async (stream) => {
          if (this._isPredictiveMode) { stream.end(); return; }
          if (!this._chartTomorrow || !this._chartTomorrow.slots?.length) { stream.end(); return; }
          let _h = 0; try { _h = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
          if (_h > 38) { this.log(`[MEM] Tomorrow chart stream skipped — heap ${_h.toFixed(1)} MB > 38 MB`); stream.end(); return; }
          await this._streamQuickChart(stream, this._chartTomorrow);
        });
        await this.setCameraImage('planning_tomorrow', 'Batterij Morgen', this.planningImageTomorrow);
        this._chartHashTomorrow = null; // force first update
      }
      if (tomorrowSlots.length > 0 && hashTomorrow !== this._chartHashTomorrow) {
        await this.planningImageTomorrow.update();
        this._chartHashTomorrow = hashTomorrow;
      }

      // PV forecast vs actual image
      const pvActual   = this.homey.settings.get('policy_pv_actual_today');
      const pvForecast = this._liveState.policy_pv_forecast_hourly
        ?? this.homey.settings.get('policy_pv_forecast_hourly');
      const pvCapW     = this.getSetting('pv_capacity_w') || 0;

      this._pvChartData = { pvActual, pvForecast, pvCapacityW: pvCapW };

      if (!this.planningImagePv) {
        await this._initPvCamera();
      }

      const pvHash = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }) + JSON.stringify(pvActual?.sums) + JSON.stringify(pvForecast);
      if (pvHash !== this._pvChartHash) {
        await this.planningImagePv.update();
        this._pvChartHash = pvHash;
      }

      this.log('📊 Planning chart camera images updated (today + tomorrow + PV)');
    } catch (err) {
      this.error('Failed to update planning chart:', err);
    } finally {
      this._planningChartUpdating = false;
    }
  }

  // Serialize a chart config object to a JavaScript expression string so that
  // function callbacks (e.g. legend filter) survive the round-trip to quickchart.io.
  _configToJs(val) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'function') return val.toString();
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    if (typeof val === 'string') return JSON.stringify(val);
    if (Array.isArray(val)) return '[' + val.map(v => this._configToJs(v)).join(',') + ']';
    const entries = Object.entries(val)
      .map(([k, v]) => `${JSON.stringify(k)}:${this._configToJs(v)}`)
      .join(',');
    return '{' + entries + '}';
  }

  async _streamQuickChart(stream, compact) {
    // eslint-disable-next-line global-require
    const https = require('https');
    const chartCfg = this._buildQuickChartConfig(compact);
    if (!chartCfg) { stream.end(); return; }
    // Pass chart as JS expression string so quickchart.io evaluates function callbacks
    const slots = compact?.slots || [];
    const slotMs = slots.length >= 2 ? (slots[1].ts - slots[0].ts) : 900000;
    const body = JSON.stringify({
      version: '4',
      backgroundColor: '#1c1c1e',
      width: 900,
      height: 500,
      chart: this._configToJs(chartCfg),
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'quickchart.io',
        path: '/chart',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            const err = new Error(`quickchart.io ${res.statusCode}: ${body.slice(0, 200)}`);
            stream.destroy(err);
            reject(err);
          });
          return;
        }
        res.pipe(stream);
        res.on('end', resolve);
        res.on('error', (e) => { stream.destroy(e); reject(e); });
      });
      req.on('error', (e) => { stream.destroy(e); reject(e); });
      req.write(body);
      req.end();
    });
  }

  async _streamPvChart(stream, pvData) {
    // eslint-disable-next-line global-require
    const https = require('https');
    const chartCfg = this._buildPvChartConfig(pvData);
    if (!chartCfg) { stream.end(); return; }
    const body = JSON.stringify({
      version: '4',
      backgroundColor: '#1c1c1e',
      width: 900,
      height: 900,
      chart: this._configToJs(chartCfg),
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'quickchart.io',
        path: '/chart',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', chunk => { errBody += chunk; });
          res.on('end', () => {
            const err = new Error(`quickchart.io PV ${res.statusCode}: ${errBody.slice(0, 200)}`);
            stream.destroy(err);
            reject(err);
          });
          return;
        }
        res.pipe(stream);
        res.on('end', resolve);
        res.on('error', (e) => { stream.destroy(e); reject(e); });
      });
      req.on('error', (e) => { stream.destroy(e); reject(e); });
      req.write(body);
      req.end();
    });
  }

  async _streamModeChart(stream) {
    // eslint-disable-next-line global-require
    const https = require('https');
    if (!this._modeChartBody) { stream.end(); return; }
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'quickchart.io',
        path: '/chart',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(this._modeChartBody),
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', chunk => { errBody += chunk; });
          res.on('end', () => {
            const err = new Error(`quickchart.io mode ${res.statusCode}: ${errBody.slice(0, 200)}`);
            stream.destroy(err);
            reject(err);
          });
          return;
        }
        res.pipe(stream);
        res.on('end', resolve);
        res.on('error', (e) => { stream.destroy(e); reject(e); });
      });
      req.on('error', (e) => { stream.destroy(e); reject(e); });
      req.write(this._modeChartBody);
      req.end();
    });
  }

  async _initPvCamera() {
    if (this.planningImagePv) return;
    this.planningImagePv = await this.homey.images.createImage();
    this.planningImagePv.setStream(async (stream) => {
      const pvActual   = this.homey.settings.get('policy_pv_actual_today');
      const pvForecast = this._liveState.policy_pv_forecast_hourly
        ?? this.homey.settings.get('policy_pv_forecast_hourly');
      const pvCapW     = this.getSetting('pv_capacity_w') || 0;
      if (!pvActual && !pvForecast) { stream.end(); return; }
      let _h = 0; try { _h = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (_h > 38) { this.log(`[MEM] PV chart stream skipped — heap ${_h.toFixed(1)} MB > 38 MB`); stream.end(); return; }
      try {
        await this._streamPvChart(stream, { pvActual, pvForecast, pvCapacityW: pvCapW });
      } catch (e) {
        this.error('PV chart stream error:', e.message);
        if (!stream.destroyed) stream.end();
      }
    });
    await this.setCameraImage('planning_pv', 'PV Opwek', this.planningImagePv);
    this.log('📷 PV Opwek camera geregistreerd');

    // Load initial data so the camera has content immediately
    const pvActual   = this.homey.settings.get('policy_pv_actual_today');
    const pvForecast = this._liveState.policy_pv_forecast_hourly
      ?? this.homey.settings.get('policy_pv_forecast_hourly');
    const pvCapW     = this.getSetting('pv_capacity_w') || 0;
    if (pvForecast || pvActual) {
      this._pvChartData = { pvActual, pvForecast, pvCapacityW: pvCapW };
      await this.planningImagePv.update();
    }
  }

  async _initModeHistoryCamera() {
    if (this._modeChartImage) return;

    // Seed recording + build body BEFORE registering camera, so Homey's initial
    // fetch has valid content. Without this the first stream fetch returns
    // empty and Homey hides the tile in the device "More Info" page.
    if (this.p1Device) {
      const mode = this.p1Device._currentDetailedMode
        || this.p1Device.getCapabilityValue('battery_group_charge_mode')
        || 'unknown';
      const soc = this.p1Device.getCapabilityValue('battery_group_average_soc') ?? 50;
      this._recordModeHistory(mode);
      this._recordSoCHistory(soc);
    }

    this._modeChartImage = await this.homey.images.createImage();
    this._modeChartImage.setStream(async (stream) => {
      // Build body on demand — ensures fresh data on every fetch, survives
      // in-memory resets after app restart.
      if (this._modeHistory?.length) {
        await this._buildModeChartBody();
      }
      if (!this._modeChartBody) { stream.end(); return; }
      // Guard: Homey fetches the stream asynchronously — the HTTP request to quickchart
      // adds ~30 MB of heap. Skip if heap is already elevated to avoid a crash.
      let _heapStream = 99;
      try { _heapStream = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (_heapStream > 38) {
        this.log(`[MEM] Mode chart stream skipped — heap ${_heapStream.toFixed(1)} MB > 38 MB`);
        stream.end();
        return;
      }
      await this._streamModeChart(stream);
    });

    // Pre-build body so the initial setCameraImage fetch has content
    if (this._modeHistory?.length) {
      let heap = 0;
      try { heap = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (heap > 40) {
        this.log(`[MEM] Skipping initial mode chart body — heap ${heap.toFixed(1)} MB > 40 MB guard`);
      } else {
        await this._buildModeChartBody();
      }
    }

    await this.setCameraImage('battery_mode_history', 'Batterij Modi', this._modeChartImage);
    this.log('📷 Batterij Modi camera geregistreerd');
  }

  async _updateModeChart() {
    if (!this._modeChartImage) return;
    if (!this._modeHistory?.length) return;
    if (this._modeChartUpdating) {
      this.log('[MEM] Mode chart update skipped — previous still in progress');
      return;
    }
    this._modeChartUpdating = true;

    try {
      await this._buildModeChartBody();
      await this._modeChartImage.update();
      this.log('📊 Battery mode chart updated (15-min slots)');
    } finally {
      this._modeChartUpdating = false;
    }
  }

  async _buildModeChartBody() {
    if (!this._modeHistory?.length) return;

    // Build 24h of 15-min slots (96 total), oldest first
    const currentSlotMs = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000);
    const slots = [];
    for (let i = 95; i >= 0; i--) {
      slots.push(new Date(currentSlotMs - i * 15 * 60000).toISOString().slice(0, 16)); // 'YYYY-MM-DDTHH:MM'
    }

    const bySlot = {};
    for (const b of this._modeHistory) bySlot[b.h] = b;

    const MODE_ORDER = [
      'to_full', 'zero_charge_only', 'zero_discharge_only', 'zero', 'standby',
      'predictive_zero', 'predictive_charge', 'predictive_discharge', 'predictive_standby',
    ];
    const MODE_COLORS = {
      to_full:              '#5f6fff',
      zero_charge_only:     '#8b9fff',
      zero_discharge_only:  '#20F29B',
      zero:                 '#FB923C',
      standby:              '#808080',
      predictive_zero:      'rgba(251,146,60,0.55)',
      predictive_charge:    'rgba(139,159,255,0.55)',
      predictive_discharge: 'rgba(32,242,155,0.55)',
      predictive_standby:   'rgba(128,128,128,0.55)',
    };
    const MODE_LABELS = {
      to_full: 'Laden', zero_charge_only: 'Laden PV', zero_discharge_only: 'Ontladen',
      zero: 'Nul', standby: 'Standby',
      predictive_zero: 'HW Nul', predictive_charge: 'HW Laden',
      predictive_discharge: 'HW Ontladen', predictive_standby: 'HW Standby',
    };

    // Labels: uur tonen alleen op :00-slots (elke 4 balkjes), rest leeg
    const labels = slots.map(s => {
      if (!s.endsWith(':00')) return '';
      const h = new Date(s + ':00Z').toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' });
      return h.padStart(2, '0') + 'u';
    });

    const modeDatasets = MODE_ORDER.map(mode => {
      const data = slots.map(slot => {
        const m = bySlot[slot]?.m || {};
        const total = Object.values(m).reduce((s, v) => s + v, 0);
        if (total === 0) return 0;
        return Math.round((m[mode] || 0) / total * 100);
      });
      if (!data.some(v => v > 0)) return null;
      return {
        label: MODE_LABELS[mode] || mode,
        data,
        backgroundColor: MODE_COLORS[mode] || '#888',
        stack: 'modes',
        borderWidth: 0,
      };
    }).filter(Boolean);

    const socData = slots.map(slot => bySlot[slot]?.soc ?? null);
    const hasSoC = socData.some(v => v !== null);

    const datasets = [
      ...modeDatasets,
      ...(hasSoC ? [{
        label: 'SoC %',
        data: socData,
        type: 'line',
        yAxisID: 'ySoC',
        borderColor: '#ffffff',
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
        spanGaps: true,
      }] : []),
    ];

    const chartCfg = {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: false,
        plugins: {
          legend: { labels: { color: '#ccc', font: { size: 13 }, boxWidth: 12 } },
          title: {
            display: true,
            text: 'Batterij modi — afgelopen 24 uur',
            color: '#e0e0e0',
            font: { size: 15 },
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#aaa', font: { size: 12 }, maxRotation: 0 },
            grid: { color: '#333' },
            barPercentage: 0.8,
            categoryPercentage: 1.0,
          },
          y: {
            stacked: true, min: 0, max: 100,
            ticks: { color: '#aaa', font: { size: 12 }, callback: (v) => v + '%' },
            grid: { color: '#333' },
          },
          ...(hasSoC ? {
            ySoC: {
              min: 0, max: 100, position: 'right',
              ticks: { color: '#fff', font: { size: 12 }, callback: (v) => v + '%' },
              grid: { drawOnChartArea: false },
            },
          } : {}),
        },
      },
    };

    this._modeChartBody = JSON.stringify({
      version: '4',
      backgroundColor: '#1c1c1e',
      width: 900,
      height: 500,
      chart: chartCfg,
    });
  }

  _recordModeHistory(mode) {
    const currentSlotMs = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000);
    const slotKey = new Date(currentSlotMs).toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
    if (!this._modeHistory) this._modeHistory = [];

    let bucket = this._modeHistory.find(b => b.h === slotKey);
    if (!bucket) {
      bucket = { h: slotKey, m: {} };
      this._modeHistory.push(bucket);
      // Keep only last 25h (100 slots)
      const cutoff = Date.now() - 25 * 3600 * 1000;
      this._modeHistory = this._modeHistory.filter(
        b => new Date(b.h + ':00Z').getTime() > cutoff
      );
    }

    bucket.m[mode] = (bucket.m[mode] || 0) + 1;
  }

  _recordSoCHistory(soc) {
    if (typeof soc !== 'number') return;
    const currentSlotMs = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000);
    const slotKey = new Date(currentSlotMs).toISOString().slice(0, 16);
    if (!this._modeHistory) this._modeHistory = [];
    const bucket = this._modeHistory.find(b => b.h === slotKey);
    if (bucket) bucket.soc = soc;
  }

  _buildPvChartConfig(pvData) {
    const { pvActual, pvForecast, pvCapacityW } = pvData || {};
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
    const pvHourly = (pvActual?.date === todayStr && Array.isArray(pvActual?.hourly)) ? pvActual.hourly : [];
    const forecastToday    = pvForecast?.[0] || {};
    const forecastTomorrow = pvForecast?.[1] || {};

    const fLg = 28;
    const fMd = 24;
    const fSm = 22;

    // Current Amsterdam hour
    const nowAmsHour = parseInt(
      new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10
    );

    // Determine if we have tomorrow data
    const hasTomorrow = Object.keys(forecastTomorrow).length > 0;

    // Build labels: 0-23 for today, optionally 0-23 for tomorrow
    const hours = [];
    for (let h = 0; h < 24; h++) hours.push(h);
    if (hasTomorrow) for (let h = 0; h < 24; h++) hours.push(24 + h);

    const labels = hours.map((h, i) => {
      const displayH = h % 24;
      if (displayH === 0 && i > 0) return 'Morgen';
      if (displayH % 2 === 0) return String(displayH);
      return '';
    });

    // Actual PV data (only past hours of today)
    const actualData = hours.map(h => {
      if (h >= 24) return null; // no actual for tomorrow
      if (h > nowAmsHour) return null; // future hours of today
      return pvHourly[h] ?? null;
    });

    // Forecast PV data (full today + tomorrow) — use 0 for missing hours so line stays continuous
    const forecastData = hours.map(h => {
      if (h < 24) return forecastToday[h] ?? 0;
      return forecastTomorrow[h - 24] ?? 0;
    });

    // Compute daily totals (kWh)
    const actualTodayKwh = pvHourly.reduce((sum, w) => sum + (w || 0), 0) / 1000;
    const forecastTodayKwh = Object.values(forecastToday).reduce((sum, w) => sum + (w || 0), 0) / 1000;
    const forecastTomorrowKwh = Object.values(forecastTomorrow).reduce((sum, w) => sum + (w || 0), 0) / 1000;

    const pvMax = Math.max(
      ...pvHourly.filter(v => v != null).map(v => v),
      ...Object.values(forecastToday).map(v => v || 0),
      ...Object.values(forecastTomorrow).map(v => v || 0),
      1
    );
    const yMax = pvCapacityW > 0 ? Math.max(pvCapacityW, pvMax * 1.1) : pvMax * 1.2;

    const todayDate = new Date().toLocaleDateString('nl-NL', {
      timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'long'
    });

    const updTime = new Date().toLocaleTimeString('nl-NL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
    });

    const titleParts = [`☀ PV Opwek ${todayDate}`];
    titleParts.push(`Werkelijk: ${actualTodayKwh.toFixed(1)} kWh`);
    titleParts.push(`Verwacht: ${forecastTodayKwh.toFixed(1)} kWh`);
    if (hasTomorrow) titleParts.push(`Morgen: ${forecastTomorrowKwh.toFixed(1)} kWh`);

    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'PV Werkelijk',
            data: actualData,
            borderColor: '#FCD34D',
            backgroundColor: 'rgba(252,211,77,0.25)',
            fill: true,
            borderWidth: 4,
            pointRadius: 0,
            tension: 0.4,
            spanGaps: false,
            yAxisID: 'yPv',
          },
          {
            label: 'PV Verwachting',
            data: forecastData,
            borderColor: '#F97316',
            backgroundColor: 'rgba(249,115,22,0.10)',
            fill: true,
            borderWidth: 3,
            borderDash: [6, 3],
            pointRadius: 0,
            tension: 0.4,
            spanGaps: false,
            yAxisID: 'yPv',
          },
        ],
      },
      options: {
        responsive: false,
        animation: false,
        layout: {
          padding: { top: 12, bottom: 16, left: 4, right: 4 },
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#9a9a9a',
              font: { size: fLg },
              padding: 18,
              usePointStyle: true,
            },
          },
          title: {
            display: true,
            text: titleParts[0] + '  |  ' + updTime,
            color: '#FCD34D',
            font: { size: fLg, weight: 'bold' },
            padding: { bottom: 4 },
          },
          subtitle: {
            display: true,
            text: titleParts.slice(1).join('  |  '),
            color: '#cccccc',
            font: { size: fLg },
            padding: { bottom: 8 },
          },
        },
        scales: {
          x: {
            ticks: { color: '#9a9a9a', font: { size: fMd }, maxRotation: 0, autoSkip: false },
            grid: { color: '#2a2a2a' },
          },
          yPv: {
            position: 'left',
            min: 0,
            max: yMax,
            ticks: {
              color: '#FCD34D',
              font: { size: fLg, weight: 'bold' },
              callback: function(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'kW' : v + 'W'; },
            },
            grid: { color: '#2a2a2a' },
            title: { display: true, text: 'Vermogen', color: '#FCD34D', font: { size: fMd } },
          },
        },
      },
    };
  }

  _buildQuickChartConfig(compact) {
    const slots = compact?.slots || [];
    const now   = Date.now();

    const shown = slots.slice(0, 96); // max one day (96 × 15min or 24 × 1h — both fit)
    if (shown.length === 0) return null;

    const fLg = 20;
    const fMd = 18;
    const fSm = 16;

    const MODE_COLORS = {
      to_full:             '#5f6fff',
      zero_charge_only:    '#8b9fff',
      zero_discharge_only: '#20F29B',
      zero:                '#FB923C',
      standby:             '#808080',
      predictive:          '#02DACE',
      past:                '#aaaaaa',
    };

    const fmt2 = n => String(n).padStart(2, '0');

    // Labels: show HH:00 on whole hours; midnight gets a short date prefix
    const labels  = shown.map(s => {
      const min = Math.floor((s.ts % 3600000) / 60000);
      if (min !== 0) return '';
      if (s.hour === 0) {
        const d = new Date(s.ts);
        const day = d.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'numeric' });
        return day;
      }
      return String(s.hour);
    });
    const prices  = shown.map(s => s.price != null ? Math.round(s.price * 1000) / 1000 : null);
    // Interpolate missing SoC for past slots (gaps in modeHistory = app wasn't running)
    const rawSocs = shown.map(s => s.soc != null ? s.soc : null);
    const socs = rawSocs.slice();
    for (let i = 0; i < socs.length; i++) {
      if (socs[i] != null) continue;
      if (shown[i].ts >= now) continue; // leave future nulls as-is
      // find nearest non-null on each side
      let left = -1, right = -1;
      for (let l = i - 1; l >= 0; l--) { if (socs[l] != null) { left = l; break; } }
      for (let r = i + 1; r < socs.length; r++) { if (socs[r] != null) { right = r; break; } }
      if (left >= 0 && right >= 0) {
        socs[i] = Math.round(socs[left] + (socs[right] - socs[left]) * (i - left) / (right - left));
      } else if (left >= 0) {
        socs[i] = socs[left];
      } else if (right >= 0) {
        socs[i] = socs[right];
      }
    }
    // Split SoC into actual (solid, past) and forecast (dashed, future)
    // Include last past slot in socForecast so the two lines connect visually
    const socActual   = socs.map((v, i) => shown[i].ts < now ? v : null);
    const socForecast = socs.map((v, i) => {
      if (shown[i].ts >= now) return v;
      if (i + 1 < shown.length && shown[i + 1].ts >= now) return v;
      return null;
    });

    // Split PV into actual (past) and forecast (future) — null outside own range
    const pvActual   = shown.map(s => s.ts < now ? Math.round((s.pvW || 0) / 10) * 10 : null);
    // Include the last past slot in pvForecast so the dashed line connects to the solid line
    const pvForecast = shown.map((s, i) => {
      if (s.ts >= now) return Math.round((s.pvW || 0) / 10) * 10;
      if (i + 1 < shown.length && shown[i + 1].ts >= now) return Math.round((s.pvW || 0) / 10) * 10;
      return null;
    });
    const pvMax      = Math.max(...shown.map(s => Math.round((s.pvW || 0) / 10) * 10), 1);

    const barColors = shown.map(s => {
      const base = MODE_COLORS[s.mode] || '#808080';
      return base + (s.ts < now ? '77' : 'CC');
    });

    // One phantom dataset per mode present — for legend only (exclude 'past')
    const modesPresent = [...new Set(shown.map(s => s.mode))].filter(m => m !== 'past');

    const MODE_LABELS = {
      to_full: 'Laden', zero_charge_only: 'PV laden', zero_discharge_only: 'Ontladen',
      zero: 'Nul', standby: 'Standby', predictive: 'Slim laden',
    };

    const socLine  = compact?.currentSoc  != null ? `${Math.round(compact.currentSoc)}%` : '-';
    const modeLine = MODE_LABELS[compact?.currentMode] || compact?.currentMode || 'standby';

    // Determine chart day label from first slot
    const firstTs   = shown.find(s => s.mode !== 'past')?.ts ?? shown[0]?.ts;
    const today     = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
    const slotDay   = firstTs
      ? new Date(firstTs).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })
      : today;
    const dayLabel  = slotDay === today
      ? 'Vandaag'
      : new Date(firstTs).toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long' });
    const updLine   = compact?.updatedAt
      ? new Date(compact.updatedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
      : '';

    const modeDatasets = modesPresent.map(mode => ({
      type: 'bar',
      label: MODE_LABELS[mode] || mode,
      data: [],
      backgroundColor: (MODE_COLORS[mode] || '#808080') + 'CC',
      yAxisID: 'yPrice',
      order: 99,
    }));

    return {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: '_prijs',
            data: prices,
            backgroundColor: barColors,
            borderColor: barColors,
            borderWidth: 0,
            yAxisID: 'yPrice',
            order: 3,
          },
          {
            type: 'line',
            label: 'SoC (%)',
            data: socActual,
            borderColor: 'rgba(255,255,255,0.85)',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            pointStyle: 'line',
            yAxisID: 'ySoc',
            order: 1,
            spanGaps: true,
          },
          {
            type: 'line',
            label: '_soc_forecast',
            data: socForecast,
            borderColor: 'rgba(255,255,255,0.85)',
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [5, 4],
            pointRadius: 0,
            pointStyle: 'line',
            yAxisID: 'ySoc',
            order: 1,
            spanGaps: true,
          },
          {
            type: 'line',
            label: 'PV',
            data: pvActual,
            borderColor: '#FCD34D',
            backgroundColor: 'rgba(252,211,77,0.15)',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            pointStyle: 'line',
            tension: 0.4,
            spanGaps: false,
            yAxisID: 'yPv',
            order: 2,
          },
          {
            type: 'line',
            label: '_pv_forecast',
            data: pvForecast,
            borderColor: '#FCD34D',
            backgroundColor: 'rgba(252,211,77,0.08)',
            fill: true,
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            pointStyle: 'line',
            tension: 0.4,
            spanGaps: false,
            yAxisID: 'yPv',
            order: 2,
          },
          ...modeDatasets,
        ],
      },
      options: {
        responsive: false,
        animation: false,
        layout: {
          padding: { top: 12, bottom: 16, left: 4, right: 4 },
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#9a9a9a',
              font: { size: fLg },
              padding: 14,
              usePointStyle: true,
              filter: function(item) { return !item.text.startsWith('_'); },
            },
          },
          title: {
            display: true,
            text: `Batterij ${dayLabel}  |  SoC: ${socLine}  |  Nu: ${modeLine}  |  ${updLine}`,
            color: '#cccccc',
            font: { size: fLg },
            padding: { bottom: 2 },
          },
          subtitle: {
            display: true,
            text: `☀ PV max: ${pvMax >= 1000 ? `${(pvMax/1000).toFixed(1)}kW` : `${pvMax}W`}`,
            color: '#FCD34D',
            font: { size: fSm, weight: 'bold' },
            padding: { bottom: 6 },
          },
        },
        scales: {
          x: {
            ticks: { color: '#9a9a9a', font: { size: fMd }, maxRotation: 0, autoSkip: false },
            grid: { color: '#2a2a2a' },
          },
          yPrice: {
            position: 'left',
            ticks: {
              color: '#cccccc',
              font: { size: fLg, weight: 'bold' },
              callback: (v) => v.toFixed(2),
            },
            grid: { color: '#2a2a2a' },
            title: { display: true, text: 'EUR/kWh', color: '#9a9a9a', font: { size: fSm } },
          },
          ySoc: {
            position: 'right',
            min: 0,
            max: 100,
            ticks: {
              color: 'rgba(255,255,255,0.85)',
              font: { size: fLg, weight: 'bold' },
              callback: (v) => `${v}%`,
            },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'SoC', color: 'rgba(255,255,255,0.6)', font: { size: fSm } },
          },
          yPv: {
            display: false,
            position: 'right',
            min: 0,
            max: compact?.pvCapacityW > 0 ? compact.pvCapacityW : pvMax * 1.2,
            ticks: { display: false },
            grid: { drawOnChartArea: false },
          },
        },
      },
    };
  }


  async _updateBatteryCostModel({ batteryPower, gridPower, pvState, soc }) {
    const intervalSeconds = 15; // polling interval is 15s (every 20th call = 5 min log)
    const deltaKwh = (batteryPower / 1000) * (intervalSeconds / 3600);

    // If battery is physically empty, record completed cycle then wipe stale cost tracking.
    // Use max(minSoc, 3) so the cycle is recorded when the firmware stops discharging
    // (typically 1-3% reported SoC), not only at exactly 0-1%.
    const minSoc = this.getSetting('min_soc') ?? 0;
    if (soc !== null && soc <= Math.max(minSoc, 3)) {
      // Save cycle profit if we discharged a meaningful amount
      if ((this._cycleKwhDischarged || 0) > 0.05) {
        const profit = (this._cycleRevenue || 0) - (this._cycleCost || 0);
        const avgDischargePrice = this._cycleRevenue / this._cycleKwhDischarged;
        let cycleHistory = this.homey.settings.get('battery_cycle_history') || [];
        cycleHistory.push({
          date: new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10),
          kwhDischarged: +this._cycleKwhDischarged.toFixed(3),
          avgChargePrice: +(this._costAvg || 0).toFixed(4),
          avgDischargePrice: +avgDischargePrice.toFixed(4),
          profitEur: +profit.toFixed(4),
        });
        if (cycleHistory.length > 60) cycleHistory = cycleHistory.slice(-60);
        this.homey.settings.set('battery_cycle_history', cycleHistory);
        this.log(`💰 Cycle recorded: ${this._cycleKwhDischarged.toFixed(2)}kWh discharged @ avg €${avgDischargePrice.toFixed(3)}, cost €${this._cycleCost.toFixed(3)}, profit €${profit.toFixed(3)}`);
      }
      this._cycleRevenue = 0;
      this._cycleCost = 0;
      this._cycleKwhDischarged = 0;
      await this.setStoreValue('cycle_kwh_discharged', 0);
      await this.setStoreValue('cycle_revenue', 0);
      await this.setStoreValue('cycle_cost', 0);

      if ((this._costEnergy || 0) > 0 || (this._costAvg || 0) > 0) {
        this.log(`💰 CostModel RESET: SoC ${soc}% <= ${Math.max(minSoc, 3)}% → clearing stale energy`);
        this._costEnergy = 0;
        this._costAvg = 0;
        await this.setStoreValue('battery_energy_kwh', 0);
        await this.setStoreValue('battery_avg_cost', 0);
      }
      return;
    }

    // Initialize in-memory accumulators from store on first call
    if (this._costEnergy === undefined) {
      this._costEnergy       = await this.getStoreValue('battery_energy_kwh')    || 0;
      this._costAvg          = await this.getStoreValue('battery_avg_cost')       || 0;
      this._cycleKwhDischarged = await this.getStoreValue('cycle_kwh_discharged') || 0;
      this._cycleRevenue     = await this.getStoreValue('cycle_revenue')          || 0;
      this._cycleCost        = await this.getStoreValue('cycle_cost')             || 0;
    }

    // Log every 60s (every 12th call)
    this._costModelCallCount = (this._costModelCallCount || 0) + 1;
    if (this._costModelCallCount % 12 === 0) {
      this.log(`💰 CostModel: batteryPower=${batteryPower}W, deltaKwh=${deltaKwh.toFixed(6)}, energy=${this._costEnergy.toFixed(3)}kWh, avgCost=€${this._costAvg.toFixed(4)}, pvState=${pvState}`);
    }

    if (Math.abs(deltaKwh) < 0.000001) return; // effectively zero

    let costNew;

    if (batteryPower > 10) {
      // Charging — if we just finished a meaningful discharge session, record the cycle now.
      // This handles PV-heavy days where SoC never reaches 0% (so the SoC-based trigger above
      // never fires). Minimum 0.3 kWh prevents noise from short standby/idle transitions.
      if (this._wasDischarging && (this._cycleKwhDischarged || 0) >= 0.3) {
        const profit = (this._cycleRevenue || 0) - (this._cycleCost || 0);
        const avgDischargePrice = this._cycleRevenue / this._cycleKwhDischarged;
        let cycleHistory = this.homey.settings.get('battery_cycle_history') || [];
        cycleHistory.push({
          date: new Date().toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10),
          kwhDischarged: +this._cycleKwhDischarged.toFixed(3),
          avgChargePrice: +(this._costAvg || 0).toFixed(4),
          avgDischargePrice: +avgDischargePrice.toFixed(4),
          profitEur: +profit.toFixed(4),
        });
        if (cycleHistory.length > 60) cycleHistory = cycleHistory.slice(-60);
        this.homey.settings.set('battery_cycle_history', cycleHistory);
        this.log(`💰 Cycle recorded (discharge→charge): ${this._cycleKwhDischarged.toFixed(2)}kWh @ avg €${avgDischargePrice.toFixed(3)}, profit €${profit.toFixed(3)}`);
        this._cycleRevenue = 0;
        this._cycleCost = 0;
        this._cycleKwhDischarged = 0;
        await this.setStoreValue('cycle_kwh_discharged', 0);
        await this.setStoreValue('cycle_revenue', 0);
        await this.setStoreValue('cycle_cost', 0);
      }
      this._wasDischarging = false;

      if (pvState) {
        const pvMode = this.getSetting('pv_cost_mode') || 'free';
        const feedIn = this.getSetting('feed_in_tariff') ?? 0.08;

        costNew = (pvMode === 'feedin') ? feedIn : 0;
      } else {
        // Grid charging
        const tariff = this.tariffManager.getCurrentTariff(gridPower);
        costNew = tariff.currentPrice;
      }

      const Enew = this._costEnergy + deltaKwh;
      const avgNew = ((this._costAvg * this._costEnergy) + (costNew * deltaKwh)) / Enew;

      this._costEnergy = Enew;
      this._costAvg = avgNew;

      if (debug) this.log(`💰 CostModel charge: +${deltaKwh.toFixed(5)}kWh @ €${costNew?.toFixed(4)}, avgCost now €${avgNew.toFixed(4)}, total ${Enew.toFixed(3)}kWh`);

    } else if (batteryPower < -10) {
      // Discharging — accumulate revenue for cycle profit tracking
      this._wasDischarging = true;
      const dischargeKwh = Math.abs(deltaKwh);
      const dischargePrice = this.tariffManager.getCurrentTariff(gridPower).currentPrice;
      this._cycleRevenue       = (this._cycleRevenue       || 0) + dischargeKwh * dischargePrice;
      this._cycleCost          = (this._cycleCost          || 0) + dischargeKwh * (this._costAvg || 0);
      this._cycleKwhDischarged = (this._cycleKwhDischarged || 0) + dischargeKwh;

      this._costEnergy = Math.max(0, this._costEnergy + deltaKwh);

      if (this._costModelCallCount % 12 === 0) {
        if (debug) this.log(`💰 CostModel discharge: ${deltaKwh.toFixed(5)}kWh @ €${dischargePrice.toFixed(4)}, total ${this._costEnergy.toFixed(3)}kWh`);
      }
    }

    // Persist to store every 2 minutes (every 8th call) instead of every 15s
    if (this._costModelCallCount % 8 === 0) {
      await this.setStoreValue('battery_energy_kwh',    this._costEnergy);
      await this.setStoreValue('battery_avg_cost',      this._costAvg);
      await this.setStoreValue('cycle_kwh_discharged',  this._cycleKwhDischarged || 0);
      await this.setStoreValue('cycle_revenue',         this._cycleRevenue       || 0);
      await this.setStoreValue('cycle_cost',            this._cycleCost          || 0);
    }
  }


}

module.exports = BatteryPolicyDevice;