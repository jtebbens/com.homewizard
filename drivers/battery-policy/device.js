'use strict';

const Homey = require('homey');
const WeatherForecaster = require('../../lib/weather-forecaster');
const PolicyEngine = require('../../lib/policy-engine');
const TariffManager = require('../../lib/tariff-manager');
const ExplainabilityEngine = require('../../lib/explainability-engine');
const LearningEngine = require('../../lib/learning-engine');
const BatteryChartGenerator = require('../../lib/battery-chart-generator');
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
    this.explainabilityEngine = new ExplainabilityEngine(this.homey);
    this.chartGenerator = new BatteryChartGenerator(this.homey);
    this.efficiencyEstimator = new EfficiencyEstimator(this.homey);
    this.optimizationEngine = new OptimizationEngine(this.getSettings());


    // State
    this.p1Device = null;
    this.weatherData = null;
    this.lastRecommendation = null;
    this._lastPvEstimateW = 0; // For EMA smoothing
    this._pvProductionW = null; // User-provided PV production via flow card
    this._pvProductionTimestamp = null; // When the PV data was last updated
    this._pvState = false; // Track PV state with hysteresis
    this._lastPvPolicyRun = null; // Debounce PV-triggered policy runs

    await this._initializeCapabilities();
    _memMB('after-initializeCapabilities');
    this._registerCapabilityListeners();

    // Connect P1 after short delay
    this.homey.setTimeout(() => {
      this._connectP1Device().catch(err => this.error(err));
    }, 1500);

    // Schedule periodic checks
    this._schedulePolicyCheck();

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
      battery_efficiency:  s.battery_efficiency  || 0.78,
      min_profit_margin:   s.min_profit_margin   || 0.01,
      tariff_type:         s.tariff_type         || 'dynamic',
      policy_interval:     s.policy_interval     || 15,
      pv_capacity_w:       s.pv_capacity_w       || 0,
      pv_estimation_enabled: s.pv_estimation_enabled || false,
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
      battery_rte: 0.78,
      last_update: new Date().toISOString(),
      active_mode: 'unknown',
      override_until: null,
      weather_override: 'auto'
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
            this.log(
              `[RTE] learning: charged=${chargedWh}Wh / 1000Wh, discharged=${dischargedWh}Wh / 1000Wh, ` +
              `current RTE=${( s.efficiency * 100).toFixed(1)}%`
            );
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
        if (gridPower > 0) {
          // Only record import (consumption), not export
          await this.learningEngine.recordConsumption(gridPower).catch(err => 
            this.error('Learning consumption recording failed:', err)
          );
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

        // Calculate "virtual export" = what grid would be if battery was in standby
        // If battery is charging (+800W), that PV energy would export to grid instead
        // So subtract charging power: grid=-1100W, batt=+800W → virtual=-1900W
        // If battery is discharging (-800W), that's already reflected in grid reading
        const virtualGridPower = batteryPower > 0 
          ? gridPower - batteryPower  // Charging: subtract to show true export potential
          : gridPower;                 // Discharging/idle: grid reading is accurate

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
    }
    if (this._hourBoundaryTimeout) {
      this.homey.clearTimeout(this._hourBoundaryTimeout);
    }

    // 1) Regular interval as fallback between hour boundaries
    this.policyCheckInterval = this.homey.setInterval(
      async () => {
        if (this.getCapabilityValue('policy_enabled')) {
          await this._runPolicyCheck();
        }
      },
      intervalMs
    );

    // 2) Align to hour boundaries — prices change on the hour.
    //    Schedule a run ~5s after each full hour to catch new prices immediately.
    this._scheduleHourBoundary();

    this.log(`Policy check scheduled every ${intervalMinutes} minutes + aligned to hour boundaries`);
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
      const hour = new Date().getHours();
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
            this.log(`🔄 Refreshing prices... (${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')})`);

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

      const loc = await this._getLocationFromSetting();
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

        let todayKwh;
        if (learnedSlots >= 10) {
          // Learned model: sum(radiation × yieldFactor) / 1000 — no pvCapW or PR needed
          todayKwh = todayProfiles.reduce((sum, h) => {
            const slotIndex = h.time.getUTCHours() * 4;
            const yf = yfs[slotIndex] ?? 0;
            return sum + h.radiationWm2 * yf;
          }, 0) / 1000;
          this.log(`☀️ PV forecast (learned, ${learnedSlots} slots): ${todayKwh.toFixed(1)} kWh`);
        } else if (pvCapW > 0) {
          // Fallback: configured capacity × performance ratio
          todayKwh = todayProfiles.reduce((sum, h) => sum + pvCapW * PR * (h.radiationWm2 / 1000), 0) / 1000;
          this.log(`☀️ PV forecast (fallback PR=${PR}, ${learnedSlots} slots learned): ${todayKwh.toFixed(1)} kWh`);
        } else {
          todayKwh = null;
        }
        this.weatherData.pvKwhToday = todayKwh !== null ? Math.round(todayKwh * 10) / 10 : null;
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

  async _getLocationFromSetting() {
    const settings = this.getSettings();

    if (settings.tariff_type !== 'dynamic') {
      return null;
    }

    const loc = this.getSetting('weather_location');

    if (!loc || loc.trim() === '') {
      this.error('Weather location not set (dynamic mode)');
      return null;
    }

    if (loc.includes(',')) {
      const [lat, lon] = loc.split(',').map(v => v.trim());
      if (!isNaN(lat) && !isNaN(lon)) {
        return { latitude: parseFloat(lat), longitude: parseFloat(lon) };
      }
      this.error('Invalid lat/lon format');
      return null;
    }

    const geo = await this.weatherForecaster.lookupCity(loc);
    if (!geo) {
      this.error(`Could not resolve location: ${loc}`);
      return null;
    }

    return {
      latitude: geo.latitude,
      longitude: geo.longitude
    };
  }

  async _runPolicyCheck() {
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

      const inputs = await this._gatherInputs();
      if (!inputs.battery || inputs.battery.stateOfCharge === undefined) {
        this.log('Skipping policy check — battery state not ready');
        return;
      }

      // Recompute optimizer schedule if stale (lazy, every ~90 min or after price update)
      if (this.optimizationEngine.isStale() && inputs.tariff) {
        this._recomputeOptimizer(inputs);
      }
      inputs.optimizer = this.optimizationEngine;

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
        result.confidence = Math.max(0, Math.min(100, result.confidence + confidenceAdjustment));
        this.log(`📊 Learning adjusted confidence: ${originalConfidence} → ${result.confidence} (${confidenceAdjustment > 0 ? '+' : ''}${confidenceAdjustment})`);
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
      const planningData = {
        batterySOC,
        policyMode,
        recommendedMode: recommended,
        currentMode: recommended, // will be overwritten below with actual HW mode
        maxDischargePowerW: inputs.battery?.maxDischargePowerW || 800,
        maxChargePowerW: inputs.battery?.maxChargePowerW || 800,
        totalCapacityKwh: inputs.battery?.totalCapacityKwh || null,
        batteryCount: Math.max(1, Math.round((inputs.battery?.totalCapacityKwh ?? 2.688) / 2.688)),
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
        battery_efficiency:  this.getSetting('battery_efficiency') || 0.78,
        min_profit_margin:   this.getSetting('min_profit_margin')   || 0.01,
        tariff_type:         this.getSetting('tariff_type')         || 'dynamic',
        policy_interval:     this.getSetting('policy_interval')     || 15,
        pv_capacity_w:          this.getSetting('pv_capacity_w')          || 0,
        pv_estimation_enabled:  this.getSetting('pv_estimation_enabled')  || false,
        pv_performance_ratio:   this.getSetting('pv_performance_ratio')   || 0.75,
      });
      // debug_top3 writes moved to _gatherInputs (single write)

      // Update battery RTE display
      // Use learned efficiency with safety bounds (learned can be from old data)
      let currentRte = this.efficiencyEstimator.getEfficiency();
      
      // Safety: Cap at realistic range for LFP batteries (AC-AC typically 70-97%)
      // If learned value is unrealistic, fall back to configured value
      const configuredRte = this.getSetting('battery_efficiency') || 0.78;
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

      await this._triggerRecommendationChanged(result, explanation);

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

          // Append to mode history for planning UI
          try {
            const modeHistory = this.homey.settings.get('policy_mode_history') || [];
            const currentPrice = result.tariff?.currentPrice ?? null;
            const currentSoc   = this.getCapabilityValue('measure_battery') ?? null;
            modeHistory.push({
              ts:     new Date().toISOString(),
              hwMode: applyMode,
              price:  currentPrice,
              soc:    currentSoc,
              maxChargePrice: this.getSetting('max_charge_price'),      
              minDischargePrice: this.getSetting('min_discharge_price') 
            });
            // Keep last 96 entries (24h at 15min intervals)
            if (modeHistory.length > 96) modeHistory.splice(0, modeHistory.length - 96);
            this.homey.settings.set('policy_mode_history', modeHistory);
          } catch (e) {
            this.error('Failed to save mode history:', e);
          }
        } else {
          if (result.confidence < minConfidence) {
            this.log(`⏸️ Not applied: confidence ${result.confidence.toFixed(1)}% below threshold ${minConfidence}%`);
          } else {
            this.log(`⚠️ Failed to apply recommendation — check P1 connection`);
          }
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

    } catch (error) {
      this.error('Policy check failed:', error);
      await this.setCapabilityValue('explanation_summary',
        `Error: ${error.message}`
      );
    }
  }

  /**
   * (Re)compute the OptimizationEngine schedule from the current inputs.
   * Called lazily in _runPolicyCheck whenever the schedule is stale.
   */
  _recomputeOptimizer(inputs) {
    // Prefer 15-min prices for finer-grained optimization; fall back to hourly
    const now = new Date();
    const raw15min = inputs.tariff?.allPrices15min;
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
    if (Array.isArray(inputs.weather?.hourlyForecast)) {
      const yfs          = this.learningEngine?.getSolarYieldFactorsSmoothed();
      const learnedSlots = this.learningEngine?.getSolarLearnedSlotCount() ?? 0;

      pvForecast = inputs.weather.hourlyForecast
        .filter(h => typeof h.radiationWm2 === 'number')
        .map(h => {
          const d   = h.time instanceof Date ? h.time : new Date(h.time);
          const pvW = learnedSlots >= 10
            ? Math.round(h.radiationWm2 * (yfs[(d.getUTCHours() * 4)] ?? 0))
            : pvCapacityW > 0 ? Math.round(pvCapacityW * pvPR * (h.radiationWm2 / 1000)) : 0;
          return { timestamp: d.toISOString(), pvPowerW: pvW };
        })
        .filter(h => h.pvPowerW > 0 || pvCapacityW > 0);
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
        const futureTime = new Date(now.getTime() + h * slotMs);
        const learned = this.learningEngine.getPredictedConsumption(futureTime) ?? 0;
        consumptionWPerSlot.push(Math.max(learned, baseloadW));
      }
    }

    const slotLabel = slotMs === 900_000 ? '15-min' : '1h';
    this.log(`🔮 Optimizer: recomputing schedule (${prices.length} × ${slotLabel} slots, SoC ${soc}%, ${capacityKwh}kWh, PV ${pvCapacityW}W peak, RTE ${learnedRte != null ? (learnedRte * 100).toFixed(0) + '%' : 'default'})`);
    this.optimizationEngine.compute(prices, soc, capacityKwh, maxChargePowerW, maxDischargePowerW, pvForecast, learnedRte, consumptionWPerSlot);

    // Persist planning schedule for the settings UI (single source of truth).
    // Frontend reads 'policy_optimizer_schedule' and renders it directly — no re-simulation.
    const slots = this.optimizationEngine._schedule?.slots;
    if (slots?.length > 0) {
      const planningSchedule = this.policyEngine.buildPlanningSchedule(slots, pvForecast ?? null);
      this.homey.settings.set('policy_optimizer_schedule', planningSchedule);
    }
  }

  /**
   * Update PV production from flow card (user-provided data)
   * @param {number} powerW - PV production in watts
   */
  _updatePvProduction(powerW) {
    this._pvProductionW = powerW;
    this._pvProductionTimestamp = Date.now();

    // Feed live measurement into the solar yield-factor learner.
    // Requires radiation data from the latest weather fetch.
    const radiation = this._getInterpolatedRadiation(Date.now());
    if (radiation !== null && this.learningEngine) {
      this.learningEngine.updateSolarYieldFactor(new Date(), powerW, radiation);
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
    const settings = this.getSettings();

    let weatherData = null;

    if (settings.tariff_type === 'dynamic') {
      if (
        !this.weatherData ||
        !this.weatherData.fetchedAt ||
        Date.now() - this.weatherData.fetchedAt > (3 * 60 * 60 * 1000)
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

    const debugPrice = tariffInfo?.currentPrice ?? 'n/a';
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
    }

    // Estimate PV production using grid analysis + sun model
    // Use next-4h sunshine only — tomorrow's forecast must not inflate the current PV estimate
    const sunScore = weatherData
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

    const batteryEfficiency = Math.min(Math.max(this.efficiencyEstimator.getEfficiency() || 0.78, 0.5), 1.0);

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
      previousHwMode: this.lastRecommendation?.hwMode ?? null
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
      const unitFallbackW = unitCount * 800;

      // ✅ NEW: Get max production and consumption power
      const maxProduction =
        this.p1Device.getCapabilityValue('measure_power.battery_group_max_production_w') ??
        unitFallbackW;

      const maxConsumption =
        this.p1Device.getCapabilityValue('measure_power.battery_group_max_consumption_w') ??
        unitFallbackW;

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
      } else {
        // Fallback: nooit niet‑bestaande modes sturen
        this.log(`⚠️ Unknown logical mode "${mode}", falling back to standby`);
        targetMode = 'standby';
      }

      // ⭐ Lees de ECHTE batterij-mode
      const actualMode = this.p1Device.getCapabilityValue('battery_group_charge_mode');

      this.log(`🔍 Actual HW mode: ${actualMode}, desired: ${targetMode}`);

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
      battery_efficiency:  newSettings.battery_efficiency  || 0.78,
      min_profit_margin:   newSettings.min_profit_margin   || 0.01,
      tariff_type:         newSettings.tariff_type         || 'dynamic',
      policy_interval:     newSettings.policy_interval     || 15,
      pv_capacity_w:       newSettings.pv_capacity_w       || 0,
      pv_estimation_enabled: newSettings.pv_estimation_enabled || false,
    });

    // Handle interval change
    if (changedKeys.includes('policy_interval')) {
      this._schedulePolicyCheck();
    }

    // Weather update
    if (changedKeys.some(k => ['weather_location', 'pv_tilt', 'pv_azimuth'].includes(k))) {
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
      changedKeys.includes('weather_location') ||
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
        battery_efficiency:  newSettings.battery_efficiency || 0.78,
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
      'device_settings',
    ];
    for (const key of settingsToClean) {
      try { this.homey.settings.unset(key); } catch (_) {}
    }

    // Clear p1Device reference
    this.p1Device = null;

    this.log('BatteryPolicyDevice cleanup complete');
  }

  /**
   * Update planning chart camera image
   * @param {Object} inputs - Policy inputs (battery, tariff, weather)
   * @param {Object} result - Policy result with recommendation
   */
  async _updatePlanningChart(inputs, result) {
    try {
      const currentHour = parseInt(
        new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'Europe/Amsterdam' })
      , 10);
      const language = this.homey.i18n.getLanguage();

      // Get hourly prices for next 24 hours
      const prices = [];
      if (inputs.tariff?.top3Low && inputs.tariff?.top3High) {
        // Generate price array from available data
        const allPrices = this.tariffManager.dynamicProvider?.cache || [];
        for (let h = 0; h < 24; h++) {
          const priceData = allPrices.find(p => new Date(p.time).getHours() === h);
          prices.push({
            hour: h,
            price: priceData?.price || inputs.tariff.currentPrice || 0.25
          });
        }
      } else {
        // Fallback: flat rate
        for (let h = 0; h < 24; h++) {
          prices.push({ hour: h, price: 0.25 });
        }
      }

      // Generate mode forecast for next 24 hours
      // Simplified: current mode for all hours (can be enhanced with actual planning)
      const modes = [];
      const currentMode = result.hwMode || result.policyMode || 'standby';
      for (let h = 0; h < 24; h++) {
        modes.push({ hour: h, mode: currentMode });
      }

      // PV forecast (simplified, could use weather hourly data)
      const pvForecast = [];
      const sun4h = inputs.weather?.sun4h || 0;
      // Simple bell curve for daylight hours
      for (let h = 0; h < 24; h++) {
        let kw = 0;
        if (h >= 8 && h <= 17 && sun4h > 0) {
          // Peak at noon
          const distance = Math.abs(h - 12.5);
          kw = Math.max(0, sun4h * (1 - distance / 5));
        }
        pvForecast.push({ hour: h, kw });
      }

      // SoC projection (simple linear discharge/charge based on current mode)
      const socProjection = [];
      let projectedSoC = inputs.battery?.stateOfCharge || 50;
      for (let h = 0; h < 24; h++) {
        socProjection.push({ hour: h, soc: Math.max(20, Math.min(100, projectedSoC)) });
        
        // Simple projection: discharge 2%/h at night, charge 5%/h during PV
        if (h >= 18 || h <= 6) {
          projectedSoC -= 2; // Discharge
        } else if (pvForecast[h].kw > 1) {
          projectedSoC += 5; // Charge from PV
        }
      }

      // Generate chart
      const chartData = {
        prices,
        modes,
        pvForecast,
        socProjection,
        currentHour,
        language
      };

      const imageBuffer = this.chartGenerator.generateChart(chartData);
      
      if (!imageBuffer) {
        // Chart generation disabled (canvas not installed)
        return;
      }

      // Update camera image
      const image = await this.homey.images.createImage();
      await image.setBuffer(imageBuffer);
      await this.setCameraImage('planning', this.homey.__('camera.planning_title'), image);

      this.log('📊 Planning chart updated successfully');

    } catch (err) {
      this.error('Failed to update planning chart:', err);
    }
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