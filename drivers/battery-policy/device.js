'use strict';

const Homey = require('homey');
const WeatherForecaster = require('../../lib/weather-forecaster');
const PolicyEngine = require('../../lib/policy-engine');
const TariffManager = require('../../lib/tariff-manager');
const ExplainabilityEngine = require('../../lib/explainability-engine');
const SunMultiSource = require('../../lib/sun-multisource');

class BatteryPolicyDevice extends Homey.Device {

  async onInit() {
    this.log('BatteryPolicyDevice initialized');

    // Components
    this.weatherForecaster = new WeatherForecaster(this.homey);
    this.policyEngine = new PolicyEngine(this.homey, this.getSettings());
    this.tariffManager = new TariffManager(this.homey, this.getSettings());
    this.explainabilityEngine = new ExplainabilityEngine(this.homey);
    this.sunMulti = new SunMultiSource(this.homey);

    // State
    this.p1Device = null;
    this.weatherData = null;
    this.lastRecommendation = null;

    await this._initializeCapabilities();
    this._registerCapabilityListeners();

    // Connect P1 after short delay
    this.homey.setTimeout(() => {
      this._connectP1Device().catch(err => this.error(err));
    }, 1500);

    // Schedule periodic checks
    this._schedulePolicyCheck();

    // Weather fetch only in dynamic
    if (this.getSettings().tariff_type === 'dynamic') {
      this._updateWeather().catch(err =>
        this.error('Initial weather fetch failed:', err)
      );
    }

    this.log('BatteryPolicyDevice ready');
  }

