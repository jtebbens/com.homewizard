'use strict';

const Homey = require('homey');
const WeatherForecaster = require('../../lib/weather-forecaster');
const PolicyEngine = require('../../lib/policy-engine');
const TariffManager = require('../../lib/tariff-manager');
const LearningEngine = require('../../lib/learning-engine');
const EfficiencyEstimator = require('../../lib/efficiency-estimator');
const OptimizationEngine = require('../../lib/optimization-engine');
const { exportValue } = require('../../lib/price-formulas');
const ChartRenderer = require('../../lib/chart-renderer');
const { sanitizeSoc, createState } = require('../../lib/soc-glitch-guard');
const userdataStore = require('../../lib/userdata-store');

const debug = false;

// Cached formatter for the planning-chart day-split below — constructing a fresh
// Intl.DateTimeFormat per slot (via toLocaleDateString) was a confirmed CPU hotspot
// (139 samples in one profiled second) since it's called once per slot in a filter().
const _amsDayKeyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' });
const _amsHourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false });

// The mode history is stored as one JSON file per Amsterdam day on /userdata. It lived in settings
// before -- first as a single 2200-entry key (~596 kB), then as per-day keys -- but chunking only
// shrank the per-key payload, not the cost: every settings.set() ships the WHOLE settings object
// (SDK manager/settings.js _save -> emitApp('setSettings', …)), so 587 kB of history rode along on
// every unrelated write, 43.8% of a 1340 kB blob. Off settings, an append writes ~25 kB to disk and
// costs other keys nothing. Retention is unchanged in wall-clock terms: MODE_HISTORY_DAYS ≈ the old
// 2200-entry cap at 96 buckets/day, which learning-engine.js:715-718 (EMA alpha 0.01 ≈ 25d) is
// tuned against.
const MODE_HISTORY_PREFIX    = 'policy_mode_history_';
const MODE_HISTORY_DIR       = '/userdata';
const MODE_HISTORY_DAYS      = 23;
const MODE_HISTORY_BUCKET_MS = 15 * 60 * 1000;
const MODE_HISTORY_FILE_RE   = /^mode-history-(\d{4}-\d{2}-\d{2})\.json$/;
const FLOORFIX_SAMPLES_MAX   = 250;

// [DP-INPUT-DUMP] lands one compute()-input snapshot per file next to the mode history. It used to
// go to this.log(), but /tmp/homey.log is tmpfs: a ~150 kB dump line rolls out of reach as the log
// grows and is gone after a restart, so the capture kept expiring before anyone read it. On
// /userdata it survives both and is one plain-HTTP GET from the dev box. 12 ≈ an hour of runs.
const DP_DUMP_DIR     = '/userdata';
const DP_DUMP_KEEP    = 12;
const DP_DUMP_FILE_RE = /^dp-input-\d{8}T\d{6}\.\d{3}Z\.json$/;

// Night bias correction (see _nightBiasCorrW). The window is the block the 08-01 reading
// verified as a LEVEL error (bias ≈ median, negative in 7/7 nights); daytime hours are excluded
// because their error is tail-driven and h8/h10 additionally feed pvCoverage.
const NIGHT_BIAS_HOURS     = new Set([23, 0, 1, 2, 3, 4, 5, 6]); // Amsterdam local
const NIGHT_BIAS_CAP_W     = 150;
const NIGHT_BIAS_MIN_COUNT = 20;

// Suppress refillConfidence swings below this threshold between consecutive policy
// runs. Open-Meteo refreshes its ensemble hourly even overnight (see _updateWeather,
// "1h cycle"), so pvSpreadTomorrow — and thus refillConfidence — churns on pure
// model disagreement with zero new PV observation to validate it while the sun is
// down. That churn moved the reserve-floor enough to flip which slot the DP reorder
// picked for discharge vs. preserve at an unchanged price (2026-07-05 incident: raw
// refillConfidence 0.84→0.70 in 30min, floor +8%→+15%). ±0.04-0.06 was the observed
// noise floor there; the real swing was 0.14. Starting value — may need tuning.
const REFILL_CONFIDENCE_DEADBAND = 0.05;

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

// NOCT temperature derating for fallback (non-learned) PV path only.
// Learned yf already captures temperature empirically — do not apply there.
function _pvTempFactor(airTempC, radiationWm2) {
  const cellTemp = (airTempC ?? 20) + (radiationWm2 / 1000) * 25;
  return Math.max(0.80, Math.min(1.05, 1 - 0.004 * (cellTemp - 25)));
}

function _settingsFootprintKB(settings) {
  const KNOWN_KEYS = [
    'learning_status', 'learning_pv_chart_data', 'policy_mode_history',
    'policy_optimizer_schedule', 'policy_all_prices', 'policy_all_prices_15min',
    'policy_pv_forecast_hourly', 'policy_pv_forecast_om', 'policy_pv_forecast_sc',
    'policy_pv_actual_today', 'policy_widget_data', 'battery_cycle_history',
    'battery_expansion_analysis', 'policy_daily_profit',
    'policy_consumption_profile', 'pv_surplus_forecast', 'policy_last_run_debug',
    'policy_pv_predictions_recent', 'battery_policy_state', 'device_settings',
  ];
  try {
    // The mode history lives in ~23 day chunks; report them as one line so they can't crowd the
    // top-8 out with 23 near-identical entries.
    const allKeys = typeof settings.getKeys === 'function' ? settings.getKeys()
      : (typeof settings.getAll === 'function' ? Object.keys(settings.getAll()) : []);
    const chunkKeys = allKeys.filter(k => k.startsWith(MODE_HISTORY_PREFIX));
    const chunkBytes = chunkKeys.reduce((s, k) => s + JSON.stringify(settings.get(k) ?? null).length, 0);
    const entries = KNOWN_KEYS
      .map(k => ({ k, bytes: JSON.stringify(settings.get(k) ?? null).length }))
      .concat(chunkKeys.length ? [{ k: `${MODE_HISTORY_PREFIX}*(${chunkKeys.length}d)`, bytes: chunkBytes }] : [])
      .filter(e => e.bytes > 5)
      .sort((a, b) => b.bytes - a.bytes);
    // Total must span ALL keys, not just KNOWN_KEYS: every settings.set() ships the complete
    // object (SDK manager/settings.js _save -> emitApp('setSettings', this._settings)), so the
    // wire cost per write is this total regardless of which key was written. KNOWN_KEYS stays
    // the breakdown only -- it misses baseload_state/debug_logs and read 780kB where the
    // object is ~1299kB (feedback_measure_wire_payload_not_value).
    const totalBytes = allKeys.reduce((s, k) => s + k.length + JSON.stringify(settings.get(k) ?? null).length, 0);
    const namedKB = (entries.reduce((s, e) => s + e.bytes, 0) / 1024).toFixed(1);
    const top = entries.slice(0, 8).map(e => `${e.k}=${(e.bytes / 1024).toFixed(1)}kB`).join(' | ');
    return {
      totalBytes,
      line: `${(totalBytes / 1024).toFixed(1)}kB wire (${allKeys.length} keys), ${namedKB}kB named | ${top}`,
    };
  } catch (e) {
    return { totalBytes: 0, line: `unavailable: ${e.message}` };
  }
}

class BatteryPolicyDevice extends Homey.Device {

