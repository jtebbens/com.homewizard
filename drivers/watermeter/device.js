'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const POLL_INTERVAL = 1000 * 10; // 10 seconds

module.exports = class HomeWizardEnergyWatermeterDevice extends Homey.Device {

  async onInit() {

    const settings = await this.getSettings();
    console.log('Offset polling for Watermeter: ',settings.offset_polling);


    // Check if polling interval is set in settings, if not set default to 10 seconds
    if ((settings.offset_polling === undefined) || (settings.offset_polling === null)) {
      settings.offset_polling = 10; // Default to 10 second if not set
      await this.setSettings({
        // Update settings in Homey
        offset_polling: 10,
      });
    }

    if ((settings.offset_water === undefined) || (settings.offset_water === null)) {
      settings.offset_water = 0; // Default to 0 second if not set
      await this.setSettings({
        // Update settings in Homey
        offset_water: 0,
      });
    }

    this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.offset_polling);
    

    this.registerCapabilityListener('identify', async (value) => {
      await this.onIdentify();
    });
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

  async onIdentify() {
    if (!this.url) return;

    const res = await fetch(`${this.url}/identify`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    }).catch(this.error);

    if (!res.ok)
    { throw new Error(res.statusText); }
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
      let res = await fetch(`${this.url}/data`);

      if (!res || !res.ok) {
        await new Promise((resolve) => setTimeout(resolve, 60000)); // wait 60s to avoid false reports due to bad wifi from users
        // try again
        res = await fetch(`${this.url}/data`);
        if (!res || !res.ok)
        { throw new Error(res ? res.statusText : 'Unknown error during fetch'); }
      }

      const data = await res.json();

      let offset_water_m3;

      // if watermeter offset is set in Homewizard Energy app take that value else use the configured value in Homey Homewizard water offset

      const settings = await this.getSettings();
      //console.log('Offset for Watermeter: ',settings.offset_water);


      if (data.total_liter_offset_m3 = '0') {
        offset_water_m3 = settings.offset_water;
      }
      else if (data.total_liter_offset_m3 != '0') {
        offset_water_m3 = data.total_liter_offset_m3;
      }

      // Save export data check if capabilities are present first
      if (!this.hasCapability('measure_water')) {
        await this.addCapability('measure_water').catch(this.error);
      }

      if (!this.hasCapability('meter_water')) {
        await this.addCapability('meter_water').catch(this.error);
      }

      if (!this.hasCapability('identify')) {
        await this.addCapability('identify').catch(this.error);
      }

      if (!this.hasCapability('rssi')) {
        await this.addCapability('rssi').catch(this.error);
      }

      const temp_total_liter_m3 = data.total_liter_m3 + offset_water_m3;

      // Update values
      if (this.getCapabilityValue('measure_water') != data.active_liter_lpm)
      { await this.setCapabilityValue('measure_water', data.active_liter_lpm).catch(this.error); }
      if (this.getCapabilityValue('meter_water') != temp_total_liter_m3)
      { await this.setCapabilityValue('meter_water', temp_total_liter_m3).catch(this.error); }
      if (this.getCapabilityValue('rssi') != data.wifi_strength)
      { await this.setCapabilityValue('rssi', data.wifi_strength).catch(this.error); }

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
  onSettings(oldSettings, newSettings) {
    this.log('Settings updated')
    // Update display values if offset has changed
        // Retrieve changedKeys from oldSettings
    const changedKeys = oldSettings.changedKeys || [];
    this.log('Debug: Updated keys =', changedKeys);

    if (changedKeys == 'offset_water') {
      this.log('Updating offset_water', oldSettings.newSettings.offset_water);
        
    }
    else if (changedKeys === 'offset_polling') {
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
        else if (changedKeys === 'cloud') {
            this.log('Updating cloud connection', oldSettings.newSettings.cloud);

            if (oldSettings.newSettings.cloud == 1) {
            this.setCloudOn();  
            }
            else if (oldSettings.newSettings.cloud == 0) {
            this.setCloudOff();
        }
      }




    //return true;
  }
  

  updateValue(cap, value) {
    // add offset if defined
    this.log('Updating value of', this.id, 'with capability', cap, 'to', value);
    const cap_offset = cap.replace('meter', 'offset');
    const offset = this.getSetting(cap_offset);
    this.log(cap_offset, offset);
    if (offset != null) {
      value += offset;
    }
    this.setCapabilityValue(cap, value)
      .catch((err) => this.error(err));
  }

};
