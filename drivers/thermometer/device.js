'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;
let pollingStarted = false;
const devices = {};
// const thermometers = {};
const debug = false;

function startPolling() {
  refreshIntervalId = setInterval(async () => {
    try {
      // Group devices by homewizard_id
      const grouped = {};
      for (const id in devices) {
        const hw_id = devices[id].getSetting('homewizard_id');
        if (!grouped[hw_id]) grouped[hw_id] = [];
        grouped[hw_id].push(devices[id]);
      }

      // Fetch data per HomeWizard unit
      for (const hw_id in grouped) {
        const result = await homewizard.getDeviceData(hw_id, 'thermometers');
        if (debug) console.log('Thermometer data:', JSON.stringify(result));
        const payload = Array.isArray(result) ? result : result?.response;

        if (!Array.isArray(payload)) {
          if (debug) console.log(`No thermometer data for ${hw_id}`);
          continue;
        }

        for (const device of grouped[hw_id]) {
          device.updateFromPayload(payload);
        }
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 1000 * 60);
}





class HomeWizardThermometer extends Homey.Device {

onInit() {
  const id = this.getData().id;
  devices[id] = this;

  if (debug) {
    console.log(`HomeWizard Thermometer ${this.getName()} registered`);
  }

  if (!pollingStarted) {
    pollingStarted = true;
    startPolling();
  }
}

updateFromPayload(payload) {
  const thermometer_id = this.getSetting('thermometer_id');
  const entry = payload.find(t => String(t.id) === String(thermometer_id));

  if (debug) {
    console.log(`Device ${this.getName()} matched entry:`, entry);
  }

  if (!entry || typeof entry.te !== 'number' || typeof entry.hu !== 'number') {
    this.setUnavailable('No data for this thermometer').catch(this.error);
    return;
  }

  this.setAvailable().catch(this.error);

  // Round and apply offsets
  let te = entry.te;
  let hu = entry.hu;

  te += this.getSetting('offset_temperature') || 0;
  hu += this.getSetting('offset_humidity') || 0;

  // Compare and update temperature
  const currentTe = this.getCapabilityValue('measure_temperature');
  if (currentTe !== te) {
    if (debug) console.log(`${this.getName()} updating temperature: ${currentTe} → ${te}`);
    this.setCapabilityValue('measure_temperature', te).catch(this.error);
  }

  // Compare and update humidity
  const currentHu = this.getCapabilityValue('measure_humidity');
  if (currentHu !== hu) {
    if (debug) console.log(`${this.getName()} updating humidity: ${currentHu} → ${hu}`);
    this.setCapabilityValue('measure_humidity', hu).catch(this.error);
  }

  // Compare and update battery status
  const lowBattery = entry.lowBattery === 'yes';
  if (!this.hasCapability('alarm_battery')) {
    this.addCapability('alarm_battery').catch(this.error);
  }

  const currentBattery = this.getCapabilityValue('alarm_battery');
  if (currentBattery !== lowBattery) {
    if (debug) console.log(`${this.getName()} updating battery status: ${currentBattery} → ${lowBattery}`);
    this.setCapabilityValue('alarm_battery', lowBattery).catch(this.error);
  }
}

  
  onDeleted() {

    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      pollingStarted = false;
      if (debug) { console.log('--Stopped Polling--'); }
    }

    console.log(`deleted: ${JSON.stringify(this)}`);
  }

  // Catch offset updates
  async onSettings(oldSettings, newSettings, changedKeys) {
    this.log('Settings updated');
    // Update display values if offset has changed
    for (const k in changedKeys) {
      const key = changedKeys[k];
      if (key.slice(0, 7) === 'offset_') {
        const cap = `measure_${key.slice(7)}`;
        const value = this.getCapabilityValue(cap);
        const delta = newSettings[key] - oldSettings[key];
        this.log('Updating value of', cap, 'from', value, 'to', value + delta);
        await this.setCapabilityValue(cap, value + delta)
          .catch((err) => this.error(err));
      }
    }

  }

  async updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('measure', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    await this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

}

module.exports = HomeWizardThermometer;