  async onInit() {
    this.homey.app.bumpDeviceCount?.('battery-policy');
    this.log('BatteryPolicyDevice initialized');
    _memMB('onInit-start');

    // Load the day files, then drain whatever settings still holds -- both before anything reads it.
    try { this._loadModeHistory(); } catch (e) { this.error('[ModeHistory] load:', e.message); }
    try { this._migrateModeHistoryChunks(); } catch (e) { this.error('[MIGRATE] mode history:', e.message); }

    // Components
    this.learningEngine = new LearningEngine(this.homey, this);
    await this.learningEngine.initialize();

    this.weatherForecaster = new WeatherForecaster(this.homey, this.learningEngine);
    const _satLat = this.getSetting('weather_latitude');
    const _satLon = this.getSetting('weather_longitude');
    const SAT_NOWCAST_URL = (_satLat && _satLon)
      ? `https://pv.tebbens.net/api/sat?lat=${_satLat}&lon=${_satLon}`
      : 'https://pv.tebbens.net/msgcpp/latest.json';
    // Deferred 45s: starting this immediately at onInit fires its own out-of-band HTTPS
    // fetch at the exact same instant as every other driver's onInit + WS auth + first
    // poll — one more uncoordinated concurrent connection during the busiest part of boot.
    // 45s (past the weather-fetch's own 30s defer + its 3s-staggered Buienradar/upwind
    // tail) lands this independent 15-min-repeating loop in a different phase of the cycle.
    this.homey.setTimeout(() => {
      this.weatherForecaster.startSatelliteLoop(SAT_NOWCAST_URL, '', () => this._onSatelliteOverlay());
    }, 45 * 1000);
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
    this._lastEffectivePvW = 0; // Cached _estimatePvProduction output (flow-when-fresh, else grid/sun fallback); used by OVERSCHOT consumers so a stale flow feed doesn't read 0
    this._pvProductionW = null; // User-provided PV production via flow card
    this._lastLoggedPvW = null; // Suppress repeat PV log lines when value unchanged
    this._pvProductionTimestamp = null; // When the PV data was last updated
    this._lastPvAccuracyBucket = null; // Deduplicate PV accuracy samples per 15-min slot
    this._pvActualHourly = null; // Accumulator for chart: {date, hourly[], sums[], counts[]}
    this._pvState = false; // Track PV state with hysteresis
    this._lastPvPolicyRun = null; // Debounce PV-triggered policy runs
    this._favorableWindowActive = false; // Tracks edge for favorable_consumption_window trigger
    this._todayDate = null;           // YYYY-MM-DD (Amsterdam) for daily reset
    this._todayGridImportKwh = 0;     // accumulated grid import today (kWh)
    this._todayConsumptionKwh = 0;    // accumulated house consumption today (kWh)
    this._lastSelfSuffWrite = 0;      // throttle: last settings write for today_self_sufficiency
    this._cachedTodayNL = null;        // cached YYYY-MM-DD Amsterdam, refreshed per minute
    this._cachedTodayNLTs = 0;
    this._cachedPsThreshold = this.getSetting('peak_shaving_threshold') ?? 0;
    this._cachedPsHours = this.getSetting('peak_hours') || '';
    this._morningPlannedProfit = null; // first DP profit of the day, captured after sunrise
    this._modeHistory = this.homey.settings.get(`batt_mode_hist_${this.getData().id}`) || [];
    this._isPredictiveMode = false;
    this._policyEnabledBeforePredictive = null; // saved state for auto-restore when predictive ends
    this._lastChartRolloverDay = null; // tracks last midnight rollover to avoid repeated swaps
    this._modeChartBody = null;
    this._modeChartImage = null;

    // EV charging gate — set via flow card, blocks battery discharge until cleared
    // or auto-expires. Restored from settings on restart so flag survives reboots.
    this._evChargingUntil = 0;
    this._evChargingTimer = null;
    try {
      const evUntil = Number(this.homey.settings.get('ev_charging_until') || 0);
      if (evUntil > Date.now()) {
        this._evChargingUntil = evUntil;
        const minsLeft = Math.round((evUntil - Date.now()) / 60000);
        this.log(`[EV] Restored EV charging flag — ${minsLeft} min remaining`);
        this._scheduleEvAutoClear();
      } else if (evUntil > 0) {
        this.homey.settings.set('ev_charging_until', 0);
      }
    } catch (_) { /* ignore */ }

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
        const soc = this._sanitizeSoc(this.p1Device.getCapabilityValue('battery_group_average_soc')) ?? 50;
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
            this._upsertModeHistory({
              ts: new Date().toISOString(), hwMode: 'predictive', soc: liveSoc, price: null,
            });
          } catch (e) { this.error('Failed to save predictive mode history (flush):', e); }
          try { this._saveWidgetData({ skipChart: true }); } catch (e) { this.error('Widget save (predictive) failed:', e.message); }
        }).catch(e => this.error('Predictive mode flush failed:', e.message));
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
      respect_minmax:      s.respect_minmax      ?? true,
      min_soc:             s.min_soc             ?? 0,
      max_soc:             s.max_soc             ?? 100,
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
    const fp = _settingsFootprintKB(this.homey.settings);
    // Cached for _accountSettingsWrite: re-scanning all keys per write would cost more than the
    // write it measures. Refreshed on this line's cadence, so a write in between reports the
    // previous total -- fine for a kB/hour rate, not for a single-write figure.
    this._settingsWireBytes = fp.totalBytes;
    this.log(`[MEM] settings footprint: ${fp.line}`);
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
    if (!this._settingsLastWritten) this._settingsLastWritten = new Map();
    // Skip the write entirely when the value is byte-identical to what's already persisted —
    // each settings.set() costs a ~30MB transient V8 spike regardless of payload size, so an
    // unchanged value queued every 15-min cycle is pure waste (device.js:306).
    const serialized = JSON.stringify(value);
    if (this._settingsLastWritten.get(key) === serialized) return;
    // Carry the string through to the flush instead of letting it rebuild one: the flush
    // has to refresh _settingsLastWritten after the set(), and on a 576kB key that second
    // walk is a full duplicate of the one just done here (project_app_rss_step_0722 —
    // the settings.set path is 79.9% of app allocation).
    this._settingsQueue.set(key, { value, serialized }); // coalesces duplicates
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

    // Priority key: policy_last_run_debug drives the settings-page diagnose dump — with
    // ~15+ keys queued per policy cycle, round-robin insertion-order left it stale for
    // 10+ minutes after a restart (feedback_dp_instability_debug_workflow). Flushing it
    // first whenever pending costs nothing extra (same 1-key-per-8s cadence, same 30MB
    // GC-safety rationale) — it just jumps the queue instead of waiting its turn.
    const _priorityKey = 'policy_last_run_debug';
    const [key, entry] = this._settingsQueue.has(_priorityKey)
      ? [_priorityKey, this._settingsQueue.get(_priorityKey)]
      : this._settingsQueue.entries().next().value;
    this._settingsQueue.delete(key);
    try {
      this.homey.settings.set(key, entry.value);
      this._settingsLastWritten.set(key, entry.serialized);
      this._accountSettingsWrite(key, entry.serialized.length);
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

  // Per-key accounting for the settings.set path. That path is 79.9% of all app allocation
  // and cost scales with payload size (the homey serializer walks the whole blob per set),
  // so bytes-written per key is the proxy for who actually drives it. Which key dominates
  // was so far only INFERRED from the stored footprint (576 of 773.9 kB) -- this measured it
  // (policy_mode_history: 596 kB/write, 86% of 1.33 MB over 42 writes), which is what gated the
  // day-chunk rewrite above.
  _accountSettingsWrite(key, bytes) {
    if (!this._settingsWriteStats) this._settingsWriteStats = new Map();
    const st = this._settingsWriteStats.get(key) || { n: 0, bytes: 0 };
    st.n += 1;
    st.bytes += bytes;
    this._settingsWriteStats.set(key, st);

    // The wire cost is the whole settings object per set(), not this key's value -- so the
    // rate that matters is writes x object size, and shrinking one key only pays off via that
    // product. Undercounts: writes that bypass _queueSettingsPersist (baseloadMonitor,
    // debug_logs from the other drivers, app.js migration) ship the same object unmeasured.
    const wire = this._settingsWireBytes || 0;
    if (!this._wireStatsSince) {
      this._wireStatsSince = Date.now();
      this._wireTotalBytes = 0;
      this._wireWrites = 0;
    }
    this._wireTotalBytes += wire;
    this._wireWrites += 1;
    const hours = (Date.now() - this._wireStatsSince) / 3600_000;
    const rate = hours > 0 ? (this._wireTotalBytes / 1048576 / hours).toFixed(1) : '—';
    console.log(`[MEM][settings.set] ${key} value=${bytes}B n=${st.n} | wire=${(wire / 1024).toFixed(0)}kB writes=${this._wireWrites} cum=${(this._wireTotalBytes / 1048576).toFixed(1)}MB rate=${rate}MB/h`);
  }

  // Writes one dump file and prunes to the newest DP_DUMP_KEEP. Returns the path, or null when the
  // dump failed -- a diagnostic must never break the policy run that produced it.
  _writeDpInputDump(payload) {
    const fs  = require('fs');
    const dir = this._dpDumpDir || DP_DUMP_DIR;
    let file;
    try {
      // Serialise BEFORE opening the file, so a bad payload cannot leave a truncated dump behind.
      const json = JSON.stringify(payload);
      file = `${dir}/dp-input-${new Date(payload.at).toISOString().replace(/[-:]/g, '')}.json`;
      fs.writeFileSync(file, json);
    } catch (e) {
      this.log(`[DP-INPUT-DUMP] write failed: ${e.message}`);
      return null;
    }
    // Best-effort: the dump already landed, so a failed prune costs disk, not the capture. The
    // filter is what keeps rotation off mode-history-*.json and the baseload state in the same dir.
    try {
      const names = fs.readdirSync(dir).filter(n => DP_DUMP_FILE_RE.test(n)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - DP_DUMP_KEEP))) fs.unlinkSync(`${dir}/${n}`);
    } catch (e) { /* prune failed: dumps stay, retention slips a run */ }
    return file;
  }

  // ---- mode history: per-Amsterdam-day files on /userdata (see MODE_HISTORY_* above) ----

  _modeHistoryBucket(ts) {
    return Math.round(new Date(ts).getTime() / MODE_HISTORY_BUCKET_MS) * MODE_HISTORY_BUCKET_MS;
  }

  _modeHistoryFile(dayKey) {
    return `${this._modeStateDir || MODE_HISTORY_DIR}/mode-history-${dayKey}.json`;
  }

  // The Map is the source of truth, the files are only persistence: _readModeHistory() runs on every
  // policy run and would otherwise re-parse the whole 23-day store from disk -- the allocation this
  // move set out to kill. Settings held the same data in memory before, so this costs nothing extra.
  _modeHistMap() {
    if (!this._modeHist) this._modeHist = new Map();
    return this._modeHist;
  }

  _modeHistoryKeys() {
    return [...this._modeHistMap().keys()].sort();
  }

  // A failed write costs that day on the next restart, not the running state -- the entry stays in
  // the Map either way. Same trade-off as baseloadMonitor._writeState.
  _writeModeDay(dayKey) {
    try {
      require('fs').writeFileSync(this._modeHistoryFile(dayKey), JSON.stringify(this._modeHistMap().get(dayKey) || []));
    } catch (e) {
      this.error(`[ModeHistory] write ${dayKey} failed: ${e.message}`);
    }
  }

  // Fills the Map from disk at init. A corrupt or unreadable file costs that one day, not the store.
  _loadModeHistory() {
    const fs  = require('fs');
    const dir = this._modeStateDir || MODE_HISTORY_DIR;
    const map = this._modeHistMap();
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      const m = MODE_HISTORY_FILE_RE.exec(name);
      if (!m) continue;
      try {
        const arr = JSON.parse(fs.readFileSync(`${dir}/${name}`, 'utf8'));
        if (Array.isArray(arr)) map.set(m[1], arr);
      } catch (e) { /* corrupt or unreadable: that day is lost, the rest stands */ }
    }
  }

  // Upsert one 15-min bucket. The chunk is picked from the BUCKET, not the raw ts: a 23:53 sample
  // rounds up to the next day's 00:00 bucket, and filing it under the ts day would put two chunks
  // in play for one bucket.
  _upsertModeHistory(entry) {
    const bucket = this._modeHistoryBucket(entry.ts);
    const dayKey = _amsDayKeyFormatter.format(new Date(bucket));
    const map    = this._modeHistMap();
    const chunk  = map.get(dayKey) || [];
    const i = chunk.findIndex(h => this._modeHistoryBucket(h.ts) === bucket);
    if (i >= 0) {
      // A run that reports no SoC must not erase one an earlier run in the same bucket did report.
      if (entry.soc == null) entry.soc = chunk[i].soc;
      chunk[i] = entry;
    } else {
      chunk.push(entry);
    }
    map.set(dayKey, chunk);
    this._writeModeDay(dayKey);
    this._pruneModeHistoryChunks();
  }

  // Retention anchors on the newest chunk, not on the clock, so a stopped or rewound clock cannot
  // wipe the store. Chunks dated beyond tomorrow are excluded from the anchor: one clock-glitch
  // entry in the future would otherwise prune every real day.
  _pruneModeHistoryChunks() {
    const days = this._modeHistoryKeys();
    if (!days.length) return;
    const map      = this._modeHistMap();
    const tomorrow = _amsDayKeyFormatter.format(new Date(Date.now() + 86400000));
    const sane     = days.filter(d => d <= tomorrow);
    const newest   = (sane.length ? sane : days)[(sane.length ? sane : days).length - 1];
    const cutoff   = new Date(new Date(`${newest}T00:00:00Z`).getTime() - (MODE_HISTORY_DAYS - 1) * 86400000)
      .toISOString().slice(0, 10);
    for (const d of days) {
      if (d < cutoff) {
        map.delete(d);
        try { require('fs').unlinkSync(this._modeHistoryFile(d)); } catch (_) {}
      }
    }
  }

  // Shadow-harvest sink for the per-slot discharge-floor fix (`pv_floor_fix`).
  //
  // The [FLOORFIX] log line only fires on a real DP recompute — a handful per day, not per policy
  // run — and /tmp/homey.log is tmpfs, so a restart takes the whole harvest with it. This keeps the
  // same samples on /userdata instead. Bounded: newest FLOORFIX_SAMPLES_MAX entries, ~200 B each.
  _appendFloorFixSample(sample) {
    try {
      const prev = userdataStore.readJson('floorfix_samples');
      const rows = Array.isArray(prev) ? prev : [];
      rows.push({ ts: new Date().toISOString(), ...sample });
      userdataStore.writeJson('floorfix_samples', rows.slice(-FLOORFIX_SAMPLES_MAX));
    } catch (_) { /* diagnostic only — never break a policy run */ }
  }

  // Concatenated history, oldest first. With lastN only the newest chunks needed to cover N are
  // walked, so the 96-slot consumers no longer touch the full 23-day store.
  _readModeHistory(lastN) {
    const days = this._modeHistoryKeys();
    const map  = this._modeHistMap();
    const chunks = [];
    let n = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const chunk = map.get(days[i]) || [];
      chunks.unshift(chunk);
      n += chunk.length;
      if (lastN != null && n >= lastN) break;
    }
    const all = [].concat(...chunks);
    return lastN != null ? all.slice(-lastN) : all;
  }

  _readModeHistoryDay(dayKey) {
    return this._modeHistMap().get(dayKey) || [];
  }

  // One-time move out of settings, covering both shapes that ever shipped: the legacy single-key
  // array and the per-day keys that replaced it. Idempotent -- every source key is unset afterwards,
  // so a second call returns at the guard. Runs after _loadModeHistory(), so a bucket the files
  // already hold wins over the settings copy.
  _migrateModeHistoryChunks() {
    const s = this.homey.settings;
    const allKeys = typeof s.getKeys === 'function' ? s.getKeys()
      : (typeof s.getAll === 'function' ? Object.keys(s.getAll()) : []);
    const chunkKeys = allKeys.filter(k => k.startsWith(MODE_HISTORY_PREFIX));
    const legacy    = s.get('policy_mode_history');
    if (!chunkKeys.length && !Array.isArray(legacy)) return;

    const map     = this._modeHistMap();
    const touched = new Set();
    let entries   = 0;
    const add = (h) => {
      if (!h || !h.ts) return;
      const bucket = this._modeHistoryBucket(h.ts);
      const dayKey = _amsDayKeyFormatter.format(new Date(bucket));
      const chunk  = map.get(dayKey) || [];
      if (chunk.some(x => this._modeHistoryBucket(x.ts) === bucket)) return;
      chunk.push(h);
      map.set(dayKey, chunk);
      touched.add(dayKey);
      entries++;
    };
    for (const k of chunkKeys) for (const h of (s.get(k) || [])) add(h);
    if (Array.isArray(legacy)) for (const h of legacy) add(h);

    // Merging two sources into a day that may already hold file entries can leave it out of order;
    // every reader assumes chronological.
    for (const dayKey of touched) map.get(dayKey).sort((a, b) => new Date(a.ts) - new Date(b.ts));

    for (const k of [...chunkKeys, 'policy_mode_history']) {
      try { s.unset(k); } catch (_) {}
    }
    this._pruneModeHistoryChunks();
    for (const dayKey of touched) {
      if (map.has(dayKey)) this._writeModeDay(dayKey);
    }
    this.log(`[MIGRATE] policy_mode_history → ${touched.size} day file(s), ${entries} entries`);
  }

  // Store rebuildable UI state in-memory for fast internal reads (cameras, widget),
  // and queue a batched settings.set so the settings page (which reads via Homey.get)
  // sees the same data. The batcher spaces writes 8s apart so each ~30 MB spike
  // is fully GC'd before the next allocation.
  _setLive(key, value) {
    this._deadArrayGuard(key, value);
    this._liveState[key] = value;
    this._queueSettingsPersist(key, value);
  }

  // An instrument that writes an all-null/NaN array is dead but looks alive: it fires on cadence,
  // logs no error, and only reveals itself when someone finally reads the stored values back --
  // the near-floor catcher rounded arrays of OBJECTS as if they were numbers and shipped 5 days of
  // JSON nulls that way (fixed c4acba6). Cost is O(1) on healthy data: the scan bails at the first
  // non-null element, so only a genuinely dead array pays for its own length. Logged once per key
  // per app run, so a legitimately-empty-at-startup array cannot spam.
  _deadArrayGuard(key, value) {
    const dead = a => Array.isArray(a) && a.length >= 4
      && !a.some(x => x != null && !(typeof x === 'number' && Number.isNaN(x)));
    // Descend at most 4 levels, and into only the FIRST element of an array of objects (for a ring
    // that is the newest entry) -- keeps the walk O(depth), never O(payload), on 50kB settings.
    const find = (v, path, depth) => {
      if (depth > 4 || v == null || typeof v !== 'object') return null;
      if (dead(v)) return path;
      if (Array.isArray(v)) return v.length ? find(v[0], `${path}[0]`, depth + 1) : null;
      for (const k of Object.keys(v)) {
        const hit = find(v[k], `${path}.${k}`, depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const field = find(value, key, 0);
    if (!field) return;
    this._deadArrayWarned ??= new Set();
    if (this._deadArrayWarned.has(field)) return;
    this._deadArrayWarned.add(field);
    this.error(`dead-array guard: ${field} is entirely null/NaN — instrument writing garbage, check the projection`);
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
      presence_mode: this.learningEngine.isPaused() ? '🏖️ Away' : '🏠 Home',
      policy_profit_eur: 0,
      pv_forecast_kwh: 0,
      bias_factor: 1,
      plan_summary: '-'
    };

    for (const [capability, defaultValue] of Object.entries(defaults)) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch(err => {
          if (err && err.code === 409) return;
          this.error(`Failed to add capability ${capability}:`, err);
        });
      }

      const current = this.getCapabilityValue(capability);

      if (capability === 'policy_mode' && current === 'balanced-dynamic') {
        // 'balanced-dynamic' removed (2026-07-11) — it only ever forced respect_minmax=false,
        // duplicating the existing checkbox under a confusing "V2 — na salderen" name that
        // falsely implied it drove asymmetric export pricing (that's tariff_model, unrelated).
        this.log(`ℹ️ Migrating policy_mode 'balanced-dynamic' → 'balanced' + respect_minmax=false (same behavior, clearer setting)`);
        await this.setSettings({ respect_minmax: false }).catch(err =>
          this.error('Failed to migrate respect_minmax:', err)
        );
        await this.setCapabilityValue(capability, 'balanced').catch(err =>
          this.error(`Failed to migrate ${capability}:`, err)
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

      if (value === 'off' && this.p1Device) {
        const userMode = this.p1Device.getSetting('mode') || 'zero';
        this.log(`Policy mode set to off — restoring hardware to user-configured mode: ${userMode}`);
        await this.p1Device.setBatteryGroupMode(userMode);
      } else {
        await this._runPolicyCheck();
      }
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

      // Startup mode restore removed: no reliable way to distinguish firmware default
      // from a user-set or policy-set mode. The policy runs at T+45s and will apply
      // the correct mode then. Restoring from history risked overwriting manual user
      // changes made just before a restart or update.
      this.log('🔄 Skipping startup mode restore — policy will apply correct mode at T+45s');

      // Restore policy_enabled if predictive ended before this restart.
      // The in-memory flag is lost on restart; if policy_enabled is false but
      // the hardware is no longer in predictive, the policy would stay permanently
      // disabled until the user manually re-enables it.
      {
        const savedPrePredictive = this.homey.settings.get('policy_enabled_before_predictive');
        if (savedPrePredictive !== null && savedPrePredictive !== undefined) {
          const hwModeAtStart = this.p1Device.getCapabilityValue('battery_group_charge_mode');
          if (hwModeAtStart !== 'predictive') {
            this.log(`[Policy] Restoring policy_enabled=${savedPrePredictive} — predictive ended before restart`);
            await this.setCapabilityValue('policy_enabled', savedPrePredictive).catch(this.error);
            this.homey.settings.unset('policy_enabled_before_predictive');
          }
        }
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
      if (this._p1PollInFlight) return; // Skip if previous poll still running (prevent pileup → OOM)
      this._p1PollInFlight = true;

      try {

        // DEBUG: Log raw capability values from P1
const rawSoc = this.p1Device.getCapabilityValue('battery_group_average_soc');
const rawGrid = this.p1Device.getCapabilityValue('measure_power');
const rawBattCap = this.p1Device.getCapabilityValue('measure_power.battery_group_power_w');

if (debug) this.log(
  `🐛 [DEBUG/setup] Raw P1 caps → soc=${rawSoc}, grid=${rawGrid}, battCap=${rawBattCap}`
);


        const soc =
          this._sanitizeSoc(this.p1Device.getCapabilityValue('battery_group_average_soc')) ??
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

        // P1 firmware bug: to_full mode reports battery power as 0W via DSMR.
        // Correct to the actual charge power so house consumption is calculated correctly.
        if (batteryPower === 0) {
          const chargeMode = this.p1Device?.getCapabilityValue('battery_group_charge_mode');
          if (chargeMode === 'to_full') {
            const state = this._liveState.battery_policy_state
              ?? this.homey.settings.get('battery_policy_state') ?? {};
            batteryPower = state.maxChargePowerW ?? 800;
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
            const pendingWh   = ((s.pendingChargeKwh   || 0) * 1000).toFixed(0);
            const chargedWh   = ((s.sessionChargeKwh   || 0) * 1000).toFixed(0);
            const dischargedWh = ((s.sessionDischargeKwh || 0) * 1000).toFixed(0);
            const dir = s.lastPowerDirection || '?';
            this.log(
              `[RTE] session: dir=${dir} pending=${pendingWh}Wh charge=${chargedWh}Wh discharge=${dischargedWh}Wh ` +
              `cycles=${this.efficiencyEstimator.getCycleCount()} RTE=${(s.efficiency * 100).toFixed(1)}%`
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

        // Mirror grid power (throttled — skip updates < 5W to reduce Homey API churn)
        if (currentPower == null || Math.abs(currentPower - gridPower) >= 5) {
          await this.setCapabilityValue('grid_power_mirror', gridPower);
        }

        this._checkReserveFloorTrigger(soc);

        // ── Reactive peak shaving trigger ─────────────────────────────────────
        // Fire extra policy run when load exceeds peak_shaving_threshold within
        // peak_hours window — reacts within 15s instead of waiting up to 15 min.
        {
          const psThreshold = this._cachedPsThreshold;
          if (psThreshold > 0) {
            const psHours       = this._cachedPsHours;
            const [psStart, psEnd] = psHours.split('-').map(s => parseInt(s, 10));
            const nowHourNL     = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false }), 10);
            const inPsWindow    = psHours && !isNaN(psStart) && !isNaN(psEnd)
              ? (nowHourNL >= psStart && nowHourNL < psEnd)
              : true;
            if (inPsWindow) {
              const psDischarge = batteryPower < 0 ? Math.abs(batteryPower) : 0;
              const psLoad      = Math.max(0, gridPower + psDischarge);
              if (psLoad > psThreshold) {
                const nowMs = Date.now();
                if (!this._lastPeakTriggerTs || nowMs - this._lastPeakTriggerTs > 2 * 60 * 1000) {
                  this._lastPeakTriggerTs = nowMs;
                  this.log(`[PEAK] Load ${Math.round(psLoad)}W > ${psThreshold}W in peak window → reactive policy run`);
                  this._runPolicyCheck().catch(e => this.error('[PEAK] reactive trigger:', e));
                }
              }
            }
          }
        }

        // ------------------------------------------------------
        // 📊 LEARNING: Record consumption patterns
        // ------------------------------------------------------
        // Calculate TRUE house consumption: what the house actually uses,
        // regardless of where the power comes from (grid, PV, or battery).
        // gridPower: + = import, − = export
        // batteryPower: + = charging (consuming PV/grid), − = discharging (supplying house)
        // pvProductionW: always >= 0 (PV output)
        const pvW = this._estimatePvProduction({
          gridPower, batteryPower,
          sunScore: this.getCapabilityValue('sun_score') ?? 0,
        });
        const houseConsumptionW = gridPower - batteryPower + pvW;
        // Skip suspiciously-low readings caused by battery_power sensor lag:
        // when in discharge mode, battery_power can read 0W for 1–2 poll cycles while
        // still discharging, making consumption appear 0W and corrupting the learned EMA.
        const currentHwMode = this.p1Device?.getCapabilityValue('battery_group_charge_mode') ?? '';
        const inDischargeMode = currentHwMode.includes('discharge');
        // Skip stale 0W readings: discharge mode + battery≈0W + either consumption<50W or grid≈0W (nul-op-de-meter with P1 lag)
        const batteryPowerLag = inDischargeMode && Math.abs(batteryPower) < 10
          && (houseConsumptionW < 50 || Math.abs(gridPower) < 30);
        if (houseConsumptionW >= 0 && !batteryPowerLag) {
          await this.learningEngine.recordConsumption(houseConsumptionW).catch(err =>
            this.error('Learning consumption recording failed:', err)
          );
          // Mean load over the current 15-min slot, accumulated from this 15s poll.
          // The policy run only sees one instantaneous reading, which is blind to short
          // appliance bursts: a 5-10 min dishwasher drying peak falls entirely between two
          // policy samples, and because both the samples (:00/:15/:30/:45) and the appliance
          // run on fixed schedules, the miss is systematic aliasing, not bad luck — it was
          // missed on 3 of 3 nights while the 20-30 min heating peak was caught 3 of 3.
          // Averaging the dense poll instead is what the forecast is comparable to anyway:
          // the learned profile is itself the mean of these same samples.
          // Slot rolled over: freeze the one that just closed. The policy run fires at the
          // START of a slot (:00:01), when the new slot holds no samples yet — so the only
          // slot with a complete mean to score against is the previous one. The policy run
          // calls this too, so it never has to wait for the next poll (see _rollLoadSlot).
          this._rollLoadSlot();
          this._loadSlotSum += houseConsumptionW;
          this._loadSlotCount++;
          // Same treatment for PV, for the same reason. The policy run's single pvW reading
          // is blind to how steeply production moves inside a slot — the 2026-07-19 replay
          // calibration found charge slots where the opening sample showed a 223 W surplus
          // while the pack actually took on ~797 W. Accumulated under this same guard so the
          // PV and load means always share one sample population.
          this._pvSlotSum += pvW;
          this._pvSlotCount++;
        }

        // ------------------------------------------------------
        // 📊 SELF-SUFFICIENCY: Accumulate actual daily energy
        // ------------------------------------------------------
        const POLL_H = 15 / 3600; // poll interval (15s) expressed in hours
        const _nowMs = Date.now();
        if (_nowMs - this._cachedTodayNLTs > 60_000) {
          this._cachedTodayNL = new Date(_nowMs).toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam' }).slice(0, 10);
          this._cachedTodayNLTs = _nowMs;
        }
        const todayNL = this._cachedTodayNL;
        if (this._todayDate && this._todayDate !== todayNL) {
          this._captureDailyProfit(this._todayDate);
          this._morningPlannedProfit = null;
        }
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
          // Skip sun_score check when already ON — virtual grid balance is sufficient.
          // Prevents false OFF during cloudy-but-producing conditions (e.g. 15% sun_score, 600W PV).
          hasExport = virtualGridPower < PV_EXPORT_OFF;
          hasActivePVConsumption = isDaylight &&
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
            // After a restart during predictive mode, _policyEnabledBeforePredictive is null
            // (in-memory state lost). Fall back to persisted settings key, then true.
            const restoreEnabled = this._policyEnabledBeforePredictive
              ?? this.homey.settings.get('policy_enabled_before_predictive')
              ?? true;
            await this.setCapabilityValue('policy_enabled', restoreEnabled).catch(this.error);
            this._policyEnabledBeforePredictive = null;
            this.homey.settings.unset('policy_enabled_before_predictive');
            this._runPolicyCheck().catch(err => this.error('Post-predictive policy check failed:', err));
          }
        }

        // Midnight day rollover: swap _chartTomorrow → _chartToday when Amsterdam date changes.
        // Prevents camera from showing yesterday's chart during SlimLaden/predictive pause overnight.
        {
          const todayKey = _amsDayKeyFormatter.format(new Date());
          if (this._lastChartRolloverDay !== todayKey && this._chartToday?.slots?.length > 0) {
            const firstSlotDay = _amsDayKeyFormatter.format(new Date(this._chartToday.slots[0].ts));
            if (firstSlotDay !== todayKey) {
              this._lastChartRolloverDay = todayKey;
              this.log('[Chart] Day rollover — swapping tomorrow chart to today camera');
              this._chartToday        = this._chartTomorrow ?? null;
              this._chartTomorrow     = null;
              this._chartHashToday    = null;
              this._chartHashTomorrow = null;
              this.planningImageToday?.update().catch(() => {});
              this.planningImageTomorrow?.update().catch(() => {});
            }
          }
        }

      } catch (err) {
        this.error('Error polling P1 capabilities:', err);
      } finally {
        this._p1PollInFlight = false;
      }
    // ✅ CPU FIX: Increased from 5s to 15s - heavy work (capability reads/writes, calculations)
    }, 15000);

    this.log('✅ P1 capability polling started (15s interval)');
  }

  // Central source guard: reject a WS-reinit SoC collapse-to-zero glitch before it fans out
  // to any consumer (CostModel RESET, policy cost-reset, reserve-floor trigger, SoC-history).
  // Shared state across all raw-SoC read sites. See lib/soc-glitch-guard.js.
  _sanitizeSoc(rawSoc) {
    if (!this._socGuard) this._socGuard = createState();
    const minSoc = this.getSetting('min_soc') ?? 0;
    const { soc, held } = sanitizeSoc(rawSoc, this._socGuard, { minSoc });
    if (held) this.log(`⚠️ SoC glitch rejected: raw=${rawSoc}% → hold ${soc}%`);
    return soc;
  }

  // ── Reactive reserve-floor breach trigger ───────────────────────────────
  // The overnight refill-reserve floor (_lastReserveFloorPct) is recomputed only
  // at each full replan (~30min). zero_discharge_only's load-following discharge
  // rate can overshoot that floor before the next replan catches it, causing a
  // same-price discharge→charge churn. React within ~15s instead.
  _checkReserveFloorTrigger(soc) {
    const floorPct = this._lastReserveFloorPct;
    if (floorPct == null || soc >= floorPct) return false;
    const hwModeNow = this.p1Device?.getCapabilityValue('battery_group_charge_mode') ?? '';
    if (!hwModeNow.includes('discharge')) return false;
    const nowMs = Date.now();
    if (this._lastFloorTriggerTs && nowMs - this._lastFloorTriggerTs < 2 * 60 * 1000) return false;
    this._lastFloorTriggerTs = nowMs;
    this.log(`🛡️ SoC ${soc}% < reserve floor ${floorPct.toFixed(0)}% during ${hwModeNow} → reactive policy run`);
    this._runPolicyCheck().catch(e => this.error('[FLOOR] reactive trigger:', e));
    return true;
  }

  // Anchors against the last APPLIED (not last raw) value: pure noise oscillating
  // around a stable mean stays suppressed indefinitely, while a real trend crossing
  // the threshold vs. that anchor still updates. See REFILL_CONFIDENCE_DEADBAND.
  _applyRefillConfidenceDeadband(rawConfidence) {
    const prevApplied = this._lastRefillConfidence ?? rawConfidence;
    return Math.abs(rawConfidence - prevApplied) < REFILL_CONFIDENCE_DEADBAND
      ? prevApplied
      : rawConfidence;
  }

  /**
   * Morning-waive shadow metric (log-only, project_morning_reserve_floor_holds_through_peak).
   * Given the live plan's slots (reserve floor ON) and a counterfactual with refillConfidence=1.0
   * (floor OFF), quantify whether the active floor holds morning kWh that midday PV refills anyway.
   *
   * The metric is deliberately STRUCTURAL and TWO-SIDED, not Δ projectedProfit: removing a DP
   * constraint can only raise forecast profit (profit_OFF >= profit_ON by construction), so a
   * profit diff is a tautology and can never go negative (device.js spreadband note ~:3438,
   * feedback_metric_must_allow_negative). Instead we measure the held energy and whether the OFF
   * run still serves the evening peak — waive-gain exists ONLY if OFF serves the peak equally;
   * if OFF strands the evening the floor was needed → negative eurAtStake.
   *
   * Returns null when the slot arrays are unusable. socProjected is in percent (socG/GRID, 0-100).
   */
  _morningWaiveShadowMetrics(onSlots, offSlots, capacityKwh) {
    if (!onSlots?.length || !offSlots?.length || onSlots.length !== offSlots.length) return null;
    const N = onSlots.length;
    const maxSoc = this.getSettings().max_soc ?? 100;

    // Anchor the morning-trough / midday-refill / evening-peak window on the PV cycle, NOT on
    // wall-clock hour. The forward horizon starts at NOW: a run in the evening has slot[0] already
    // past any hard-coded hour (the old `localHour>=16 break` broke on slot[0] → tMin=-1 → null on
    // every evening/night run) and TOMORROW's morning sits mid-horizon. Slots carry pvForecastW, so
    // use the FIRST PV block as midday, the drain into it as the morning trough, and the discharge
    // after it as the evening peak — run-time-independent, no local-hour aliasing across two days.
    let maxPv = 0;
    for (let i = 0; i < N; i++) maxPv = Math.max(maxPv, offSlots[i].pvForecastW ?? 0);
    if (maxPv <= 0) return null; // no PV refill in horizon → the waive question is moot
    const PV_THRESH = Math.max(50, maxPv * 0.1);
    const isPv = (i) => (offSlots[i].pvForecastW ?? 0) >= PV_THRESH;

    // First contiguous PV block = midday refill; the block after a gap (if the horizon spans a 2nd
    // day) bounds the evening window so it stays within one cycle.
    let tPvStart = -1;
    for (let i = 0; i < N; i++) { if (isPv(i)) { tPvStart = i; break; } }
    if (tPvStart < 0) return null;
    let tPvEnd = tPvStart;
    for (let i = tPvStart; i < N && isPv(i); i++) tPvEnd = i;
    let tNextPv = N;
    for (let i = tPvEnd + 1; i < N; i++) { if (isPv(i)) { tNextPv = i; break; } }

    // Morning window: the 8h of drain immediately preceding PV onset. On an evening run a prior-
    // evening low sits >8h earlier in the horizon, so this excludes it; tMin = the LAST (closest to
    // PV) slot achieving the OFF-run minimum here — the deepest pre-refill drain the DP dares WITHOUT
    // the floor. The floor's morning contribution = SoC gap at this slot.
    const ts = (i) => new Date(offSlots[i].timestamp).getTime();
    const morningStartMs = ts(tPvStart) - 8 * 3600_000;
    let tMin = -1, tMinSoc = Infinity;
    for (let i = 0; i <= tPvEnd; i++) {
      if (ts(i) < morningStartMs) continue;
      const soc = offSlots[i].socProjected;
      if (soc == null) continue;
      if (soc <= tMinSoc) { tMinSoc = soc; tMin = i; } // <= → last (closest-to-PV) occurrence wins
    }
    if (tMin < 0 || onSlots[tMin].socProjected == null) return null;

    const heldKwh = Math.max(0, (onSlots[tMin].socProjected - offSlots[tMin].socProjected) / 100 * capacityKwh);

    // bothReachMax: each schedule hits ~maxSoc during the refill (tMin, tPvEnd] → midday PV refilled
    // both → the morning hold was redundant on this day.
    const EPS = 1.0; // percent
    const reachesMax = (slots) => {
      for (let i = tMin + 1; i <= tPvEnd; i++) {
        if (slots[i].socProjected != null && slots[i].socProjected >= maxSoc - EPS) return true;
      }
      return false;
    };
    const bothReachMax = reachesMax(onSlots) && reachesMax(offSlots);

    // Evening discharge revenue over the post-refill window (tPvEnd, tNextPv): Σ SoC-drop × cap × price.
    const eveningRevenue = (slots) => {
      let rev = 0;
      for (let i = tPvEnd + 1; i < tNextPv; i++) {
        if (slots[i].socProjected == null || slots[i - 1].socProjected == null) continue;
        const drop = (slots[i - 1].socProjected - slots[i].socProjected) / 100 * capacityKwh;
        if (drop > 0) rev += drop * (slots[i].price ?? 0);
      }
      return rev;
    };
    const onEve = eveningRevenue(onSlots), offEve = eveningRevenue(offSlots);
    const offServesEvening = offEve >= onEve - 1e-6;

    let eurAtStake;
    if (offServesEvening) {
      // Waive frees heldKwh from the morning peak to be refilled midday. Value = held × (drain − refill).
      const avgPrice = (pred) => {
        let sum = 0, n = 0;
        for (let i = 1; i < N; i++) { if (pred(i)) { sum += onSlots[i].price ?? 0; n++; } }
        return n ? sum / n : 0;
      };
      // pDrain: morning slots up to tMin where OFF discharges but ON holds (the kWh the floor pinned).
      const pDrain = avgPrice(i => i <= tMin && ts(i) >= morningStartMs
        && offSlots[i].socProjected != null && offSlots[i - 1].socProjected != null
        && onSlots[i].socProjected != null && onSlots[i - 1].socProjected != null
        && offSlots[i].socProjected < offSlots[i - 1].socProjected
        && onSlots[i].socProjected >= onSlots[i - 1].socProjected - EPS);
      // pRefill: refill slots (tMin, tPvEnd] where ON re-buys the held kWh from midday PV.
      const pRefill = avgPrice(i => i > tMin && i <= tPvEnd
        && onSlots[i].socProjected != null && onSlots[i - 1].socProjected != null
        && onSlots[i].socProjected > onSlots[i - 1].socProjected);
      eurAtStake = heldKwh * (pDrain - pRefill);
    } else {
      // OFF strands the evening peak → the floor was needed. Negative: lost evening revenue.
      eurAtStake = -(onEve - offEve);
    }
    return { heldKwh, bothReachMax, offServesEvening, eurAtStake };
  }

  /**
   * Shadow metric: the € value of a grid top-up the DP declined, on days where the PV surplus
   * dries up before the battery is full. Log-only — nothing here changes a decision.
   *
   * The DP skips midday grid charging via preserve:pv_strong / trickle:pv_weak, betting free PV
   * will fill the battery anyway. On an overcast day that bet fails: 2026-07-30 peaked at 44%
   * while midday slots cost €0.144-0.152 and the evening peak was €0.396. Whether buying would
   * actually have paid is still OPEN (project_dp_daytime_pv_timing_no_hedge, "measure first,
   * then decide" — 2026-07-05); this collects the numbers to settle it.
   *
   * marginPerKwh charges the FULL cycleCostPerKwh, not half: the DP books cycleCostPerKwh*0.5 on
   * charge (optimization-engine.js:904) AND on discharge (:946), so a round trip pays both.
   *
   * Deliberately NOT clamped at zero (feedback_metric_must_allow_negative): a low evening peak or
   * an expensive midday has to be able to come out negative, otherwise the measurement can only
   * ever confirm the hypothesis that prompted it.
   *
   * Returns null when there is nothing to measure (no PV surplus in the horizon, nothing left to
   * sell into, headroom under 0.2 kWh) or when any value would be non-finite.
   * socProjected is in percent (socG/GRID, 0-100), like _morningWaiveShadowMetrics.
   */
  _topupMissMetrics(slots, capacityKwh, rte, cycleCostKwh, maxSoc) {
    if (!slots?.length || !Number.isFinite(capacityKwh) || capacityKwh <= 0) return null;
    if (!Number.isFinite(rte) || !Number.isFinite(cycleCostKwh) || !Number.isFinite(maxSoc)) return null;
    const N = slots.length;

    // End of PV surplus = last slot the plan still expects to store PV. pvCoverage is net surplus
    // / maxChargeW (optimization-engine.js:227), so > 0 means "there is something to store".
    let pvEnd = -1;
    for (let i = 0; i < N; i++) { if ((slots[i].pvCoverage ?? 0) > 0) pvEnd = i; }
    if (pvEnd < 0 || pvEnd >= N - 1) return null; // no surplus at all, or nothing left to sell into

    const socAtEnd = slots[pvEnd].socProjected;
    if (!Number.isFinite(socAtEnd)) return null;
    const headroomKwh = capacityKwh * Math.max(0, maxSoc - socAtEnd) / 100;
    if (headroomKwh < 0.2) return null; // essentially full on PV alone → nothing worth buying

    // Sell side: the highest price after the PV surplus ends.
    let eveMax = -Infinity, eveIdx = -1;
    for (let i = pvEnd + 1; i < N; i++) {
      const p = slots[i].price;
      if (Number.isFinite(p) && p > eveMax) { eveMax = p; eveIdx = i; }
    }
    if (eveIdx < 0) return null;

    // Buy side: cheapest slot from now up to that peak — the window a top-up could have used.
    let buy = Infinity, buyIdx = -1;
    for (let i = 0; i < eveIdx; i++) {
      const p = slots[i].price;
      if (Number.isFinite(p) && p < buy) { buy = p; buyIdx = i; }
    }
    if (buyIdx < 0) return null;

    const marginPerKwh = eveMax * rte - buy - cycleCostKwh;
    const valueEur = headroomKwh * marginPerKwh;

    // Input coverage is measured, not assumed: a flat default or synthetic tail has to be visible
    // in the sample, or a later verdict rests on made-up inputs (the flatten-gate replay ran
    // 126/134 slots on a 400W consumption default and flipped sign once fed real data).
    let covPv = 0, covCons = 0;
    for (const s of slots) {
      if (Number.isFinite(s.pvForecastW)) covPv++;
      if (Number.isFinite(s.consumptionW)) covCons++;
    }

    // Never hand a NaN to the ring: c4acba6 stored NaN prices and made every collected sample
    // unusable, c6d9fe8 added the same guard for all-null arrays.
    for (const v of [socAtEnd, headroomKwh, buy, eveMax, marginPerKwh, valueEur]) {
      if (!Number.isFinite(v)) return null;
    }

    return {
      pvEndTs: slots[pvEnd].timestamp, socAtEnd, headroomKwh,
      buy, buyTs: slots[buyIdx].timestamp,
      eveMax, eveTs: slots[eveIdx].timestamp,
      rte, cycleCostKwh, marginPerKwh, valueEur,
      covPv, covCons, nSlots: N,
    };
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
        // Skip if the slot-aligned interval already ran a policy check since the top of
        // this hour — otherwise the :00 interval run and this :05 net double-recompute.
        const topOfHour = new Date().setMinutes(0, 0, 0);
        if (this._lastPolicyRunAt && this._lastPolicyRunAt >= topOfHour) {
          this.log(`⏰ Hour boundary (${new Date().getHours()}:00) → slot run already covered it, skipping net`);
        } else {
          this.log(`⏰ Hour boundary reached (${new Date().getHours()}:00) → running policy check`);
          await this._runPolicyCheck().catch(err => this.error('Hour-boundary policy check failed:', err));
        }
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
          const settings = this.getSettings();

          if (settings.enable_dynamic_pricing && this.tariffManager.dynamicProvider) {
            const now = new Date();
            const nowAms = now.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
            const predictiveSuffix = this._isPredictiveMode ? ' (predictive — prices only)' : '';
            this.log(`🔄 Refreshing prices... (${nowAms} Amsterdam)${predictiveSuffix}`);

            try {
              // Force-refresh the merged provider (fetches Xadi + KwhPrice concurrently)
              this.homey.app.logMem?.('[BatteryPolicy] before-price-refresh');
              await this.tariffManager.mergedProvider.fetchPrices(true);
              this.homey.app.logMem?.('[BatteryPolicy] after-price-refresh');
              const priceCount = this.tariffManager.mergedProvider.cache?.length || 0;
              const sources    = this.tariffManager.mergedProvider.lastFetchSources.join('+');
              const days       = priceCount > 24 ? 'today + tomorrow' : 'today only';
              this.log(`✅ Prices refreshed: ${priceCount}h (${days}, sources: ${sources})`);

              if (!this._isPredictiveMode && priceCount > 0 && this.getCapabilityValue('policy_enabled')) {
                // When tomorrow's prices arrive for the first time today, refresh weather
                // so pvKwhTomorrow in the terminal value uses an up-to-date PV forecast.
                const todayDate = new Date().toDateString();
                if (priceCount > 24 && this._tomorrowPricesWeatherRefreshedOn !== todayDate) {
                  this._tomorrowPricesWeatherRefreshedOn = todayDate;
                  this.log('📡 Tomorrow prices detected — refreshing weather for terminal value accuracy');
                  await this._updateWeather().catch(e => this.error('Weather refresh on tomorrow prices failed:', e));
                }
                // Always recompute optimizer after price refresh — new data may include
                // tomorrow's prices (96→192 slots) that change the optimal schedule.
                this.optimizationEngine.updateSettings({});
                await this._runPolicyCheck();
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

  // Guards against concurrent weather-fetch cycles: policyCheckInterval and
  // _scheduleHourBoundary both call _maybeRefreshWeatherOnly independently, and
  // both read weatherData.fetchedAt before either write updates it (check-then-act
  // race) — when they land close together this fired _updateWeather twice, each
  // spawning its own 3s-delayed fetchUpwindData burst (2026-07-13: same 2 coords
  // hit pv.tebbens.net 3x within ~2s, tripping its rate limiter).
  async _updateWeather() {
    if (this._weatherUpdateInFlight) return this._weatherUpdateInFlight;
    this._weatherUpdateInFlight = this._updateWeatherImpl().finally(() => {
      this._weatherUpdateInFlight = null;
    });
    return this._weatherUpdateInFlight;
  }

  async _updateWeatherImpl() {
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
      // Gated on the tilt/azimuth values themselves, not pv_estimation_enabled — that flag is
      // Priority-2 fallback ("estimate current PV when no flow-card data"), an unrelated feature
      // that happens to share a settings-UI section with these fields. Coupling it here meant
      // panel-plane GTI transposition (OM ensemble AND satellite both route through it) silently
      // never ran whenever a user has real PV telemetry (so never needs the fallback estimator)
      // but still wants the forecast panel-plane-corrected — confirmed 2026-07-10, this device
      // has real tilt=35/azimuth=0 configured with the flag off, forecast ran fully flat/horizontal.
      const pvTilt = typeof devSettings.pv_tilt === 'number' ? devSettings.pv_tilt : null;
      const pvAzimuth = typeof devSettings.pv_azimuth === 'number' ? devSettings.pv_azimuth : null;

      this.weatherForecaster.knmiApiKey = devSettings.knmi_api_key || null;
      this.weatherForecaster.pvCapacityW = devSettings.pv_capacity_w || 0;
      this.weatherData = await this.weatherForecaster.fetchForecast(latitude, longitude, pvTilt, pvAzimuth);

      if (this.learningEngine) {
        await this.learningEngine.checkPanelGeometry(pvTilt, pvAzimuth);
      }

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

      // Upwind cloud monitor: fire-and-forget, non-critical; windFromDeg=null skips upwind point but still fetches home station.
      // TEMP RSS-investigation stagger (2026-07-06): delayed 3s so its 2 new-host connections
      // (SAT-relay qg+point) don't open at the same instant as the Buienradar fetch above —
      // fewer simultaneous fresh TLS handshakes during the weather-update burst.
      this.homey.setTimeout(() => {
        this.weatherForecaster.fetchUpwindData(latitude, longitude, this.weatherData?.currentWindDeg ?? null)
          .then(d => {
            if (d !== null) {
              // Preserve previous upwind station when this run had no windFromDeg (OM wind not yet loaded)
              if (d.station === null && this._upwindData?.station != null) {
                d = { ...d, station: this._upwindData.station, upwindCot: this._upwindData.upwindCot, dcot: this._upwindData.dcot };
              }
              this._upwindData = d;
            }
            this._queueSettingsPersist('policy_wind_data', {
              windMs:  this.weatherData?.currentWindMs  ?? null,
              windDeg: this.weatherData?.currentWindDeg ?? null,
              wmoCode: this.weatherData?.currentWmoCode ?? null,
              upwind:  d !== null ? d : (this._upwindData ?? null),
              ts:      new Date().toISOString()
            });
          })
          .catch(() => {});
      }, 3000);

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
          // Fallback: configured capacity × performance ratio × temperature derating
          todayKwh     = todayProfiles.reduce((sum, h) => sum + pvCapW * PR * (h.radiationWm2 / 1000) * _pvTempFactor(h.temp, h.radiationWm2), 0) / 1000;
          remainingKwh = futureProfiles.reduce((sum, h) => sum + pvCapW * PR * (h.radiationWm2 / 1000) * _pvTempFactor(h.temp, h.radiationWm2), 0) / 1000;
          this.log(`☀️ PV forecast (fallback PR=${PR}, ${learnedSlots} slots learned): ${todayKwh.toFixed(1)} kWh today, ${remainingKwh.toFixed(1)} kWh remaining`);
        } else {
          todayKwh = null;
          remainingKwh = null;
        }
        this.weatherData.pvKwhToday     = todayKwh     !== null ? Math.round(todayKwh     * 10) / 10 : null;
        this.weatherData.pvKwhRemaining = remainingKwh !== null ? Math.round(remainingKwh * 10) / 10 : null;
        if (this.weatherData.pvKwhToday !== null) {
          this.setCapabilityValue('pv_forecast_kwh', this.weatherData.pvKwhToday).catch(this.error);
        }

        // Net surplus = PV remaining minus expected consumption during PV hours.
        // Prevents delay-charge on low-PV days where household load consumes most of the yield.
        if (remainingKwh !== null && this.learningEngine) {
          let consumptionDuringPvHours = 0;
          for (const h of futureProfiles) {
            const slotIndex = h.time.getUTCHours() * 4;
            const pvW = learnedSlots >= 10
              ? h.radiationWm2 * (yfs?.[slotIndex] ?? 0)
              : pvCapW * PR * (h.radiationWm2 / 1000);
            if (pvW > 0) consumptionDuringPvHours += (this.learningEngine.getPredictedConsumption(h.time) ?? 0) / 1000;
          }
          const surplus = Math.max(0, remainingKwh - consumptionDuringPvHours);
          this.weatherData.pvSurplusRemaining = Math.round(surplus * 10) / 10;
          this.log(`☀️ PV surplus remaining: ${surplus.toFixed(1)} kWh (${remainingKwh.toFixed(1)} kWh PV − ${consumptionDuringPvHours.toFixed(1)} kWh consumption during PV hours)`);
        } else {
          this.weatherData.pvSurplusRemaining = null;
        }

        // Build per-hour PV forecast for the chart (today + tomorrow).
        // Uses dailyProfiles (all 24h, incl. past) so the chart line is complete and consistent.
        // Runs here — not in _recomputeOptimizer — so it updates even when the policy is disabled,
        // and chart values are NOT distorted by the accuracy-discount applied for optimizer planning.
        if (learnedSlots >= 10 || pvCapW > 0) {
          const nowFc          = new Date();
          const nowAmsDate     = _amsDayKeyFormatter.format(nowFc);
          const tomorrowAmsDate = _amsDayKeyFormatter.format(new Date(nowFc.getTime() + 86_400_000));
          const pvFcByDay      = [{}, {}];

          for (const h of this.weatherData.dailyProfiles) {
            const d     = h.time instanceof Date ? h.time : new Date(h.time);
            const hDate = _amsDayKeyFormatter.format(d);
            const dayIdx = hDate === nowAmsDate ? 0 : hDate === tomorrowAmsDate ? 1 : -1;
            if (dayIdx < 0) continue;
            const hHour = parseInt(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
            const s0    = d.getUTCHours() * 4;
            let pvPowerW;
            if (learnedSlots >= 10 && yfs) {
              const yf4 = [yfs[s0], yfs[s0+1], yfs[s0+2], yfs[s0+3]].filter(v => v != null && v > 0);
              if (yf4.length > 0) {
                const yf  = yf4.reduce((a, b) => a + b, 0) / yf4.length;
                const raw = Math.round(h.radiationWm2 * yf);
                pvPowerW  = pvCapW > 0 ? Math.min(raw, pvCapW) : raw;
              } else {
                // No learned sub-slots for this hour (e.g. early sunrise) — PR fallback
                pvPowerW  = pvCapW > 0 ? Math.min(pvCapW, Math.round(pvCapW * PR * (h.radiationWm2 / 1000) * _pvTempFactor(h.temp, h.radiationWm2))) : 0;
              }
            } else {
              pvPowerW  = pvCapW > 0 ? Math.min(pvCapW, Math.round(pvCapW * PR * (h.radiationWm2 / 1000) * _pvTempFactor(h.temp, h.radiationWm2))) : 0;
            }
            pvFcByDay[dayIdx][hHour] = pvPowerW;
          }

          // Only write chart if optimizer hasn't pushed a fresher blended forecast recently.
          // Prevents _updateWeather (1h cycle) from overwriting the 15-min optimizer chart.
          // Also skips the Solcast fetch — optimizer already blends Solcast, no extra API call needed.
          const omFcByDay = [{ ...pvFcByDay[0] }, { ...pvFcByDay[1] }];
          const blendAge = this._pvForecastBlendedAt ? Date.now() - this._pvForecastBlendedAt : Infinity;
          if (blendAge > 30 * 60 * 1000) {
            // Optimizer hasn't run recently (policy disabled or first startup): mirror the
            // optimizer's weighted OM/Solcast blend here so the settings page uses the same
            // forecast source as the planner.
            let scFcByDay = null;
            if (settings.solcast_enabled && settings.solcast_api_key && settings.solcast_resource_id) {
              if (!this._solcastProvider) {
                const SolcastProvider = require('../../lib/solcast-provider');
                this._solcastProvider = new SolcastProvider(this.homey);
              }
              try {
                const solcastForecast = await this._solcastProvider.getForecast(
                  settings.solcast_api_key,
                  settings.solcast_resource_id,
                  settings.pv_capacity_w || 0,
                );
                if (Array.isArray(solcastForecast) && solcastForecast.length > 0) {
                  // Persist day-start Solcast snapshot once per Amsterdam calendar day.
                  // Survives restarts; provides past-hour SC data for the chart green line.
                  const _scSnapKey  = 'policy_sc_daystart';
                  const _scSnap     = this.homey.settings.get(_scSnapKey);
                  if (!_scSnap || _scSnap.date !== nowAmsDate) {
                    this.homey.settings.set(_scSnapKey, { date: nowAmsDate, data: solcastForecast });
                    this.log(`[Solcast] Day-start snapshot saved for ${nowAmsDate} (${solcastForecast.length} slots)`);
                  }

                  const { wOM: baseWom, wSC: baseWsc } = this.learningEngine?.getPvBlendWeights?.() ?? { wOM: 0.5, wSC: 0.5 };
                  const nowAmsHour  = parseInt(nowFc.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
                  const scByDayHour = [{}, {}];
                  for (const s of solcastForecast) {
                    const st    = new Date(s.timestamp);
                    const sDate = _amsDayKeyFormatter.format(st);
                    const sIdx  = sDate === nowAmsDate ? 0 : sDate === tomorrowAmsDate ? 1 : -1;
                    if (sIdx < 0) continue;
                    const sHour = parseInt(st.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
                    if (!Array.isArray(scByDayHour[sIdx][sHour])) scByDayHour[sIdx][sHour] = [];
                    scByDayHour[sIdx][sHour].push(s.pvPowerW);
                  }
                  // Divergence correction: when SC exceeds OM for today, reduce SC weight.
                  // Use future hours only — past SC is irrelevant for remaining planning.
                  let omTodayWh = 0, scTodayWh = 0;
                  for (const [hour, values] of Object.entries(scByDayHour[0])) {
                    if (!Array.isArray(values) || values.length === 0) continue;
                    if (parseInt(hour) < nowAmsHour) continue; // future only
                    const omW = pvFcByDay[0][hour];
                    if (typeof omW !== 'number') continue;
                    omTodayWh += omW;
                    scTodayWh += values.reduce((a, b) => a + b, 0) / values.length;
                  }
                  let wOM = baseWom, wSC = baseWsc, divLog = '';
                  if (omTodayWh > 0 && scTodayWh > omTodayWh) {
                    const div = scTodayWh / omTodayWh;
                    wSC = Math.max(baseWsc * 0.5, baseWsc / Math.sqrt(div));
                    wOM = 1.0 - wSC;
                    divLog = ` div=${div.toFixed(2)}`;
                  }
                  scFcByDay = [{}, {}];
                  for (let d = 0; d < 2; d++) {
                    for (const [hour, values] of Object.entries(scByDayHour[d])) {
                      if (!Array.isArray(values) || values.length === 0) continue;
                      scFcByDay[d][hour] = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
                    }
                  }
                  let blendedHours = 0;
                  for (let d = 0; d < 2; d++) {
                    for (const [hour, values] of Object.entries(scByDayHour[d])) {
                      if (!Array.isArray(values) || values.length === 0) continue;
                      if (d === 0 && parseInt(hour) < nowAmsHour) continue; // past hours: in scFcByDay for chart only
                      const scAvg = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
                      const omW = pvFcByDay[d][hour];
                      pvFcByDay[d][hour] = typeof omW === 'number'
                        ? Math.round(wOM * omW + wSC * scAvg)
                        : scAvg;
                      blendedHours++;
                    }
                  }
                  const scTodayKwh = Object.values(pvFcByDay[0]).reduce((s, w) => s + (w || 0), 0) / 1000;
                  const scTomKwh  = Object.values(pvFcByDay[1]).reduce((s, w) => s + (w || 0), 0) / 1000;
                  this.log(`[Solcast] Blended ${blendedHours} chart hours with wOM=${wOM.toFixed(2)} wSC=${wSC.toFixed(2)}${divLog} — chart forecast now: vandaag ${scTodayKwh.toFixed(1)} kWh, morgen ${scTomKwh.toFixed(1)} kWh`);
                }
              } catch (err) {
                this.log(`[Solcast] Chart forecast error: ${err.message}`);
              }
            }
            // Apply the same corrections the operational forecast got to the raw model
            // overlays (OM, satellite), so they track actual instead of sitting structurally
            // low on under-forecast days. daily-bias applies to all hours; the intraday ratio
            // is a today-specific actual-vs-forecast scaling for the REMAINING hours only —
            // applying it to already-realised past hours retroactively inflates the curve
            // (the accuracy chart freezes the ratio per slot at record time, so the overlays
            // diverged). Cap at the panel ceiling like the operational line.
            const _nowAmsHr = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
            const _scaleChartFc = (byDay) => {
              if (!byDay) return byDay;
              for (let d = 0; d < 2; d++) {
                for (const h of Object.keys(byDay[d])) {
                  const applyIntraday = (d === 0 && parseInt(h) >= _nowAmsHr);
                  byDay[d][h] = this._correctOverlayW(byDay[d][h], applyIntraday);
                }
              }
              return byDay;
            };
            this._setLive('policy_pv_forecast_hourly', pvFcByDay);
            this._setLive('policy_pv_forecast_om', _scaleChartFc(omFcByDay));
            if (scFcByDay) this._setLive('policy_pv_forecast_sc', scFcByDay);
            this._setLive('policy_pv_forecast_sat',
              this._buildSatForecastForChart(this.weatherData, pvCapW));
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
        // Keep learning_status fresh even when policy/optimizer isn't running.
        // pvPredictions/modelAcc live in learning_pv_chart_data (written by _gatherInputs)
        // so this lightweight write stays small.
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
        // Predictive mode: alleen PV camera verversen, optimizer niet aanraken.
        // Als forecast ontbreekt (bijv. na versiesprong), eerst weather fetchen.
        const hasForecast = !!(this._liveState.policy_pv_forecast_hourly
          ?? this.homey.settings.get('policy_pv_forecast_hourly'));
        const doUpdate = async () => {
          if (!this.planningImagePv) await this._initPvCamera().catch(() => {});
          else await this.planningImagePv.update().catch(() => {});
        };
        if (!hasForecast) {
          this._maybeRefreshWeatherOnly().catch(() => {}).then(doUpdate).catch(() => {});
        } else {
          doUpdate().catch(() => {});
        }
        return;
      }

      // When policy is disabled (user off, not predictive): refresh PV camera with fresh forecast.
      // After a restart planningImagePv is null (only _updatePlanningChart initialises it, which
      // only runs after a policy run). Call _initPvCamera so the camera is registered with Homey
      // and shows the correct today forecast rather than a stale cached image.
      if (!this.getCapabilityValue('policy_enabled')) {
        const hasForecast2 = !!(this._liveState.policy_pv_forecast_hourly
          ?? this.homey.settings.get('policy_pv_forecast_hourly'));
        const doUpdate2 = async () => {
          if (!this.planningImagePv) await this._initPvCamera().catch(() => {});
          else await this.planningImagePv.update().catch(() => {});
        };
        if (!hasForecast2) {
          this._maybeRefreshWeatherOnly().catch(() => {}).then(doUpdate2).catch(() => {});
        } else {
          doUpdate2().catch(() => {});
        }
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
    const intervalMs = 3_600_000;
    const age = this.weatherData?.fetchedAt ? Date.now() - this.weatherData.fetchedAt : Infinity;
    if (age > intervalMs) {
      await this._updateWeather();
    }
  }

  /**
   * Freeze the 15-min load slot that just closed, if the boundary was crossed.
   * Idempotent — a second call within the same slot is a no-op.
   *
   * Called from BOTH the 15s poll (which then accumulates into the new slot) and the
   * policy run (which reads _loadPrevSlotMs). The policy run fires at :00:00.5, up to
   * 15s BEFORE the first poll of the new slot. Without this call it would still see the
   * slot that closed 30 min ago, and the 30-min freshness guard on consumAvgW /
   * recordConsumptionAccuracy rejects it — silently starving the consumption accuracy
   * meter from the day it was built (~5 samples in 5 days, all from off-schedule runs
   * that happened to fire late enough to win the race).
   *
   * Do NOT "fix" this by widening that freshness guard instead: scoring against the
   * slot-before-previous pairs a slot mean with the wrong slot's forecast — wrong data
   * rather than missing data.
   */
  _rollLoadSlot(nowMs = Date.now()) {
    const slotMs = Math.floor(nowMs / (15 * 60_000)) * (15 * 60_000);
    if (this._loadSlotMs === slotMs) return;
    if (this._loadSlotCount > 0) {
      this._loadPrevSlotMs = this._loadSlotMs;
      this._loadPrevMeanW  = this._loadSlotSum / this._loadSlotCount;
      this._loadPrevCount  = this._loadSlotCount;
    }
    // PV rides the same boundary and the same guard, so its mean covers an identical sample
    // set to the load mean and the two can be paired honestly. Frozen separately (not derived
    // from _loadSlotCount) so a future change to one accumulator cannot silently skew the other.
    if (this._pvSlotCount > 0) {
      this._pvPrevMeanW = this._pvSlotSum / this._pvSlotCount;
      this._pvPrevCount = this._pvSlotCount;
    }
    this._loadSlotMs = slotMs;
    this._loadSlotSum = 0;
    this._loadSlotCount = 0;
    this._pvSlotSum = 0;
    this._pvSlotCount = 0;
  }

  async _runPolicyCheck({ skipEnabledCheck = false } = {}) {
    if (this._policyCheckRunning) {
      this.log('Policy check already in progress, skipping concurrent call');
      return;
    }
    this._policyCheckRunning = true;
    try {
      // [MEM] runtime sample. The onInit-only sampling could not explain the
      // 2026-07-22 11:00→12:00Z +10MB RSS step: there was no restart that hour,
      // so every heap/ext sample sat at an identical point in boot and could not
      // move. Sampling on the policy cadence catches the next level-shift while
      // it happens. Uses app.logMem (heap + total + external) rather than the
      // local _memMB, which reports heap only.
      this.homey.app.logMem?.('[BatteryPolicy] policy-run');
      if (Date.now() - (this._lastMemFootprintMs || 0) > 3600_000) {
        this._lastMemFootprintMs = Date.now();
        this._logSettingsFootprint();
      }

      if (!skipEnabledCheck && !this.getCapabilityValue('policy_enabled')) {
        this.log('Policy disabled, skipping check');
        return;
      }

      if (!skipEnabledCheck && this.getCapabilityValue('policy_mode') === 'off') {
        this.log('Policy mode is off, skipping check');
        return;
      }

      const overrideUntil = this.getStoreValue('override_until');
      if (overrideUntil && new Date(overrideUntil) > new Date()) {
        this.log('Manual override active, skipping policy check');
        return;
      }

      // Timestamp of the last real (non-skipped) policy run. Lets the hour-boundary
      // safety-net skip when the slot-aligned interval already covered this hour.
      this._lastPolicyRunAt = Date.now();

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
            this.homey.settings.set('policy_enabled_before_predictive', this._policyEnabledBeforePredictive);
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
            this._upsertModeHistory({
              ts: new Date().toISOString(), hwMode: 'predictive', soc: currentSoC, price: null,
            });
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
      this.homey.app.logMem?.('[BatteryPolicy] after-inputs');
      if (!inputs.battery || inputs.battery.stateOfCharge === undefined) {
        this.log('Skipping policy check — battery state not ready');
        return;
      }

      // Recompute optimizer schedule if stale (lazy, every ~90 min or after price update),
      // or when intra-day conditions have drifted significantly from the last DP run.
      const currentSoc = inputs.battery?.stateOfCharge ?? null;
      if ((this.optimizationEngine.isStale() || this._shouldForceReoptimize(currentSoc)) && inputs.tariff) {
        await this._recomputeOptimizer(inputs);
        this.homey.app.logMem?.('[BatteryPolicy] after-optimizer');
      }
      inputs.optimizer = this.optimizationEngine;
      inputs.optimizerSlots = this.optimizationEngine._schedule?.slots ?? null;

      // Log planned vs actual SoC to detect consumption/discharge drift.
      if (currentSoc != null && inputs.optimizerSlots?.length) {
        const nowMs = Date.now();
        const plannedSlot = inputs.optimizerSlots
          .filter(s => new Date(s.timestamp).getTime() <= nowMs)
          .at(-1);
        if (plannedSlot?.socProjected != null) {
          const socDrift = currentSoc - plannedSlot.socProjected;
          this.log(`[SoC] actual=${currentSoc}% planned=${plannedSlot.socProjected.toFixed(1)}% drift=${socDrift > 0 ? '+' : ''}${socDrift.toFixed(1)}pp`);
        }
      }

      const result = this.policyEngine.calculatePolicy(inputs);
      this.homey.app.logMem?.('[BatteryPolicy] after-policy');

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

      // The history-based confidence adjustment was removed 2026-07-18. It averaged this app's
      // OWN past confidence values with no outcome feedback — confidence feeding confidence —
      // and predates the DP by a month (added 2026-02-14, DP 2026-03-15, confidence hardcoded
      // to `exception ? 75 : 90` on 2026-04-13). Once the DP path stopped computing confidence
      // its input no longer varied, so it emitted a constant +2.2 into a gate that has never
      // fired in the entire log: on this path confidence is bounded to ~70-99 and the threshold
      // is 55. Do not reintroduce without real outcome feedback (did the decision pay off?),
      // and note that a firing gate freezes the previous hardware mode rather than choosing a
      // safer one — the DP already hedges uncertainty internally via consumptionMargin,
      // refillConfidence and the reserve floor.

      // Guard: skip explainability when heap is already high — the engine adds ~25 MB
      // which pushes total above the Homey memory ceiling (~65 MB heap).
      let _heapBeforeExplain = 50; // conservative default: skip
      try { _heapBeforeExplain = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      // Surface overnight refill-reserve so the explanation can tell users WHY the battery
      // holds charge instead of discharging (PV-forecast downside — refillConfidenceFromForecast).
      inputs.refillConfidence    = this._lastRefillConfidence ?? 1;
      inputs.refillReserveActive = (this._lastRefillConfidence ?? 1) < 1;
      inputs.upwindData          = this._upwindData ?? null;
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
      this.homey.app.logMem?.('[BatteryPolicy] after-explain');

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
        reportedMaxChargePowerW: inputs.battery?.reportedMaxChargePowerW ?? null,
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
        respect_minmax:      this.getSetting('respect_minmax')      ?? true,
        min_soc:             this.getSetting('min_soc')             ?? 0,
        max_soc:             this.getSetting('max_soc')             ?? 100,
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
        ? (inputs.dpDecision
            ? this.explainabilityEngine._generateDpShortSummary({ hwMode: currentActiveMode }, inputs)
            : this.explainabilityEngine._generateShortSummary({ hwMode: currentActiveMode }, inputs))
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
        // Terminal value: show the DP's actual factor + the post-horizon refill window it used.
        // pvKwhTomorrow stays the WITHIN-horizon net surplus (drives the flatten threshold and
        // netto%-of-clear-sky on the settings page); the post-horizon terminal window is its own
        // field so the two are not conflated (the terminal window is 0 until the day-after loads).
        const _sched = this.optimizationEngine?._schedule;
        if (_sched?.terminalFactor != null) result.debug.pvTermFactor = +_sched.terminalFactor.toFixed(2);
        if (_sched?.terminalPvKwh != null)  result.debug.pvTermKwh = +_sched.terminalPvKwh.toFixed(1);
        // PV forecast-accuracy EMAs (learning-engine.js recordPvAccuracy) — exposed here so they're
        // readable from settings/diagnose without flipping learning-engine.js's debug flag + restart.
        // Gates project_satellite_dp_integration_playbook's CHUNK 0 go/no-go on pv_accuracy_sat.
        const _pvAcc = this.learningEngine?.data;
        if (_pvAcc) {
          result.debug.pvAccuracySat = _pvAcc.pv_accuracy_sat ?? null;
          result.debug.pvAccuracyOm = _pvAcc.pv_accuracy_om ?? null;
          result.debug.pvAccuracySc = _pvAcc.pv_accuracy_sc ?? null;
          result.debug.pvAccuracyScore = _pvAcc.pv_accuracy_score ?? null;
          result.debug.pvAccuracySamples = _pvAcc.pv_predictions?.length ?? null;
          // Temp: raw per-slot om/sc/actual W for divergence-mining analysis
          // (project_roadmap_perslot_blend_divergence). Remove after analysis done.
          // Its OWN key, not a field of result.debug: _queueSettingsPersist dedupes per key, and
          // the debug blob changes every policy run through the scalars below — riding along meant
          // this ~45 kB array was re-serialized ~6.5x/hour while it only mutates once per PV slot.
          // settings.set is 79.9% of app allocation and cost scales with payload size
          // (project_app_rss_step_0722), so the skipped writes are the point, not the split itself.
          this._setLive('policy_pv_predictions_recent', _pvAcc.pv_predictions?.slice(-300) ?? null);
          // Learned scalar sat yield-factor (panel-plane basis) — exposed so it's checkable
          // against the SAT_YF_PRIOR warm-start without a debug-flag flip + restart.
          result.debug.satYieldFactors = _pvAcc.solar_sat_yield_factor ?? null;
        }
        // Refill-reserve state + near-term discharge count — exposed so a "discharge tonight
        // silently dropped" report (feedback_dp_instability_debug_workflow) is traceable from
        // one diag-dump instead of a temp full-array log + restart + wait.
        result.debug.refillConfidence = this._lastRefillConfidence ?? null;
        result.debug.reserveFloorPct  = this._lastReserveFloorPct ?? null;
        result.debug.minDischargePriceRange = this._lastMinDischargePriceRange ?? null;
        // Shadow range of the fixed per-slot floor. null = PV-headroom block did not run.
        result.debug.minDischargeFixRange = this._lastMinDischargeFixRange ?? null;
        result.debug.consumptionMarginRange = this._lastConsumptionMarginRange ?? null;
        // Night bias correction actually applied, in W (≤ 0). null = flag off. Expect a non-zero
        // min on a run whose horizon spans 23-06 and 0/0 on a pure daytime horizon.
        result.debug.nightBiasCorrRange = this._lastNightBiasCorrRange ?? null;
        // Consumption-accuracy meter. learning_data lives in the device store, which no
        // external reader can reach — pv_predictions is only inspectable because it gets
        // mirrored out too. Riding on this existing payload instead of claiming a new
        // settings key keeps it off the heap-throttled persist queue (1 key / 8s).
        // Snapshot, not the live object: consumption_accuracy_hourly keeps mutating after
        // this payload is queued (the persist queue flushes ~8s later), which would alias
        // learning data into _liveState and report score/hourly from different moments.
        {
          const _ch = _pvAcc?.consumption_accuracy_hourly;
          result.debug.consumptionAccuracy = {
            score: _pvAcc?.consumption_accuracy_score != null
              ? +_pvAcc.consumption_accuracy_score.toFixed(4) : null,
            hourly: _ch ? Object.fromEntries(Object.entries(_ch).map(([h, v]) => [h, {
              emaAbsErrW: Math.round(v.emaAbsErrW),
              emaBiasW:   Math.round(v.emaBiasW),
              count:      v.count,
            }])) : null,
          };
        }
        {
          const _schedSlots    = this.optimizationEngine?._schedule?.slots ?? [];
          const _next12hCutoff = Date.now() + 12 * 3_600_000;
          result.debug.dischargeNext12h = _schedSlots.filter(
            s => s.action === 'discharge' && new Date(s.timestamp).getTime() <= _next12hCutoff
          ).length;
        }
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
        
        // Must match the resolution in _applyRecommendation — this copy only phrases the log
        // line below, so a different default would explain a refusal with a threshold that did
        // not cause it. Schema default is 55.
        const minConfidence = this.getSetting('min_confidence_threshold') ?? 55;
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
          // Mapper-level block: DP planned charge but the hwMode does not charge (price > ceiling,
          // no PV). Not caught above because policyMode tracks dpAction; the divergence is at the
          // mapper. Surfaces whether the DP ever plans charge above maxChargePrice (open question).
          const _chargeModes = ['to_full', 'zero_charge_only', 'pv_trickle'];
          if (_dpAction === 'charge' && !_chargeModes.includes(applyMode)) {
            this.log(`⚠️ PLAN AFWIJKING (mapper): DP gepland charge maar hwMode ${applyMode} (laadt niet) — prijs €${(result.debug?.price ?? '?')} > plafond, geen PV`);
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
          const currentPrice = result.debug?.price ?? inputs.tariff?.currentPrice ?? null;
          const currentSoc   = this.getCapabilityValue('battery_soc_mirror') ?? null;
          const _rtBatt      = this.p1Device?._getRealtimePluginBatteryData?.() ?? [];
          const battW        = _rtBatt.length > 0
            ? _rtBatt.reduce((sum, b) => sum + (b.power ?? 0), 0)
            : (inputs.p1?.battery_power ?? this._lastBatteryTargetW ?? null);
          const gridW        = inputs.p1?.resolved_gridPower ?? 0;
          const socDropped   = this._lastHistorySoc != null && currentSoc != null && currentSoc < this._lastHistorySoc - 1;
          const sensorLag    = socDropped && battW !== null && Math.abs(battW) < 10;
          // Immediate stale detection: discharge mode + battery=0W + grid=0W = P1 lag (nul-op-de-meter but battery unreported)
          const _hwModeNow     = this.p1Device?.getCapabilityValue('battery_group_charge_mode') ?? '';
          const _inDischarge   = _hwModeNow.includes('discharge');
          const zeroOnMeterLag = _inDischarge && Math.abs(battW ?? 0) < 10 && Math.abs(gridW) < 30;
          const _calSunset   = inputs.weather?.todaySunset;
          const _calSunrise  = inputs.weather?.todaySunrise;
          const _afterSunsetNow = !_calSunset
            || (Date.now() > _calSunset.getTime() + 30 * 60 * 1000)
            || (_calSunrise instanceof Date && Date.now() < _calSunrise.getTime());
          const _battWAbs = Math.abs(battW ?? 0);
          const bmsCalibration = (currentSoc ?? 0) <= 0
            && ((_battWAbs >= 50 && _battWAbs <= 150) || (_battWAbs >= 700 && _battWAbs <= 900));
          const p1Available  = this.p1Device?.getAvailable() !== false;
          this._lastHistorySoc = currentSoc;
          const nowTs   = new Date();
          // plan-accuracy: store this slot's forecast alongside the actuals.
          // Slots may be hourly (1h optimizer) or 15-min — pick the slot covering now
          // (latest start <= now) so bucket granularity never blocks the match.
          const _planSlot = this.optimizationEngine?._schedule?.slots
            ?.filter(s => new Date(s.timestamp).getTime() <= nowTs.getTime())
            .pop();
          // plan-accuracy F3: store this slot's live sat + Solcast forecast alongside OM (pvFcW),
          // so the 🎯 block can compare sat vs SC vs OM on valid live data (shadow-only; not fed
          // to the DP). Read the already-computed live values — satPanelW (= satGHI × gtiOverGhi ×
          // scalar) off the hourly slot, and Solcast p50 off _pvForecastSC — never re-derive a
          // formula (that is the ktvssc-drift trap). satFcW is null outside the 0-2h sat window.
          const _hourMs = nowTs.getTime()
            - (nowTs.getUTCMinutes() * 60_000)
            - (nowTs.getUTCSeconds() * 1_000)
            - nowTs.getUTCMilliseconds();
          const _satFcW = this.weatherData?.hourlyForecast
            ?.find(h => h.time.getTime() === _hourMs)?.satPanelW ?? null;
          // Age (min) of the sat data behind this satFcW — so the F4 analysis can label lead
          // time / drop laggy-mirror samples. Only meaningful when satFcW is present.
          const _satIssueMs = this.weatherForecaster?.getSatIssueMs?.() ?? null;
          const _satAgeMin = (_satFcW != null && _satIssueMs != null)
            ? Math.round((nowTs.getTime() - _satIssueMs) / 60_000)
            : null;
          const _scSlots = this._pvForecastSC?.get(_hourMs);
          const _scFcW = _scSlots?.p50?.length > 0
            ? Math.round(_scSlots.p50.reduce((a, b) => a + b, 0) / _scSlots.p50.length)
            : null;
          // Close the slot that just ended before reading it below. This runs at :00:00.5,
          // ahead of the next 15s poll, so without it consumAvgW and the accuracy sample
          // would both read a 30-min-old slot and fail their freshness guard.
          this._rollLoadSlot(nowTs.getTime());
          const entry = {
            ts:     nowTs.toISOString(),
            hwMode: applyMode,
            price:  currentPrice,
            soc:    currentSoc,
            maxChargePrice: this.getSetting('max_charge_price'),
            minDischargePrice: this.getSetting('min_discharge_price'),
            pvW:     result.debug?.pvEstimate      ?? null,
            consumW: result.debug?.houseConsumption ?? null,
            // Mean load over the 15 min ENDING at this timestamp, from the 15s poll. consumW
            // above is a single instantaneous reading and is blind to short appliance bursts
            // (a 5-10 min dishwasher drying peak lands between two policy samples, and since
            // both run on fixed schedules it is missed every night, not occasionally). Pair
            // this with the PREVIOUS entry's consumFcW for an honest forecast-vs-actual join.
            consumAvgW: (this._loadPrevSlotMs != null && Date.now() - this._loadPrevSlotMs < 30 * 60_000)
              ? Math.round(this._loadPrevMeanW) : null,
            // Mean PV over the same closed slot as consumAvgW. Pair BOTH with the previous
            // entry's forecast fields, never with this entry's — they describe the interval
            // that just ended, not the one starting now.
            pvAvgW: (this._loadPrevSlotMs != null && Date.now() - this._loadPrevSlotMs < 30 * 60_000
                     && this._pvPrevMeanW != null)
              ? Math.round(this._pvPrevMeanW) : null,
            pvFcW:     _planSlot?.pvForecastW  ?? null,
            consumFcW: _planSlot?.consumptionW ?? null,
            satFcW:  _satFcW,
            scFcW:   _scFcW,
            satAgeMin: _satAgeMin,
            gridW:   this.getCapabilityValue('grid_power_mirror') ?? null,
            battW:   inputs.p1?.battery_power        ?? this._lastBatteryTargetW ?? null,
            policyMode: result.policyMode ?? result.debug?.policyMode ?? null,
            dpAction: typeof dpAction === 'string' ? dpAction : (dpAction?.action ?? null),
            exception: !p1Available ? 'p1_unavailable' : (sensorLag || zeroOnMeterLag) ? 'battery_sensor_lag' : bmsCalibration ? 'bms_calibration' : (result.debug?.exception ?? null),
          };
          // Consumption forecast accuracy — the load side has no equivalent of
          // recordPvAccuracy, so forecast quality was only knowable by scraping this history
          // by hand. Observe-only; nothing reads it back.
          //
          // Scores the slot that just CLOSED, not the one starting now: this runs at :00:01,
          // when the new slot has no samples yet. Actual = mean over that closed slot from the
          // 15s poll; forecast = the plan slot covering it. Using the run's instantaneous
          // reading instead would alias — a 5-10 min appliance burst falls between two policy
          // samples, and with both on fixed schedules it is missed every night, so even the
          // signed bias would not average out.
          //
          // The forecast is comparable to a slot mean by construction: the learned profile is
          // itself the mean of these same 15s samples. consumFcW is raw (consumptionMargin is
          // applied later inside the DP), so this scores the forecast, not the hedge.
          //
          // One sample per 15-min bucket, mirroring _recordPvAccuracySample's dedup: a restart
          // fires several policy runs into one bucket, and counting each would over-weight it.
          {
            const _cBucket = Math.floor(nowTs.getTime() / (15 * 60_000)) * (15 * 60_000);
            const _closedMs = this._loadPrevSlotMs;
            const _closedFresh = _closedMs != null && nowTs.getTime() - _closedMs < 30 * 60_000;
            // Enough of the closed slot actually sampled? 15s poll → 60 expected. Require 75%:
            // a thinly-covered slot can miss a short burst just like the instantaneous reading
            // this replaces, which would quietly reintroduce the aliasing. Better to skip the
            // slot than score against a mean that never saw the peak. 75% still tolerates the
            // normal losses (batteryPowerLag guard, _p1PollInFlight skips) while rejecting a
            // slot that spans a restart.
            const _closedComplete = _closedFresh && this._loadPrevCount >= 45;
            // Reads the stashed RAW learned profile, not _schedule.slots[].consumptionW: with
            // night_consumption_bias_corr on, that array carries the correction, and scoring it
            // would make emaBiasW measure its own output (bias → 0 → correction → 0 → bias back).
            // The meter's job is to score the learned profile, which is what feeds the correction.
            const _closedFc = _closedComplete
              ? (this._rawConsumptionSlots?.filter(s => s.ms <= _closedMs).pop()?.w ?? null)
              : null;
            if (this._lastConsumAccuracyBucket !== _cBucket && _closedComplete
                && this.learningEngine?.recordConsumptionAccuracy(
                  _closedFc, this._loadPrevMeanW, new Date(_closedMs))) {
              this._lastConsumAccuracyBucket = _cBucket;
            }
          }
          // Upserts this 15-min bucket in the day chunk (non-null SoC wins) and prunes chunks
          // outside the MODE_HISTORY_DAYS window — retains F3 sat-accuracy over a multi-week vacation.
          this._upsertModeHistory(entry);
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
            const hwActiveSummary = inputs.dpDecision
              ? this.explainabilityEngine._generateDpShortSummary({ hwMode: actualHwMode }, inputs)
              : this.explainabilityEngine._generateShortSummary({ hwMode: actualHwMode }, inputs);
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
    const amhour = ts => parseInt(_amsHourFormatter.format(new Date(ts)), 10);

    // Future slots from the optimizer schedule (include current slot via -15min buffer)
    // Use step as grace period so the current slot is never lost in the gap
    // between past-loop cutoff (now - step) and future filter (now - 15min)
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
          pvW:   Math.round(s.pvW ?? 0),
          consumptionW: Math.round(s.consumptionW ?? 0)
        };
      });

    // Chart plots the DP's own socProjected trajectory (already mapped to
    // slot.soc above from each schedule slot), so the chart, the settings planning
    // view, and the explainability engine all show the same numbers. Exception:
    // slots where the planning mapper overrode the DP action carry a re-simulated
    // value instead (buildPlanningSchedule, socOverride flag) — the DP projected no
    // delta for what the mapper decided there. The [PLANTILE] log line counts them.
    // Drift between live SoC and the schedule start is handled upstream — reopt
    // force-recomputes the schedule whenever the deviation exceeds threshold.

    // Past slots from mode history (has real soc + mode) — keyed by rounded 15-min ts
    const modeHistory = this._readModeHistory();
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
      windMs:       this.weatherData?.currentWindMs  ?? null,
      windDeg:      this.weatherData?.currentWindDeg ?? null,
      upwind:       this._upwindData ?? null,
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
        if (ratioDelta > 0.15) {
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
   * Daytime-masked relative PV forecast bias = Σ(actual − forecast) / Σ(actual)
   * over the last 96 history slots where either actual or forecast > 50W.
   * Positive = under-forecast (PV beats forecast). null if < 4 daytime samples.
   */
  _computePvRelBias() {
    const hist = this._readModeHistory(96);
    let sAct = 0, sErr = 0, n = 0;
    for (const e of hist) {
      if (e.pvFcW == null || e.pvW == null) continue;
      if (e.pvW <= 50 && e.pvFcW <= 50) continue;
      sAct += e.pvW; sErr += e.pvW - e.pvFcW; n++;
    }
    return (sAct > 0 && n >= 4) ? sErr / sAct : null;
  }

  /**
   * Plan-accuracy stats (MAE + signed bias, bias = actual − forecast) over a history slice,
   * per forecast source. Single implementation for the 🎯 diagnostic AND its test.
   * pv = OM forecast, sat = live satellite nowcast, sc = Solcast p50, co = consumption.
   * Each source returns { n, mae, bias } or null when < 4 paired samples.
   */
  _planAccuracyStats(hist) {
    const acc = (fc, act) => {
      const errs = hist
        .filter(e => e[fc] != null && e[act] != null)
        .map(e => e[act] - e[fc]);
      if (errs.length < 4) return null;
      const mae  = errs.reduce((a, x) => a + Math.abs(x), 0) / errs.length;
      const bias = errs.reduce((a, x) => a + x, 0) / errs.length;
      return { n: errs.length, mae: Math.round(mae), bias: Math.round(bias) };
    };
    return {
      pv:  acc('pvFcW', 'pvW'),
      sat: acc('satFcW', 'pvW'),
      sc:  acc('scFcW', 'pvW'),
      co:  acc('consumFcW', 'consumW'),
    };
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
    const slotBoundary15 = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const rawPrices = (raw15min?.length > 0)
      ? raw15min.filter(p => new Date(p.timestamp) >= slotBoundary15)
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
          let rawPvW;
          if (learnedSlots >= 10 && yf4.length > 0) {
            const yf = yf4.reduce((a, b) => a + b, 0) / yf4.length;
            rawPvW = Math.round(h.radiationWm2 * yf);
          } else {
            rawPvW = pvCapacityW > 0 ? Math.round(pvCapacityW * pvPR * (h.radiationWm2 / 1000) * _pvTempFactor(h.temp, h.radiationWm2)) : 0;
          }

          // Cap at installed system capacity — learned yield factors can overshoot on
          // exceptional days, but the inverter/system can never exceed its rated peak.
          const pvW = pvCapacityW > 0 ? Math.min(rawPvW, pvCapacityW) : rawPvW;
          // Carry the satellite nowcast alongside OM so the blend below can swap it into the
          // Solcast leg without re-finding the hour slot per forecast slot. _applySatelliteOverlay
          // (weather-forecaster.js) writes satPanelW onto these very hourlyForecast slots, and
          // leaves it null outside its 0-3h lead window or below 15° solar elevation.
          return { timestamp: d.toISOString(), pvPowerW: pvW, precipMmh: h.precipMmh ?? 0, spreadFrac: h.radiationSpreadFrac ?? 0, satPanelW: h.satPanelW ?? null, satIssueMs: h.satIssueMs ?? null };
        })
        .filter(h => h.pvPowerW > 0 || pvCapacityW > 0);

      // Per-model pvForecast (ECMWF/GFS/ICON/KNMI) for per-model accuracy tracking.
      // Uses perModelWm2 from hourlyForecast (aligned to standardData indices, no time-map lookup).
      this._pvForecastPerModel = null;
      if (yfs) {
        const MODELS_OM = ['meteofrance_arpege_europe', 'gfs_seamless', 'icon_seamless', 'knmi_harmonie_arome_netherlands', 'ecmwf_ifs'];
        this._pvForecastPerModel = {};
        for (const m of MODELS_OM) {
          const mSlots = inputs.weather.hourlyForecast
            .filter(h => typeof h.radiationWm2 === 'number')
            .map(h => {
              const rad = h.perModelWm2?.[m];
              if (typeof rad !== 'number') return null;
              // perModelWm2 is GTI when tilt/azimuth configured (via transposition in weather-forecaster),
              // GHI otherwise. Either way apply yield factors directly.
              const d = h.time instanceof Date ? h.time : new Date(h.time);
              const s0 = d.getUTCHours() * 4;
              const yf4 = [yfs[s0], yfs[s0+1], yfs[s0+2], yfs[s0+3]].filter(v => v != null && v > 0);
              const pvW = (learnedSlots >= 10 && yf4.length > 0)
                ? Math.round(rad * (yf4.reduce((a, b) => a + b, 0) / yf4.length))
                : Math.round(pvCapacityW * pvPR * (rad / 1000));
              return { timestamp: d.toISOString(), pvPowerW: Math.max(0, pvCapacityW > 0 ? Math.min(pvW, pvCapacityW) : pvW) };
            })
            .filter(s => s != null);
          if (mSlots.length > 0) this._pvForecastPerModel[m] = mSlots;
        }
        const slotCounts = Object.entries(this._pvForecastPerModel).map(([m, fc]) =>
          `${m.replace('meteofrance_arpege_europe','mf').replace('_seamless','').replace('knmi_harmonie_arome_netherlands','knmi').replace('ecmwf_ifs','ecmwf')}=${fc.length}`).join(' ');
        this.log(`[PV perModel] slots: ${slotCounts || 'none'}`);
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
            blendSettings.pv_capacity_w || 0,
          );
          if (Array.isArray(solcastForecast) && solcastForecast.length > 0) {
            solcastByHourMs = new Map();
            for (const s of solcastForecast) {
              const t = new Date(s.timestamp);
              const hourMs = t.getTime() - (t.getUTCMinutes() * 60_000) - (t.getUTCSeconds() * 1_000) - t.getUTCMilliseconds();
              if (!solcastByHourMs.has(hourMs)) solcastByHourMs.set(hourMs, { p50: [], p10: [] });
              solcastByHourMs.get(hourMs).p50.push(s.pvPowerW);
              solcastByHourMs.get(hourMs).p10.push(s.pvPowerW10 ?? s.pvPowerW);
            }
          }
        } catch (err) {
          this.log(`[Solcast] Error: ${err.message}`);
        }
      }

      // Save unblended OM forecast for per-model accuracy tracking
      this._pvForecastOM = pvForecast;

      // ── Blend all available sources per hourly slot ──────────────────────────
      if (solcastByHourMs) {
        this._pvForecastSC = solcastByHourMs;

        const { wOM: baseWom, wSC: baseWsc } = this.learningEngine?.getPvBlendWeights?.() ?? { wOM: 0.5, wSC: 0.5 };
        // Lever A: fixed 50/50 OM↔SC. getPvBlendWeights already returns 0.5/0.5 here, but the
        // per-day divergence penalty and per-slot p10-pessimism below would still shift it —
        // bypass both so the blend is exactly the measured unbiased average. Toggle off to revert.
        const unbiasedBlend = this.getSetting('pv_unbiased_blend') !== false;

        const todayNLDate = _amsDayKeyFormatter.format(new Date());
        const tomorrowNLDate = _amsDayKeyFormatter.format(new Date(Date.now() + 86_400_000));
        const byDay = { [todayNLDate]: { om: 0, sc: 0, bl: 0 }, [tomorrowNLDate]: { om: 0, sc: 0, bl: 0 } };

        // Pre-scan per-day OM vs SC totals for divergence detection.
        // When SC optimistically exceeds OM, OM's NWP ensemble captures cloud/rain faster
        // (SC satellite/ML lags on approaching weather fronts). Compute separately per day so
        // tomorrow's blend isn't skewed by today's weather divergence.
        const dayTotals = { [todayNLDate]: { om: 0, sc: 0 }, [tomorrowNLDate]: { om: 0, sc: 0 } };
        for (const slot of pvForecast) {
          const dk = _amsDayKeyFormatter.format(new Date(slot.timestamp));
          if (!dayTotals[dk]) continue;
          const scSlots = solcastByHourMs.get(new Date(slot.timestamp).getTime());
          if (scSlots?.p50?.length > 0) {
            dayTotals[dk].om += slot.pvPowerW;
            dayTotals[dk].sc += scSlots.p50.reduce((a, b) => a + b, 0) / scSlots.p50.length;
          }
        }
        const getDayWeights = (dk, applyDivergence = true) => {
          if (unbiasedBlend) return { wOM: 0.5, wSC: 0.5, div: null };
          const t = dayTotals[dk];
          // SC satellite/ML lag on approaching weather fronts applies mainly to today's
          // remaining hours. Tomorrow's SC forecast uses its ML model which is less prone
          // to front-lag, so skip the divergence penalty for tomorrow entirely.
          if (applyDivergence && t && t.om > 0 && t.sc > t.om) {
            const div = t.sc / t.om;
            // √div for gentler penalty; floor at baseWsc×0.5 so SC never drops below half its
            // accuracy-derived share.
            const wSC = Math.max(baseWsc * 0.5, baseWsc / Math.sqrt(div));
            return { wOM: 1.0 - wSC, wSC, div };
          }
          return { wOM: baseWom, wSC: baseWsc, div: null };
        };
        const weightsToday    = getDayWeights(todayNLDate, true);
        const weightsTomorrow = getDayWeights(tomorrowNLDate, false);

        // Satellite-for-Solcast swap on near-term slots (chunk 2). Two gates live here; the
        // third (lead window ≤3h, elevation ≥15°) is already baked into satPanelW being null.
        // Freshness is checked per slot against the issue that produced that slot's value —
        // a slot outside the current lead window keeps its previous satPanelW, so the latest
        // issue being fresh says nothing about the value actually sitting on the slot.
        const SAT_MAX_AGE_MS = 3600_000;
        const SAT_LEAD_MS    = 3 * 3600_000;
        const satReplSc  = this.getSetting('sat_replaces_sc') === true;
        const satIssueMs = this.weatherForecaster?.getSatIssueMs?.() ?? null;
        const satLog     = [];
        let satDeltaWh   = 0;
        // Coverage denominator: blend-eligible slots overlapping the current sat lead window
        // that carry any PV signal. Without it, n= has no scale.
        let satWindowSlots = 0;
        let satStaleSlots  = 0;

        const scEffectiveSlots = []; // collect effective SC per slot for chart transparency
        pvForecast = pvForecast.map(slot => {
          const slotMs = new Date(slot.timestamp).getTime();
          const dayKey = _amsDayKeyFormatter.format(new Date(slot.timestamp));
          const { wOM, wSC } = dayKey === todayNLDate ? weightsToday : weightsTomorrow;

          const scSlots = solcastByHourMs.get(slotMs);
          let blendedW;
          if (scSlots?.p50?.length > 0) {
            const scP50 = Math.round(scSlots.p50.reduce((a, b) => a + b, 0) / scSlots.p50.length);
            const scP10 = Math.round(scSlots.p10.reduce((a, b) => a + b, 0) / scSlots.p10.length);
            // Hourly slot overlaps the lead window when it ends after the issue and starts
            // before issue+3h — the current, partly-elapsed hour counts.
            if (satIssueMs != null && slotMs + 3600_000 > satIssueMs && slotMs < satIssueMs + SAT_LEAD_MS
                && (slot.pvPowerW > 0 || slot.satPanelW != null)) satWindowSlots++;
            const satAgeOk = typeof slot.satIssueMs === 'number' && (Date.now() - slot.satIssueMs) <= SAT_MAX_AGE_MS;
            if (!satAgeOk && slot.satPanelW != null) satStaleSlots++;
            const satW  = (satAgeOk && typeof slot.satPanelW === 'number')
              ? (pvCapacityW > 0 ? Math.min(slot.satPanelW, pvCapacityW) : slot.satPanelW)
              : null;
            const base  = { omW: slot.pvPowerW, scP50, scP10, wOM, wSC, unbiased: unbiasedBlend };
            let r;
            if (satW == null) {
              r = BatteryPolicyDevice._blendOmScSlot(base);
            } else {
              // Shadow: score both legs every run so the swap is measurable before the
              // toggle flips, and stays measurable after it.
              const rSc  = BatteryPolicyDevice._blendOmScSlot(base);
              const rSat = BatteryPolicyDevice._blendOmScSlot({ ...base, satW, satActive: true });
              r = satReplSc ? rSat : rSc;
              satDeltaWh += rSat.blendedW - rSc.blendedW;
              satLog.push(`h${new Date(slotMs).getUTCHours()} om=${slot.pvPowerW} sc=${scP50} sat=${satW} blend ${rSc.blendedW}→${rSat.blendedW}W`);
            }
            blendedW = r.blendedW;
            if (byDay[dayKey]) { byDay[dayKey].sc += r.scAvg; if (r.useP10) byDay[dayKey].p10slots = (byDay[dayKey].p10slots ?? 0) + 1; }
            scEffectiveSlots.push({ ts: slot.timestamp, w: r.scAvg, dayKey });
          } else {
            blendedW = slot.pvPowerW;
          }

          if (byDay[dayKey]) { byDay[dayKey].om += slot.pvPowerW; byDay[dayKey].bl += blendedW; }
          return { ...slot, pvPowerW: blendedW };
        });

        // Satellite swap trace. Slots here are hourly, so W sums straight to Wh. The Δ is
        // always sat-leg minus SC-leg regardless of the toggle, and is bounded to the 0-3h
        // lead window — it is NOT a whole-horizon plan delta.
        if (satIssueMs != null) {
          const ageMin = Math.round((Date.now() - satIssueMs) / 60_000);
          this.log(`[SAT-SC] n=${satLog.length}/${satWindowSlots} ΔkWh=${(satDeltaWh / 1000).toFixed(2)} mode=${satReplSc ? 'active' : 'shadow'} satAge=${ageMin}min stale=${satStaleSlots}`);
          if (satLog.length > 0) this.log(`[SAT-SC] ${satLog.join(' | ')}`);
        }

        // Aggregate effective SC to hourly for chart (shows p10 where actually used)
        const scEffByDay = [{}, {}];
        const scEffBuckets = [{}, {}];
        for (const { ts, w, dayKey } of scEffectiveSlots) {
          const dIdx = dayKey === todayNLDate ? 0 : dayKey === tomorrowNLDate ? 1 : -1;
          if (dIdx < 0) continue;
          const hour = parseInt(new Date(ts).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
          if (!scEffBuckets[dIdx][hour]) scEffBuckets[dIdx][hour] = [];
          scEffBuckets[dIdx][hour].push(w);
        }
        for (let d = 0; d < 2; d++) {
          for (const [hour, vals] of Object.entries(scEffBuckets[d])) {
            scEffByDay[d][hour] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
          }
        }
        this._setLive('policy_pv_forecast_sc_effective', scEffByDay);

        const fmt = wh => (wh / 1000).toFixed(1);
        const pct = (v, base) => (base > 0 ? `${v >= base ? '+' : ''}${((v - base) / base * 100).toFixed(0)}%` : '—');
        const td = byDay[todayNLDate], tm = byDay[tomorrowNLDate];
        // Label the SC total honestly: with sat_replaces_sc on, the near-term slots inside it
        // are satellite, not Solcast (byDay.sc sums the leg that was actually blended).
        const scLabel    = satReplSc && satLog.length > 0 ? `SC*sat${satLog.length}` : 'SC';
        const scToday    = td.sc > 0 ? ` ${scLabel}=${fmt(td.sc)}kWh(${pct(td.sc, td.om)})${td.p10slots ? ` p10=${td.p10slots}slots` : ''}` : '';
        const scTomorrow = tm.sc > 0 ? ` SC=${fmt(tm.sc)}kWh(${pct(tm.sc, tm.om)})${tm.p10slots ? ` p10=${tm.p10slots}slots` : ''}` : '';
        const accOM = this.learningEngine?.data?.pv_accuracy_om;
        const accSC = this.learningEngine?.data?.pv_accuracy_sc;
        const accLog = accOM != null && accSC != null ? ` acc: om=${(accOM*100).toFixed(0)}% sc=${(accSC*100).toFixed(0)}%` : ' learning';
        const wTd = weightsToday,    dTd = wTd.div != null    ? ` div=${wTd.div.toFixed(2)}`    : '';
        const wTm = weightsTomorrow, dTm = wTm.div != null    ? ` div=${wTm.div.toFixed(2)}`    : '';
        this.log(`[PV blend] today:    OM=${fmt(td.om)}kWh${scToday} → blended=${fmt(td.bl)}kWh [w_om=${wTd.wOM.toFixed(2)} w_sc=${wTd.wSC.toFixed(2)}${dTd}${accLog}]`);
        this.log(`[PV blend] tomorrow: OM=${fmt(tm.om)}kWh${scTomorrow} → blended=${fmt(tm.bl)}kWh [w_om=${wTm.wOM.toFixed(2)} w_sc=${wTm.wSC.toFixed(2)}${dTm}]`);
        this._logOmTrend();
      } else {
        this._pvForecastSC = null;
      }
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-blend');

    // Compute net PV surplus for next 24h using the blended forecast (post-Solcast).
    // Placed after the blend so Solcast data is included in the terminal value calculation.
    // Uses a rolling 24h window from now — NOT the next calendar day — to avoid
    // a strategy flip at midnight when "tomorrow" jumps to the next calendar date.
    if (pvForecast && inputs.weather) {
      const nowMs = now.getTime();
      const consFn = this.learningEngine
        ? (d) => this.learningEngine.getPredictedConsumption(d)
        : null;
      // Within-horizon refill (flattening / pvAbundant / night-floor guards): rolling 24h from now.
      inputs.weather.pvKwhTomorrow = OptimizationEngine.sumPvNetWindow(
        pvForecast, nowMs, nowMs + 24 * 3600_000, maxChargePowerW, consFn);
      // Post-horizon refill (terminal value only): 24h starting at the end of the priced
      // horizon, so today's PV — already credited in the DP forward pass via pvWPerSlot — is
      // not double-counted into the terminal refill discount. Rolling past the horizon end
      // also avoids the midnight strategy flip the now-window was built to dodge.
      const lastPricedSlotEnd = new Date(prices[prices.length - 1].timestamp).getTime() + slotMs;
      inputs.weather.terminalPvKwh = OptimizationEngine.sumPvNetWindow(
        pvForecast, lastPricedSlotEnd, lastPricedSlotEnd + 24 * 3600_000, maxChargePowerW, consFn);

      // Forward model-spread over the same 24h window: relative std of the per-model
      // ensemble radiation, radiation-weighted (Σstd/Σmean) so disagreement at high-PV
      // slots dominates and dawn/dusk noise barely counts. Feeds the refill-reserve
      // confidence as the only forward-looking uncertainty signal (cv/ratio are
      // backward-looking and miss "clear today, models split about tomorrow").
      let _spreadStdSum = 0, _spreadMeanSum = 0;
      for (const h of inputs.weather.hourlyForecast ?? []) {
        const tMs = (h.time instanceof Date ? h.time : new Date(h.time)).getTime();
        if (tMs <= nowMs || tMs > nowMs + 24 * 3600_000) continue;
        const vals = Object.values(h.perModelWm2 ?? {}).filter(v => typeof v === 'number');
        if (vals.length < 2) continue;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        if (mean < 30) continue; // skip near-dark slots (relative spread is noise there)
        _spreadStdSum += Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
        _spreadMeanSum += mean;
      }
      inputs.weather.pvSpreadTomorrow = _spreadMeanSum > 0
        ? Math.round((_spreadStdSum / _spreadMeanSum) * 100) / 100
        : undefined;
    }

    // Snapshot blended forecast before discounts (used for accuracy tracking below).
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      this._pvForecastBlended   = pvForecast;
      this._pvForecastBlendedAt = Date.now();

      // Snapshot today's blended forecast once at first forecast build of the day (NL timezone).
      // Accuracy tracking compares against this fixed day-start snapshot, not the rolling forecast,
      // to avoid degrading the score when providers revise the forecast mid-day.
      const _pvSnapDate = _amsDayKeyFormatter.format(now);
      if (this._pvDayStartForecastDate !== _pvSnapDate) {
        this._pvDayStartForecast     = pvForecast.map(slot => ({ ...slot }));
        this._pvDayStartForecastDate = _pvSnapDate;
      }
    }

    // PV accuracy tracking: compare forecast for now vs actual from flow card.
    // Only when flow card provides fresh inverter data (< 20 min old) and at least one
    // side shows meaningful PV (> 50W) to avoid noisy night comparisons.
    // Skip at negative prices: users often disable their inverter to avoid export penalty,
    // so actual=0 with forecast>0 would wrongly degrade the PV accuracy score.
    this._recordPvAccuracySample(now, inputs.tariff?.currentPrice ?? null);

    // (Unused since the chart now plots the DP forecast directly — see ~line 2898.
    // Kept as a no-op anchor; the chart source switched away from this pre-bias snapshot
    // because it diverged in shape from the DP series after per-slot corrections.)
    const pvForecastChart = pvForecast ? [...pvForecast] : null;

    const simplified = this.getSetting('pv_correction_simplified') === true;
    let _pvDailyBiasFactor = 1.0;
    let _pvAccFactor = 1.0;
    let _pvBiasCloud = null;
    if (pvForecast && this.learningEngine) {
      const hf = inputs.weather?.hourlyForecast;
      const cloudVals    = Array.isArray(hf) ? hf.map(h => h.cloudCover).filter(v => typeof v === 'number') : [];
      const cloudLowVals = Array.isArray(hf) ? hf.map(h => h.cloudCoverLow).filter(v => typeof v === 'number') : [];
      const todayAvgCloud    = cloudVals.length > 0    ? cloudVals.reduce((a, b) => a + b, 0) / cloudVals.length       : null;
      const todayAvgCloudLow = cloudLowVals.length > 0 ? cloudLowVals.reduce((a, b) => a + b, 0) / cloudLowVals.length : null;
      const effectiveCloud = (todayAvgCloud != null && todayAvgCloudLow != null)
        ? Math.min(100, Math.max(todayAvgCloud, todayAvgCloudLow * 1.2))
        : todayAvgCloud;
      _pvBiasCloud = effectiveCloud;
      const todayKt   = this.weatherForecaster?.getTodayKt() ?? null;
      const dailyBias = this.getSetting('pv_weathertype_bias') === false
        ? 1.0
        : this.learningEngine.getDailyPvBiasFactor(effectiveCloud, todayKt);
      let cappedDailyBias = dailyBias;
      if (dailyBias > 1.0 && effectiveCloud != null && effectiveCloud > 75) {
        const cloudFrac = Math.min(1, (effectiveCloud - 75) / 25);
        cappedDailyBias = Math.max(1.0, 1.0 + (dailyBias - 1.0) * (1 - cloudFrac));
      }
      _pvDailyBiasFactor = cappedDailyBias;

      if (!simplified) {
        // Legacy path: apply dailyBias to ALL slots (today + tomorrow).
        if (cappedDailyBias !== 1.0) {
          pvForecast = pvForecast.map(s => ({ ...s, pvPowerW: Math.round(s.pvPowerW * cappedDailyBias) }));
        }
      } else {
        // Simplified path: dailyBias only on tomorrow's slots (today handled by intradayRatio).
        const todayNL = _amsDayKeyFormatter.format(now);
        if (cappedDailyBias !== 1.0) {
          pvForecast = pvForecast.map(s => {
            const slotDate = _amsDayKeyFormatter.format(new Date(s.timestamp));
            if (slotDate === todayNL) return s;
            return { ...s, pvPowerW: Math.round(s.pvPowerW * cappedDailyBias) };
          });
        }
      }
      const cloudLabel = todayAvgCloud != null ? `, cloud=${todayAvgCloud.toFixed(0)}%` : '';
      const capLabel   = cappedDailyBias !== dailyBias ? ` (capped from ${dailyBias.toFixed(3)})` : '';
      if (cappedDailyBias !== 1.0 || dailyBias !== 1.0) {
        this.log(`[PV daily bias] factor=${cappedDailyBias.toFixed(3)}${simplified ? ' (tomorrow-only)' : ''} applied${cloudLabel}${capLabel}`);
      }
    }

    // PV conservatism: if accuracy score is low, discount pvForecast to avoid over-optimistic planning.
    // Simplified mode skips this — accFactor overlaps with dailyBias and intradayRatio
    // already absorbs the real error for today's slots.
    if (pvForecast && this.learningEngine && !simplified) {
      const pvAcc = this.learningEngine.data?.pv_accuracy_score ?? 1.0;
      const _relBias = this._computePvRelBias();
      const _underForecast = _relBias != null && _relBias > 0.05;
      if (pvAcc < 0.80 && !_underForecast) {
        const factor = Math.max(0.80, 0.80 + 0.20 * (pvAcc / 0.80));
        _pvAccFactor = factor;
        pvForecast = pvForecast.map(s => ({ ...s, pvPowerW: Math.round(s.pvPowerW * factor) }));
        this.log(`[PV accuracy] score=${pvAcc.toFixed(2)} → conservatism factor=${factor.toFixed(2)} applied`);
      } else if (pvAcc < 0.80 && _underForecast) {
        this.log(`[PV accuracy] score=${pvAcc.toFixed(2)} → conservatism discount SKIPPED — forecast running low (relBias +${_relBias.toFixed(2)})`);
      }
    }
    // Cloud uncertainty discount for DP pvCoverage projection: when cloud cover is high,
    // the DP should not rely on uncertain PV recharge to justify early discharge.
    // Kicks in above 70% cloud, reduces pvCoverage by up to 40% at full overcast.
    // KNMI cross-check: OM cloud% can be a false-overcast (see _knmiAwareCloudGate above, same
    // kt≥0.65 bar) — KNMI-clear releases the discount instead of applying it blindly.
    let _pvCloudFactor = 1.0;
    if (_pvBiasCloud != null && _pvBiasCloud > 70) {
      const _todayKtForCloudGate = this.weatherForecaster?.getTodayKt() ?? null;
      const _omOnlyCloudFactor = Math.max(0.6, 1.0 - 0.5 * Math.min(1, (_pvBiasCloud - 70) / 30));
      _pvCloudFactor = BatteryPolicyDevice._pvCloudUncertaintyFactor(_pvBiasCloud, _todayKtForCloudGate);
      if (_pvCloudFactor !== _omOnlyCloudFactor) {
        this.log(`[PV cloud KNMI gate] cloud=${Math.round(_pvBiasCloud)}% kt=${_todayKtForCloudGate != null ? _todayKtForCloudGate.toFixed(2) : 'null'} → applied factor ${_omOnlyCloudFactor.toFixed(2)}→${_pvCloudFactor.toFixed(2)}`);
      }
      this.log(`[PV cloud uncertainty] cloud=${Math.round(_pvBiasCloud)}% → pvCoverageFactor=${_pvCloudFactor.toFixed(2)}`);
    }
    this._setLive('policy_pv_bias', {
      dailyBias: _pvDailyBiasFactor,
      accFactor: _pvAccFactor,
      cloud: _pvBiasCloud != null ? Math.round(_pvBiasCloud) : null,
      cloudFactor: _pvCloudFactor !== 1.0 ? Math.round(_pvCloudFactor * 100) / 100 : null,
      net: Math.round(_pvDailyBiasFactor * _pvAccFactor * 1000) / 1000,
      simplified,
    });
    // Day-level PV correction for chart overlays. In simplified mode, accFactor is not
    // applied (it is redundant with intradayRatio for today, and for tomorrow the daily
    // bias alone is the best available correction).
    this._pvDayCorrectionFactor = simplified ? _pvDailyBiasFactor : _pvDailyBiasFactor * _pvAccFactor;

    // Intraday PV scaling: correct today's remaining forecast from actual production.
    // Uses pv_predictions already tracked by learning engine — no new API calls.
    // Only scales today's future slots; tomorrow's forecast is unchanged.
    if (pvForecast && this.learningEngine && Array.isArray(this.learningEngine.data?.pv_predictions)) {
      const nowMs       = Date.now();
      const cutoffMs    = nowMs - 3 * 3600_000;
      const todayNLDate = _amsDayKeyFormatter.format(now);
      const todayPreds  = this.learningEngine.data.pv_predictions.filter(p =>
        p.timestamp >= cutoffMs && p.timestamp <= nowMs &&
        p.predicted > 50 && p.actual > 50
      );
      const avgActual = todayPreds.length
        ? todayPreds.reduce((s, p) => s + p.actual, 0) / todayPreds.length : 0;
      if (todayPreds.length >= 4 && avgActual >= 200) {
        // Per-sample ratios, winsorised at [0.25, 2.5] — prevents a single spike from
        // dominating the correction (sumActual/sumForecast gave high weight to outliers).
        const WIN_LO = 0.25, WIN_HI = 2.5;
        const sampleRatios = todayPreds.map(p => Math.min(WIN_HI, Math.max(WIN_LO, p.actual / p.predicted)));
        const meanRatio = sampleRatios.reduce((s, r) => s + r, 0) / sampleRatios.length;

        // p.predicted is the pre-bias day-start forecast; pvForecast here is post-bias.
        // In simplified mode, today's slots have no dailyBias/accFactor applied, so
        // biasCorrFactor=1 and meanRatio passes through directly (actual/pre_bias).
        // In legacy mode: ratio_needed = meanRatio / biasCorrFactor to undo the bias.
        const biasCorrFactor = simplified ? 1.0 : _pvDailyBiasFactor * _pvAccFactor;
        const correctedMeanRatio = biasCorrFactor > 0 ? meanRatio / biasCorrFactor : meanRatio;

        // Consistency check: high CV (stddev/mean) means conditions are volatile (e.g. sun spike
        // followed by cloud). Blend toward 1.0 to avoid over-correcting on noisy data.
        const variance  = sampleRatios.reduce((s, r) => s + (r - meanRatio) ** 2, 0) / sampleRatios.length;
        const cv        = Math.sqrt(variance) / meanRatio;
        this._lastPvForecastCv = cv; // persisted for overnight refill-reserve confidence
        this._lastPvForecastRatio = correctedMeanRatio; // residual actual/post-bias → refill-reserve downside
        // CV<0.25 → full correction; CV>0.60 → no correction; linear between.
        const cvWeight  = Math.max(0, Math.min(1, (0.60 - cv) / 0.35));
        // Cloud gate: the recent actual/forecast ratio is usually sampled over a clear morning.
        // The CV guard above can't catch a clear-morning→cloudy-afternoon turn — consistent
        // morning samples give low CV → full correction → the upward ratio re-inflates PV the
        // model already (correctly) lowered for the cloudy afternoon. Damp the upward push as
        // forecast cloud rises (1.0 at ≤70% → 0 at full overcast). KNMI clearness overrides a
        // false-overcast so it doesn't suppress a legitimate upward correction. See
        // _knmiAwareCloudGate. Downward correction is left intact.
        const cloudGate = BatteryPolicyDevice._knmiAwareCloudGate(
          correctedMeanRatio, _pvBiasCloud, this.weatherForecaster?.getTodayKt() ?? null);
        const ratio     = 1.0 + (correctedMeanRatio - 1.0) * cvWeight * cloudGate;

        this._lastIntradayPvRatio = ratio;
        this.setCapabilityValue('bias_factor', parseFloat(ratio.toFixed(2))).catch(this.error);
        if (Math.abs(ratio - 1.0) > 0.10) {
          // Counterfactual isolation (temp instrumentation, remove after 2026-06-19 A/B):
          // sum today's remaining-slot PV BEFORE the intraday ratio (= what naïef om+sc would
          // plan) so the corrector's kWh contribution can be checked against actual yield.
          const todayFuture = pvForecast.filter(s =>
            new Date(s.timestamp) > now &&
            _amsDayKeyFormatter.format(new Date(s.timestamp)) === todayNLDate);
          const futureSlotsCount = todayFuture.length;
          const kwhBefore = todayFuture.reduce((s, sl) => s + sl.pvPowerW, 0) * 0.25 / 1000;
          pvForecast = pvForecast.map(slot => {
            if (new Date(slot.timestamp) <= now) return slot;
            const slotDate = _amsDayKeyFormatter.format(new Date(slot.timestamp));
            if (slotDate !== todayNLDate) return slot;
            return { ...slot, pvPowerW: Math.round(slot.pvPowerW * ratio) };
          });
          const kwhAfter = kwhBefore * ratio;
          const dKwh = kwhAfter - kwhBefore;
          this.log(`[PV intraday] ${todayPreds.length} samples, meanRatio=${meanRatio.toFixed(2)} corrected=${correctedMeanRatio.toFixed(2)} cv=${cv.toFixed(2)} cvWeight=${cvWeight.toFixed(2)} cloudGate=${cloudGate.toFixed(2)} → applied ratio=${ratio.toFixed(2)} to ${futureSlotsCount} slots | today-future PV ${kwhBefore.toFixed(1)}→${kwhAfter.toFixed(1)}kWh (Δ${dKwh >= 0 ? '+' : ''}${dKwh.toFixed(1)})`);
        } else {
          this.log(`[PV intraday] ${todayPreds.length} samples, meanRatio=${meanRatio.toFixed(2)} corrected=${correctedMeanRatio.toFixed(2)} cv=${cv.toFixed(2)} → ratio=${ratio.toFixed(2)} within 10% threshold, no scaling`);
        }
      }
    }

    // Shadow-run: when simplified is OFF, log what the simplified path would produce
    // vs legacy so the delta can be monitored before switching.
    if (pvForecast && !simplified && (_pvDailyBiasFactor !== 1.0 || _pvAccFactor !== 1.0)) {
      const todayNL = _amsDayKeyFormatter.format(now);
      const todayTotalLegacy = pvForecast.filter(s =>
        _amsDayKeyFormatter.format(new Date(s.timestamp)) === todayNL &&
        new Date(s.timestamp) > now
      ).reduce((s, sl) => s + sl.pvPowerW, 0);
      const netLegacy = _pvDailyBiasFactor * _pvAccFactor;
      const netSimplified = 1.0; // simplified skips both for today
      if (netLegacy !== 1.0) {
        const todayTotalSimpl = Math.round(todayTotalLegacy / netLegacy);
        const deltaKwh = (todayTotalSimpl - todayTotalLegacy) * 0.25 / 1000;
        this.log(`[PV simplified shadow] today-future: legacy=${todayTotalLegacy}W simplified=${todayTotalSimpl}W Δ=${deltaKwh >= 0 ? '+' : ''}${deltaKwh.toFixed(2)}kWh (intradayRatio handles correction instead)`);
      }
    }

    // Re-clamp to installed capacity after all upward corrections (dailyBias, intradayRatio
    // can multiply a pvCapacityW-capped slot back above the rated peak).
    if (pvForecast && pvCapacityW > 0) {
      pvForecast = pvForecast.map(s =>
        s.pvPowerW > pvCapacityW ? { ...s, pvPowerW: pvCapacityW } : s
      );
    }

    // Buienradar rain correction: cap near-term PV slots based on precipitation radar.
    // Only applies within the 2-hour Buienradar window; only reduces, never increases.
    // Uses windowed average over ±7.5 min (half a 15-min slot) so adjacent rainy 5-min
    // intervals all contribute rather than a single nearest-neighbour point.
    if (pvForecast && Array.isArray(this.buienradarData) && this.buienradarData.length > 0) {
      const buienradarEndMs = this.buienradarData[this.buienradarData.length - 1].time.getTime();
      const halfSlotMs = 7.5 * 60 * 1000;
      let correctedCount = 0;
      pvForecast = pvForecast.map(slot => {
        const slotMs = new Date(slot.timestamp).getTime();
        if (slotMs > buienradarEndMs) return slot;
        const inWindow = this.buienradarData.filter(b =>
          Math.abs(b.time.getTime() - slotMs) <= halfSlotMs
        );
        const samples = inWindow.length > 0 ? inWindow : [
          this.buienradarData.reduce((a, b) =>
            Math.abs(b.time.getTime() - slotMs) < Math.abs(a.time.getTime() - slotMs) ? b : a
          ),
        ];
        const avgFactor = samples.reduce((s, b) => s + b.factor, 0) / samples.length;
        if (avgFactor >= 1.0) return slot;
        correctedCount++;
        return { ...slot, pvPowerW: Math.round(slot.pvPowerW * avgFactor) };
      });
      if (correctedCount > 0) {
        this.log(`🌧️ Buienradar: PV correctie op ${correctedCount} slots`);
      }
    }

    // OM precipitation: extend rain correction beyond the 2h Buienradar window.
    // OM irradiance already accounts for most cloud effects; _omPrecipFactor adds a
    // conservative residual correction for slots with active precipitation.
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      const buienradarEndMs = (Array.isArray(this.buienradarData) && this.buienradarData.length > 0)
        ? this.buienradarData[this.buienradarData.length - 1].time.getTime()
        : 0;
      let omCorrCount = 0;
      pvForecast = pvForecast.map(slot => {
        const slotMs = new Date(slot.timestamp).getTime();
        if (slotMs <= buienradarEndMs) return slot;
        const factor = WeatherForecaster._omPrecipFactor(slot.precipMmh ?? 0);
        if (factor >= 1.0) return slot;
        omCorrCount++;
        return { ...slot, pvPowerW: Math.round(slot.pvPowerW * factor) };
      });
      if (omCorrCount > 0) {
        this.log(`🌧️ OM precipitatie: PV correctie op ${omCorrCount} slots`);
      }
    }

    // Final cap at the physical inverter ceiling. The intraday ratio (and daily bias) above
    // are upward multipliers — on days where actual PV outruns the forecast the ratio can
    // exceed 2×, pushing slots well over pv_capacity_w (impossible). Cap here, after every
    // scaler and before the DP, chart orange line, and stored forecast consume pvForecast.
    if (Array.isArray(pvForecast) && pvCapacityW > 0) {
      pvForecast = pvForecast.map(s => ({ ...s, pvPowerW: Math.min(s.pvPowerW, pvCapacityW) }));
    }

    // Satellite nowcast: override 0-2h pvForecast with sat-derived panel-W.
    // sat_replaces_sc already swapped the satellite into the Solcast leg of the blend above.
    // Letting this override run too would substitute the satellite twice — the second time
    // over the OM half as well, which the F4 head-to-head does not support (OM ≥ sat).
    const satDpActive = this.getSetting('satellite_dp_active') === true
      && this.getSetting('sat_replaces_sc') !== true;
    if (pvForecast) {
      const _nowMs = Date.now();
      const _SAT_MAX_LEAD_MS = 2 * 3600_000;
      let _satCount = 0;
      pvForecast = pvForecast.map(slot => {
        const slotMs = new Date(slot.timestamp).getTime();
        const lead = slotMs - _nowMs;
        if (lead < -1800_000 || lead >= _SAT_MAX_LEAD_MS) return slot;
        const hSlot = (this.weatherData?.hourlyForecast || []).find(h =>
          (h.time instanceof Date ? h.time.getTime() : new Date(h.time).getTime()) === slotMs);
        if (hSlot?.satPanelW == null) return slot;
        const satPvW = pvCapacityW > 0 ? Math.min(hSlot.satPanelW, pvCapacityW) : hSlot.satPanelW;
        if (!satDpActive) {
          this.log(`[SAT shadow] h=${new Date(slotMs).getUTCHours()} sat=${satPvW}W om=${slot.pvPowerW}W`);
          return slot;
        }
        _satCount++;
        this.log(`[SAT DP] h=${new Date(slotMs).getUTCHours()} sat=${satPvW}W om=${slot.pvPowerW}W`);
        return { ...slot, pvPowerW: satPvW, spreadFrac: 0 };
      });
      if (_satCount > 0) this.log(`[SAT DP] Override ${_satCount} slots (0-2h) with satellite PV`);
      // 4h horizon (was 2h) — matches raw satellite data extent, so dips beyond
      // the 0-2h DP override window (e.g. today's 165-195min front) now log.
      const _satDip = this.weatherForecaster?.getNextSatDip?.(Date.now(), 0.15, maxChargePowerW);
      if (_satDip) this.log(`[SAT DIP] dip in ${_satDip.leadMin}min @ ${new Date(_satDip.dipStartMs).toISOString()} → ${new Date(_satDip.dipEndMs).toISOString()} min=${_satDip.minPanelW}W`);
    }

    // Upwind cloud modulation: clouds at upwind KNMI station → lower pvForecast for lead-time slot.
    // Runs independently of satDpActive (upwind data is always fetched when _satUrl is set).
    {
      const upwind = this._upwindData;
      const nowMs  = Date.now();
      const upMod  = WeatherForecaster.getUpwindModulation(upwind, nowMs);
      if (upMod.active) {
        let _upCount = 0;
        pvForecast = (pvForecast || []).map(slot => {
          const slotMs = new Date(slot.timestamp).getTime();
          if (Math.abs((slotMs - nowMs) - upMod.leadMs) > 1800_000) return slot; // ±30 min window
          const upW = Math.round(slot.pvPowerW * upMod.upwindKt);
          if (upW >= slot.pvPowerW) return slot;           // never raise forecast
          _upCount++;
          this.log(`[Upwind DP] h=${new Date(slotMs).getUTCHours()} kt=${upMod.upwindKt.toFixed(2)} lead=${upMod.leadMin}min → ${upW}W (was ${slot.pvPowerW}W)`);
          return { ...slot, pvPowerW: upW };
        });
        if (_upCount > 0) this.log(`[Upwind DP] ${_upCount} slot(s) modulated, wind=${upwind.thisFf}m/s`);
      }
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-pvcorr');

    // Capture before _dpHourly (future-only) overwrites liveState at line below.
    // The chart aggregator at line ~2869 needs past-hour data (e.g. hour 9) that
    // pvForecast doesn't contain because hourlyForecast only has slots > now.
    const _preExistingPvForecast = this._liveState.policy_pv_forecast_hourly
      ?? this.homey.settings.get('policy_pv_forecast_hourly');

    // NOTE: this future-only write is superseded below (~line 2898) by the past+future
    // merge, which now uses the SAME fully-corrected DP forecast. Both are consistent.
    // Sync chart orange line with the fully-corrected DP forecast (bias+conservatism+coverage applied)
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      const _todayNL    = _amsDayKeyFormatter.format(new Date());
      const _tomorrowNL = _amsDayKeyFormatter.format(new Date(Date.now() + 86_400_000));
      const _dpBuckets  = [{ key: _todayNL, h: {} }, { key: _tomorrowNL, h: {} }];
      for (const slot of pvForecast) {
        const dk = _amsDayKeyFormatter.format(new Date(slot.timestamp));
        const bucket = _dpBuckets.find(b => b.key === dk);
        if (!bucket) continue;
        const hr = parseInt(new Date(slot.timestamp).toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
        if (!bucket.h[hr]) bucket.h[hr] = [];
        bucket.h[hr].push(slot.pvPowerW);
      }
      const _dpHourly = _dpBuckets.map(b => {
        const result = {};
        for (const [hr, vals] of Object.entries(b.h)) {
          result[parseInt(hr)] = Math.round(vals.reduce((a, v) => a + v, 0) / vals.length);
        }
        return result;
      });
      this._setLive('policy_pv_forecast_hourly', _dpHourly);
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-chartsync');

    // Learned round-trip efficiency from efficiencyEstimator
    let learnedRte = this.efficiencyEstimator?.getEfficiency() ?? null;
    if (learnedRte != null && (learnedRte < 0.50 || learnedRte > 0.97)) learnedRte = null;

    // 24h consumption forecast from learning engine, floored by baseload when available.
    // BaseloadMonitor is optional (requires P1 baseload feature to be active).
    const baseloadW = this.homey.app?.baseloadMonitor?.currentBaseload ?? 0;
    let consumptionWPerSlot = null;
    // Prefer explicit Amsterdam hour/minute fields from the price record (both KwhPrice and
    // Xadi provide these via toLocaleString / item.hour). This avoids any UTC/local timestamp
    // parsing ambiguity: if a provider returns Amsterdam-local times without a UTC indicator,
    // _getAmsterdamTime() would shift the hour by +2 (CEST), causing all consumption lookups
    // to land on the wrong slot and return baseload-floor (~314 W) everywhere.
    const hasSlotFields = typeof prices[0]?.hour === 'number' && typeof prices[0]?.minute === 'number';
    if (this.learningEngine) {
      const rawLearned = [];
      const hoursAms = [];
      let nonZeroCount = 0;
      for (let h = 0; h < prices.length; h++) {
        const futureTime = new Date(prices[h].timestamp);
        const learned = hasSlotFields
          ? (this.learningEngine.getPredictedConsumptionForSlot(futureTime, prices[h].hour, prices[h].minute) ?? 0)
          : (this.learningEngine.getPredictedConsumption(futureTime) ?? 0);
        if (learned > 0) nonZeroCount++;
        rawLearned.push(learned);
        // Same Amsterdam hour the accuracy meter buckets on, so the correction lines up with
        // the bucket it came from. _amsHourFormatter is the cached module-level formatter.
        hoursAms.push(hasSlotFields ? prices[h].hour : Number(_amsHourFormatter.format(futureTime)));
      }
      // Only pass consumption data when the learning engine has meaningful data.
      // When nothing is learned yet (all slots return 0), the baseload floor (~300W
      // standby power) would make the optimizer think discharge is always baseload-limited —
      // causing it to plan too little PV charging. With null the optimizer uses
      // maxDischargePowerW (unconstrained 800W), which is the correct conservative assumption.
      if (nonZeroCount > 0) {
        // Floor by baseload: a learned value below the measured baseload is an
        // artefact of averaging quiet evenings — the house always consumes at least
        // baseload, so the optimizer should never plan slower discharge than that.
        const hourly = this.learningEngine.data?.consumption_accuracy_hourly;
        const nightCorrOn = this.getSetting('night_consumption_bias_corr') === true;
        consumptionWPerSlot = BatteryPolicyDevice._buildDpConsumption(
          rawLearned, hoursAms, hourly, baseloadW, nightCorrOn);

        // The accuracy meter must keep scoring the RAW learned profile. It used to read
        // optimizationEngine._schedule.slots[].consumptionW, which is this same array
        // (optimization-engine.js:407) — with the correction applied that would make emaBiasW
        // measure its own output: bias → 0 → correction → 0 → bias back. Stash the uncorrected
        // profile for it instead, keyed the same way the meter looks slots up.
        this._rawConsumptionSlots = prices.map((p, i) => ({
          ms: new Date(p.timestamp).getTime(),
          w: Math.max(rawLearned[i], baseloadW),
        }));

        if (nightCorrOn) {
          const deltas = consumptionWPerSlot.map((v, i) => v - this._rawConsumptionSlots[i].w);
          this._lastNightBiasCorrRange = {
            min: +Math.min(...deltas).toFixed(1),
            max: +Math.max(...deltas).toFixed(1),
          };
        } else {
          this._lastNightBiasCorrRange = null;
        }
      } else {
        this._rawConsumptionSlots = null;
        this._lastNightBiasCorrRange = null;
      }
      this.log(`🔮 Consumption: ${nonZeroCount}/${prices.length} learned slots (hasSlotFields=${hasSlotFields}), sample=[${rawLearned.slice(0,3).map(v=>Math.round(v)).join(',')},...], nonZero=${nonZeroCount}`);
    }

    const slotLabel = slotMs === 900_000 ? '15-min' : '1h';
    this.log(`🔮 Optimizer: recomputing schedule (${prices.length} × ${slotLabel} slots, SoC ${soc}%, ${capacityKwh}kWh, PV ${pvCapacityW}W peak, RTE ${learnedRte != null ? (learnedRte * 100).toFixed(0) + '%' : 'default'})`);
    const respectMinMax = inputs.settings?.respect_minmax !== false;
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
    if (this.learningEngine && pvKwhTomorrow > 0) {
      const tomorrowStr = _amsDayKeyFormatter.format(new Date(Date.now() + 24 * 3600_000));
      this.learningEngine.savePvNetSurplusPrediction(tomorrowStr, pvKwhTomorrow);
    }
    this._lastMinDischargeFixRange = null;
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
      const weakPvFloorBase = Math.max(actualBreakEven + 0.02, 0.115);
      const pvStrongW    = (inputs.battery?.maxChargePowerW || 800) * 0.5; // mirrors pvStrongCoverage=400/800
      const maxSoc       = inputs.settings?.max_soc ?? 95;
      // When battery is at max_soc, PV cannot add more energy — the opportunity-cost
      // reasoning behind dayFloor (PV recharges for free) does not apply.
      const atMaxSoc = soc >= maxSoc;
      // RTE-spread guard: a weak-PV slot is also a candidate grid-charge slot (DP fills for
      // the evening peak). Discharging there is only profitable when the price clears the
      // cost of recharging the same energy later: price ≥ cheapestRefillAhead / RTE.
      // Without it the DP churns (discharge €0.21 → recharge €0.20 = ~27% RTE loss, no arb).
      // Only slots priced BELOW the discharge floor are real grid-recharge candidates —
      // evening/peak slots (all above the floor) carry no rebuy risk and must not be blocked.
      const suffixMinChargePrice = new Array(prices.length);
      let runningMin = Infinity;
      for (let i = prices.length - 1; i >= 0; i--) {
        suffixMinChargePrice[i] = runningMin;
        if (prices[i].price < dayFloor) runningMin = Math.min(runningMin, prices[i].price);
      }
      const oldBranches = new Array(prices.length);
      const perSlotFloorsOld = prices.map((p, i) => {
        const pvW = this.optimizationEngine._getPvForSlot(pvForecast, p.timestamp);
        if (pvW >= pvStrongW && !atMaxSoc) { oldBranches[i] = 'day'; return dayFloor; }
        if (pvW >= 50 || (pvW >= pvStrongW && atMaxSoc)) {
          oldBranches[i] = 'weakPv';
          const refill = suffixMinChargePrice[i];
          const rteFloor = (refill !== Infinity && refill > 0) ? refill / effectiveRte : 0;
          return Math.max(weakPvFloorBase, rteFloor);
        }
        oldBranches[i] = 'night';
        return nightFloor;
      });
      // The line above looks up PV with the raw pvForecast and an ISO timestamp, while
      // _getPvForSlot expects the _buildPvIndex output and epoch ms — so every slot silently
      // gets pvForecast[0] and the whole horizon collapses onto one regime. Shadow the fixed
      // array next to it; `pv_floor_fix`=1 switches the DP over to it.
      const newBranches = new Array(prices.length);
      const perSlotFloorsNew = this.optimizationEngine.buildPerSlotDischargeFloors(prices, pvForecast, {
        dayFloor, nightFloor, weakPvFloorBase, pvStrongW, atMaxSoc, effectiveRte
      }, newBranches);
      const floorFixLive = Number(this.homey.settings.get('pv_floor_fix') || 0) === 1;
      const nDiff = perSlotFloorsOld.reduce((n, v, i) => n + (Math.abs(v - perSlotFloorsNew[i]) > 1e-6 ? 1 : 0), 0);
      const _f = a => `€${Math.min(...a).toFixed(3)}–${Math.max(...a).toFixed(3)}`;
      this.log(`[FLOORFIX] ${floorFixLive ? 'live' : 'shadow'}: ${nDiff}/${prices.length} slots differ | old ${_f(perSlotFloorsOld)} | new ${_f(perSlotFloorsNew)} | pv[0]=${pvForecast[0]?.pvPowerW ?? '?'}W`);
      this._appendFloorFixSample({
        nDiff, nSlots: prices.length, soc,
        oldMin: +Math.min(...perSlotFloorsOld).toFixed(3), oldMax: +Math.max(...perSlotFloorsOld).toFixed(3),
        newMin: +Math.min(...perSlotFloorsNew).toFixed(3), newMax: +Math.max(...perSlotFloorsNew).toFixed(3),
        pv0W: Math.round(pvForecast[0]?.pvPowerW ?? -1),
        oldBranch: [...new Set(oldBranches)].join('+'),
        newBranchCounts: newBranches.reduce((c, b) => { c[b] = (c[b] || 0) + 1; return c; }, {})
      });
      this._lastMinDischargeFixRange = { min: +Math.min(...perSlotFloorsNew).toFixed(3), max: +Math.max(...perSlotFloorsNew).toFixed(3) };
      this.log(`☀️ PV headroom: pvTomorrow=${pvKwhTomorrow}kWh ≥ ${(capacityKwh * 0.9).toFixed(1)}kWh → night floor €${nightFloor}, weak-PV floor ≥€${weakPvFloorBase} (RTE-spread guard: ≥ refillAhead/${effectiveRte.toFixed(2)}), day floor €${dayFloor}${atMaxSoc ? ` (SoC ${soc}%=max → weak-PV floor on PV-strong slots too)` : ''} (pvStrong≥${pvStrongW}W, break-even €${actualBreakEven})`);
      minDischargePrice = floorFixLive ? perSlotFloorsNew : perSlotFloorsOld;
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
        const cv = hasSlotFields
          ? this.learningEngine.getConsumptionCVForSlot(new Date(prices[h].timestamp), prices[h].hour, prices[h].minute)
          : this.learningEngine.getConsumptionCV(new Date(prices[h].timestamp));
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

    // Cheap scalar min/max summaries of the two per-slot arrays feeding compute() — surfaced
    // in policy_last_run_debug so a future discharge-plan flip can be diagnosed from one diag
    // dump instead of a temp full-array log (feedback_dp_instability_debug_workflow: these two
    // arrays turned out to be exactly what a hand-typed repro got wrong last time).
    {
      const _range = v => Array.isArray(v)
        ? { min: +Math.min(...v).toFixed(3), max: +Math.max(...v).toFixed(3) }
        : { min: +v.toFixed(3), max: +v.toFixed(3) };
      this._lastMinDischargePriceRange = _range(minDischargePrice);
      this._lastConsumptionMarginRange = _range(consumptionMargin);
    }

    // When battery was charged at zero or negative cost (avgCost ≤ 0) AND pvKwhTomorrow
    // is stale/missing (=0), assume PV will refill so terminal value doesn't block discharge.
    // Only applies when pvKwhTomorrow is actually 0 — a real forecast must be respected.
    const _avgCost    = inputs.batteryCost?.avgCost ?? null;
    const _costActive = _avgCost !== null && (inputs.batteryCost?.energyKwh ?? 0) >= 0.5;
    const _negativeCharge = _costActive && _avgCost <= 0;
    const effectivePvKwhTomorrow = (_negativeCharge && pvKwhTomorrow === 0)
      ? capacityKwh * 2
      : pvKwhTomorrow;

    const _netFactor = this.learningEngine?.getPvNetSurplusAccuracyFactor() ?? 1.0;
    // Terminal value uses the post-horizon refill window (PV that arrives AFTER the
    // priced horizon ends) so today's PV — already credited in the DP forward pass —
    // is not double-counted into the terminal refill discount.
    const terminalPvKwh = inputs.weather?.terminalPvKwh ?? 0;
    const effectiveTerminalPvKwh = (_negativeCharge && terminalPvKwh === 0)
      ? capacityKwh * 2
      : terminalPvKwh;
    const adjustedTerminalPvKwh = effectiveTerminalPvKwh * _netFactor;

    if (adjustedTerminalPvKwh > 0) {
      // Mirror of optimization-engine terminal normaliser: refillable = min(usable SoC span,
      // overnight-dischargeable). Discharge is firmware-capped at maxDischargePowerW regardless
      // of pack size, so large packs only empty ~dischargeCap×window — not full capacity.
      const REFILL_WINDOW_H = 10; // overnight discharge hours (sunset→sunrise)
      const _ts = this.getSettings();
      const usableSpanKwh = (((_ts.max_soc ?? 100) - (_ts.min_soc ?? 0)) / 100) * capacityKwh;
      const refillableKwh = Math.min(usableSpanKwh, (maxDischargePowerW / 1000) * REFILL_WINDOW_H);
      const pvRefill = refillableKwh > 0 ? Math.min(1, adjustedTerminalPvKwh / refillableKwh) : 0;
      const terminalFactor = pvRefill >= 0.8 ? 0 : Math.max(0, 1 - pvRefill / 0.8);
      const negNote = _negativeCharge ? ` (→ ${effectiveTerminalPvKwh.toFixed(1)}kWh: negatief geladen €${_avgCost.toFixed(3)}, terminal=0)` : '';
      const factorNote = _netFactor !== 1.0 ? ` [netFactor=${_netFactor.toFixed(2)}→adj=${adjustedTerminalPvKwh.toFixed(1)}kWh]` : '';
      this.log(`☀️ Terminal value: pvRefill(post-horizon)=${terminalPvKwh}kWh${factorNote}, refillable=${refillableKwh.toFixed(1)}kWh, pvRefill=${(pvRefill*100).toFixed(0)}% → factor=${terminalFactor.toFixed(2)}${pvRefill >= 0.8 ? ' (ZERO — PV refills battery)' : ''}${negNote}`);
    }
    // Overnight refill-reserve confidence: high CV (volatile PV forecast) → low confidence
    // → hold a SoC buffer overnight. No samples yet (night/cold start) → confidence 1 (no reserve).
    const _pvCv = this._lastPvForecastCv;
    const _pvRatio = this._lastPvForecastRatio;
    const _s = this.getSettings();
    const _usableSpanKwh = (((_s.max_soc ?? 100) - (_s.min_soc ?? 0)) / 100) * capacityKwh;
    // Same-day forecast accuracy (cv/ratio) spikes on low-light sample noise every sunset
    // and ignores tomorrow's actual forecast. Pass tomorrow's within-horizon PV surplus so
    // an abundant forecast lifts confidence and waives a reserve that guards a vanished risk.
    const _cvConf = OptimizationEngine.refillConfidenceFromForecast(_pvCv, _pvRatio);
    const _pvSpread = inputs.weather?.pvSpreadTomorrow;
    const rawRefillConfidence = OptimizationEngine.refillConfidenceFromForecast(_pvCv, _pvRatio, pvKwhTomorrow, _usableSpanKwh, _pvSpread);
    const refillConfidence = this._applyRefillConfidenceDeadband(rawRefillConfidence);
    this._lastRefillConfidence = refillConfidence; // surfaced to explainability (why battery holds reserve)
    const _ratioNote = typeof _pvRatio === 'number' && _pvRatio < 1 ? ` ratio=${_pvRatio.toFixed(2)}` : '';
    const _cvStr = typeof _pvCv === 'number' ? _pvCv.toFixed(2) : 'n/a';
    const _spreadNote = typeof _pvSpread === 'number' ? ` spread=${_pvSpread.toFixed(2)}` : '';
    const _confNote = rawRefillConfidence !== refillConfidence ? ` raw-conf=${rawRefillConfidence.toFixed(2)}→applied-conf=${refillConfidence.toFixed(2)}` : ` conf=${refillConfidence.toFixed(2)}`;
    if (refillConfidence < 1.0) {
      const floorAddPct = (1 - refillConfidence) * 0.5 * ((_s.max_soc ?? 100) - (_s.min_soc ?? 0));
      this._lastReserveFloorPct = (_s.min_soc ?? 0) + floorAddPct;
      this.log(`🛡️ refill-reserve: cv=${_cvStr}${_ratioNote}${_spreadNote} pvTomorrow=${pvKwhTomorrow.toFixed(1)}/${_usableSpanKwh.toFixed(1)}kWh${_confNote} → overnight floor +${floorAddPct.toFixed(0)}% (until next strong-PV refill)`);
    } else {
      this._lastReserveFloorPct = (_s.min_soc ?? 0);
      if (_cvConf < 1.0) {
        this.log(`🛡️ refill-reserve WAIVED: tomorrow PV (${pvKwhTomorrow.toFixed(1)}/${_usableSpanKwh.toFixed(1)}kWh) refills usable span → no overnight floor despite cv=${_cvStr}`);
      }
    }
    // Dynamic-or-static ceiling (Math.max of both, policy-engine.js:25-66) — matches what
    // the mapper/explainability already use everywhere (chunk 2, project_stability_focus_chunkplan).
    // Only ever raises the ceiling vs the static setting, so the DP's drain-avoidance/topup
    // checks (optimization-engine.js:423-436, :787) become more permissive, never stricter.
    const maxChargePrice = this.policyEngine._getDynamicChargePrice(inputs.tariff, inputs.tariff?.currentPrice);
    // Spread-band (pvTimingRobust) retired 2026-07-04: unmeasured (pv_predictions.csv is blind to
    // a discharge-cap-only change) and inert live; dropped to reduce DP-stack complexity. Pass
    // false — the optimization-engine helper stays as dead-but-tested code (inv20/21).
    //
    // The 2026-07-06 shadow-diag that re-measured this (dual compute(), Δ projectedProfit ON-vs-OFF,
    // spreadband_shadow_stats counters) was removed 2026-07-16: its metric could not produce a
    // negative result. The band only lowers pvWForDischarge, which feeds nothing but the
    // effectiveDischargePowerW cap (optimization-engine.js:797) — lower PV there means a weakly
    // higher cap, i.e. pure constraint relaxation on an otherwise identical objective, so
    // projectedProfit_ON >= projectedProfit_OFF holds by construction. The observed 201:0
    // positive:negative split over 1060 runs was therefore a tautology, not evidence. Do not
    // re-measure this way; score both plans against realised PV instead. See
    // project_dp_pv_timing_robustness + feedback_metric_must_allow_negative.
    // [DP-INPUT-DUMP] Exact compute() arguments, log-only, for offline replay. The 2026-07-10
    // minDischargePrice scalar-vs-array bug was invisible in every derived log line and only fell
    // out of replaying the REAL arguments — param SHAPE, not just value, can flip the decision.
    // Gated on app setting `dp_input_dump` (default off) and self-limiting: it clears the setting
    // after `dumpsLeft` runs so it can never sit on in a shipped build. Set it to the number of
    // runs you want captured (e.g. 3 to straddle an hour boundary).
    const _dumpsLeft = Number(this.homey.settings.get('dp_input_dump') || 0);
    if (_dumpsLeft > 0) {
      const _file = this._writeDpInputDump({
        at: new Date().toISOString(), soc, capacityKwh, maxChargePowerW, maxDischargePowerW,
        learnedRte, minDischargePrice, consumptionMargin, effectivePvKwhTomorrow,
        adjustedTerminalPvKwh, pvCloudFactor: _pvCloudFactor, refillConfidence, maxChargePrice,
        prices, pvForecast, consumptionWPerSlot,
      });
      // Log the pointer, not the payload: the file is the artefact, the line only says where.
      if (_file) this.log(`[DP-INPUT-DUMP] wrote ${_file} (${_dumpsLeft - 1} left)`);
      this.homey.settings.set('dp_input_dump', _dumpsLeft - 1);
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:before-dp');
    this.optimizationEngine.compute(prices, soc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin, effectivePvKwhTomorrow, adjustedTerminalPvKwh, _pvCloudFactor, refillConfidence, false, maxChargePrice);
    this.homey.app.logMem?.('[BatteryPolicy] opt:after-dp');

    // Morning-waive shadow (log-only, project_morning_reserve_floor_holds_through_peak). When the
    // refill-reserve floor is active (refillConfidence < 1.0), re-run the DP with the floor OFF
    // (refillConfidence=1.0) on a SEPARATE engine so the live _schedule/_reorderDebug/_flattenDebug
    // stay untouched, and log a two-sided metric of whether the floor held morning kWh the midday PV
    // refills anyway. Gated: conf=1.0 → ON≡OFF → skip (no CPU). Does NOT affect the live plan.
    if (refillConfidence < 1.0) {
      try {
        if (!this._morningWaiveEngine) this._morningWaiveEngine = new OptimizationEngine(this.getSettings());
        this._morningWaiveEngine.compute(prices, soc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin, effectivePvKwhTomorrow, adjustedTerminalPvKwh, _pvCloudFactor, 1.0, false, maxChargePrice);
        const m = this._morningWaiveShadowMetrics(
          this.optimizationEngine._schedule?.slots, this._morningWaiveEngine._schedule?.slots, capacityKwh);
        if (m) {
          this.log(`🔬 morning-waive: conf=${refillConfidence.toFixed(2)} floor=${Math.round(this._lastReserveFloorPct ?? 0)}% held=${m.heldKwh.toFixed(2)}kWh bothMax=${m.bothReachMax ? 'Y' : 'N'} offEvening=${m.offServesEvening ? 'Y' : 'N'} eurStake=${m.eurAtStake >= 0 ? '+' : ''}${m.eurAtStake.toFixed(3)}`);
        }
      } catch (err) {
        this.error('morning-waive shadow failed', err);
      }
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-shadow');

    // Near-floor chatter catcher (log-only, project_soc_near_floor_chatter_0723). When SoC sits just
    // above the refill-reserve floor and the DP's slot[0] action FLIPS between two ADJACENT runs at
    // (near-)flat price, persist the FULL compute() input arrays of BOTH runs so the mech1 (near-floor
    // budget-tilt) vs mech2 (per-slot PV-array shift) question can be settled from faithful data. The
    // 07-23 window was unrecoverable because policy_mode_history stores only scalars. Gated hard
    // (near-floor band + slot0 flip) so it fires almost never; no behaviour change on the live plan.
    try {
      const _floorPct = this._lastReserveFloorPct ?? null;
      // Require an ACTIVE floor: with floorPct=0 the band degenerates to "SoC <= 3%", which caught
      // ordinary near-empty runs that have nothing to do with the reserve floor (2026-07-29) and
      // evicted real catches from the 4-deep ring. Every catch of interest so far had a live floor
      // (2026-07-26: 20%/16%, 2026-07-25 night: 38%), so this loses nothing.
      if (_floorPct > 0 && soc <= _floorPct + 3) {
        const _r4 = a => Array.isArray(a) ? a.map(x => +(+x).toFixed(4)) : +(+a).toFixed(4);
        const _r0 = a => Array.isArray(a) ? a.map(x => Math.round(x)) : Math.round(a);
        const _ts = t => (t == null ? null : new Date(t).toISOString());
        const _slot0 = this.optimizationEngine._schedule?.slots?.[0]?.action ?? null;
        const _now = Date.now();
        const _snap = {
          ts: new Date(_now).toISOString(),
          soc, floorPct: _floorPct,
          refillConfidence: +refillConfidence.toFixed(3),
          maxChargePrice: +maxChargePrice.toFixed(4),
          effectivePvKwhTomorrow: +effectivePvKwhTomorrow.toFixed(2),
          adjustedTerminalPvKwh: +adjustedTerminalPvKwh.toFixed(2),
          pvCloudFactor: +(_pvCloudFactor ?? 1).toFixed(3),
          dpAction0: _slot0,
          // prices[] and pvForecast[] are arrays of OBJECTS ({price,timestamp,exportPrice} /
          // {timestamp,pvPowerW}), not numbers — rounding them directly yielded NaN → JSON null,
          // which made every catch before 2026-07-29 useless. Project to the scalar the DP uses and
          // keep one anchor timestamp per array so runs with a different horizon start can be aligned.
          pricesTs0: _ts(prices?.[0]?.timestamp),
          pvForecastTs0: _ts(pvForecast?.[0]?.timestamp),
          prices: _r4((prices ?? []).map(p => p.price)),
          pvForecast: _r0((pvForecast ?? []).map(p => p.pvPowerW)),
          consumptionWPerSlot: _r0(consumptionWPerSlot),
          minDischargePrice: _r4(minDischargePrice),
          consumptionMargin: _r4(consumptionMargin),
        };
        const _prev = this._nearFloorPrevSnap;
        // Pair only with a genuinely adjacent run (<30min old) whose slot0 differs = the flip.
        if (_prev && _prev.dpAction0 !== _slot0 && (_now - Date.parse(_prev.ts)) <= 30 * 60_000) {
          // Seed from the PERSISTED setting, not only from _liveState: _liveState is in-memory and
          // resets on restart, so a restart used to silently drop every catch collected so far
          // (8 catches from the 2026-07-26 near-floor window were lost that way).
          const _persisted = this.homey.settings.get('nearfloor_chatter_catch');
          const _ring = Array.isArray(this._liveState?.nearfloor_chatter_catch)
            ? this._liveState.nearfloor_chatter_catch
            : (Array.isArray(_persisted) ? _persisted : []);
          _ring.unshift({ prev: _prev, cur: _snap });
          this._setLive('nearfloor_chatter_catch', _ring.slice(0, 4));
          this.log(`🎯 nearfloor-chatter caught: ${_prev.dpAction0}→${_slot0} @SoC ${soc}% floor ${_floorPct}% price €${_snap.prices[0]} (pair persisted)`);
        }
        this._nearFloorPrevSnap = _snap;
      } else {
        this._nearFloorPrevSnap = null; // reset once out of the near-floor band
      }
    } catch (err) {
      this.error('nearfloor-chatter catcher failed', err);
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-catcher');

    // Compact planning summary — always visible in user diagnostics.
    {
      const _slots = this.optimizationEngine._schedule?.slots ?? [];
      const _cnt   = { charge: 0, discharge: 0, preserve: 0, standby: 0, trickle: 0 };
      let _socMin = 100, _socMax = 0;
      // Next-12h discharge count, separate from the full-horizon total: cheap, always-on
      // signal to spot a "discharge tonight silently dropped to 0" flip between two runs
      // without needing a temp per-incident diagnostic dump + restart (feedback_dp_instability_debug_workflow).
      const _next12hCutoff = Date.now() + 12 * 3_600_000;
      let _dischargeNext12h = 0;
      for (const s of _slots) {
        if (_cnt[s.action] !== undefined) _cnt[s.action]++;
        if (s.socProjected != null) { _socMin = Math.min(_socMin, s.socProjected); _socMax = Math.max(_socMax, s.socProjected); }
        if (s.action === 'discharge' && new Date(s.timestamp).getTime() <= _next12hCutoff) _dischargeNext12h++;
      }
      const _profit = this.optimizationEngine._schedule?.todayProjectedProfit ?? this.optimizationEngine._schedule?.projectedProfit ?? 0;
      this.log(`📋 Plan: ${_slots.length} slots | charge=${_cnt.charge} discharge=${_cnt.discharge} (next12h=${_dischargeNext12h}) preserve=${_cnt.preserve} standby=${_cnt.standby} trickle=${_cnt.trickle} | SoC ${soc}%→min${_socMin}%→max${_socMax}% | profit €${_profit.toFixed(3)} | refillConf=${refillConfidence.toFixed(2)}`);
      this.setCapabilityValue('policy_profit_eur', parseFloat(_profit.toFixed(2))).catch(this.error);
      if (this._morningPlannedProfit == null) {
        const h = parseInt(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
        if (h >= 6 && h <= 10) {
          this._morningPlannedProfit = parseFloat(_profit.toFixed(3));
          this.log(`📅 Morning planned profit captured: €${this._morningPlannedProfit.toFixed(3)}`);
        }
      }
      this.setCapabilityValue('plan_summary', `${_cnt.charge}↑ ${_cnt.discharge}↓ ${_cnt.preserve}=`).catch(this.error);
    }

    // Plan-accuracy: forecast vs actual over last 24h (96 slots). bias = actual − forecast
    // (positive = under-forecast). Observe-only; not yet fed back into confidence.
    {
      const _hist = this._readModeHistory(96);
      const _fmt = m => `MAE ${m.mae}W bias ${m.bias > 0 ? '+' : ''}${m.bias}W (n${m.n})`;
      // F3: pv=OM, sat=live satellite nowcast, sc=Solcast p50, co=consumption — all vs the same
      // actual, so sat-vs-SC ranking is fair. Sat/SC are sparse (sat only fills 0-2h slots) and
      // show only when ≥4 samples accumulate. Shadow-only; not fed to the DP.
      const { pv: _pv, sat: _sat, sc: _sc, co: _co } = this._planAccuracyStats(_hist);
      // Daytime-masked relative PV bias (positive = under-forecast). Now also gates the
      // conservatism discount upstream (see _computePvRelBias / [PV accuracy] block).
      const _pvRelBias = this._computePvRelBias();
      if (_pv || _co) {
        const _rb = _pvRelBias != null ? ` relBias ${_pvRelBias > 0 ? '+' : ''}${_pvRelBias.toFixed(2)}` : '';
        const _satS = _sat ? ` | SAT ${_fmt(_sat)}` : '';
        const _scS  = _sc  ? ` | SC ${_fmt(_sc)}`  : '';
        this.log(`🎯 Plan-accuracy 24h: PV ${_pv ? _fmt(_pv) : 'n/a'}${_rb}${_satS}${_scS} | verbruik ${_co ? _fmt(_co) : 'n/a'}`);
      }
    }

    this.homey.app.logMem?.('[BatteryPolicy] opt:after-summary');

    // Persist planning schedule for the settings UI (single source of truth).
    // Frontend reads 'policy_optimizer_schedule' and renders it directly. The SoC line
    // in it is the DP's own socProjected, except on slots flagged socOverride, where
    // the planning mapper overrode the DP action and buildPlanningSchedule re-simulated.
    // _recomputeOptimizer runs before policyEngine.evaluate(), so dynamicMaxChargePrice is not
    // yet set on inputs — reuse the value already computed above for optimizer.compute(),
    // same tariff/price inputs so recomputing would give an identical result anyway.
    if (!inputs.dynamicMaxChargePrice) {
      inputs.dynamicMaxChargePrice = maxChargePrice;
    }
    const slots = this.optimizationEngine._schedule?.slots;
    if (slots?.length > 0) {
      const planningSchedule = this.policyEngine.buildPlanningSchedule(
        slots,
        pvForecast ?? null,
        minDischargePrice,
        maxChargePowerW,
        inputs.dynamicMaxChargePrice ?? null,
        inputs.battery?.totalCapacityKwh ?? null,
        effectivePvKwhTomorrow,
        refillConfidence
      );
      // Enrich with consumption sample count for confidence display in the UI
      if (this.learningEngine) {
        for (const slot of planningSchedule) {
          slot.sampleCount = this.learningEngine.getConsumptionSampleCount(new Date(slot.timestamp));
        }
      }
      this._setLive('policy_optimizer_schedule', planningSchedule);

      // ── Shadow: € value of the grid top-up the DP declined ─────────────────
      // Log-only, no behaviour change. This is the measurement the 2026-07-05 decision asked for
      // ("first just LOG, then decide whether it is worth the DP complexity") and that was never
      // built — the question then came back on 07-10 and 07-24 and got answered off the code each
      // time, with no data. One entry per Amsterdam day, overwritten with the latest estimate.
      // Exit condition lives in project_running_experiments_tracker.md, not here.
      try {
        const _tmMaxSoc = this.getSettings().max_soc ?? 100;
        const _tm = this._topupMissMetrics(
          slots, capacityKwh, learnedRte ?? 0.75,
          this.optimizationEngine.cycleCostPerKwh ?? 0.075, _tmMaxSoc,
        );
        if (_tm) {
          const _day = _amsDayKeyFormatter.format(new Date());
          // Seed from the PERSISTED setting, not only from _liveState: _liveState is in-memory and
          // resets on restart, which is exactly how the nearfloor ring silently lost its catches
          // before c4acba6.
          const _persisted = this.homey.settings.get('topup_miss_samples');
          const _ring = Array.isArray(this._liveState?.topup_miss_samples)
            ? this._liveState.topup_miss_samples
            : (Array.isArray(_persisted) ? _persisted : []);
          const _today = _ring.find(e => e.day === _day);
          let _runs = 1;
          if (_today) {
            // Keep the first estimate of the day alongside the latest, so intraday drift stays
            // visible without writing 96 entries per day.
            _runs = (_today.nRuns ?? 1) + 1;
            const _first = _today.firstValueEur ?? _tm.valueEur;
            Object.assign(_today, _tm, { day: _day, nRuns: _runs, firstValueEur: _first });
          } else {
            _ring.unshift({ day: _day, nRuns: 1, firstValueEur: _tm.valueEur, ..._tm });
          }
          this._setLive('topup_miss_samples', _ring.slice(0, 14));
          const _hhmm = t => new Date(t).toLocaleTimeString('en-GB', {
            timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false,
          });
          const _sgn = n => (n >= 0 ? '+' : '') + n.toFixed(3);
          this.log(`[TOPUP-MISS] ${_day} pvEnd=${_hhmm(_tm.pvEndTs)} soc=${_tm.socAtEnd.toFixed(0)}% `
            + `headroom=${_tm.headroomKwh.toFixed(2)}kWh | buy=${_tm.buy.toFixed(3)}@${_hhmm(_tm.buyTs)} `
            + `eveMax=${_tm.eveMax.toFixed(3)}@${_hhmm(_tm.eveTs)} rte=${_tm.rte.toFixed(3)} `
            + `cyc=${_tm.cycleCostKwh.toFixed(3)} | margin=${_sgn(_tm.marginPerKwh)}/kWh `
            + `value=${_sgn(_tm.valueEur)} | cov pv=${_tm.covPv}/${_tm.nSlots} `
            + `cons=${_tm.covCons}/${_tm.nSlots} runs=${_runs}`);
        }
      } catch (err) {
        this.error('topup-miss shadow failed', err);
      }

      // ── PV surplus forecast ────────────────────────────────────────────────
      // Use mapped hwModes (not raw DP actions) so mapper overrides like standby→to_full
      // are counted correctly. Filter: hwModes that actually charge the battery from PV.
      if (pvForecast && consumptionWPerSlot) {
        // Split surplus + DP-projected peak SoC by Amsterdam calendar day (today vs tomorrow).
        // socMax follows the DP schedule, so the UI matches what the optimizer plans on every
        // slot the planning mapper agreed with. On socOverride slots the mapper contradicted
        // the DP action and ps.socProjected is a re-simulated value — those are the only slots
        // where this peak can still diverge, and [PLANTILE] reports how many there were.
        const _nlDate  = ts => _amsDayKeyFormatter.format(new Date(ts));
        const todayNL  = _amsDayKeyFormatter.format(new Date());
        let netPvTodayKwh = 0, netPvTomorrowKwh = 0;
        let socMaxToday = soc, socMaxTomorrow = null;
        for (let i = 0; i < planningSchedule.length; i++) {
          const ps = planningSchedule[i];
          const isToday = _nlDate(ps.timestamp) === todayNL;
          const hwm = ps.hwMode;
          if (hwm === 'zero_charge_only' || hwm === 'pv_trickle' || hwm === 'to_full') {
            const nextSoc = planningSchedule[i + 1]?.socProjected ?? ps.socProjected;
            const sv = Math.max(0, nextSoc - ps.socProjected) / 100 * capacityKwh;
            if (isToday) netPvTodayKwh += sv; else netPvTomorrowKwh += sv;
          }
          if (ps.socProjected != null) {
            if (isToday) socMaxToday = Math.max(socMaxToday, ps.socProjected);
            else socMaxTomorrow = Math.max(socMaxTomorrow ?? 0, ps.socProjected);
          }
        }
        const remainingKwh = Math.max(0, (1 - soc / 100) * capacityKwh);
        const _gridToday    = planningSchedule.filter(s => s.hwMode === 'to_full' && _nlDate(s.timestamp) === todayNL).length;
        const _gridTomorrow = planningSchedule.filter(s => s.hwMode === 'to_full' && _nlDate(s.timestamp) !== todayNL).length;
        this.log(`☀️ PV-surplus: vandaag ${netPvTodayKwh.toFixed(2)}kWh→SoC≤${Math.round(socMaxToday)}% | morgen ${netPvTomorrowKwh.toFixed(2)}kWh→SoC≤${socMaxTomorrow != null ? Math.round(socMaxTomorrow) : '—'}% (rest ${remainingKwh.toFixed(1)}kWh, SoC ${soc}%)`);
        this._setLive('pv_surplus_forecast', {
          today:    { netPvKwh: Math.round(netPvTodayKwh * 100) / 100,    socMax: Math.round(socMaxToday),                              chargeSlots: _gridToday },
          tomorrow: { netPvKwh: Math.round(netPvTomorrowKwh * 100) / 100, socMax: socMaxTomorrow != null ? Math.round(socMaxTomorrow) : null, chargeSlots: _gridTomorrow },
          remainingKwh: Math.round(remainingKwh * 100) / 100,
          soc,
          updatedAt:    new Date().toISOString(),
        });
      }

      // Sync PV chart from the SAME forecast the DP planned on (bias + intraday + rain/
      // precip corrections all applied) — single source of truth, no chart/DP divergence.
      {
        const pvFcByDay      = BatteryPolicyDevice._buildPvChartByDay(_preExistingPvForecast, pvForecast, pvCapacityW, new Date());
        const _chartTodayKwh = Object.values(pvFcByDay[0]).reduce((s, w) => s + (w || 0), 0) / 1000;
        const _chartTomKwh  = Object.values(pvFcByDay[1]).reduce((s, w) => s + (w || 0), 0) / 1000;
        this.log(`[PV chart] DP forecast stored: vandaag ${_chartTodayKwh.toFixed(1)} kWh, morgen ${_chartTomKwh.toFixed(1)} kWh`);
        this._setLive('policy_pv_forecast_hourly', pvFcByDay);
      }

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

        // Cache key: prices only change on the hour, soc rounded to 5% to avoid
        // rerunning 4× DP on every minor SoC fluctuation between policy checks.
        const expansionKey = `${prices.length}_${prices[0]?.timestamp}_${prices.at(-1)?.timestamp}`
          + `_${Math.round(soc / 5) * 5}_${Math.round(pvKwhTomorrow * 10)}`;

        let scenarios;
        if (this._expansionCache?.key === expansionKey) {
          scenarios = this._expansionCache.scenarios;
        } else {
          scenarios = [];
          for (let n = 1; n <= 4; n++) {
            const kwh    = +(n * KWH_PER_UNIT).toFixed(3);
            const powerW = n * W_PER_UNIT;

            const result = this.optimizationEngine.computeExpectedProfit(
              prices, soc, kwh, powerW, powerW,
              pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin, pvKwhTomorrow
            );
            // profitFromEmpty, not profit: the raw DP value credits the charge already in
            // the battery at t=0, which scales with pack size and so inflates every larger
            // scenario in this comparison.
            const profit = +result.profitFromEmpty.toFixed(4);
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
          this._expansionCache = { key: expansionKey, scenarios };
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
   * OM-standalone forecast-quality tracker (observe-only). Logs OM/SC/blend same-slot
   * MAE+bias and the MAE-optimal OM weight from the pv_predictions buffer (midday actual
   * >300W), over the full buffer and the last 50 samples. OM's MAE is independent of the
   * fixed 50/50 blend weight, so this surfaces whether OM-the-forecast is actually
   * improving and whether its optimal weight is earning >0.50 (→ revisit the blend).
   */
  _logOmTrend() {
    const buf = this.learningEngine?.data?.pv_predictions;
    if (!Array.isArray(buf)) return;
    const stat = (rows, fn) => {
      let ae = 0, se = 0;
      for (const r of rows) { const e = fn(r) - r.actual; ae += Math.abs(e); se += e; }
      return { mae: Math.round(ae / rows.length), bias: Math.round(se / rows.length) };
    };
    const optW = (rows) => {
      let bw = 0.5, bm = Infinity;
      for (let w = 0; w <= 1.0001; w += 0.05) {
        let ae = 0;
        for (const r of rows) ae += Math.abs(w * r.om + (1 - w) * r.sc - r.actual);
        if (ae < bm) { bm = ae; bw = w; }
      }
      return bw;
    };
    const all = buf.filter(r => typeof r.actual === 'number' && r.actual > 300
      && typeof r.om === 'number' && typeof r.sc === 'number');
    if (all.length < 20) { this.log(`[OM trend] n=${all.length} midday samples (<20, need more)`); return; }
    const line = (lbl, rows) => {
      const o = stat(rows, r => r.om), s = stat(rows, r => r.sc), b = stat(rows, r => r.predicted);
      return `${lbl} n=${rows.length} OM=${o.mae}/${o.bias} SC=${s.mae}/${s.bias} blend=${b.mae}/${b.bias} optW_om=${optW(rows).toFixed(2)}`;
    };
    this.log(`[OM trend] ${line('all', all)} | ${line('last50', all.slice(-50))} (MAE/bias W; OM standalone, independent of fixed 50/50)`);
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

    // SAT yield-factor learning: independent of forecast-accuracy gates (no 100W floor).
    // SAT data lags ~30-60 min; scan back up to 8 buckets for most recent available reading.
    // Dedup on the SAT bucket timestamp (not now) so each SAT bucket is sampled once.
    if (this.weatherForecaster && this.learningEngine) {
      const nowMs = Date.now();
      const nowBucket = Math.floor(nowMs / 900_000) * 900_000;
      let satGhiWm2 = null, satLookupMs = null;
      for (let i = 1; i <= 8; i++) {
        const t = nowBucket - i * 900_000;
        const v = this.weatherForecaster.getSatGhiAt?.(t) ?? null;
        if (v != null) { satGhiWm2 = v; satLookupMs = t; break; }
      }
      if (satGhiWm2 != null && satGhiWm2 > 0 && satLookupMs !== this._lastSatYfBucket) {
        this._lastSatYfBucket = satLookupMs;
        // Train the yield-factor EMA against the panel-plane GHI (same gtiOverGhi
        // transposition the scoring/chart legs use), not raw horizontal GHI — otherwise
        // the learned factor has to blindly absorb the east-tilt geometry too.
        const satHourMs = satLookupMs - (satLookupMs % 3_600_000);
        const satHourSlot = this.weatherData?.hourlyForecast?.find(h => h.time.getTime() === satHourMs);
        const satPanelGhi = typeof satHourSlot?.gtiOverGhi === 'number' && satHourSlot.gtiOverGhi > 0
          ? satGhiWm2 * satHourSlot.gtiOverGhi
          : satGhiWm2;
        this.learningEngine.recordSatYield(new Date(satLookupMs).getUTCHours(), satPanelGhi, powerW);
      }
    }

    // Record PV forecast accuracy from live PV updates too, not only during policy runs.
    // Samples are deduplicated per 15-minute bucket.
    this._recordPvAccuracySample(new Date(), this._lastTariffInfo?.currentPrice ?? null);

    // Accumulate actual PV per Amsterdam hour for planning chart display.
    const nowAms = new Date();
    const todayStr = _amsDayKeyFormatter.format(nowAms);
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
        if (this._pvActualHourly && this.learningEngine) {
          const yDate = new Date(Date.now() - 24 * 3600_000);
          let actualNetKwh = 0;
          for (let h = 0; h < 24; h++) {
            const pvW = this._pvActualHourly.hourly[h] ?? 0;
            if (pvW <= 0) continue;
            const slotDate = new Date(yDate);
            slotDate.setHours(h, 0, 0, 0);
            const consW = this.learningEngine.getPredictedConsumption(slotDate) ?? 0;
            actualNetKwh += Math.max(0, pvW - consW) / 1000;
          }
          this.learningEngine.settlePvNetSurplusAccuracy(this._pvActualHourly.date, actualNetKwh);
        }
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

  // Single source of truth for overlay-forecast correction (the OM/satellite chart
  // lines AND the accuracy-chart corrected values). daily-bias always applies; the
  // intraday ratio is a today-specific actual-vs-forecast scaling for REMAINING hours
  // only — it must never retroactively inflate already-realised past hours. Both call
  // sites (_scaleChartFc for the webcam, recordPvAccuracy chartW for the diag chart)
  // route through here so the two surfaces cannot silently diverge.
  _correctOverlayW(w, applyIntraday) {
    if (w == null) return null;
    const dayCorr  = this._pvDayCorrectionFactor ?? 1.0;
    const intraday = this._lastIntradayPvRatio ?? 1.0;
    const f = applyIntraday ? dayCorr * intraday : dayCorr;
    const capW = this.getSetting('pv_capacity_w') || 0;
    let v = Math.round(w * f);
    if (capW > 0) v = Math.min(v, capW);
    return v;
  }

  _recordPvAccuracySample(now = new Date(), currentPrice = null) {
    if (!this.learningEngine || this._pvProductionW == null || !this._pvProductionTimestamp) return;
    if (!this._pvDayStartForecast || !Array.isArray(this._pvDayStartForecast) || this._pvDayStartForecast.length === 0) return;
    if (currentPrice != null && currentPrice < 0) return;

    const ageMs = Date.now() - this._pvProductionTimestamp;
    if (ageMs >= 20 * 60 * 1000) return;

    const nowMs      = now.getTime();
    const pvDayIdx   = this.optimizationEngine._buildPvIndex(this._pvDayStartForecast);
    const predictedW = this.optimizationEngine._getPvForSlot(pvDayIdx, nowMs) || 0;
    const actualW = this._pvProductionW;
    if (predictedW <= 50 || actualW <= 100) return;

    const bucketMs = Math.floor(nowMs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    if (this._lastPvAccuracyBucket === bucketMs) return;
    this._lastPvAccuracyBucket = bucketMs;

    const omIdx = this._pvForecastOM ? this.optimizationEngine._buildPvIndex(this._pvForecastOM) : null;
    const omW   = omIdx ? this.optimizationEngine._getPvForSlot(omIdx, nowMs) : null;
    const hourMs = now.getTime()
      - (now.getUTCMinutes() * 60_000)
      - (now.getUTCSeconds() * 1_000)
      - now.getUTCMilliseconds();
    const scSlots = this._pvForecastSC?.get(hourMs);
    const scW = scSlots?.p50?.length > 0
      ? Math.round(scSlots.p50.reduce((a, b) => a + b, 0) / scSlots.p50.length)
      : null;

    // RAW per-model PV — drives the per-model accuracy EMA (pv_model_accuracy → getModelWeights →
    // ensemble blend). Must stay raw: the model-weight ranking is judged against actual, and the
    // correction factor (≈ actual / ensemble-mean) collapses all models toward the mean, ranking
    // by closeness-to-mean instead of closeness-to-truth (circular). See recordPvAccuracy `chartW`
    // for the corrected display values.
    const perModelW = {};
    if (this._pvForecastPerModel) {
      for (const [m, fc] of Object.entries(this._pvForecastPerModel)) {
        const mIdx = this.optimizationEngine._buildPvIndex(fc);
        const mW = mIdx ? this.optimizationEngine._getPvForSlot(mIdx, nowMs) : null;
        if (mW != null) perModelW[m] = mW;
      }
    }
    // Satellite accuracy sample at 15-min resolution (matches Solcast cadence). The
    // overlay retains the raw 15-min curve; look up the value for THIS 15-min bucket
    // instead of the hourly slot, so the sat line has no gaps SC lacks. gtiOverGhi
    // from the containing hour slot keeps the GHI→panel conversion identical.
    const _satHourSlot = this.weatherData?.hourlyForecast?.find(h => h.time.getTime() === hourMs);
    const satW = this.weatherForecaster?.getSatPanelWAt?.(bucketMs, _satHourSlot?.gtiOverGhi) ?? null;

    // Corrected display values for the accuracy chart only — routed through the shared
    // _correctOverlayW so the diag chart and the webcam overlay cannot diverge. This is the
    // current (today, remaining) slot, so the intraday ratio applies. Applied to OM, per-model
    // and satellite (which share the yield-factor under-forecast offset), NOT to Solcast
    // (independent provider that over-forecasts). These feed the chart fields in pv_predictions,
    // never the accuracy/weight EMAs.
    const _corr = (this._pvDayCorrectionFactor ?? 1.0) * (this._lastIntradayPvRatio ?? 1.0);
    const chartW = _corr === 1 ? null : {
      om: this._correctOverlayW(omW, true),
      sat: this._correctOverlayW(satW, false),
      perModel: Object.fromEntries(Object.entries(perModelW).map(([m, w]) => [m, this._correctOverlayW(w, true)])),
    };

    this.learningEngine.recordPvAccuracy(predictedW, actualW, omW, scW, perModelW, satW, chartW).catch(e =>
      this.error('PV accuracy recording failed:', e)
    );
  }

  /**
   * Per-slot OM↔Solcast blend (pure, for property-testing).
   * Lever A — `unbiased`: a fixed 50/50 of raw OM & Solcast-p50 (no learned weights, no
   * p10-pessimism) cancels the two models' opposite biases and measured ~10% lower MAE than
   * accuracy-weighting on the 300-sample buffer (2026-06-15). Biased path keeps the learned
   * weights and the p10 cloud-miss guard (use SC p10 when its p50 sits ≥10% above OM, where
   * SC likely missed cloud the OM NWP ensemble already saw).
   * @param {{omW:number, scP50:number, scP10:number, wOM:number, wSC:number, unbiased:boolean}} a
   * @returns {{blendedW:number, scAvg:number, useP10:boolean}}
   */
  /**
   * Night bias correction for one slot, in watts (always ≤ 0).
   *
   * Measured 2026-08-01 on 652 raw pairs (07-17..07-24): the learned profile runs 19% HIGH at
   * night — bias −76W on 403W actual, median ≈ mean, negative in 7/7 nights and in both
   * sub-windows. That is a level error, unlike the daytime error which is tail-driven
   * (median ≈ 0, p90 up to 1374W) and must NOT be bias-corrected.
   *
   * Downward only: correcting upward is consumptionMargin's job (optimization-engine.js:856),
   * and running both on the same slot double-counts.
   *
   * This lands BEFORE consumptionMargin, and the margin is not a buffer beside the plan — it is
   * the number the DP plans the discharge cap with. So the margin multiplies the correction
   * through: at night (margin ≈ 1.128, CV is low) a −76W correction arrives as −85W of planned
   * load, 479×1.128=540W → 403×1.128=455W. Deliberate: the margin then hedges variance on a
   * bias-free base. Moving the correction after the margin would land exactly −76W instead.
   *
   * Fed by the live EMA rather than a constant so it tracks into winter. That EMA runs α=0.01
   * (~25 days to settle) and only started 07-18, so it is roughly half converged: hence the
   * count gate and the clamp.
   */
  static _nightBiasCorrW(hourly, hourAms) {
    if (!NIGHT_BIAS_HOURS.has(hourAms)) return 0;
    const b = hourly?.[hourAms];
    if (!b || !(b.count >= NIGHT_BIAS_MIN_COUNT)) return 0;
    const bias = b.emaBiasW;
    // emaBiasW = actual − predicted, so only a negative value means "predicted too high".
    if (!Number.isFinite(bias) || bias >= 0) return 0;
    return Math.max(-NIGHT_BIAS_CAP_W, bias);
  }

  /**
   * Consumption array as the DP should see it: learned profile + night bias correction, then
   * floored by baseload. The correction lands BEFORE the floor on purpose — after it the floor
   * would swallow the correction and stop being a floor.
   * With `enabled` false this is byte-identical to the uncorrected build.
   */
  static _buildDpConsumption(rawLearned, hoursAms, hourly, baseloadW, enabled) {
    return rawLearned.map((v, i) => {
      const corr = enabled ? BatteryPolicyDevice._nightBiasCorrW(hourly, hoursAms[i]) : 0;
      return Math.max(v + corr, baseloadW);
    });
  }

  // Build policy_pv_forecast_hourly for today+tomorrow from DP pvForecast.
  // Past hours come from existing[0] (previous run), future hours from pvForecast.
  // All values are capped at pvCapacityW. Injectable `now` enables unit testing.
  static _buildPvChartByDay(existing, pvForecast, pvCapacityW, now) {
    const _fcToday    = _amsDayKeyFormatter.format(now);
    const _fcTomorrow = _amsDayKeyFormatter.format(new Date(now.getTime() + 86_400_000));
    const _ex         = existing ?? [{}, {}];
    const cap         = (w) => pvCapacityW > 0 ? Math.min(w, pvCapacityW) : w;
    const pvFcByDay   = [
      Object.fromEntries(Object.entries(_ex[0] ?? {}).map(([h, w]) => [h, cap(w)])),
      { ...(_ex[1] ?? {}) },
    ];
    const pvSumByDayHour = [{}, {}];
    const pvCntByDayHour = [{}, {}];
    for (const fc of (pvForecast ?? [])) {
      const st    = new Date(fc.timestamp);
      const sDate = _amsDayKeyFormatter.format(st);
      const sIdx  = sDate === _fcToday ? 0 : sDate === _fcTomorrow ? 1 : -1;
      if (sIdx < 0) continue;
      const sHour = parseInt(st.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
      pvSumByDayHour[sIdx][sHour] = (pvSumByDayHour[sIdx][sHour] ?? 0) + fc.pvPowerW;
      pvCntByDayHour[sIdx][sHour] = (pvCntByDayHour[sIdx][sHour] ?? 0) + 1;
    }
    for (let d = 0; d < 2; d++) {
      for (const h of Object.keys(pvSumByDayHour[d])) {
        pvFcByDay[d][h] = cap(Math.round(pvSumByDayHour[d][h] / pvCntByDayHour[d][h]));
      }
    }
    return pvFcByDay;
  }

  // satW/satActive: the satellite nowcast takes over the SOLCAST leg for near-term slots
  // (sat_replaces_sc). F4 verdict 2026-07-28 — sat beats Solcast at every sstd threshold
  // (n=302-642, no crossover) but OM stays marginally ahead of sat, so the satellite may
  // only ever occupy the SC half; the OM half is untouched. The caller owns the freshness,
  // lead-time and elevation gates (see the blend loop).
  static _blendOmScSlot({ omW, scP50, scP10, wOM, wSC, unbiased, satW = null, satActive = false }) {
    const satUsed = satActive && typeof satW === 'number' && Number.isFinite(satW) && satW >= 0;
    // The p10 pessimism is a Solcast property (percentile spread); the satellite has none.
    const useP10 = !satUsed && !unbiased && scP50 > 0 && scP10 > 0 && scP50 > omW * 1.10;
    const scAvg = satUsed ? satW : (useP10 ? scP10 : scP50);
    const w_om = unbiased ? 0.5 : wOM;
    const w_sc = unbiased ? 0.5 : wSC;
    return { blendedW: Math.round(w_om * omW + w_sc * scAvg), scAvg, useP10, satUsed };
  }

  /**
   * Cloud-uncertainty gate for the intraday PV correction, with KNMI clearness override.
   * Damps the UPWARD correction as OM cloud cover rises above 70% (a clear-morning ratio
   * shouldn't re-inflate PV the model already lowered for a cloudy afternoon). But OM cloud%
   * can be a false-overcast (model miss): when KNMI's measured clearness index says the sky
   * is actually clear (kt ≥ 0.65, same threshold as getDailyPvBiasFactor), the OM cloud
   * reading is untrusted and the gate is released so a legitimate upward correction isn't
   * suppressed. Returns a factor in [0,1]; only ever relaxes (≥) the OM-only gate, never tightens.
   * @param {number} correctedMeanRatio - intraday actual/post-bias ratio (>1 = under-forecast)
   * @param {number|null} effectiveCloud - OM effective cloud cover 0–100 (max of total, low×1.2)
   * @param {number|null} knmiKt - KNMI clearness index for today, or null
   * @returns {number} gate factor in [0,1]
   */
  static _knmiAwareCloudGate(correctedMeanRatio, effectiveCloud, knmiKt) {
    const knmiClear = knmiKt != null && knmiKt >= 0.65;
    if (correctedMeanRatio > 1.0 && effectiveCloud != null && effectiveCloud > 70 && !knmiClear) {
      return Math.max(0, 1 - (effectiveCloud - 70) / 30);
    }
    return 1.0;
  }

  /**
   * Cloud-uncertainty discount for DP pvCoverage, cross-checked against KNMI ground truth.
   * OM cloud% above 70% discounts pvCoverage by up to 40% (DP shouldn't rely on uncertain PV
   * recharge) — but OM's cloud forecast can be a false-overcast. Same KNMI-clear bar as
   * _knmiAwareCloudGate (kt ≥ 0.65): if KNMI's measured clearness disagrees with OM's high
   * cloud%, don't discount. Returns a factor in [0.6,1]; only ever relaxes the OM-only discount.
   * @param {number|null} effectiveCloud - OM effective cloud cover 0–100 (max of total, low×1.2)
   * @param {number|null} knmiKt - KNMI clearness index for today, or null
   * @returns {number} pvCoverage factor in [0.6,1]
   */
  static _pvCloudUncertaintyFactor(effectiveCloud, knmiKt) {
    if (effectiveCloud == null || effectiveCloud <= 70) return 1.0;
    const knmiClear = knmiKt != null && knmiKt >= 0.65;
    if (knmiClear) return 1.0;
    return Math.max(0.6, 1.0 - 0.5 * Math.min(1, (effectiveCloud - 70) / 30));
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
        if (settings.enable_logging && this._pvProductionW !== this._lastLoggedPvW) {
          this._lastLoggedPvW = this._pvProductionW;
          this.log(`PV from flow card: ${this._pvProductionW}W (age: ${Math.round(age/1000)}s)`);
        }
        // Clamp to physical array capacity when configured — a flow source can
        // momentarily over-report (DC string sum / transient) above nameplate,
        // which is physically impossible as AC output. Flow users without a
        // configured pv_capacity_w are trusted as-is (no reference to clamp to).
        return settings.pv_capacity_w > 0
          ? Math.min(this._pvProductionW, settings.pv_capacity_w)
          : this._pvProductionW;
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

    // Hard-clamp to physical array capacity: the learning multiplier (≤1.5×) and
    // pvFromGrid (export + battery charge/discharge summed) can push the estimate
    // above nameplate, which is physically impossible. pvCap is always >0 here
    // (guarded at the Priority-2 entry above).
    return Math.min(pvCap, Math.max(0, adjustedEstimate));
  }

  _isEvCharging() {
    return this._evChargingUntil > Date.now();
  }

  _scheduleEvAutoClear() {
    if (this._evChargingTimer) {
      this.homey.clearTimeout(this._evChargingTimer);
      this._evChargingTimer = null;
    }
    const delay = this._evChargingUntil - Date.now();
    if (delay <= 0) return;
    this._evChargingTimer = this.homey.setTimeout(() => {
      this._evChargingTimer = null;
      if (this._isEvCharging()) return;
      this.log('[EV] Auto-clear: 8h timeout reached, discharge gate released');
      this._evChargingUntil = 0;
      try { this.homey.settings.set('ev_charging_until', 0); } catch (_) {}
      this._enforceEvGate(false).catch(err => this.error('[EV] auto-clear gate release failed:', err));
    }, delay);
  }

  async _setEvCharging(active) {
    const EV_TTL_MS = 8 * 60 * 60 * 1000;
    if (active) {
      this._evChargingUntil = Date.now() + EV_TTL_MS;
      this.log(`[EV] Charging session started — discharge blocked until ${new Date(this._evChargingUntil).toISOString()}`);
    } else {
      this._evChargingUntil = 0;
      this.log('[EV] Charging session stopped — discharge gate released');
    }
    try { this.homey.settings.set('ev_charging_until', this._evChargingUntil); } catch (_) {}
    this._scheduleEvAutoClear();
    this._enforceEvGate(active).catch(err => this.error('[EV] gate enforce after toggle failed:', err));
  }

  // Enforce the EV discharge-gate at the hardware level. When the policy is ENABLED the
  // normal policy run + mapper gate (policy-engine.js _mapPolicyToHwMode) already blocks
  // discharge. When the policy is DISABLED (predictive / manual off) that run is skipped,
  // so the gate would be a dead flag and the EV drains the battery via nul-op-de-meter —
  // we then take the battery OUT of predictive into standby (fully passive, no charge or
  // discharge) and restore the pre-gate HW mode on release.
  async _enforceEvGate(active) {
    const runPolicy = () => this._runPolicyCheck();
    if (active) {
      if (this.getCapabilityValue('policy_enabled') || !this.p1Device) return runPolicy();
      this._evPreGateMode = this.p1Device.getCapabilityValue('battery_group_charge_mode') || 'predictive';
      try { this.homey.settings.set('ev_pregate_mode', this._evPreGateMode); } catch (_) {}
      this.log(`[EV] policy disabled — predictive off → standby (pre-gate ${this._evPreGateMode})`);
      await this._applyRecommendation('standby', 100, { force: true });
    } else {
      if (this.getCapabilityValue('policy_enabled')) return runPolicy();
      const restore = this._evPreGateMode || this.homey.settings.get('ev_pregate_mode') || 'predictive';
      this._evPreGateMode = null;
      try { this.homey.settings.set('ev_pregate_mode', null); } catch (_) {}
      this.log(`[EV] policy disabled — restoring HW mode ${restore}`);
      await this._applyRecommendation(restore, 100, { force: true });
    }
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
        Date.now() - this.weatherData.fetchedAt > 3_600_000
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
    if (this.p1Device?._updateBatteryGroup) {
      await this.p1Device._updateBatteryGroup().catch(e => this.error('Battery group refresh failed:', e.message));
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
    const { wOM, wSC } = this.learningEngine?.getPvBlendWeights?.() ?? { wOM: 0.5, wSC: 0.5 };
    const accOM  = this.learningEngine?.data?.pv_accuracy_om ?? null;
    const accSC  = this.learningEngine?.data?.pv_accuracy_sc ?? null;
    const accSAT = this.learningEngine?.data?.pv_accuracy_sat ?? null;
    const pvPredictions = this.learningEngine?.data?.pv_predictions?.slice(-864) ?? [];
    const _mAcc = this.learningEngine?.data?.pv_model_accuracy ?? {};
    const modelAcc = {
      mf:    _mAcc['meteofrance_arpege_europe']            != null ? +(_mAcc['meteofrance_arpege_europe'] * 100).toFixed(1)            : null,
      gfs:   _mAcc['gfs_seamless']                        != null ? +(_mAcc['gfs_seamless'] * 100).toFixed(1)                        : null,
      icon:  _mAcc['icon_seamless']                        != null ? +(_mAcc['icon_seamless'] * 100).toFixed(1)                        : null,
      knmi:  _mAcc['knmi_harmonie_arome_netherlands']      != null ? +(_mAcc['knmi_harmonie_arome_netherlands'] * 100).toFixed(1)      : null,
      ecmwf: _mAcc['ecmwf_ifs']                            != null ? +(_mAcc['ecmwf_ifs'] * 100).toFixed(1)                            : null,
    };
    this._setLive('learning_status', {
      days:           learningStats.days_tracking,
      samples:        learningStats.total_samples,
      coverage:       learningStats.pattern_coverage,
      pvAccuracy:     learningStats.pv_accuracy,
      rte:            rte != null ? +(rte * 100).toFixed(1) : null,
      rteByPower:     rteInsightsObj?.rteByPower ?? null,
      rteByDischargePower: rteInsightsObj?.rteByDischargePower ?? null,
      rteByDischargeComposition: rteInsightsObj?.rteByDischargeComposition ?? null,
      rteByChargeComposition: rteInsightsObj?.rteByChargeComposition ?? null,
      rteBySeason:    rteInsightsObj?.rteBySeason ?? null,
      rteByMode:      rteInsightsObj?.rteByMode ?? null,
      cycles:         this.efficiencyEstimator.getCycleCount(),
      accOM:          accOM != null ? +(accOM * 100).toFixed(1) : null,
      accSC:          accSC != null ? +(accSC * 100).toFixed(1) : null,
      accSAT:         accSAT != null ? +(accSAT * 100).toFixed(1) : null,
      wOM:            +(wOM * 100).toFixed(0),
      wSC:            +(wSC * 100).toFixed(0),
      updatedAt:      new Date().toISOString(),
    });
    // Chart data (large: pvPredictions + modelAcc) written separately so the
    // lightweight _updateWeather write above doesn't overwrite it.
    this._setLive('learning_pv_chart_data', { pvPredictions, modelAcc });
    
    // NOTE: policy_all_prices is written by TariffManager._getDynamicTariff() every 5 min
    // — no need to duplicate here
    
    // Push weather forecast with hourly radiation data for PV visualization.
    // Prefer dailyProfiles (full 24h including past hours) over hourlyForecast (future only).
    const weatherSource = weatherData?.dailyProfiles ?? weatherData?.hourlyForecast;
    if (weatherSource && Array.isArray(weatherSource)) {
      const nowAmsDate = _amsDayKeyFormatter.format(new Date());
      const hourlyWeather = weatherSource.map(h => {
        const t = new Date(h.time);
        const hAmsDate = _amsDayKeyFormatter.format(t);
        return {
          hour: parseInt(_amsHourFormatter.format(t), 10),
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
    const _sunset  = weatherData?.todaySunset;
    const _beforeSunrise = _sunrise instanceof Date && _nowMs < _sunrise.getTime();
    const _afterSunset   = _sunset instanceof Date && _nowMs > _sunset.getTime() + 30 * 60 * 1000;
    if (_beforeSunrise || _afterSunset) this._lastPvEstimateW = 0; // reset EMA — no sun
    const sunScore = (weatherData && !_beforeSunrise && !_afterSunset)
      ? Math.min(100, Math.round((weatherData.sunshineNext4Hours / 4) * 100))
      : 0;
    const sun = { gfs: sunScore, harmonie: sunScore };
    const pvEstimateW = this._estimatePvProduction({
      gridPower: batteryState.gridPower,
      batteryPower: batteryState.groupPower,
      sunScore
    });
    // Cache the effective PV (flow-when-fresh, else grid/sun fallback) so OVERSCHOT
    // consumers that can't pass ctx (e.g. _checkFavorableWindow) don't read raw 0 on a stale feed.
    this._lastEffectivePvW = pvEstimateW;

    const p1 = {
      resolved_gridPower: batteryState.gridPower,
      battery_power: batteryState.groupPower,
      pv_power_estimated: pvEstimateW,
      avg_consumption_w: Math.round(this.learningEngine.getPredictedConsumption(new Date()) ?? 0),
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
      evCharging: this._isEvCharging(),
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
        this._sanitizeSoc(this.p1Device.getCapabilityValue('battery_group_average_soc')) ??
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

      // max_consumption_w (the pack's reported charge ceiling) is a PLANNING-ONLY input:
      // the app never commands a charge wattage — it sets a mode and the HW enforces its own
      // real limit at dispatch. So planning must use the pack's nominal charge capability,
      // not the momentary reported ceiling. A BMS calibration drops max_consumption_w to a
      // low value that then freezes (2026-07-19: stuck at 60 W for ~20 h after a calibration,
      // even at zero charge current → sumPvNetWindow clamped pvKwhTomorrow to 0.5 kWh →
      // refillConfidence collapsed → a 30 % SoC plan, real money lost). Both that freeze and
      // any near-full tapering are the wrong input for a 24 h-forward absorption forecast (the
      // window spans states where the pack recharges at full rate), so we always plan with
      // nominal charge power. The earlier charge-contradiction check only caught the freeze
      // while the pack was charging hard enough to contradict itself; nominal-always closes
      // the zero-current gap too. Log when the reported value diverges so the event stays
      // visible in diagnostics.
      const reportedMaxConsumption =
        this.p1Device.getCapabilityValue('measure_power.battery_group_max_consumption_w') ||
        chargeFallbackW;
      const maxConsumption = chargeFallbackW;
      const diverged = reportedMaxConsumption < chargeFallbackW;
      if (diverged !== !!this._maxConsumptionContradicted) {
        this._maxConsumptionContradicted = diverged;
        this.log(diverged
          ? `⚠️ max_consumption_w=${reportedMaxConsumption}W below nominal ${chargeFallbackW}W (calibration/taper) → planning with nominal ${chargeFallbackW}W`
          : `✅ max_consumption_w=${reportedMaxConsumption}W back at nominal ${chargeFallbackW}W`);
      }

      // Squeeze-at-zero-SoC: LOG ONLY, not yet a trigger source. checkSoCDrift() in
      // plugin_battery/device.js (power-signature: sustained 75W or 800W charge while
      // SoC stuck at 0%) stays the sole source that fires battery_soc_drift_detected —
      // it is proven over multiple real calibrations. This max_consumption_w-based check
      // is new (first-ever-seen 60W reading 2026-07-21) and the "squeezed value" signal
      // is not yet trustworthy on its own: the pack also derates max_consumption_w a few
      // percent (e.g. 794W vs 800W) when it runs warm — an unrelated, harmless cause with
      // the same shape (diverged=true) that this check cannot yet tell apart from a real
      // calibration. Logging the exact wattage here (not just a boolean) lets a future
      // session compare thermal-derate magnitudes (~expect small, single-digit-%) against
      // real calibration magnitudes (60W ≈ 92% below nominal) before this is trusted
      // enough to drive the trigger card itself. Checked PER UNIT (plugin_battery
      // devices' own measure_battery), not the P1's battery_group_average_soc: on a
      // multi-battery group the group average is a capacity-weighted blend across all
      // units (energy_v2/device.js ~1420), so one unit calibrating at 0% while others sit
      // at 50% would never bring the average to exactly 0 — the group signal would
      // silently miss multi-battery calibrations, hence per-unit even for this log.
      let calibratingUnits = [];
      try {
        const battDriver = this.homey.drivers.getDriver('plugin_battery');
        if (battDriver) {
          calibratingUnits = battDriver.getDevices()
            .filter(dev => dev.getCapabilityValue('measure_battery') === 0);
        }
      } catch (e) { /* driver not available */ }

      const calibrationSqueeze = diverged && calibratingUnits.length > 0;
      if (calibrationSqueeze !== !!this._calibrationSqueezeActive) {
        this._calibrationSqueezeActive = calibrationSqueeze;
        this.log(calibrationSqueeze
          ? `🔎 [observe-only] max_consumption_w=${reportedMaxConsumption}W squeezed (nominal ${chargeFallbackW}W), ${calibratingUnits.length} unit(s) at SoC 0% — not yet wired to battery_soc_drift_detected`
          : '🔎 [observe-only] max_consumption_w back at nominal or no unit at SoC 0%');
      }

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
        // Raw reported ceiling (before the nominal-always override) so the diagnose
        // page can flag a stuck calibration value at a glance instead of it hiding
        // behind the corrected number.
        reportedMaxChargePowerW: reportedMaxConsumption,
        battery_group_max_discharge_power_w: maxProduction
      };

    } catch (error) {
      this.error('Failed to get battery state from P1:', error);
      return fallback;
    }
  }

  async _applyRecommendation(mode, confidence, { force = false } = {}) {
    // ?? not ||: the schema allows 0 (min: 0), meaning "never gate on confidence". || would
    // discard that explicit choice and keep refusing at 55.
    const minConfidence = this.getSetting('min_confidence_threshold') ?? 55;

    if (!force && confidence < minConfidence) {
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

      if (mode === 'zero_charge_only' || mode === 'pv_trickle') {
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

      // Detect external steering: HW mode differs from what we last commanded, and it is
      // neither predictive (HW-cloud/SlimLaden, legitimate) nor a change we made ourselves.
      // Could be a 3rd-party EMS app or a firmware mode-glitch — diagnose-only log, no card.
      if (this._lastCommandedMode && actualMode !== this._lastCommandedMode && actualMode !== 'predictive') {
        this.log(`⚠️ [EXT-CTRL] Unexpected HW mode change: last commanded "${this._lastCommandedMode}", HW now "${actualMode}" (not us, not predictive) — external EMS app or firmware`);
      }

      // ⭐ HW Slim laden actief → policy engine niet overrulen.
      // Exception: EV-charging gate (force) MUST block discharge even in predictive,
      // otherwise the EV drains the home battery via nul-op-de-meter (see _enforceEvGate).
      if (actualMode === 'predictive' && !force) {
        this.log('⏸️ HW Slim laden (predictive) actief — policy engine gepauzeerd, geen mode-wijziging');
        return true;
      }

      // ⭐ Als al correct → niets doen
      if (actualMode === targetMode) {
        this.log(`ℹ️ Battery already in correct HW mode (${actualMode}), no change needed`);
        this._lastCommandedMode = targetMode;
        return true;
      }

      // ⭐ Mode zetten
      this.log(`🔄 Changing battery mode: ${actualMode} → ${targetMode} (confidence: ${confidence}%)`);
      const result = await this.p1Device.setBatteryGroupMode(targetMode);

      if (result) {
        this.log(`✅ Battery mode successfully changed to: ${targetMode}`);
        this._lastCommandedMode = targetMode;
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

  // set_override/clear_override flow-card handlers (driver.js:97-106). Writes the
  // override_until store value that _runPolicyCheck already reads (line ~1598) to
  // skip policy runs — that read-side existed but nothing ever wrote it.
  async setManualOverride(durationMinutes) {
    const until = new Date(Date.now() + durationMinutes * 60_000);
    await this.setStoreValue('override_until', until.toISOString());
    this.log(`Manual override set for ${durationMinutes}min (until ${until.toISOString()})`);
    await this._triggerOverrideSet(durationMinutes);
  }

  async clearManualOverride() {
    await this.setStoreValue('override_until', null);
    this.log('Manual override cleared');
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

    // PV surplus: significant solar production (>500W means PV is covering meaningful load).
    // Prefer the cached effective PV (flow-when-fresh, else grid/sun fallback) so a stale flow
    // feed doesn't read 0 while PV is genuinely producing; fall back to raw flow value if unset.
    const isPvSurplus = (this._lastEffectivePvW || (this._pvProductionW ?? 0)) > 500;

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

    // Refresh cached settings used in hot poll loop
    if (changedKeys.includes('peak_shaving_threshold')) this._cachedPsThreshold = newSettings.peak_shaving_threshold ?? 0;
    if (changedKeys.includes('peak_hours')) this._cachedPsHours = newSettings.peak_hours || '';

    // Update internal modules
    this.policyEngine.updateSettings(newSettings);
    this.tariffManager.updateSettings(newSettings);
    this.optimizationEngine.updateSettings(newSettings);

    // Push updated settings immediately so planning page reflects the change
    this.homey.settings.set('device_settings', {
      max_charge_price:    newSettings.max_charge_price    || 0.19,
      min_discharge_price: newSettings.min_discharge_price || 0.22,
      respect_minmax:      newSettings.respect_minmax      ?? true,
      min_soc:             newSettings.min_soc             ?? 0,
      max_soc:             newSettings.max_soc             ?? 100,
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
        respect_minmax:      newSettings.respect_minmax      ?? true,
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

    if (this._evChargingTimer) {
      this.homey.clearTimeout(this._evChargingTimer);
      this._evChargingTimer = null;
    }
    // Final flush — write pending queued settings synchronously on shutdown
    // so the last policy run's state is not lost on restart.
    if (this._settingsQueue && this._settingsQueue.size > 0) {
      for (const [key, entry] of this._settingsQueue) {
        try { this.homey.settings.set(key, entry.value); } catch (_) {}
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
      'learning_pv_chart_data',
      'pv_surplus_forecast',
      'policy_pv_forecast_hourly',
      'policy_pv_actual_today',
      'policy_pv_bias',
      'policy_pv_predictions_recent',
      `batt_mode_hist_${this.getData().id}`,
      // Day keys from before the /userdata move; harmless when the migration already unset them.
      ...Object.keys(this.homey.settings.getAll?.() || {}).filter(k => k.startsWith(MODE_HISTORY_PREFIX)),
    ];
    for (const key of settingsToClean) {
      try { this.homey.settings.unset(key); } catch (_) {}
    }

    // The history itself lives on /userdata now, so it needs unlinking, not unsetting.
    for (const dayKey of this._modeHistoryKeys()) {
      try { require('fs').unlinkSync(this._modeHistoryFile(dayKey)); } catch (_) {}
    }
    this._modeHist = null;

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
      const dayKey = ts => _amsDayKeyFormatter.format(new Date(ts)); // YYYY-MM-DD
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
          try {
            await ChartRenderer.streamPlanningChart(stream, this._chartToday);
          } catch (e) {
            this.error('[Chart] Today stream failed:', e.message);
            if (!stream.destroyed) stream.end();
          }
        });
        await this.setCameraImage('planning_today', 'Batterij Vandaag', this.planningImageToday);
        this._chartHashToday = null; // force first update
      }
      if (hashToday !== this._chartHashToday) {
        await this.planningImageToday.update();
        this._chartHashToday = hashToday;
      }

      // Tomorrow image — only register once slots are available (after ~14:00 when DAP prices arrive).
      // Registering with an empty stream causes Homey to cache an empty response and hide the tile
      // permanently until the next app restart, even after subsequent .update() calls.
      if (!this.planningImageTomorrow && tomorrowSlots.length > 0) {
        this.planningImageTomorrow = await this.homey.images.createImage();
        this.planningImageTomorrow.setStream(async (stream) => {
          if (this._isPredictiveMode) { this.log('[Chart] Tomorrow stream: predictive mode → empty'); stream.end(); return; }
          if (!this._chartTomorrow || !this._chartTomorrow.slots?.length) { this.log('[Chart] Tomorrow stream: no slots → empty'); stream.end(); return; }
          let _h = 0; try { _h = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
          if (_h > 38) { this.log(`[MEM] Tomorrow chart stream skipped — heap ${_h.toFixed(1)} MB > 38 MB`); stream.end(); return; }
          try {
            await ChartRenderer.streamPlanningChart(stream, this._chartTomorrow);
          } catch (e) {
            this.error('[Chart] Tomorrow stream failed:', e.message);
            if (!stream.destroyed) stream.end();
          }
        });
        await this.setCameraImage('planning_tomorrow', 'Batterij Morgen', this.planningImageTomorrow);
        this._chartHashTomorrow = null; // force first update
      }
      if (this.planningImageTomorrow && tomorrowSlots.length > 0 && hashTomorrow !== this._chartHashTomorrow) {
        await this.planningImageTomorrow.update();
        this._chartHashTomorrow = hashTomorrow;
      }

      // PV forecast vs actual image
      const pvActual     = this.homey.settings.get('policy_pv_actual_today');
      const pvForecast   = this._liveState.policy_pv_forecast_hourly
        ?? this.homey.settings.get('policy_pv_forecast_hourly');
      const pvForecastOM = this._liveState.policy_pv_forecast_om ?? null;
      const pvForecastSC = this._liveState.policy_pv_forecast_sc ?? null;
      const pvForecastSCEffective = this._liveState.policy_pv_forecast_sc_effective ?? null;
      const pvForecastSAT = this._liveState.policy_pv_forecast_sat ?? null;
      const pvCapW       = this.getSetting('pv_capacity_w') || 0;
      const pvScDayStart = this.homey.settings.get('policy_sc_daystart') ?? null;

      this._pvChartData = { pvActual, pvForecast, pvForecastOM, pvForecastSC, pvForecastSCEffective, pvForecastSAT, pvForecastDayStart: this._correctedDayStartForChart(), pvScDayStart, pvCapacityW: pvCapW };

      if (!this.planningImagePv) {
        await this._initPvCamera();
      }

      const pvHash = _amsDayKeyFormatter.format(new Date()) + JSON.stringify(pvActual?.sums) + JSON.stringify(pvForecast);
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


  // Put satellite GHI on the same tilted plane OM uses, so the chart/accuracy
  // sat line is comparable (OM feeds GTI to yieldFactor; raw GHI undershoots the
  // east-tilt morning boost). Falls back to raw GHI when tilt/geo isn't set.
  _satGhiToPanelGhi(satGhiWm2, date) {
    const s = this.getSettings();
    const tilt = s.pv_estimation_enabled && typeof s.pv_tilt === 'number' ? s.pv_tilt : null;
    const azimuth = s.pv_estimation_enabled && typeof s.pv_azimuth === 'number' ? s.pv_azimuth : null;
    const lat = s.weather_latitude;
    const lon = s.weather_longitude;
    if (typeof tilt === 'number' && typeof azimuth === 'number' && typeof lat === 'number' && typeof lon === 'number') {
      return WeatherForecaster._ghiToGti(satGhiWm2, date, lat, lon, tilt, azimuth);
    }
    return satGhiWm2;
  }

  // Satellite GHI → panel plane. Prefer the OM ensemble's own per-slot GTI/GHI ratio
  // (gtiOverGhi) so the sat line shares the operational forecast's transposition geometry;
  // fall back to the standalone Erbs transposition only when the ratio is unavailable.
  _satGhiToPanel(satGhiWm2, date, gtiOverGhi) {
    if (typeof gtiOverGhi === 'number' && gtiOverGhi > 0) return satGhiWm2 * gtiOverGhi;
    return this._satGhiToPanelGhi(satGhiWm2, date);
  }

  _onSatelliteOverlay() {
    const pvCapW = this.getSetting('pv_capacity_w') || 0;
    const sat = this._buildSatForecastForChart(this.weatherData, pvCapW);
    this._setLive('policy_pv_forecast_sat', sat);
    const keys = sat ? Object.keys(sat[0] || {}).length + Object.keys(sat[1] || {}).length : 0;
    this.log(`[SAT chart] overlay→chart: ${keys} hours, cam=${!!this.planningImagePv}`);
    if (sat && this.planningImagePv) this.planningImagePv.update().catch(() => {});
  }

  _buildSatForecastForChart(weatherData, pvCapW) {
    const store = this.homey.settings.get('policy_pv_sat_obs') || {};
    const slots = weatherData?.hourlyForecast;
    if (Array.isArray(slots)) {
      for (const s of slots) {
        if (typeof s.satGhiWm2 !== 'number') continue;
        const t = s.time instanceof Date ? s.time : new Date(s.time);
        // {ghi, ratio} — ratio carries the ensemble's gtiOverGhi so the chart's panel-W
        // conversion shares the same transposition as the live overlay/accuracy sampler.
        store[String(t.getTime())] = { ghi: s.satGhiWm2, ratio: typeof s.gtiOverGhi === 'number' ? s.gtiOverGhi : null };
      }
    }
    const todayAms = _amsDayKeyFormatter.format(new Date());
    const result = [{}, {}];
    for (const key of Object.keys(store)) {
      const t = new Date(Number(key));
      const amsDate = _amsDayKeyFormatter.format(t);
      if (amsDate < todayAms) { delete store[key]; continue; }
      const dayIdx = amsDate > todayAms ? 1 : 0;
      const amsH = parseInt(t.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
      // Backward-compat: entries persisted before this change are plain numbers (raw GHI, no ratio).
      const entry = store[key];
      const ghi   = typeof entry === 'number' ? entry : entry?.ghi;
      const ratio = typeof entry === 'number' ? null : entry?.ratio;
      const raw = this.weatherForecaster?.satGhiToPanelW?.(ghi, t.getUTCHours(), ratio) ?? 0;
      result[dayIdx][amsH] = pvCapW > 0 ? Math.min(raw, pvCapW) : raw;
    }
    this._queueSettingsPersist('policy_pv_sat_obs', store);
    return (Object.keys(result[0]).length + Object.keys(result[1]).length) > 0 ? result : null;
  }

  /**
   * Day-start PV forecast scaled by the same corrections the chart overlays get
   * (_pvDayCorrectionFactor × intraday ratio for today, _pvDayCorrectionFactor for
   * tomorrow). Returns a COPY — the original stays raw as the intraday-ratio reference.
   */
  _correctedDayStartForChart() {
    const src = this._pvDayStartForecast;
    if (!Array.isArray(src)) return null;
    const dayCorr  = this._pvDayCorrectionFactor ?? 1.0;
    const intraday = this._lastIntradayPvRatio ?? 1.0;
    const capW     = this.getSetting('pv_capacity_w') || 0;
    const today    = _amsDayKeyFormatter.format(new Date());
    return src.map(s => {
      const isToday = _amsDayKeyFormatter.format(new Date(s.timestamp)) === today;
      const f = isToday ? dayCorr * intraday : dayCorr;
      if (f === 1) return s;
      let w = Math.round(s.pvPowerW * f);
      if (capW > 0) w = Math.min(w, capW);
      return { ...s, pvPowerW: w };
    });
  }

  async _initPvCamera() {
    if (this.planningImagePv) return;
    this.planningImagePv = await this.homey.images.createImage();
    this.planningImagePv.setStream(async (stream) => {
      const pvActual     = this.homey.settings.get('policy_pv_actual_today');
      const pvForecast   = this._liveState.policy_pv_forecast_hourly
        ?? this.homey.settings.get('policy_pv_forecast_hourly');
      const pvForecastOM = this._liveState.policy_pv_forecast_om ?? null;
      const pvForecastSC = this._liveState.policy_pv_forecast_sc ?? null;
      const pvForecastSCEffective = this._liveState.policy_pv_forecast_sc_effective ?? null;
      const pvForecastSAT = this._liveState.policy_pv_forecast_sat ?? null;
      const pvCapW       = this.getSetting('pv_capacity_w') || 0;
      if (!pvActual && !pvForecast) { stream.end(); return; }
      let _h = 0; try { _h = require('v8').getHeapStatistics().used_heap_size / 1048576; } catch (_) {}
      if (_h > 38) { this.log(`[MEM] PV chart stream skipped — heap ${_h.toFixed(1)} MB > 38 MB`); stream.end(); return; }
      try {
        await ChartRenderer.streamPvChart(stream, { pvActual, pvForecast, pvForecastOM, pvForecastSC, pvForecastSCEffective, pvForecastSAT, pvForecastDayStart: this._correctedDayStartForChart(), pvScDayStart: this.homey.settings.get('policy_sc_daystart') ?? null, pvCapacityW: pvCapW });
      } catch (e) {
        this.error('PV chart stream error:', e.message);
        if (!stream.destroyed) stream.end();
      }
    });
    await this.setCameraImage('planning_pv', 'PV Opwek', this.planningImagePv);
    this.log('📷 PV Opwek camera geregistreerd');

    // Load initial data so the camera has content immediately
    const pvActual     = this.homey.settings.get('policy_pv_actual_today');
    const pvForecast   = this._liveState.policy_pv_forecast_hourly
      ?? this.homey.settings.get('policy_pv_forecast_hourly');
    const pvForecastOM = this._liveState.policy_pv_forecast_om ?? null;
    const pvForecastSC = this._liveState.policy_pv_forecast_sc ?? null;
    const pvForecastSCEffective = this._liveState.policy_pv_forecast_sc_effective ?? null;
    const pvForecastSAT = this._liveState.policy_pv_forecast_sat ?? null;
    const pvCapW       = this.getSetting('pv_capacity_w') || 0;
    if (pvForecast || pvActual) {
      this._pvChartData = { pvActual, pvForecast, pvForecastOM, pvForecastSC, pvForecastSCEffective, pvForecastSAT, pvForecastDayStart: this._correctedDayStartForChart(), pvScDayStart: this.homey.settings.get('policy_sc_daystart') ?? null, pvCapacityW: pvCapW };
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
      try {
        await ChartRenderer.streamModeChart(stream, this._modeChartBody);
      } catch (e) {
        this.error('[Chart] Mode history stream failed:', e.message);
        if (!stream.destroyed) stream.end();
      }
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
    this._modeChartBody = ChartRenderer.buildModeChartBody(this._modeHistory);
  }

  _computeDailyProfit(dateStr) {
    // Two chunks, not one: an entry timestamped 23:53 on dateStr rounds into the 00:00 bucket and
    // is therefore filed under the NEXT day's chunk. The ts filter below still decides the day.
    const next = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
    const hist = [...this._readModeHistoryDay(dateStr), ...this._readModeHistoryDay(next)];
    let revenue = 0, cost = 0, slots = 0;
    for (const h of hist) {
      const d = _amsDayKeyFormatter.format(new Date(h.ts));
      if (d !== dateStr || h.price == null || h.battW == null) continue;
      slots++;
      const kwh = Math.abs(h.battW) * (15 / 60) / 1000;
      if (h.battW < -10) revenue += kwh * h.price;
      else if (h.battW > 10) cost += kwh * h.price;
    }
    return { revenue: +revenue.toFixed(3), cost: +cost.toFixed(3), profit: +(revenue - cost).toFixed(3), slots };
  }

  _captureDailyProfit(dateStr) {
    try {
      const actual = this._computeDailyProfit(dateStr);
      const planned = this._morningPlannedProfit;
      const entry = {
        date: dateStr,
        planned: planned ?? null,
        actual: actual.profit,
        revenue: actual.revenue,
        cost: actual.cost,
        gap: planned != null ? +(actual.profit - planned).toFixed(3) : null,
        slots: actual.slots,
      };
      const history = this.homey.settings.get('policy_daily_profit') || [];
      history.push(entry);
      if (history.length > 30) history.splice(0, history.length - 30);
      this._queueSettingsPersist('policy_daily_profit', history);
      const gapStr = entry.gap != null ? ` gap €${entry.gap > 0 ? '+' : ''}${entry.gap.toFixed(3)}` : '';
      this.log(`📅 Daily profit ${dateStr}: planned €${(planned ?? 0).toFixed(3)} actual €${actual.profit.toFixed(3)}${gapStr} (${actual.slots} slots, rev €${actual.revenue.toFixed(3)} cost €${actual.cost.toFixed(3)})`);
    } catch (e) {
      this.error('Daily profit capture failed:', e);
    }
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
        // Opportunity cost of storing PV instead of exporting it — same exportValue()
        // the DP uses, so this ledger's profit numbers stay in sync with what the
        // optimizer actually decided. No dynamic price available (fixed tariff_type)
        // → treat as free, matching the prior default.
        const tariff = this.tariffManager.getCurrentTariff(gridPower);
        if (tariff.currentPrice == null) {
          costNew = 0;
        } else {
          const tariffModel = this.getSetting('tariff_model') || 'saldering';
          costNew = exportValue({ price: tariff.currentPrice, exportPrice: tariff.currentExportPrice }, tariffModel);
        }
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

BatteryPolicyDevice.DP_DUMP_KEEP = DP_DUMP_KEEP;

module.exports = BatteryPolicyDevice;
