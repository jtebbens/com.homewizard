'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

//const POLL_INTERVAL = 1000; // 1000 ms = 1 second

//const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;

async function updateCapability(device, capability, value) {
        if (value === null || value === undefined) {
          if (device.hasCapability(capability)) {
            await device.removeCapability(capability).catch(device.error);
          }
          return;
        }

        if (!device.hasCapability(capability)) {
          await device.addCapability(capability).catch(device.error);
        }

        const current = device.getCapabilityValue(capability);
        if (current !== value) {
          await device.setCapabilityValue(capability, value).catch(device.error);
        }
}


module.exports = class HomeWizardEnergyDevice extends Homey.Device {

  async onInit() {

    await updateCapability(this, 'connection_error', 'No errors');

    const settings = await this.getSettings();
    console.log('Polling settings for P1 apiv1: ',settings.polling_interval);


    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.polling_interval === undefined) || (settings.polling_interval === null) || (settings.polling_interval == 0)) {
      settings.polling_interval = 10; // Default to 10 second if not set or 0
      await this.setSettings({
        // Update settings in Homey
        polling_interval: 10,
      });
    }

    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.number_of_phases === undefined) || (settings.number_of_phases === null)) {
      settings.number_of_phases = 1; // Default to 1 phase
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
    
    if (settings.number_of_phases == 1) {
        await this.removeCapability('net_load_phase2').catch(this.error);
        await this.removeCapability('net_load_phase3').catch(this.error);  
    }


    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);

    /*  if (Homey2023) {
      this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL * settings.interval);  // 1 seconds interval for newer models
    } else {
      this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL*10);  // 10 seconds interval for older/slower models 
    }
    */

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

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.onPoll();
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.log('onDiscoveryAddressChanged');
    this.onPoll();
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this.log(`URL: ${this.url}`);
    this.setAvailable();
    this.onPoll();
  }

  async setCloudOn() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: true })
    }).catch(this.error);

    if (!res.ok)
    { 
      await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }


  async setCloudOff() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/system`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloud_enabled: false })
    }).catch(this.error);

    if (!res.ok)
    { 
      //await this.setCapabilityValue('connection_error',res.code);
      await updateCapability(this, 'connection_error', res.code);
      throw new Error(res.statusText); 
    }
  }

  async onRequest(body) {
    if (!this.url) return;

    const res = await fetch(`${this.url}/state`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }).catch(this.error);

    if (!res.ok)
    { 
      await updateCapability(this, 'connection_error', res.code);
      throw new Error(res.statusText); 
    }
  }

 async onPoll() {
    if (!this.url) return;

    try {

        const now = new Date();
        const tz = this.homey.clock.getTimezone();
        const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));

        const settings = this.getSettings();

      
        // Check if polling interval is running)
        if (!this.onPollInterval) {
          this.log('Polling interval is not running, starting now...');
          this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * this.getSettings().polling_interval);
        }

        let res = await fetch(`${this.url}/data`);

          if (!res || !res.ok) {
            await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s to avoid false reports due to bad wifi from users
            // try again
            res = await fetch(`${this.url}/data`);
            if (!res || !res.ok)
            { 
              await updateCapability(this, 'connection_error', res.code);
              throw new Error(res ? res.statusText : 'Unknown error during fetch'); }
          }

          const data = await res.json();
          
          // At exactly midnight
          if (nowLocal.getHours() === 0 && nowLocal.getMinutes() === 0) {
            if (data.total_power_import_kwh !== undefined) {
              this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (data.total_gas_m3 !== undefined) {
              this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          } else {
            // First-time setup fallback
            if (!this.getStoreValue('meter_start_day') && data.total_power_import_kwh !== undefined) {
              this.setStoreValue('meter_start_day', data.total_power_import_kwh).catch(this.error);
            }
            if (!this.getStoreValue('gasmeter_start_day') && data.total_gas_m3 !== undefined) {
              this.setStoreValue('gasmeter_start_day', data.total_gas_m3).catch(this.error);
            }
          }

          // Check if it is 5 minutes
          if (nowLocal.getMinutes() % 5 === 0) {
            const prevReadingTimeStamp = await this.getStoreValue('gasmeter_previous_reading_timestamp');
            
            if (prevReadingTimeStamp == null) {
              await this.setStoreValue('gasmeter_previous_reading_timestamp', data.gas_timestamp);
            }

            if (data.total_gas_m3 != null && prevReadingTimeStamp !== data.gas_timestamp) {
              const prevReading = await this.getStoreValue('gasmeter_previous_reading');

              if (prevReading != null) {
                const gasDelta = data.total_gas_m3 - prevReading;
                if (gasDelta >= 0) {
                  await updateCapability(this, 'measure_gas', gasDelta);
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
            await updateCapability(this, 'meter_power.daily', dailyImport);
          }

          // Update the capability meter_gas.daily
          const gasStart = await this.getStoreValue('gasmeter_start_day');
          const gasDiff = (data.total_gas_m3 != null && gasStart != null)
            ? data.total_gas_m3 - gasStart
            : null;

          await updateCapability(this, 'meter_gas.daily', gasDiff);

          // Save export data check if capabilities are present first
          await updateCapability(this, 'measure_power', data.active_power_w);
          //await updateCapability(this, 'measure_power.active_power_w', null);
          await updateCapability(this, 'rssi', data.wifi_strength);
          await updateCapability(this, 'tariff', data.active_tariff);
          await updateCapability(this, 'identify', 'identify'); // or another placeholder value if needed
          await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh);
          await updateCapability(this, 'meter_power.consumed.t2', data.total_power_import_t2_kwh);
          await updateCapability(this, 'meter_power.consumed', data.total_power_import_kwh);


          // Trigger tariff
          if (data.active_tariff != this.getStoreValue('last_active_tariff')) {
            this.flowTriggerTariff(this, { tariff_changed: data.active_tariff });
            this.setStoreValue('last_active_tariff', data.active_tariff).catch(this.error);
          }

          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a);

          // Not all users have a gas meter in their system (if NULL ignore creation or even delete from view)

          await updateCapability(this, 'meter_gas', data.total_gas_m3);

          // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
          await updateCapability(this, 'meter_power.produced.t1', 
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
            ? data.total_power_export_t1_kwh 
            : null);

          await updateCapability(this, 'meter_power.produced.t2', 
            (data.total_power_export_kwh > 1 || data.total_power_export_t2_kwh > 1)
              ? data.total_power_export_t2_kwh 
              : null);


          // aggregated meter for Power by the hour support
          // Ensure meter_power exists and update value based on firmware
          const netImport =
            data.total_power_import_kwh === undefined
              ? (data.total_power_import_t1_kwh + data.total_power_import_t2_kwh) - (data.total_power_export_t1_kwh + data.total_power_export_t2_kwh)
              : data.total_power_import_kwh - data.total_power_export_kwh;

          await updateCapability(this, 'meter_power', netImport);

          // Also update returned power if firmware supports it
          if (data.total_power_import_kwh !== undefined) {
            await updateCapability(this, 'meter_power.returned', data.total_power_export_kwh);
          }


          // Trigger import
          if (data.total_power_import_kwh != this.getStoreValue('last_total_import_kwh')) {
            this.flowTriggerImport(this, { import_changed: data.total_power_import_kwh });
            this.setStoreValue('last_total_import_kwh', data.total_power_import_kwh).catch(this.error);
          }

          // Trigger export
          if (data.total_power_export_kwh != this.getStoreValue('last_total_export_kwh')) {
            this.flowTriggerExport(this, { export_changed: data.total_power_export_kwh });
            this.setStoreValue('last_total_export_kwh', data.total_power_export_kwh).catch(this.error);
          }

          // Belgium
          await updateCapability(this, 'measure_power.montly_power_peak', data.montly_power_peak_w);


          // active_voltage_l1_v Some P1 meters do have voltage data
          await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v);


          // active_current_l1_a Some P1 meters do have amp data
          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a);


          // Power failure count - long_power_fail_count
          await updateCapability(this, 'long_power_fail_count', data.long_power_fail_count);


          // voltage_sag_l1_count - Net L1 dip
          await updateCapability(this, 'voltage_sag_l1', data.voltage_sag_l1_count);

          // voltage_swell_l1_count - Net L1 peak
          await updateCapability(this, 'voltage_swell_l1', data.voltage_swell_l1_count);

          

          
          // Rewrite of L1/L2/L3 Voltage/Amp
          await updateCapability(this, 'measure_power.l1', data.active_power_l1_w);
          await updateCapability(this, 'measure_voltage.l1', data.active_voltage_l1_v);
          


          await updateCapability(this, 'measure_current.l1', data.active_current_l1_a);

          if (data.active_current_l1_a !== undefined) {
            const tempCurrentPhase1Load = Math.abs((data.active_current_l1_a / settings.phase_capacity) * 100);

            await updateCapability(this, 'net_load_phase1', Math.abs(data.active_current_l1_a));
            await updateCapability(this, 'net_load_phase1_pct', tempCurrentPhase1Load);
            await this.setCapabilityOptions('net_load_phase1', { max: settings.phase_capacity }).catch(this.error);

            if (tempCurrentPhase1Load > 95) {
              await this.homey.notifications.createNotification({
                excerpt: `Fase 1 overbelast 95%`
              });
            }
          }

          // Rewrite Voltage/Amp Phase 2 and 3 (this part will be skipped if netgrid is only 1 phase)

          if ((data.active_power_l2_w !== undefined) || (data.active_power_l3_w !== undefined)) {

              // voltage_sag_l2_count - Net L2 dip
              await updateCapability(this, 'voltage_sag_l2', data.voltage_sag_l2_count);
              
              // voltage_sag_l3_count - Net L3 dip
              await updateCapability(this, 'voltage_sag_l3', data.voltage_sag_l3_count);
              
              // voltage_swell_l2_count - Net L2 peak
              await updateCapability(this, 'voltage_swell_l2', data.voltage_swell_l2_count);
              
              // voltage_swell_l3_count - Net L3 peak
              await updateCapability(this, 'voltage_swell_l3', data.voltage_swell_l3_count);


              await updateCapability(this, 'measure_power.l2', data.active_power_l2_w);
              await updateCapability(this, 'measure_power.l3', data.active_power_l3_w);
              
              await updateCapability(this, 'measure_voltage.l2', data.active_voltage_l2_v);
              await updateCapability(this, 'measure_voltage.l3', data.active_voltage_l3_v);



              await updateCapability(this, 'measure_current.l2', data.active_current_l2_a);


              if (data.active_current_l2_a !== undefined) {
                const tempCurrentPhase2Load = Math.abs((data.active_current_l2_a / settings.phase_capacity) * 100);

                await updateCapability(this, 'net_load_phase2', Math.abs(data.active_current_l2_a));
                await updateCapability(this, 'net_load_phase2_pct', tempCurrentPhase2Load);
                await this.setCapabilityOptions('net_load_phase2', { max: settings.phase_capacity }).catch(this.error);

                if (tempCurrentPhase2Load > 95) {
                  await this.homey.notifications.createNotification({
                    excerpt: `Fase 2 overbelast 95%`
                  });
                }
              }

              await updateCapability(this, 'measure_current.l3', data.active_current_l3_a);


              if (data.active_current_l3_a !== undefined) {
                const tempCurrentPhase3Load = Math.abs((data.active_current_l3_a / settings.phase_capacity) * 100);

                await updateCapability(this, 'net_load_phase3', Math.abs(data.active_current_l3_a));
                await updateCapability(this, 'net_load_phase3_pct', tempCurrentPhase3Load);
                await this.setCapabilityOptions('net_load_phase3', { max: settings.phase_capacity }).catch(this.error);

                if (tempCurrentPhase3Load > 95) {
                  await this.homey.notifications.createNotification({
                    excerpt: `Fase 3 overbelast 95%`
                  });
                }
              }

          } // END OF PHASE 2 and 3 Capabilities

          // T3 meter request import and export
          await updateCapability(this, 'meter_power.consumed.t3', data.total_power_import_t3_kwh);
          await updateCapability(this, 'meter_power.produced.t3', data.total_power_export_t3_kwh);


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
          await updateCapability(this, 'meter_water', latestWaterData?.value ?? null);

          // Log if the water meter capability was removed due to no valid source
          if (!latestWaterData && this.hasCapability('meter_water')) {
            console.log('Removed meter as there is no water meter in P1.');
          }


          // Execute all promises concurrently using Promise.all()
          //await Promise.all(promises);
          //await Promise.allSettled(promises);

      } catch (err) {
      this.error(err);
      await this.setUnavailable(err);
    }
  }

    // Catch offset updates
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

      if ('cloud' in MySettings.oldSettings &&
        MySettings.oldSettings.cloud !== MySettings.newSettings.cloud
      ) {
        this.log('Cloud connection in advanced settings changed to:', MySettings.newSettings.cloud);
  
        if (MySettings.newSettings.cloud == 1) {
            this.setCloudOn();  
        }
        else if (MySettings.newSettings.cloud == 0) {
            this.setCloudOff();
        }
      }
      // return true;
    }
     

};
