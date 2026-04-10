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

class BatteryPolicyDevice extends Homey.Device {

  async onInit() {
    this.log('BatteryPolicyDevice initialized');
    _memMB('onInit-start');

    // Components
    this.learningEngine = new LearningEngine(this.homey, this);
    await this.learningEngine.initialize();
    _memMB('after-learningEngine.initialize');

    this.weatherForecaster = new WeatherForecaster(this.homey, this.learningEngine);
    this.policyEngine = new PolicyEngine(this.homey, this.getSettings());
    this.tariffManager = new TariffManager(this.homey, this.getSettings());
    _memMB('after-engines-created');
    this.explainabilityEngine = null; // lazy-loaded on first policy check
    this.chartGenerator = null;       // lazy-loaded on first chart request
    this.efficiencyEstimator = new EfficiencyEstimator(this.homey);
    this.optimizationEngine = new OptimizationEngine(this.getSettings());


    // State
    this.p1Device = null;
    this.weatherData = null;
    this.lastRecommendation = null;
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
    _memMB('after-initializeCapabilities');
    this._registerCapabilityListeners();

    // Connect P1 after short delay
    this.homey.setTimeout(() => {
      this._connectP1Device().catch(err => this.error(err));
    }, 1500);

    // Schedule periodic checks
    this._schedulePolicyCheck();

    // Restore widget + camera from cached settings immediately after restart
    // (first scheduled policy check may be up to 15 min away)
    this.homey.setTimeout(() => {
      try { this._saveWidgetData(); } catch (e) { this.error('Startup widget restore failed:', e); }
    }, 3000);

    // Set default for price_resolution if not yet saved (existing paired devices)
    if (!this.getSetting('price_resolution')) {
      await this.setSettings({ price_resolution: '15min' });
    }

    // Migrate legacy weather_location (city name) to weather_latitude/weather_longitude
    await this._migrateWeatherLocation();

    // Weather fetch only in dynamic
    if (this.getSettings().tariff_type === 'dynamic') {
      this._updateWeather()
        .then(() => _memMB('after-weather-fetch'))
        .catch(err => this.error('Initial weather fetch failed:', err));
      
      // Schedule periodic price refresh (every 30 minutes)
      this._schedulePriceRefresh();
    }

    // Push device settings immediately so planning page has correct values after restart
    // (normally pushed on every _runPolicyCheck, but that runs with a delay)
    const s = this.getSettings();
    this.homey.settings.set('device_settings', {
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
        await this._runPolicyCheck();
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

      await this._runPolicyCheck();

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
        if (houseConsumptionW > 0) {
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
          this.homey.settings.set('today_self_sufficiency', {
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

        // Get current sun score and time
        const currentHour = new Date().getHours();
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
      if (this.getCapabilityValue('policy_enabled')) {
        this._runPolicyCheck().catch(err => this.error('Slot-aligned policy check failed:', err));
      }
      this.policyCheckInterval = this.homey.setInterval(async () => {
        if (this.getCapabilityValue('policy_enabled')) {
          await this._runPolicyCheck();
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

      // Bereken verwachte PV-productie vandaag (kWh) op basis van straling + piekvermogen
      const pvCapW = devSettings.pv_capacity_w || 0;
      const PR     = devSettings.pv_performance_ratio || 0.75;
      if (Array.isArray(this.weatherData.dailyProfiles)) {
        const todayDate    = new Date().toISOString().slice(0, 10);
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
      } else {
        this.weatherData.pvKwhToday = null;
      }

      const sunScore = this.weatherForecaster.calculateSunScore(this.weatherData);

      await this.setCapabilityValue('sun_score', sunScore);
      await this.setCapabilityValue(
        'predicted_sun_hours',
        parseFloat(this.weatherData.sunshineNext4Hours.toFixed(1))
      );

      this.log('Weather updated:', {
        sun4h: this.weatherData.sunshineNext4Hours,
        sunScore
      });

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

  async _runPolicyCheck() {
    if (this._policyCheckRunning) {
      this.log('Policy check already in progress, skipping concurrent call');
      return;
    }
    this._policyCheckRunning = true;
    try {
      if (!this.getCapabilityValue('policy_enabled')) {
        this.log('Policy disabled, skipping check');
        return;
      }

      const overrideUntil = this.getStoreValue('override_until');
      if (overrideUntil && new Date(overrideUntil) > new Date()) {
        this.log('Manual override active, skipping policy check');
        return;
      }

      // ⭐ HW Slim laden (predictive) actief → volledige policy check overslaan
      if (this.p1Device) {
        const currentHwMode = this.p1Device.getCapabilityValue('battery_group_charge_mode');
        if (currentHwMode === 'predictive') {
          this.log('🤖 HW Slim laden (predictive) actief — policy engine volledig gepauzeerd, cloud stuurt batterij aan');
          return;
        }
      }

      const inputs = await this._gatherInputs();
      if (!inputs.battery || inputs.battery.stateOfCharge === undefined) {
        this.log('Skipping policy check — battery state not ready');
        return;
      }

      // Recompute optimizer schedule if stale (lazy, every ~90 min or after price update)
      if (this.optimizationEngine.isStale() && inputs.tariff) {
        await this._recomputeOptimizer(inputs);
      }
      inputs.optimizer = this.optimizationEngine;
      inputs.optimizerSlots = this.optimizationEngine._schedule?.slots ?? null;

      const result = this.policyEngine.calculatePolicy(inputs);

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

      if (!this.explainabilityEngine) {
        this.explainabilityEngine = new (require('../../lib/explainability-engine'))(this.homey);
        _memMB('after-lazy-load-explainability');
      }
      const explanation = this.explainabilityEngine.generateExplanation(
        result,
        inputs,
        result.scores
      );

      this.homey.api.realtime('explainability_update', explanation);

      this.homey.settings.set('policy_explainability', explanation);

      this.log('Saving explainability length:', JSON.stringify(explanation).length);
      
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
      this.homey.settings.set('battery_policy_state', planningData);

      // Push device settings to app settings so planning page can read them
      // (device settings are not accessible via Homey.get() in the settings page)
      this.homey.settings.set('device_settings', {
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
      this.homey.settings.set('battery_efficiency_effective', currentRte);

      await this.setCapabilityValue('recommended_mode', recommended);

      await this.setCapabilityValue('confidence_score', result.confidence);
      // explanation_summary shows the ACTIVE mode, not the recommended mode
      const currentActiveMode = this.getCapabilityValue('active_mode') || recommended;
      const activeSummary = this.explainabilityEngine._generateShortSummary({ hwMode: currentActiveMode }, inputs);
      await this.setCapabilityValue('explanation_summary', activeSummary);
      await this.setCapabilityValue('last_update', new Date().toISOString());

      const previousMode = this.lastRecommendation?.hwMode || this.lastRecommendation?.policyMode;
      const currentMode = result.hwMode || result.policyMode;
      const modeChanged = previousMode !== currentMode;

      if (modeChanged && this.getSetting('enable_policy_notifications')) {
        try {
          await this.homey.notifications.createNotification({
            excerpt: explanation.summary
          });
        } catch (err) {
          this.error('Failed to send policy notification:', err);
        }
      }

      this.lastRecommendation = result;

      this.log('Policy check complete:', {
        mode: currentMode,
        confidence: result.confidence,
        summary: explanation.summary
      });

      // Store compact diagnostic for user-facing troubleshooting (settings page).
      if (result.debug) {
        result.debug.appVersion = require('../../app.json').version;
        this.homey.settings.set('policy_last_run_debug', result.debug);
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
          this.homey.settings.set('policy_mode_history', modeHistory);
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
          // Patch currentMode in already-saved planningData (avoid 2nd settings.set)
          planningData.currentMode = actualHwMode;
          this.homey.settings.set('battery_policy_state', planningData);

          // Always sync explanation_summary to the actual hardware mode
          const hwActiveSummary = this.explainabilityEngine._generateShortSummary(
            { hwMode: actualHwMode },
            inputs
          );
          await this.setCapabilityValue('explanation_summary', hwActiveSummary).catch(this.error);
        }
      }

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

  _saveWidgetData() {
    const schedule  = this.homey.settings.get('policy_optimizer_schedule') || [];
    const state     = this.homey.settings.get('battery_policy_state')      || {};
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

    const slots = [...pastSlots, ...futureSlots]
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

    this.homey.settings.set('policy_widget_data', compact);
    this.homey.api.realtime('planning-update', compact);
    this.log(`[Widget] Data saved: ${slots.length} slots`);

    // Camera image in device UI (fire-and-forget)
    this._updatePlanningChart(compact).catch(e => this.error('Camera image update failed:', e));
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
    const rawPrices = (raw15min?.length > 0)
      ? raw15min.filter(p => new Date(p.timestamp) >= now)
      : (inputs.tariff?.allPrices || inputs.tariff?.next24Hours);
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
          // Yield factor slot index: hour*4 (hourly data always on the hour, minutes=0)
          const slotIdx = d.getUTCHours() * 4;
          const rawPvW = learnedSlots >= 10
            ? Math.round(h.radiationWm2 * (yfs[slotIdx] ?? 0))
            : pvCapacityW > 0 ? Math.round(pvCapacityW * pvPR * (h.radiationWm2 / 1000)) : 0;
          // Cap at installed system capacity — learned yield factors can overshoot on
          // exceptional days, but the inverter/system can never exceed its rated peak.
          const pvW = pvCapacityW > 0 ? Math.min(rawPvW, pvCapacityW) : rawPvW;
          return { timestamp: d.toISOString(), pvPowerW: pvW };
        })
        .filter(h => h.pvPowerW > 0 || pvCapacityW > 0);

      // Expose tomorrow's PV kWh to the policy engine so it can make better
      // preserve/discharge decisions without relying solely on Open-Meteo sunshine_duration.
      if (pvForecast && inputs.weather) {
        const tomorrowDateStr = new Date(now.getTime() + 86_400_000)
          .toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        const pvWhTomorrow = pvForecast
          .filter(({ timestamp }) =>
            new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' }) === tomorrowDateStr)
          .reduce((sum, { pvPowerW }) => sum + pvPowerW, 0); // W × 1h each = Wh
        inputs.weather.pvKwhTomorrow = Math.round(pvWhTomorrow / 100) / 10; // 1 decimal
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
    const minDischargePrice = respectMinMax
      ? (inputs.settings?.min_discharge_price ?? 0)
      : (inputs.settings?.opportunistic_discharge_floor ?? 0.20);
    // Internal margin: planning assumes 20% higher consumption than learned average
    // while the learning engine is still building up per-weekday evening patterns.
    const consumptionMargin = 1.20;
    this.optimizationEngine.compute(prices, soc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin);

    // Persist planning schedule for the settings UI (single source of truth).
    // Frontend reads 'policy_optimizer_schedule' and renders it directly — no re-simulation.
    const slots = this.optimizationEngine._schedule?.slots;
    if (slots?.length > 0) {
      const planningSchedule = this.policyEngine.buildPlanningSchedule(slots, pvForecast ?? null);
      // Enrich with consumption sample count for confidence display in the UI
      if (this.learningEngine) {
        for (const slot of planningSchedule) {
          slot.sampleCount = this.learningEngine.getConsumptionSampleCount(new Date(slot.timestamp));
        }
      }
      this.homey.settings.set('policy_optimizer_schedule', planningSchedule);

      // ── SoC plan snapshot: first planned SoC per slot, never overwritten ──
      // Allows the frontend to show "planned XX%" alongside actual SoC for past slots.
      try {
        const nowTs = Date.now();
        let socPlan = this.homey.settings.get('policy_soc_plan') || {};
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
        if (changed) this.homey.settings.set('policy_soc_plan', socPlan);
      } catch (e) { /* non-critical */ }

      // ── Battery expansion analysis (non-critical) ──────────────────────────
      // Runs DP for 1–4 battery scenarios to show the marginal value of each
      // additional unit. _schedule is NOT touched by computeExpectedProfit().
      try {
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
            pvForecast, learnedRte, consumptionWPerSlot, minDischargePrice, consumptionMargin
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
        const today = new Date().toISOString().slice(0, 10);
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
        this.homey.settings.set('expansion_profit_history', hist);

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

        this.homey.settings.set('battery_expansion_analysis', {
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
          this.homey.settings.set('policy_consumption_profile', {
            timestamp: new Date().toISOString(),
            days,
          });
        }
      } catch (e) {
        this.error('Consumption profile save failed (non-critical):', e);
      }
    }

    // Persist hourly PV forecast so the settings chart uses the same values as the optimizer.
    // Keyed by Amsterdam local hour (0-23) for the next 48h (today + tomorrow).
    if (Array.isArray(pvForecast) && pvForecast.length > 0) {
      const now         = new Date();
      const nowAmsDate  = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
      const nowAmsHour  = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
      const pvForecastByDay = [{}, {}];

      // Future hours: one pvForecast entry per hour — map directly by Amsterdam local hour.
      for (const { timestamp, pvPowerW } of pvForecast) {
        const t      = new Date(timestamp);
        const tDate  = t.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
        const tHour  = parseInt(t.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
        const dayIdx = tDate === nowAmsDate ? 0 : 1;
        if (dayIdx === 0 || tDate > nowAmsDate) {
          pvForecastByDay[dayIdx][tHour] = pvPowerW;
        }
      }

      // Past hours today: apply the same learned yield factors to dailyProfiles radiation so
      // the chart line is consistent across the full day. Without this, past hours fall back to
      // pvCapW × PR × radiation/1000 which underestimates partial-sunrise slots (e.g. the first
      // morning slot after DST where the sun rose mid-hour but learned data knows the real yield).
      if (learnedSlots >= 10 && yfs && Array.isArray(inputs.weather?.dailyProfiles)) {
        for (const h of inputs.weather.dailyProfiles) {
          const d     = h.time instanceof Date ? h.time : new Date(h.time);
          const hDate = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
          if (hDate !== nowAmsDate) continue;
          const hHour = parseInt(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' }), 10);
          if (hHour >= nowAmsHour) continue;            // only truly past hours
          if (pvForecastByDay[0][hHour] != null) continue; // don't overwrite future slots
          const rawPvW = Math.round(h.radiationWm2 * (yfs[d.getUTCHours() * 4] ?? 0));
          pvForecastByDay[0][hHour] = pvCapacityW > 0 ? Math.min(rawPvW, pvCapacityW) : rawPvW;
        }
      }

      this.homey.settings.set('policy_pv_forecast_hourly', pvForecastByDay);
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

    this.homey.settings.set('policy_pv_actual_today', {
      date:   this._pvActualHourly.date,
      hourly: this._pvActualHourly.hourly,
      sums:   this._pvActualHourly.sums,
      counts: this._pvActualHourly.counts,
    });
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
    this.homey.settings.set('policy_debug_top3low', debugTopLowText);
    this.homey.settings.set('policy_debug_top3high', debugTopHighText);
    
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
      this.homey.settings.set('policy_weather_hourly', hourlyWeather);
      if (weatherData.fetchedAt) {
        this.homey.settings.set('policy_weather_fetched_at', new Date(weatherData.fetchedAt).toISOString());
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
        reason: explanation.summary
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
          if (!this._chartToday || !this._chartToday.slots?.length) { stream.end(); return; }
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
          if (!this._chartTomorrow || !this._chartTomorrow.slots?.length) { stream.end(); return; }
          await this._streamQuickChart(stream, this._chartTomorrow);
        });
        await this.setCameraImage('planning_tomorrow', 'Batterij Morgen', this.planningImageTomorrow);
        this._chartHashTomorrow = null; // force first update
      }
      if (tomorrowSlots.length > 0 && hashTomorrow !== this._chartHashTomorrow) {
        await this.planningImageTomorrow.update();
        this._chartHashTomorrow = hashTomorrow;
      }

      this.log('📊 Planning chart camera images updated (today + tomorrow)');
    } catch (err) {
      this.error('Failed to update planning chart:', err);
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
            data: socs,
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

    // If battery is physically empty, wipe stale cost tracking in persistent store
    const minSoc = this.getSetting('min_soc') ?? 0;
    if (soc !== null && soc <= Math.max(minSoc, 1)) {
      if ((this._costEnergy || 0) > 0 || (this._costAvg || 0) > 0) {
        this.log(`💰 CostModel RESET: SoC ${soc}% <= ${Math.max(minSoc, 1)}% → clearing stale energy`);
        this._costEnergy = 0;
        this._costAvg = 0;
        await this.setStoreValue('battery_energy_kwh', 0);
        await this.setStoreValue('battery_avg_cost', 0);
      }
      return;
    }

    // Initialize in-memory accumulators from store on first call
    if (this._costEnergy === undefined) {
      this._costEnergy = await this.getStoreValue('battery_energy_kwh') || 0;
      this._costAvg = await this.getStoreValue('battery_avg_cost') || 0;
    }

    // Log every 60s (every 12th call)
    this._costModelCallCount = (this._costModelCallCount || 0) + 1;
    if (this._costModelCallCount % 12 === 0) {
      this.log(`💰 CostModel: batteryPower=${batteryPower}W, deltaKwh=${deltaKwh.toFixed(6)}, energy=${this._costEnergy.toFixed(3)}kWh, avgCost=€${this._costAvg.toFixed(4)}, pvState=${pvState}`);
    }

    if (Math.abs(deltaKwh) < 0.000001) return; // effectively zero

    let costNew;

    if (batteryPower > 10) {
      // Charging
      if (pvState) {
        const pvMode = await this.getStoreValue('pv_cost_mode') || 'hybrid';
        const feedIn = await this.getStoreValue('feed_in_tariff') || 0.10;

        if (pvMode === 'free') costNew = 0;
        else if (pvMode === 'feedin') costNew = feedIn;
        else costNew = feedIn < 0.08 ? 0 : feedIn;
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
      // Discharging
      this._costEnergy = Math.max(0, this._costEnergy + deltaKwh);

      if (this._costModelCallCount % 12 === 0) {
        if (debug) this.log(`💰 CostModel discharge: ${deltaKwh.toFixed(5)}kWh, total ${this._costEnergy.toFixed(3)}kWh`);
      }
    }

    // Persist to store every 2 minutes (every 8th call) instead of every 15s
    if (this._costModelCallCount % 8 === 0) {
      await this.setStoreValue('battery_energy_kwh', this._costEnergy);
      await this.setStoreValue('battery_avg_cost', this._costAvg);
    }
  }


}

module.exports = BatteryPolicyDevice;