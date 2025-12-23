'use strict';

const Homey = require('homey');

const fetch = require('../../includes/utils/fetchQueue');
// const fetch = require('node-fetch');
const BaseloadMonitor = require('../../includes/utils/baseloadMonitor');


const http = require('http');

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
  if (value == null) {
    if (device.hasCapability(capability) && device.getCapabilityValue(capability) !== null) {
      await device.removeCapability(capability).catch(device.error);
    }
    return;
  }

  if (!device.hasCapability(capability)) {
    // device.log(`⚠️ Capability "${capability}" missing — skipping update`);
    // return;
    await device.addCapability(capability).catch(device.error);
    device.log(`➕ Added capability "${capability}"`);
  }

  const current = device.getCapabilityValue(capability);
  if (current !== value) {
    await device.setCapabilityValue(capability, value).catch(device.error);
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
let agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,  // avoids stale sockets
  maxSockets: 1          // only one active connection per host
});

module.exports = class HomeWizardEnergyDevice extends Homey.Device {

  async onInit() {

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

    this.log('Polling settings for P1 apiv1: ', settings.polling_interval);
    
    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    // Check if number of phases is set, if not default to 1
    if (settings.number_of_phases === undefined || settings.number_of_phases === null) {
      await this.setSettings({
        // Update settings in Homey
        number_of_phases: 1,
      });
    }

    // Remove gasmeter if disabled in settings
    if (!settings.show_gas) {
      if (this.hasCapability('meter_gas'))
      { await this.removeCapability('meter_gas'); }
      if (this.hasCapability('measure_gas'))
      { await this.removeCapability('measure_gas'); }
      if (this.hasCapability('meter_gas'))
      { await this.removeCapability('meter_gas.daily'); }
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


    // --- Baseload Monitor Integration (v1 only) ---
    this._baseloadNotificationsEnabled = this.getSetting('baseload_notifications') ?? true;
    const app = this.homey.app;

    // Create the monitor if it doesn't exist yet
    if (!app.baseloadMonitor) {
      app.baseloadMonitor = new BaseloadMonitor(this.homey);
    }

    // Register this device with the monitor
    app.baseloadMonitor.registerP1Device(this);

    // Attempt to become the master P1 source (first device wins)
    app.baseloadMonitor.trySetMaster(this);

    // Notifications
    app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);

    // Overload notification true/false
    this._phaseOverloadNotificationsEnabled = this.getSetting('phase_overload_notifications') ?? true;

    this._phaseOverloadState = {
      l1: { highCount: 0, notified: false },
      l2: { highCount: 0, notified: false },
      l3: { highCount: 0, notified: false }
    };




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

    /**
   * Called whenever a new P1 power value is received.
   * Integrate this into your existing polling logic.
   */
  _onNewPowerValue(power) {
    const app = this.homey.app;

    // Forward to baseload monitor (only if this device is master)
    if (app.baseloadMonitor) {
      app.baseloadMonitor.updatePowerFromDevice(this, power);
    }
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
    const app = this.homey.app;

    if (app.baseloadMonitor) {
      app.baseloadMonitor.unregisterP1Device(this);
    }

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

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
        this.log(`ℹ️ this.url was empty, restored from settings: ${this.url}`);
      } else {
        this.error('❌ this.url is empty and no fallback settings.url found — aborting poll');
        await this.setUnavailable().catch(this.error);
        return;
      }
    }


    Promise.resolve().then(async () => {
        // Get current time in the timezone of Homey
        const now = new Date();
        const tz = this.homey.clock.getTimezone();
        const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));

        const homey_lang = this.homey.i18n.getLanguage();
            

        // const res = await fetch(`${this.url}/data`);
        const res = await fetch(`${this.url}/data`, {
            agent,
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            }
          });

          if (!res || !res.ok) {
             
              await updateCapability(this, 'connection_error', 'Fetch error').catch(this.error);
              throw new Error(res ? res.statusText : 'Unknown error during fetch'); 
          }

          const data = await res.json();
          
          // At exactly midnight
          if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
            if (data.total_power_import_kwh !== undefined) {
              await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (data.total_gas_m3 !== undefined && settings.show_gas) {
              await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          } else {
            // First-time setup fallback
            const meterStartDay = await this.getStoreValue('meter_start_day');
            let gasmeterStartDay = null; 
            if (settings.show_gas) {
              gasmeterStartDay = await this.getStoreValue('gasmeter_start_day');
            }
            
            
            if (!meterStartDay && data.total_power_import_kwh !== undefined) {
              await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (!gasmeterStartDay && data.total_gas_m3 !== undefined && settings.show_gas) {
              await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          }


          // Check if it is 5 minutes
          if ((nowLocal.getMinutes() % 5 === 0) && settings.show_gas) {
            const prevReadingTimeStamp = await this.getStoreValue('gasmeter_previous_reading_timestamp');

            // First-time setup
            if (prevReadingTimeStamp == null) {
              await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp).catch(this.error);
              return; // Exit early to avoid calculating delta with missing timestamp
            }

            // Calculate gas usage delta
            if (data.total_gas_m3 != null && prevReadingTimeStamp !== data.gas_timestamp) {
              const prevReading = await this.getStoreValue('gasmeter_previous_reading');

              if (prevReading != null) {
                const gasDelta = data.total_gas_m3 - prevReading;
                if (gasDelta >= 0) {
                  await updateCapability(this, 'measure_gas', gasDelta).catch(this.error);
                }
              }

              await this.setStoreValue('gasmeter_previous_reading', data.total_gas_m3).catch(this.error);
              await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp).catch(this.error);
            }
          }

          // Update is show gasmeter is enabled
          if (settings.show_gas) {
            // Update the capability meter_power.daily
            const meterStart = await this.getStoreValue('meter_start_day');
            if (meterStart != null && data.total_power_import_kwh != null) {
              const dailyImport = data.total_power_import_kwh - meterStart;
              await updateCapability(this, 'meter_power.daily', dailyImport).catch(this.error);
            }

            // Update the capability meter_gas.daily
            const gasStart = await this.getStoreValue('gasmeter_start_day');
            const gasDiff = (data.total_gas_m3 != null && gasStart != null)
              ? data.total_gas_m3 - gasStart
              : null;

            await updateCapability(this, 'meter_gas.daily', gasDiff).catch(this.error);
          }


          // Save export data check if capabilities are present first
          await updateCapability(this, 'measure_power', data.active_power_w).catch(this.error);
          // Forward the power sample to the baseload monitor
          this._onNewPowerValue(data.active_power_w);

          await updateCapability(this, 'rssi', data.wifi_strength).catch(this.error);
          await updateCapability(this, 'tariff', data.active_tariff).catch(this.error);
          await updateCapability(this, 'identify', 'identify'); // or another placeholder value if needed
          await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);
          await updateCapability(this, 'meter_power.consumed.t2', data.total_power_import_t2_kwh).catch(this.error);
          await updateCapability(this, 'meter_power.consumed', data.total_power_import_kwh).catch(this.error);

          const wifiQuality = await getWifiQuality(data.wifi_strength);
          await updateCapability(this, 'wifi_quality', wifiQuality).catch(this.error);

          // Trigger tariff
          const lastTariff = await this.getStoreValue('last_active_tariff');
          const currentTariff = data.active_tariff;

          if (typeof currentTariff === 'number' && currentTariff !== lastTariff) {
            this.flowTriggerTariff(this, { tariff_changed: currentTariff });
            try {
              await this.setStoreValue('last_active_tariff', currentTariff);
            } catch (err) {
              this.error(err);
            }
          }


          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a).catch(this.error);

          // Not all users have a gas meter in their system (if NULL ignore creation or even delete from view)

          if (settings.show_gas) {
            await updateCapability(this, 'meter_gas', data.total_gas_m3).catch(this.error);
          }

          // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
          await updateCapability(
            this,
            'meter_power.produced.t1',
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
              ? data.total_power_export_t1_kwh
              : null
          ).catch(this.error);

          await updateCapability(
            this,
            'meter_power.produced.t2',
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
              ? data.total_power_export_t2_kwh
              : null
          ).catch(this.error);



          // aggregated meter for Power by the hour support
          // Ensure meter_power exists and update value based on firmware
          const netImport = data.total_power_import_kwh === undefined
              ? (data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) 
                - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh)
              : data.total_power_import_kwh - data.total_power_export_kwh;

          await updateCapability(this, 'meter_power', netImport).catch(this.error);

          // Also update returned power if firmware supports it
          if (data.total_power_import_kwh !== undefined) {
            await updateCapability(this, 'meter_power.returned', data.total_power_export_kwh).catch(this.error);
          }


          // Trigger import
          const lastImport = await this.getStoreValue('last_total_import_kwh');
          const currentImport = data.total_power_import_kwh;

          if (typeof currentImport === 'number' && currentImport !== lastImport) {
            this.flowTriggerImport(this, { import_changed: currentImport });
            await this.setStoreValue('last_total_import_kwh', currentImport).catch(this.error);
          }
          
          // Trigger export
          const lastExport = await this.getStoreValue('last_total_export_kwh');
          const currentExport = data.total_power_export_kwh;

          if (typeof currentExport === 'number' && currentExport !== lastExport) {
            this.flowTriggerExport(this, { export_changed: currentExport });
            await this.setStoreValue('last_total_export_kwh', currentExport).catch(this.error);
          }


          // Belgium
          await updateCapability(this, 'measure_power.montly_power_peak', data.montly_power_peak_w).catch(this.error);
          


          // active_voltage_l1_v Some P1 meters do have voltage data
          await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v).catch(this.error);


          // active_current_l1_a Some P1 meters do have amp data
          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a).catch(this.error);


          // Power failure count - long_power_fail_count
          await updateCapability(this, 'long_power_fail_count', data.long_power_fail_count).catch(this.error);


          // voltage_sag_l1_count - Net L1 dip
          await updateCapability(this, 'voltage_sag_l1', data.voltage_sag_l1_count).catch(this.error);

          // voltage_swell_l1_count - Net L1 peak
          await updateCapability(this, 'voltage_swell_l1', data.voltage_swell_l1_count).catch(this.error);

          

          
          // Rewrite of L1/L2/L3 Voltage/Amp
          await updateCapability(this, 'measure_power.l1', data.active_power_l1_w).catch(this.error);
          await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v).catch(this.error);
          


          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a).catch(this.error);

          //
          if (data.active_current_l1_a !== undefined) {
            const load1 = Math.abs((data.active_current_l1_a / settings.phase_capacity) * 100);
            await updateCapability(this, 'net_load_phase1_pct', load1).catch(this.error);
            this._handlePhaseOverload('l1', load1, homey_lang);
          }


          // Rewrite Voltage/Amp Phase 2 and 3 (this part will be skipped if netgrid is only 1 phase)

          if ((data.active_current_l2_a !== undefined) || (data.active_current_l3_a !== undefined)) {

              try {
                if (
                  settings.number_of_phases === undefined
                  || settings.number_of_phases === null
                  || Number(settings.number_of_phases) === 1
                ) {
                  await this.setSettings({ number_of_phases: 3 });
                  this.log('number_of_phases successfully updated to 3');
                }
              } catch (err) {
                this.error('Failed to update number_of_phases:', err.message, err.stack);
              }
              // voltage_sag_l2_count - Net L2 dip
              await updateCapability(this, 'voltage_sag_l2', data.voltage_sag_l2_count).catch(this.error);
              
              // voltage_sag_l3_count - Net L3 dip
              await updateCapability(this, 'voltage_sag_l3', data.voltage_sag_l3_count).catch(this.error);
              
              // voltage_swell_l2_count - Net L2 peak
              await updateCapability(this, 'voltage_swell_l2', data.voltage_swell_l2_count).catch(this.error);
              
              // voltage_swell_l3_count - Net L3 peak
              await updateCapability(this, 'voltage_swell_l3', data.voltage_swell_l3_count).catch(this.error);


              await updateCapability(this, 'measure_power.l2', data.active_power_l2_w).catch(this.error);
              await updateCapability(this, 'measure_power.l3', data.active_power_l3_w).catch(this.error);
              
              await updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v).catch(this.error);
              await updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v).catch(this.error);



              await updateCapability(this, 'measure_current.l2', data.active_current_l2_a).catch(this.error);


              if (data.active_current_l2_a !== undefined) {
                const load2 = Math.abs((data.active_current_l2_a / settings.phase_capacity) * 100);
                await updateCapability(this, 'net_load_phase2_pct', load2).catch(this.error);
                this._handlePhaseOverload('l2', load2, homey_lang);
              }

              await updateCapability(this, 'measure_current.l3', data.active_current_l3_a).catch(this.error);


              if (data.active_current_l3_a !== undefined) {
                const load3 = Math.abs((data.active_current_l3_a / settings.phase_capacity) * 100);
                await updateCapability(this, 'net_load_phase3_pct', load3).catch(this.error);
                this._handlePhaseOverload('l3', load3, homey_lang);
              }


          } // END OF PHASE 2 and 3 Capabilities

          // T3 meter request import and export
          await updateCapability(this, 'meter_power.consumed.t3', data.total_power_import_t3_kwh).catch(this.error);
          await updateCapability(this, 'meter_power.produced.t3', data.total_power_export_t3_kwh).catch(this.error);

      
          // Always update 3‑phase values 
          await updateCapability(this, 'measure_power.l1', data.active_power_l1_w).catch(this.error);
          await updateCapability(this, 'measure_power.l2', data.active_power_l2_w).catch(this.error);
          await updateCapability(this, 'measure_power.l3', data.active_power_l3_w).catch(this.error);

          // Voltage per phase
          await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v).catch(this.error);
          await updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v).catch(this.error);
          await updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v).catch(this.error);

          // Current per phase
          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a).catch(this.error);
          await updateCapability(this, 'measure_current.l2', data.active_current_l2_a).catch(this.error);
          await updateCapability(this, 'measure_current.l3', data.active_current_l3_a).catch(this.error);



          // Accessing external data
          const externalData = data.external;

          // Extract the most recent water meter reading
          const latestWaterData = externalData?.reduce((prev, current) => {
            if (current.type === 'water_meter') {
              return !prev || current.timestamp > prev.timestamp ? current : prev;
            }
            return prev;
          }, null);

          // Update or remove meter_water capability
          await updateCapability(this, 'meter_water', latestWaterData?.value ?? null).catch(this.error);

          // Log if the water meter capability was removed due to no valid source
          if (!latestWaterData && this.hasCapability('meter_water')) {
            await this.removeCapability('meter_water').catch(this.error);
            this.log('Removed meter as there is no water meter in P1.');
          }
          
        // Update settings.url when changed
        if (this.url && this.url !== settings.url) {
          this.log(`Energy - Updating settings url from ${settings.url} → ${this.url}`);
          try {
            await this.setSettings({ url: this.url });
          } catch (err) {
            this.error('Energy - Failed to update settings url', err);
          }
        }

      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch(async (err) => {
        this.error('❌ Poll failed:', err.message || err);
        await this.setUnavailable(err.message || 'Polling error').catch(this.error);

        if (['ETIMEDOUT', 'ECONNRESET'].includes(err.code)) {
          this.log('⚠️ Timeout detected — recreating HTTP agent and restarting poll');

          try {
            // Recreate a brand‑new agent with tuned settings
            agent.destroy?.(); // clean up old sockets if possible
            agent = new http.Agent({
              keepAlive: true,
              keepAliveMsecs: 10000, // matches your 10s poll cycle
              maxSockets: 1
            });
          } catch (createErr) {
            this.error('Failed to recreate agent:', createErr);
          }

          // Backoff before retrying to avoid hammering
          setTimeout(() => {
            this.onPoll();
          }, 2000);
        }
      });

  }

  _handlePhaseOverload(phaseKey, loadPct, lang) {
  const state = this._phaseOverloadState[phaseKey];

  // Debounce: 3 opeenvolgende samples boven 97%
  if (loadPct > 97) {
    state.highCount++;

    if (!state.notified && state.highCount >= 3 && this._phaseOverloadNotificationsEnabled) {
      const phaseNum = phaseKey.replace('l', ''); // l1 → 1
      const msg = lang === 'nl'
        ? `Fase ${phaseNum} overbelast (${loadPct.toFixed(0)}%)`
        : `Phase ${phaseNum} overloaded (${loadPct.toFixed(0)}%)`;

      this.homey.notifications.createNotification({ excerpt: msg }).catch(this.error);
      state.notified = true;
    }
  } else {
    // Hysterese: reset pas onder 85%
    if (loadPct < 85) {
      state.highCount = 0;
      state.notified = false;
    }
  }
}


    // Catch offset updates
    async onSettings(MySettings) {
      this.log('Settings updated');
      this.log('Settings:', MySettings);
      // Update interval polling
      if (
        'polling_interval' in MySettings.oldSettings
        && MySettings.oldSettings.polling_interval !== MySettings.newSettings.polling_interval
      ) {
        this.log('Polling_interval for P1 changed to:', MySettings.newSettings.polling_interval);
        clearInterval(this.onPollInterval);
        // this.onPollInterval = setInterval(this.onPoll.bind(this), MySettings.newSettings.polling_interval * 1000);
        const settings = this.getSettings();
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      }

      if ('cloud' in MySettings.oldSettings 
        && MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
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

      if ('baseload_notifications' in MySettings.newSettings) {
        this._baseloadNotificationsEnabled = MySettings.newSettings.baseload_notifications;
        const app = this.homey.app;
        if (app.baseloadMonitor) {
          app.baseloadMonitor.setNotificationsEnabledForDevice(this, this._baseloadNotificationsEnabled);
        }
        this.log('Baseload notifications changed to:', this._baseloadNotificationsEnabled);
      }

      if ('phase_overload_notifications' in MySettings.newSettings) {
        this._phaseOverloadNotificationsEnabled = MySettings.newSettings.phase_overload_notifications;
        this.log('Phase overload notifications changed to:', this._phaseOverloadNotificationsEnabled);
      }

    }
     

};
