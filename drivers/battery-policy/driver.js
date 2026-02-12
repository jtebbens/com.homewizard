'use strict';

const Homey = require('homey');

class BatteryPolicyDriver extends Homey.Driver {

  async onInit() {
    this.log('BatteryPolicyDriver initialized');

    // Register flow cards
    this._registerFlowCards();
  }

  /**
   * Register flow cards
   * @private
   */
  _registerFlowCards() {
    // Trigger: Recommendation changed
    this.homey.flow.getDeviceTriggerCard('policy_recommendation_changed')
      .registerRunListener(async (args, state) => {
        return true;
      });

    // Trigger: Mode applied
    this.homey.flow.getDeviceTriggerCard('policy_mode_applied')
      .registerRunListener(async (args, state) => {
        return true;
      });

    // Trigger: Override set
    this.homey.flow.getDeviceTriggerCard('policy_override_set')
      .registerRunListener(async (args, state) => {
        return true;
      });

    // Condition: Policy enabled
    this.homey.flow.getConditionCard('policy_is_enabled')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('policy_enabled');
      });

    // Condition: Confidence above threshold
    this.homey.flow.getConditionCard('confidence_above')
      .registerRunListener(async (args) => {
        const confidence = args.device.getCapabilityValue('confidence_score');
        return confidence >= args.threshold;
      });

    // Condition: Recommended mode is
    this.homey.flow.getConditionCard('recommended_mode_is')
      .registerRunListener(async (args) => {
        const mode = args.device.getCapabilityValue('recommended_mode');
        return mode === args.mode;
      });

    // Condition: Sun score above
    this.homey.flow.getConditionCard('sun_score_above')
      .registerRunListener(async (args) => {
        const sunScore = args.device.getCapabilityValue('sun_score');
        return sunScore >= args.threshold;
      });

    // Action: Enable policy
    this.homey.flow.getActionCard('enable_policy')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('policy_enabled', true);
      });

    // Action: Disable policy
    this.homey.flow.getActionCard('disable_policy')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('policy_enabled', false);
      });

    // Action: Set policy mode
    this.homey.flow.getActionCard('set_policy_mode')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('policy_mode', args.mode);
      });

    // Action: Enable auto-apply
    this.homey.flow.getActionCard('enable_auto_apply')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('auto_apply', true);
      });

    // Action: Disable auto-apply
    this.homey.flow.getActionCard('disable_auto_apply')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('auto_apply', false);
      });

    // Action: Set manual override
    this.homey.flow.getActionCard('set_override')
      .registerRunListener(async (args) => {
        await args.device.setManualOverride(args.duration);
      });

    // Action: Clear override
    this.homey.flow.getActionCard('clear_override')
      .registerRunListener(async (args) => {
        await args.device.clearManualOverride();
      });

    // Action: Force policy check
    this.homey.flow.getActionCard('force_policy_check')
      .registerRunListener(async (args) => {
        await args.device._runPolicyCheck();
      });

    // Action: Refresh weather
    this.homey.flow.getActionCard('refresh_weather')
      .registerRunListener(async (args) => {
        args.device.weatherForecaster.invalidateCache();
        await args.device._updateWeather();
      });

    // Action: Set weather override
    this.homey.flow.getActionCard('set_weather_override')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('weather_override', args.override);
      });

    this.log('Flow cards registered');
  }

  /**
   * Pairing sequence
   * Koppel aan een P1 (energy_v2) device
   */
  async onPair(session) {
    let selectedP1Id = null;

    // Stap 1: lijst met P1 devices
    session.setHandler('list_devices', async () => {
      const driver = this.homey.drivers.getDriver('energy_v2');
      if (!driver) {
        this.log('energy_v2 driver not found during pairing');
        return [];
      }

      const devices = driver.getDevices();

      return devices.map(device => ({
        name: `Battery Policy: ${device.getName()}`,
        data: {
          id: `policy_${device.getData().id}`
        },
        settings: {
          p1_device_id: device.getData().id
        }
      }));
    });

    // Stap 2: selectie verwerken (optioneel, maar netjes)
    session.setHandler('list_devices_selection', async (devices) => {
      if (devices && devices.length > 0) {
        selectedP1Id = devices[0].settings.p1_device_id;
        this.log('Selected P1 device for policy:', selectedP1Id);
        return true;
      }
      return false;
    });
  }

  /**
   * Device repair (voor opnieuw koppelen aan P1 device)
   */
  async onRepair(session, device) {
    session.setHandler('list_devices', async () => {
      const driver = this.homey.drivers.getDriver('energy_v2');
      if (!driver) {
        this.log('energy_v2 driver not found during repair');
        return [];
      }

      const devices = driver.getDevices();

      return devices.map(p1Device => ({
        name: p1Device.getName(),
        data: {
          id: p1Device.getData().id
        }
      }));
    });

    session.setHandler('list_devices_selection', async (devices) => {
      if (devices && devices.length > 0) {
        const newP1Id = devices[0].data.id;

        await device.setSettings({
          p1_device_id: newP1Id
        });

        // Reconnect naar P1
        if (typeof device._connectP1Device === 'function') {
          await device._connectP1Device();
        }

        this.log('Repaired policy device to P1:', newP1Id);
        return true;
      }
      return false;
    });
  }
}

module.exports = BatteryPolicyDriver;