  async _initializeCapabilities() {
    const defaults = {
      policy_mode: 'balanced',
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
      battery_soc_mirror: 50,
      grid_power_mirror: 0,
      last_update: new Date().toISOString(),
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
      const soc =
        this.p1Device.getCapabilityValue('battery_group_average_soc') ??
        50;

      const gridPower =
        this.p1Device.getCapabilityValue('measure_power') ?? 0;

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
      // ⭐ REALTIME PV STATE CHANGE DETECTIE
      // ------------------------------------------------------
      const prevGrid = this._prevGridPower ?? 0;

      const hadPV = prevGrid < -100;   // export → PV overschot
      const hasPV = gridPower < -100;

      if (hadPV !== hasPV) {
        this.log(`⚡ PV state changed (${hadPV} → ${hasPV}) → running policy immediately`);
        this._runPolicyCheck().catch(err => this.error(err));
      }

      this._prevGridPower = gridPower;

    } catch (err) {
      this.error('Error polling P1 capabilities:', err);
    }
  }, 5000);

  this.log('✅ P1 capability polling started (5s interval)');
}


  _schedulePolicyCheck() {
    const intervalMinutes = this.getSetting('policy_interval') || 15;
    const intervalMs = intervalMinutes * 60 * 1000;

    if (this.policyCheckInterval) {
      this.homey.clearInterval(this.policyCheckInterval);
    }

    this.policyCheckInterval = this.homey.setInterval(
      async () => {
        if (this.getCapabilityValue('policy_enabled')) {
          await this._runPolicyCheck();
        }
      },
      intervalMs
    );

    this.log(`Policy check scheduled every ${intervalMinutes} minutes`);
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

      this.weatherData = await this.weatherForecaster.fetchForecast(latitude, longitude);

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

      const result = this.policyEngine.calculatePolicy(inputs);

      const explanation = this.explainabilityEngine.generateExplanation(
        result,
        inputs,
        result.scores
      );

      this.homey.api.realtime('explainability_update', explanation);

      this.homey.settings.set('policy_explainability', explanation);

      this.log('Saving explainability length:', JSON.stringify(explanation).length);

      const recommended = result.hwMode || result.policyMode || 'standby';
      await this.setCapabilityValue('recommended_mode', recommended);

      await this.setCapabilityValue('confidence_score', result.confidence);
      await this.setCapabilityValue('explanation_summary', explanation.shortSummary);
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

      await this.setStoreValue('last_explanation', explanation);

      this.lastRecommendation = result;

      this.log('Policy check complete:', {
        mode: currentMode,
        confidence: result.confidence,
        summary: explanation.summary
      });

      await this._triggerRecommendationChanged(result, explanation);

      const autoApplyEnabled = this.getCapabilityValue('auto_apply');
      this.log(`Auto-apply status: ${autoApplyEnabled ? 'ENABLED' : 'DISABLED'}`);

      if (autoApplyEnabled) {
        const applyMode = result.hwMode || result.policyMode;
        this.log(`Attempting to apply recommendation: ${applyMode} (confidence: ${result.confidence}%)`);
        const applied = await this._applyRecommendation(applyMode, result.confidence);

        if (applied) {
          this.log(`✅ Successfully applied: ${applyMode}`);
        } else {
          this.log(`⚠️ Failed to apply recommendation`);
        }
      } else {
        this.log('Auto-apply disabled — recommendation not applied');
      }

    } catch (error) {
      this.error('Policy check failed:', error);
      await this.setCapabilityValue('explanation_summary',
        `Error: ${error.message}`
      );
    }
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

    let sun = null;
    const loc = await this._getLocationFromSetting();

    if (loc) {
      const { latitude, longitude } = loc;

      this.log("SunMulti loc:", loc);

      const gfs = await this.sunMulti.fetchGFS(latitude, longitude);
      const harmonie = await this.sunMulti.fetchHarmonie(latitude, longitude);

      this.log("SunMulti GFS sunshine sample:", gfs?.hourly?.sunshine_duration?.slice(0, 6));
      this.log("SunMulti ICON-D2 sunshine sample:", harmonie?.hourly?.sunshine_duration?.slice(0, 6));

      const sunScoreGFS = this.sunMulti.calculateSunScore(
        gfs?.hourly?.sunshine_duration,
        gfs?.hourly?.time
      );

      const sunScoreHarmonie = this.sunMulti.calculateSunScore(
        harmonie?.hourly?.sunshine_duration,
        harmonie?.hourly?.time
      );

      const consistency = this.sunMulti.compareScores(sunScoreGFS, sunScoreHarmonie);

      this.log("SunMulti scores:", sunScoreGFS, sunScoreHarmonie, consistency);

      sun = {
        gfs: sunScoreGFS,
        harmonie: sunScoreHarmonie,
        consistent: consistency.consistent,
        diff: consistency.diff
      };
    }

    const batteryState = await this._getBatteryState();
    const tariffInfo = this.tariffManager.getCurrentTariff(batteryState.gridPower);

    const debugPrice = tariffInfo?.currentPrice ?? 'n/a';
    const debugTopLow = Array.isArray(tariffInfo?.top3Lowest)
      ? tariffInfo.top3Lowest.map(p => Number(p).toFixed(3)).join(',')
      : 'n/a';
    const debugTopHigh = Array.isArray(tariffInfo?.top3Highest)
      ? tariffInfo.top3Highest.map(p => Number(p).toFixed(3)).join(',')
      : 'n/a';
    const debugSun4h = Number(weatherData?.sunshineNext4Hours ?? 0).toFixed(1);
    const debugSun8h = Number(weatherData?.sunshineNext8Hours ?? 0).toFixed(1);
    const debugSunToday = Number(weatherData?.sunshineTodayRemaining ?? 0).toFixed(1);
    const debugSunTomorrow = Number(weatherData?.sunshineTomorrow ?? 0).toFixed(1);

    const debugRate = tariffInfo?.currentRate ?? 'n/a';
    const debugPriceText = `price=${debugPrice} rate=${debugRate}`;
    const debugTopLowText = `low=[${debugTopLow}]`;
    const debugTopHighText = `high=[${debugTopHigh}]`;
    const debugSunText = `4h=${debugSun4h} 8h=${debugSun8h} today=${debugSunToday} tmw=${debugSunTomorrow}`;

    await this.setCapabilityValue('policy_debug_price', debugPriceText).catch(this.error);
    await this.setCapabilityValue('policy_debug_top3low', debugTopLowText).catch(this.error);
    await this.setCapabilityValue('policy_debug_top3high', debugTopHighText).catch(this.error);
    await this.setCapabilityValue('policy_debug_sun', debugSunText).catch(this.error);

    const p1 = {
      resolved_gridPower: batteryState.gridPower,
      battery_power: batteryState.groupPower
    };

    return {
      weather: (settings.tariff_type === 'dynamic') ? weatherData : null,
      battery: batteryState,
      tariff: tariffInfo,
      time: new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })),
      policyMode: this.getCapabilityValue('policy_mode'),
      settings,
      p1,
      sun
    };
  }

  _applyWeatherOverride(weatherData, override) {
    const modified = { ...weatherData };

    switch (override) {
      case 'sunny':
        modified.sunshineNext4Hours = 4;
        modified.cloudCover = 0;
        modified.precipitationProbability = 0;
        break;

      case 'cloudy':
        modified.sunshineNext4Hours = 0.5;
        modified.cloudCover = 80;
        modified.precipitationProbability = 20;
        break;

      case 'rainy':
        modified.sunshineNext4Hours = 0;
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
      groupPower: 0
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

      await this.setCapabilityValue('battery_soc_mirror', soc).catch(this.error);
      await this.setCapabilityValue('grid_power_mirror', gridPower).catch(this.error);

      return {
        stateOfCharge: soc,
        health: 100,
        cycles: 0,
        gridPower,
        mode: groupMode,
        groupPower,
        totalCapacityKwh: totalCapacity
      };

    } catch (error) {
      this.error('Failed to get battery state from P1:', error);
      return fallback;
    }
  }

async _applyRecommendation(mode, confidence) {
  const minConfidence = this.getSetting('min_confidence_threshold') || 60;

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

    this.policyEngine.updateSettings(newSettings);
    this.tariffManager.updateSettings(newSettings);

    if (changedKeys.includes('policy_interval')) {
      this._schedulePolicyCheck();
    }

    if (changedKeys.includes('weather_location')) {
      this.weatherForecaster.invalidateCache();
      await this._updateWeather();
    }

    if (changedKeys.includes('p1_device_id')) {
      await this._connectP1Device();
    }

    if (
      changedKeys.includes('policy_interval') ||
      changedKeys.includes('weather_location') ||
      changedKeys.includes('p1_device_id')
    ) {
      await this._runPolicyCheck();
    }
  }

  async onDeleted() {
    this.log('BatteryPolicyDevice deleted');

    if (this.policyCheckInterval) {
      this.homey.clearInterval(this.policyCheckInterval);
    }

    if (this._p1PollInterval) {
      this.homey.clearInterval(this._p1PollInterval);
      this.log('P1 capability polling stopped');
    }
  }
}

module.exports = BatteryPolicyDevice;
