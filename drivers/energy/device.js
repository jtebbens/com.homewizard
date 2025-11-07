'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
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
    //device.log(`⚠️ Capability "${capability}" missing — skipping update`);
    //return;
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
const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs : 11000
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

    let settings = this.getSettings();

    // Array to hold all update promises
    const promises = [];

    if (!this.url) {
      if (settings.url) {
        this.url = settings.url;
      }
      else return;
      this.log("No URL found for P1apiv1, please check your device settings.");
    }

    Promise.resolve().then(async () => {
        // Get current time in the timezone of Homey
        const now = new Date();
        const tz = this.homey.clock.getTimezone();
        const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));

        const homey_lang = this.homey.i18n.getLanguage();
             
        // Check if polling interval is running)
        if (!this.onPollInterval) {
          this.log('Polling interval is not running, starting now...');
          this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
        }

        //const res = await fetch(`${this.url}/data`);
        const res = await fetch(`${this.url}/data`, {
            agent,
            method: 'GET',
            headers: {
              'Content-Type': 'application/json'
            }
          });

          if (!res || !res.ok) {
             
              await updateCapability(this, 'connection_error', res.code);
              throw new Error(res ? res.statusText : 'Unknown error during fetch'); 
          }

          const data = await res.json();
          
          // At exactly midnight
          if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
            if (data.total_power_import_kwh !== undefined) {
              await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (data.total_gas_m3 !== undefined) {
              await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          } else {
            // First-time setup fallback
            const meterStartDay = await this.getStoreValue('meter_start_day');
            const gasmeterStartDay = await this.getStoreValue('gasmeter_start_day');

            if (!meterStartDay && data.total_power_import_kwh !== undefined) {
              await this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (!gasmeterStartDay && data.total_gas_m3 !== undefined) {
              await this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          }


          // Check if it is 5 minutes
          if (nowLocal.getMinutes() % 5 === 0) {
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
                  promises.push(updateCapability(this, 'measure_gas', gasDelta).catch(this.error));
                }
              }

              await this.setStoreValue('gasmeter_previous_reading', data.total_gas_m3).catch(this.error);
              await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp).catch(this.error);
            }
          }


          
          // Update the capability meter_power.daily
          const meterStart = await this.getStoreValue('meter_start_day');
          if (meterStart != null && data.total_power_import_kwh != null) {
            const dailyImport = data.total_power_import_kwh - meterStart;
            promises.push((updateCapability(this, 'meter_power.daily', dailyImport)).catch(this.error));
          }

          // Update the capability meter_gas.daily
          const gasStart = await this.getStoreValue('gasmeter_start_day');
          const gasDiff = (data.total_gas_m3 != null && gasStart != null)
            ? data.total_gas_m3 - gasStart
            : null;

          promises.push((updateCapability(this, 'meter_gas.daily', gasDiff)).catch(this.error));

          // Save export data check if capabilities are present first
          promises.push((updateCapability(this, 'measure_power', data.active_power_w)).catch(this.error));
          promises.push((updateCapability(this, 'rssi', data.wifi_strength)).catch(this.error));
          promises.push((updateCapability(this, 'tariff', data.active_tariff)).catch(this.error));
          promises.push((updateCapability(this, 'identify', 'identify')).catch(this.error)); // or another placeholder value if needed
          promises.push((updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh)).catch(this.error));
          promises.push((updateCapability(this, 'meter_power.consumed.t2', data.total_power_import_t2_kwh)).catch(this.error));
          promises.push((updateCapability(this, 'meter_power.consumed', data.total_power_import_kwh)).catch(this.error));

          const wifiQuality = await getWifiQuality(data.wifi_strength);
          promises.push((updateCapability(this, 'wifi_quality', wifiQuality)).catch(this.error));

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


          promises.push((updateCapability(this, 'measure_current.l1', data.active_current_l1_a)).catch(this.error));

          // Not all users have a gas meter in their system (if NULL ignore creation or even delete from view)

          promises.push((updateCapability(this, 'meter_gas', data.total_gas_m3)).catch(this.error));

          // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
          promises.push((updateCapability(this, 'meter_power.produced.t1', 
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
            ? data.total_power_export_t1_kwh 
            : null)).catch(this.error));

          promises.push((updateCapability(this, 'meter_power.produced.t2', 
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
              ? data.total_power_export_t2_kwh 
              : null)).catch(this.error));


          // aggregated meter for Power by the hour support
          // Ensure meter_power exists and update value based on firmware
          const netImport =
            data.total_power_import_kwh === undefined
              ? (data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh)
              : data.total_power_import_kwh - data.total_power_export_kwh;

          promises.push((updateCapability(this, 'meter_power', netImport)).catch(this.error));

          // Also update returned power if firmware supports it
          if (data.total_power_import_kwh !== undefined) {
            promises.push((updateCapability(this, 'meter_power.returned', data.total_power_export_kwh)).catch(this.error));
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
          promises.push((updateCapability(this, 'measure_power.montly_power_peak', data.montly_power_peak_w)).catch(this.error));


          // active_voltage_l1_v Some P1 meters do have voltage data
          promises.push((updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v)).catch(this.error));


          // active_current_l1_a Some P1 meters do have amp data
          promises.push((updateCapability(this, 'measure_current.l1', data.active_current_l1_a)).catch(this.error));


          // Power failure count - long_power_fail_count
          promises.push((updateCapability(this, 'long_power_fail_count', data.long_power_fail_count)).catch(this.error));


          // voltage_sag_l1_count - Net L1 dip
          promises.push((updateCapability(this, 'voltage_sag_l1', data.voltage_sag_l1_count)).catch(this.error));

          // voltage_swell_l1_count - Net L1 peak
          promises.push((updateCapability(this, 'voltage_swell_l1', data.voltage_swell_l1_count)).catch(this.error));

          

          
          // Rewrite of L1/L2/L3 Voltage/Amp
          promises.push((updateCapability(this, 'measure_power.l1', data.active_power_l1_w)).catch(this.error));
          promises.push((updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v)).catch(this.error));
          


          promises.push((updateCapability(this, 'measure_current.l1', data.active_current_l1_a)).catch(this.error));

          //
          if (data.active_current_l1_a !== undefined) {
            const tempCurrentPhase1Load = Math.abs((data.active_current_l1_a / settings.phase_capacity) * 100);

            promises.push((updateCapability(this, 'net_load_phase1_pct', tempCurrentPhase1Load)).catch(this.error));

            if (tempCurrentPhase1Load > 97) {
                if (homey_lang == "nl") {
                    await this.homey.notifications.createNotification({
                    excerpt: `Fase 1 overbelast 97%`
                });  
                } else {
                    await this.homey.notifications.createNotification({
                    excerpt: `Phase 1 overloaded 97%`
                    });
                }
            }
          }

          // Rewrite Voltage/Amp Phase 2 and 3 (this part will be skipped if netgrid is only 1 phase)

          if ((data.active_current_l2_a !== undefined) || (data.active_current_l3_a !== undefined)) {

              try {
                if (
                  settings.number_of_phases === undefined ||
                  settings.number_of_phases === null ||
                  Number(settings.number_of_phases) === 1
                ) {
                  await this.setSettings({ number_of_phases: 3 });
                  console.log('number_of_phases successfully updated to 3');
                }
              } catch (err) {
                console.error('Failed to update number_of_phases:', err.message, err.stack);
              }
              // voltage_sag_l2_count - Net L2 dip
              promises.push((updateCapability(this, 'voltage_sag_l2', data.voltage_sag_l2_count)).catch(this.error));
              
              // voltage_sag_l3_count - Net L3 dip
              promises.push((updateCapability(this, 'voltage_sag_l3', data.voltage_sag_l3_count)).catch(this.error));
              
              // voltage_swell_l2_count - Net L2 peak
              promises.push((updateCapability(this, 'voltage_swell_l2', data.voltage_swell_l2_count)).catch(this.error));
              
              // voltage_swell_l3_count - Net L3 peak
              promises.push((updateCapability(this, 'voltage_swell_l3', data.voltage_swell_l3_count)).catch(this.error));


              promises.push((updateCapability(this, 'measure_power.l2', data.active_power_l2_w)).catch(this.error));
              promises.push((updateCapability(this, 'measure_power.l3', data.active_power_l3_w)).catch(this.error));
              
              promises.push((updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v)).catch(this.error));
              promises.push((updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v)).catch(this.error));



              promises.push((updateCapability(this, 'measure_current.l2', data.active_current_l2_a)).catch(this.error));


              if (data.active_current_l2_a !== undefined) {
                const tempCurrentPhase2Load = Math.abs((data.active_current_l2_a / settings.phase_capacity) * 100);

                
                promises.push((updateCapability(this, 'net_load_phase2_pct', tempCurrentPhase2Load)).catch(this.error));
                

                if (tempCurrentPhase2Load > 97) {
                  if (homey_lang == "nl") {
                    await this.homey.notifications.createNotification({
                    excerpt: `Fase 2 overbelast 97%`
                });  
                } else {
                    await this.homey.notifications.createNotification({
                    excerpt: `Phase 2 overloaded 97%`
                    });
                }
                }
              }

              promises.push((updateCapability(this, 'measure_current.l3', data.active_current_l3_a)).catch(this.error));


              if (data.active_current_l3_a !== undefined) {
                const tempCurrentPhase3Load = Math.abs((data.active_current_l3_a / settings.phase_capacity) * 100);

                
                promises.push((updateCapability(this, 'net_load_phase3_pct', tempCurrentPhase3Load)).catch(this.error));
                

                if (tempCurrentPhase3Load > 97) {
                  if (homey_lang == "nl") {
                    await this.homey.notifications.createNotification({
                    excerpt: `Fase 3 overbelast 97%`
                });  
                } else {
                    await this.homey.notifications.createNotification({
                    excerpt: `Phase 3 overloaded 97%`
                    });
                }
                }
              }

          } // END OF PHASE 2 and 3 Capabilities

          // T3 meter request import and export
          promises.push((updateCapability(this, 'meter_power.consumed.t3', data.total_power_import_t3_kwh)).catch(this.error));
          promises.push((updateCapability(this, 'meter_power.produced.t3', data.total_power_export_t3_kwh)).catch(this.error));


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
          promises.push((updateCapability(this, 'meter_water', latestWaterData?.value ?? null)).catch(this.error));

          // Log if the water meter capability was removed due to no valid source
          if (!latestWaterData && this.hasCapability('meter_water')) {
            console.log('Removed meter as there is no water meter in P1.');
          }


          // Execute all promises concurrently using Promise.all()
          
          if (this.url != settings.url) {
            this.log("P1 - Updating settings url");
            await this.setSettings({
                  // Update url settings
                  url: this.url
                });
          }

          await Promise.allSettled(promises);

      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
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
