'use strict';

const Homey = require('homey');
const http = require('http');
const fetch = require('node-fetch');


/**
 * Helper function to add, remove or update a capability
 *
 * @async
 * @param {*} device 
 * @param {*} capability 
 * @param {*} value 
 * @returns {*} 
 */
async function updateCapability(device, capability, value) {
  const current = device.getCapabilityValue(capability);

  if (value == null) {
    if (device.hasCapability(capability) && current !== null) {
      await device.removeCapability(capability).catch(device.error);
      device.log(`🗑️ Removed capability "${capability}"`);
    }
    return;
  }

  if (!device.hasCapability(capability)) {
    await device.addCapability(capability).catch(device.error);
    device.log(`➕ Added capability "${capability}"`);
  }

  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
    //device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}

/**
 * Helper function to determine WiFi quality based on RSSI percentage
 *
 * @async
 * @param {*} percent 
 * @returns {unknown} 
 */
async function getWifiQuality(percent) {
  if (percent >= 80) return 'Excellent / Strong';
  if (percent >= 60) return 'Moderate';
  if (percent >= 40) return 'Weak';
  if (percent >= 20) return 'Poor';
  if (percent > 0) return 'Unusable';
  return 'Unusable';
}

// http.agent options to improve performance
// KeepAlive to true to reuse connections
// KeepAliveMsecs to 1 second to keep connections alive
// maxSockets to 5 to limit the number of concurrent sockets
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs : 11000
});

