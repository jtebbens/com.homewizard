'use strict';

const Homey = require('homey');
const api = require('../../includes/v2/Api');

const POLL_INTERVAL = 1000 * 1; // 1 seconds

module.exports = class HomeWizardEnergyDeviceV2 extends Homey.Device {

  async onInit() {
    await this._updateCapabilities();
    await this._registerCapabilityListeners();

    const settings = await this.getSettings();
    console.log('Settings for P1 apiv2: ',settings.polling_interval);

    if (settings.polling_interval === undefined) {
      settings.polling_interval = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
    }

    //this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);
    this.token = this.getStoreValue('token');

    this._triggerFlowPrevious = {};
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `https://${discoveryResult.address}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  /**
   * Helper function to update capabilities configuration.
   * This function is called when the device is initialized.
   */
  async _updateCapabilities() {
    if (!this.hasCapability('identify')) {
      await this.addCapability('identify').catch(this.error);
      console.log(`created capability identify for ${this.getName()}`);
    }

    // Remove capabilities that are not needed
    if (this.hasCapability('measure_power.power_w')) {
      await this.removeCapability('measure_power.power_w').catch(this.error);
      console.log(`removed capability measure_power.power_w for ${this.getName()}`);
    }
  }

  /**
   * Helper function to register capability listeners.
   * This function is called when the device is initialized.
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('identify', async (value) => {
      await api.identify(this.url, this.token);
    });
  }

  /**
   * Helper function for 'optional' capabilities.
   * This function is called when the device is initialized.
   * It will create the capability if it doesn't exist.
   *
   * We do not remove capabilities here, as we assume the user may want to keep them.
   * Besides that we assume that the P1 Meter is connected to a smart meter that does not change often.
   *
   * @param {string} capability The capability to set
   * @param {*} value The value to set
   * @returns {Promise<void>} A promise that resolves when the capability is set
   */
  async _setCapabilityValue(capability, value) {
    // Test if value is undefined, if so, we don't set the capability
    if (value === undefined) {
      return;
    }

    // Create a new capability if it doesn't exist
    if (!this.hasCapability(capability)) {
      await this.addCapability(capability).catch(this.error);
    }

    // Set the capability value
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  /**
   * Helper function to trigger flows on change.
   * This function is called when the device is initialized.
   *
   * We use this function to trigger flows when the value changes.
   * We store the previous value in a variable.
   *
   * @param {*} flow_id Flow ID name
   * @param {*} value The value to check for changes
   * @returns {Promise<void>} A promise that resolves when the flow is triggered
   */
  async _triggerFlowOnChange(flow_id, value) {

    // Ignore if value is undefined
    if (value === undefined) {
      return;
    }

    // Check if the value is undefined
    // If so, we assume this is the first time we are setting the value
    // We cannot trust the the 'trigger' function to be called with the correct value
    if (this._triggerFlowPrevious[flow_id] === undefined) {
      this._triggerFlowPrevious[flow_id] = value;
      return;
    }

    // Return of the value is the same as the previous value
    if (this._triggerFlowPrevious[flow_id] === value) {

      // We don't need to trigger the flow
      return;
    }

    // It is a bit 'costly' to get the flow card every time
    // But we can assume the trigger does not change often
    const flow = this.homey.flow.getDeviceTriggerCard(flow_id);
    if (flow === undefined) {
      this.error('Flow not found');
      return;
    }

    // Update value and trigger the flow
    this._triggerFlowPrevious[flow_id] = value;
    flow.trigger(this, { [flow_id]: value }).catch(this.error);
  }

  onPoll() {

    // URL may be undefined if the device is not available
    if (!this.url) return;

    // Check if polling interval is running)
    if (!this.onPollInterval) {
      this.log('Polling interval is not running, starting now...');
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }

    Promise.resolve().then(async () => {

      const data = await api.getMeasurement(this.url, this.token);

      const setCapabilityPromises = [];
      const triggerFlowPromises = [];

      // Values
      /// / Power
      setCapabilityPromises.push(this._setCapabilityValue('measure_power', data.power_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l1', data.power_l1_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l2', data.power_l2_w).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.l3', data.power_l3_w).catch(this.error));

      /// / Tariff
      setCapabilityPromises.push(this._setCapabilityValue('tariff', data.active_tariff).catch(this.error));

      /// / Total consumption
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.consumed', data.energy_import_kwh).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.consumed.t1', data.energy_import_t1_kwh).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.consumed.t2', data.energy_import_t2_kwh).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.consumed.t3', data.energy_import_t3_kwh).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('meter_power.consumed.t4', data.energy_import_t4_kwh).catch(this.error));

      /// / Total production
      // if energy_export_kwh == 0, we assume the device does not produce energy
      // We ignore this case
      if (data.energy_export_kwh != 0) {
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.returned', data.energy_export_kwh).catch(this.error));
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.produced.t1', data.energy_export_t1_kwh).catch(this.error));
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.produced.t2', data.energy_export_t2_kwh).catch(this.error));
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.produced.t3', data.energy_export_t3_kwh).catch(this.error));
        setCapabilityPromises.push(this._setCapabilityValue('meter_power.produced.t4', data.energy_export_t4_kwh).catch(this.error));
      }

      /// / Voltage
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l1', data.voltage_l1_v).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l2', data.voltage_l2_v).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_voltage.l3', data.voltage_l3_v).catch(this.error));

      /// / Current
      setCapabilityPromises.push(this._setCapabilityValue('measure_current', data.current_l1_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l1', data.current_l1_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l2', data.current_l2_a).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('measure_current.l3', data.current_l3_a).catch(this.error));

      /// / Voltage sags and swells
      setCapabilityPromises.push(this._setCapabilityValue('voltage_sag_l1', data.voltage_sag_l1_count).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('voltage_sag_l2', data.voltage_sag_l2_count).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('voltage_sag_l3', data.voltage_sag_l3_count).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('voltage_swell_l1', data.voltage_swell_l1_count).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('voltage_swell_l2', data.voltage_swell_l2_count).catch(this.error));
      setCapabilityPromises.push(this._setCapabilityValue('voltage_swell_l3', data.voltage_swell_l3_count).catch(this.error));

      /// / Power failures
      setCapabilityPromises.push(this._setCapabilityValue('long_power_fail_count', data.long_power_fail_count).catch(this.error));

      /// / Belgium
      setCapabilityPromises.push(this._setCapabilityValue('measure_power.montly_power_peak', data.montly_power_peak_w).catch(this.error));

      // Trigger flows
      triggerFlowPromises.push(this._triggerFlowOnChange('tariff_changed', data.active_tariff).catch(this.error));
      triggerFlowPromises.push(this._triggerFlowOnChange('import_changed', data.energy_import_kwh).catch(this.error));
      triggerFlowPromises.push(this._triggerFlowOnChange('export_changed', data.energy_export_kwh).catch(this.error));

      // Accessing external data
      const externalData = data.external;

      // Belgium water meter using external source (P1)
      let latestWaterData = null;
      if (externalData && externalData.length > 0) {

        // Find the water data with the latest timestamp
        latestWaterData = externalData.reduce((prev, current) => {
          if (current.type === 'water_meter') {
            if (!prev || current.timestamp > prev.timestamp) {
              return current;
            }
          }
          return prev;
        }, null);
      }

      if (latestWaterData) {
        // Access water data
        const waterValue = latestWaterData.value;

        if (!this.hasCapability('meter_water')) {
          setCapabilityPromises.push(this.addCapability('meter_water').catch(this.error));
        }

        if (this.getCapabilityValue('meter_water') != waterValue) { setCapabilityPromises.push(this.setCapabilityValue('meter_water', waterValue).catch(this.error)); }

      } else if (this.hasCapability('meter_water')) {
        setCapabilityPromises.push(this.removeCapability('meter_water').catch(this.error));
        console.log('Removed meter as there is no water meter in P1.');
      }

      // Execute all promises concurrently using Promise.all()
      Promise.all(setCapabilityPromises);
      Promise.all(triggerFlowPromises);

      // Battery mode here?
      const batteryMode = await api.getMode(this.url, this.token);
      if (batteryMode !== undefined) {
        console.log('Battery mode:', batteryMode);
      }

    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  }

  onSettings(MySettings) {
    this.log('Settings updated');
    this.log('Settings:', MySettings);
    // Update interval polling
    if (
      'polling_interval' in MySettings.oldSettings &&
      MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
    ) {
      this.log('Polling_interval for P1 changed to:', MySettings.newSettings.polling_interval);
      clearInterval(this.onPollInterval);
      //this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
      this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
    }
    // return true;
  }

};
