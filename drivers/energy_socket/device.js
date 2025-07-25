'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 10; // 10 seconds
const POLL_STATE_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    
    if (!this.hasCapability('connection_error')) {
        await this.addCapability('connection_error').catch(this.error);
    }
    await this.setCapabilityValue('connection_error', 'No errors');

    const custom_interval = this.getSetting('offset_polling');

    console.log('offset_polling', custom_interval); // print the value of offset_polling
    
    this.onPollInterval = setInterval(this.onPoll.bind(this), POLL_INTERVAL);


    
    this.onPollStateInterval = setInterval(this.onPollState.bind(this), POLL_STATE_INTERVAL);

    if (this.getClass() == 'sensor') {
      this.setClass('socket');
    }

    this.registerCapabilityListener('onoff', async (value) => {
      if (this.getCapabilityValue('locked'))
      { throw new Error('Device is locked'); }

      await this.onRequest({ power_on: value });
    });

    this.registerCapabilityListener('identify', async (value) => {
      await this.onIdentify();
    });

    this.registerCapabilityListener('dim', async (value) => {
      await this.onRequest({ brightness: (255 * value) });
    });

    this.registerCapabilityListener('locked', async (value) => {
      await this.onRequest({ switch_lock: value });
    });
  }

  onDeleted() {
    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
    }
    if (this.onPollStateInterval) {
      clearInterval(this.onPollStateInterval);
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
    this.onPoll();
    this.setAvailable();
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
      await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
  }

  async onIdentify() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/identify`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    }).catch(this.error);

    if (!res.ok)
    { 
      await this.setCapabilityValue('connection_error',res.code);
      throw new Error(res.statusText); 
    }
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
        //await this.setCapabilityValue('connection_error',res.code);
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
        throw new Error(res.statusText); 
      }
    }



  onPoll() {
    if (!this.url) return;

    Promise.resolve().then(async () => {
      //
      let res = await fetch(`${this.url}/data`);

      if (!res || !res.ok) {
        await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s to avoid false reports due to bad wifi from users
        // try again
        res = await fetch(`${this.url}/data`);
        if (!res || !res.ok)
        { 
          await this.setCapabilityValue('connection_error',res.code);
          throw new Error(res ? res.statusText : 'Unknown error during fetch'); 
        }
      }

      const data = await res.json();

      const offset_socket = this.getSetting('offset_socket');

      const temp_socket_watt = data.active_power_w + offset_socket;

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_power')) {
        await this.addCapability('measure_power').catch(this.error);
      }

      if (this.hasCapability('measure_power.active_power_w')) {
        await this.removeCapability('measure_power.active_power_w').catch(this.error);
      } // remove

      if (!this.hasCapability('meter_power.consumed.t1')) {
        await this.addCapability('meter_power.consumed.t1').catch(this.error);
      }

      if (!this.hasCapability('measure_power.l1')) {
        await this.addCapability('measure_power.l1').catch(this.error);
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error);
      }

      // Update values
      // if (this.getCapabilityValue('measure_power') != data.active_power_w)
      // await this.setCapabilityValue('measure_power', data.active_power_w).catch(this.error);

      // Use temp_socket_watt with the compensated value
      if (this.getCapabilityValue('measure_power') != temp_socket_watt)
      { await this.setCapabilityValue('measure_power', temp_socket_watt).catch(this.error); }

      if (this.getCapabilityValue('meter_power.consumed.t1') != data.total_power_import_t1_kwh)
      { await this.setCapabilityValue('meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error); }
      if (this.getCapabilityValue('measure_power.l1') != data.active_power_l1_w)
      { await this.setCapabilityValue('measure_power.l1', data.active_power_l1_w).catch(this.error); }
      if (this.getCapabilityValue('rssi') != data.wifi_strength)
      { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error); }

      // Check to see if there is solar panel production exported if received value is more than 1 it returned back to the power grid
      if (data.total_power_export_t1_kwh > 1) {
        if (!this.hasCapability('meter_power.produced.t1')) {
          // add production meters
          await this.addCapability('meter_power.produced.t1').catch(this.error);
        }
        // update values for solar production
        if (this.getCapabilityValue('meter_power.produced.t1') != data.total_power_export_t1_kwh)
								  { await this.setCapabilityValue('meter_power.produced.t1', data.total_power_export_t1_kwh).catch(this.error); }
      }
      else if (data.total_power_export_t1_kwh < 1) {
        await this.removeCapability('meter_power.produced.t1').catch(this.error);
      }

      // aggregated meter for Power by the hour support
      if (!this.hasCapability('meter_power')) {
        await this.addCapability('meter_power').catch(this.error);
      }
      // update calculated value which is sum of import deducted by the sum of the export this overall kwh number is used for Power by the hour app
      if (this.getCapabilityValue('meter_power') != (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh))
      { await this.setCapabilityValue('meter_power', (data.total_power_import_t1_kwh - data.total_power_export_t1_kwh)).catch(this.error); }

      // active_voltage_l1_v
      if (data.active_voltage_v !== undefined) {
        if (!this.hasCapability('measure_voltage')) {
          await this.addCapability('measure_voltage').catch(this.error);
        }
        if (this.getCapabilityValue('measure_voltage') != data.active_voltage_v)
        { await this.setCapabilityValue('measure_voltage', data.active_voltage_v).catch(this.error); }
      }
      else if ((data.active_voltage_v == undefined) && (this.hasCapability('measure_voltage'))) {
        await this.removeCapability('measure_voltage').catch(this.error);
      }

    })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        if (err.code === 'ECONNRESET') {
          // Handle the ECONNRESET error
          console.log('Connection was reset');
        } else {
          this.error(err);
        }
        this.setUnavailable(err).catch(this.error);
      });
  }

  onPollState() {
    if (!this.url) return;

    Promise.resolve().then(async () => {
      const res = await fetch(`${this.url}/state`).catch(this.error); // Error: Not Found
      if (!res)
      { throw new Error(res.statusText); }

      const data = await res.json();

      const offset_socket = this.getSetting('offset_socket');

      if (!this.hasCapability('onoff')) {
        await this.addCapability('onoff').catch(this.error);
      }

      if (!this.hasCapability('dim')) {
        await this.addCapability('dim').catch(this.error);
      }

      if (!this.hasCapability('identify')) {
        await this.addCapability('identify').catch(this.error);
      }

      if (!this.hasCapability('locked')) {
        await this.addCapability('locked').catch(this.error);
      }

      // Update values
      if (this.getCapabilityValue('onoff') != data.power_on)
      { await this.setCapabilityValue('onoff', data.power_on).catch(this.error); }
      if (this.getCapabilityValue('dim') != data.brightness)
      { await this.setCapabilityValue('dim', data.brightness * (1 / 255)).catch(this.error); }
      if (this.getCapabilityValue('locked') != data.switch_lock)
      { await this.setCapabilityValue('locked', data.switch_lock).catch(this.error); }
    })
      .catch((err) => {
        this.error(err);
      });
  }

  // Catch offset updates
  onSettings(oldSettings, newSettings) {
    this.log('Settings updated');
    this.log('oldSettings', oldSettings);

    // Retrieve changedKeys from oldSettings
    const changedKeys = oldSettings.changedKeys || [];
    this.log('Debug: Updated keys =', changedKeys);

    // Iterate over changedKeys to update settings
    for (const key of changedKeys) {
        if (key.startsWith('offset_') && key !== 'offset_polling') {
            const cap = `measure_${key.slice(7)}`;
            const value = this.getCapabilityValue(cap) || 0; // Prevent undefined values
            const delta = newSettings[key] - (oldSettings[key] || 0); // Default oldSettings[key] to 0 if missing
            this.log('Updating value of', cap, 'from', value, 'to', value + delta);

            this.setCapabilityValue(cap, value + delta)
                .catch((err) => this.error(err));
        } else if (key === 'offset_polling') {
            this.log('Updating polling interval to', oldSettings.newSettings.offset_polling);

            // Ensure polling interval is a valid number
            if (typeof oldSettings.newSettings.offset_polling === 'number' && oldSettings.newSettings.offset_polling > 0) {
                if (this.onPollInterval) {
                    clearInterval(this.onPollInterval);
                }
                this.onPollInterval = setInterval(this.onPoll.bind(this), oldSettings.newSettings.offset_polling * 1000); // Convert to ms
            } else {
                this.log('Invalid polling interval:', oldSettings.newSettings.offset_polling);
            }
        }
        else if (key === 'cloud') {
            this.log('Updating cloud connection', oldSettings.newSettings.cloud);

            if (oldSettings.newSettings.cloud == 1) {
            this.setCloudOn();  
            }
            else if (oldSettings.newSettings.cloud == 0) {
            this.setCloudOff();
        }

        }
    }
}


  updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('measure', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

};