module.exports = class HomeWizardEnergyDevice extends Homey.Device {

  async onInit() {

    await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    await updateCapability(this, 'connection_error', 'No errors');

    if (this.hasCapability('net_load_phase1')) {
         await this.removeCapability('net_load_phase1').catch(this.error);
    }

    if (this.hasCapability('net_load_phase2')) {
      await this.removeCapability('net_load_phase2').catch(this.error);
    }

    if (this.hasCapability('net_load_phase3')) {
      await this.removeCapability('net_load_phase3').catch(this.error);
    }

    const settings = this.getSettings();
    // ... set defaults if needed ...
    if (!settings.polling_interval) {
      settings.polling_interval = 10;
      await this.setSettings({ polling_interval: 10 });
    }
    this.log('Polling settings for P1 apiv1: ',settings.polling_interval);
    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    // Check if number of phases is set, if not default to 1
    if (settings.number_of_phases === undefined || settings.number_of_phases === null) {
      await this.setSettings({
        // Update settings in Homey
        number_of_phases: 1,
      });
    }

    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.phase_capacity === undefined) || (settings.phase_capacity === null)) {
      settings.phase_capacity = 40; // Default to 40 Amp
      await this.setSettings({
        // Update settings in Homey
        phase_capacity: 40,
      });
    }

    // Initialize flow triggers
    this._flowTriggerTariff = this.homey.flow.getDeviceTriggerCard('tariff_changed');
    this._flowTriggerImport = this.homey.flow.getDeviceTriggerCard('import_changed');
    this._flowTriggerExport = this.homey.flow.getDeviceTriggerCard('export_changed');

    this.registerCapabilityListener('identify', async (value) => {
      await this.onIdentify();
    });
  }

  flowTriggerTariff(device, tokens) {
    this._flowTriggerTariff.trigger(device, tokens).catch(this.error);
  }

  flowTriggerImport(device, tokens) {
    this._flowTriggerImport.trigger(device, tokens).catch(this.error);
  }

  flowTriggerExport(device, tokens) {
    this._flowTriggerExport.trigger(device, tokens).catch(this.error);
  }

  async onIdentify() {
    if (!this.url) return;

    let res;
    try {
      res = await fetch(`${this.url}/identify`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      this.error(err);
      throw new Error('Network error during onIdentify');
    }

    if (!res || !res.ok) {
      await this.setCapabilityValue('connection_error', res ? res.status : 'fetch failed');
      throw new Error(res ? res.statusText : 'Unknown error during fetch');
    }
  }

  

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
  }

  
  /**
   * Handles a newly discovered device and starts polling.
   *
   * @async
   * @param {*} discoveryResult - The result from device discovery, containing address, port, and TXT record.
   * @returns {Promise<void>}
   */
   onDiscoveryAvailable(discoveryResult) {
    try {
      // Validate discovery result
      if (!discoveryResult?.address || !discoveryResult?.port || !discoveryResult?.txt?.path) {
        throw new Error('Invalid discovery result: missing address, port, or path');
      }

      // Construct device URL
      this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
      this.log(`Discovered device URL: ${this.url}`);

      // Start polling the device
      this.onPoll();
    } catch (err) {
      this.log(`Discovery failed: ${err.message}`);
    }
  }

  
  /**
   * Handles mDNS address changes by updating the device URL and polling.
   *
   * @param {*} discoveryResult 
   */
  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryLastSeenChanged');
    this.setAvailable();
    this.onPoll();
  }

  // Function to enable Cloud mode on the device
  async setCloudOn() {
    if (!this.url) return;

    let res;
    try {
      res = await fetch(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      });
    } catch (err) {
      this.error(err);
      throw new Error('Network error during setCloudOn');
    }

    if (!res || !res.ok) {
      await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
      throw new Error(res ? res.statusText : 'Unknown error during fetch');
    }
  }

  // Function to disable Cloud mode on the device
  async setCloudOff() {
    if (!this.url) return;

    let res;
    try {
      res = await fetch(`${this.url}/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: false })
      });
    } catch (err) {
      this.error(err);
      throw new Error('Network error during setCloudOff');
    }

    if (!res || !res.ok) {
      await updateCapability(this, 'connection_error', res ? res.status : 'fetch failed');
      throw new Error(res ? res.statusText : 'Unknown error during fetch');
    }
  }

  async onPoll() {
    const settings = this.getSettings();
    const promises = [];

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      } else {
        this.log("No URL found for P1apiv1, please check your device settings.");
        return;
      }
    }

    try {
      const now = new Date();
      const tz = this.homey.clock.getTimezone();
      const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const homey_lang = this.homey.i18n.getLanguage();

      if (!this.onPollInterval) {
        this.log('Polling interval is not running, starting now...');
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      }

      const res = await fetch(`${this.url}/data`, {
        agent,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res || !res.ok) {
        await updateCapability(this, 'connection_error', res.code);
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }

      const data = await res.json();

      // Midnight reset
      if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
        if (data.total_power_import_kwh !== undefined) {
          await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
        }
        if (data.total_gas_m3 !== undefined) {
          await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
        }
      } else {
        const meterStartDay = await this.getStoreValue('meter_start_day');
        const gasmeterStartDay = await this.getStoreValue('gasmeter_start_day');

        if (!meterStartDay && data.total_power_import_kwh !== undefined) {
          await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
        }
        if (!gasmeterStartDay && data.total_gas_m3 !== undefined) {
          await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
        }
      }

      // Gas delta every 5 minutes
      if (nowLocal.getMinutes() % 5 === 0) {
        const prevReadingTimeStamp = await this.getStoreValue('gasmeter_previous_reading_timestamp');
        if (prevReadingTimeStamp == null) {
          await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp).catch(this.error);
          return;
        }

        if (data.total_gas_m3 != null && prevReadingTimeStamp !== data.gas_timestamp) {
          const prevReading = await this.getStoreValue('gasmeter_previous_reading');
          if (prevReading != null) {
            const gasDelta = data.total_gas_m3 - prevReading;
            if (gasDelta >= 0) {
              promises.push(updateCapability(this, 'measure_gas', gasDelta));
            }
          }
          await this.setStoreValue('gasmeter_previous_reading', data.total_gas_m3).catch(this.error);
          await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp).catch(this.error);
        }
      }

      // Daily meters
      const meterStart = await this.getStoreValue('meter_start_day');
      if (meterStart != null && data.total_power_import_kwh != null) {
        const dailyImport = data.total_power_import_kwh - meterStart;
        promises.push(updateCapability(this, 'meter_power.daily', dailyImport));
      }

      const gasStart = await this.getStoreValue('gasmeter_start_day');
      const gasDiff = (data.total_gas_m3 != null && gasStart != null)
        ? data.total_gas_m3 - gasStart
        : null;
      promises.push(updateCapability(this, 'meter_gas.daily', gasDiff));

      // Core capabilities
      promises.push(updateCapability(this, 'measure_power', data.active_power_w));
      promises.push(updateCapability(this, 'rssi', data.wifi_strength));
      promises.push(updateCapability(this, 'tariff', data.active_tariff));
      promises.push(updateCapability(this, 'identify', 'identify'));
      promises.push(updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh));
      promises.push(updateCapability(this, 'meter_power.consumed.t2', data.total_power_import_t2_kwh));
      promises.push(updateCapability(this, 'meter_power.consumed', data.total_power_import_kwh));

      const wifiQuality = await getWifiQuality(data.wifi_strength);
      promises.push(updateCapability(this, 'wifi_quality', wifiQuality));

      // Tariff flow
      const lastTariff = await this.getStoreValue('last_active_tariff');
      const currentTariff = data.active_tariff;
      if (typeof currentTariff === 'number' && currentTariff !== lastTariff) {
        this.flowTriggerTariff(this, { tariff_changed: currentTariff });
        await this.setStoreValue('last_active_tariff', currentTariff).catch(this.error);
      }

      // Import/export flows
      const lastImport = await this.getStoreValue('last_total_import_kwh');
      const currentImport = data.total_power_import_kwh;
      if (typeof currentImport === 'number' && currentImport !== lastImport) {
        this.flowTriggerImport(this, { import_changed: currentImport });
        await this.setStoreValue('last_total_import_kwh', currentImport).catch(this.error);
      }

      const lastExport = await this.getStoreValue('last_total_export_kwh');
      const currentExport = data.total_power_export_kwh;
      if (typeof currentExport === 'number' && currentExport !== lastExport) {
        this.flowTriggerExport(this, { export_changed: currentExport });
        await this.setStoreValue('last_total_export_kwh', currentExport).catch(this.error);
      }

      // Solar export
      const solarExport = (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1);
      promises.push(updateCapability(this, 'meter_power.produced.t1', solarExport ? data.total_power_export_t1_kwh : null));
      promises.push(updateCapability(this, 'meter_power.produced.t2', solarExport ? data.total_power_export_t2_kwh : null));

      // Aggregated meter
      const netImport = data.total_power_import_kwh !== undefined
        ? data.total_power_import_kwh - data.total_power_export_kwh
        : (data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh);
      promises.push(updateCapability(this, 'meter_power', netImport).catch(this.error));

      if (data.total_power_import_kwh !== undefined) {
        promises.push(updateCapability(this, 'meter_power.returned', data.total_power_export_kwh));
      }

      // Voltage and current
      promises.push(updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v));
      promises.push(updateCapability(this, 'measure_current.l1', data.active_current_l1_a));

      // Phase load
      if (data.active_current_l1_a !== undefined) {
        const loadPct = Math.abs((data.active_current_l1_a / settings.phase_capacity) * 100);
        promises.push(updateCapability(this, 'net_load_phase1_pct', loadPct));
        if (loadPct > 97) {
          const msg = homey_lang === 'nl' ? 'Fase 1 overbelast 97%' : 'Phase 1 overloaded 97%';
          await this.homey.notifications.createNotification({ excerpt: msg });
        }
      }

      // External water meter
      const latestWaterData = data.external?.reduce((prev, current) => {
        return current.type === 'water_meter' && (!prev || current.timestamp > prev.timestamp) ? current : prev;
      }, null);
      promises.push(updateCapability(this, 'meter_water', latestWaterData?.value ?? null));
      if (!latestWaterData && this.hasCapability('meter_water')) {
        console.log('Removed meter as there is no water meter in P1.');
      }

      // Update settings URL if changed
      if (this.url !== settings.url) {
        this.log("P1 - Updating settings url");
        await this.setSettings({ url: this.url });
      }

      const results = await Promise.allSettled(promises);
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          this.error(`Capability update failed:`, result.reason);
        }
      });

      await this.setAvailable().catch(this.error);

    } catch (err) {
      this.error(err);
      await this.setUnavailable(err).catch(this.error);
    }
  }


    // Catch offset updates
    async onSettings(MySettings) {
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
        const settings = this.getSettings();
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      }

      if ('cloud' in MySettings.oldSettings &&
        MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
      ) {
        this.log('Cloud connection in advanced settings changed to:', MySettings.newSettings.cloud);
  
        try {
        if (MySettings.newSettings.cloud == 1) {
            await this.setCloudOn();  
        }
        else if (MySettings.newSettings.cloud == 0) {
            await this.setCloudOff();
        }
        } catch (err) {
            this.error('Failed to update cloud connection:', err);
        }
      }
      // return true;
    }
     

};
