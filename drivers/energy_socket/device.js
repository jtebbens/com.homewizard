'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const http = require('http');

const POLL_INTERVAL = 1000 * 10; // 10 seconds
const POLL_STATE_INTERVAL = 1000 * 10; // 10 seconds

let agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,  // avoids stale sockets
  maxSockets: 1          // only one active connection per host
});

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

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    //await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);
    
    await this.setCapabilityValue('connection_error', 'No errors');

    const custom_interval = this.getSetting('offset_polling');

    this.log('offset_polling', custom_interval); // print the value of offset_polling
    
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
      this.onPollInterval = null;
    }
    if (this.onPollStateInterval) {
      clearInterval(this.onPollStateInterval);
      this.onPollStateInterval = null;
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

  async onRequest(body) {
    if (!this.url) return;

    const maxRetries = 2;
    let attempt = 0;
    let res;

    while (attempt <= maxRetries) {
      try {
        res = await fetch(`${this.url}/state`, {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        });

        if (res.ok) {
          return; // Success
        }

        // Response received but not OK
        throw new Error(res.statusText || 'Unknown error during fetch');

      } catch (err) {
        this.error(`Attempt ${attempt + 1} failed:`, err);

        if (attempt === maxRetries) {
          await this.setCapabilityValue('connection_error', 'fetch failed');
          throw new Error('Network error during onRequest');
        }

        attempt++;
        await new Promise(resolve => setTimeout(resolve, 2000)); // Optional backoff
      }
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
        throw new Error(`Network error during setCloudOn: ${err.message}`);
      }
  
      if (!res || !res.ok) {
        throw new Error(res ? res.statusText : 'Unknown error during fetch');
      }
    }
  
  
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
        throw new Error(`Network error during setCloudOff: ${err.message}`);
      }
  
      if (!res || !res.ok) { 
        throw new Error(res ? res.statusText : 'Unknown error during fetch'); 
      }
    }



  async onPoll() {
      const settings = this.getSettings();

      // Ensure URL is set
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

      // Ensure polling interval is active
      if (!this.onPollInterval) {
        this.log('Socket - Polling interval is not running, starting now...');
        clearInterval(this.onPollInterval);
        this.onPollInterval = setInterval(this.onPoll.bind(this), 1000 * settings.polling_interval);
      }

      // Guard against deleted device
      if (!this.getData()) {
        this.error('Device no longer exists — skipping poll');
        return;
      }

      try {
        const res = await fetch(`${this.url}/data`, {
          agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!res || !res.ok) {
          throw new Error(res ? res.statusText : 'Unknown error during fetch');
        }

        const data = await res.json();
        const offset_socket = this.getSetting('offset_socket') || 0;
        const temp_socket_watt = data.active_power_w + offset_socket;

        // Update capabilities using helper
        await updateCapability(this, 'measure_power', temp_socket_watt).catch(this.error);
        await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);
        await updateCapability(this, 'measure_power.l1', data.active_power_l1_w).catch(this.error);
        await updateCapability(this, 'rssi', data.wifi_strength).catch(this.error);

        // Solar export logic
        const solarExport = data.total_power_export_t1_kwh;
        await updateCapability(this, 'meter_power.produced.t1', solarExport > 1 ? solarExport : null).catch(this.error);

        // Aggregated meter
        const netImport = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
        await updateCapability(this, 'meter_power', netImport).catch(this.error);

        // Voltage
        await updateCapability(this, 'measure_voltage', data.active_voltage_v ?? null).catch(this.error);

        // Amp
        await updateCapability(this, 'measure_current', data.active_current_a ?? null).catch(this.error);

        // Update stored URL if changed
        if (this.url !== settings.url) {
          this.log('Socket - Updating settings url');
          await this.setSettings({ url: this.url });
        }

        await this.setAvailable().catch(this.error);

        } catch (err) {
          if (err.code === 'ECONNRESET') {
            this.log('Socket - Connection was reset');
            await updateCapability(this, 'connection_error', 'Connection reset').catch(this.error);
          } else if (err.code === 'EHOSTUNREACH') {
            await updateCapability(this, 'connection_error', 'Socket unreachable').catch(this.error);
          } else if (err.code === 'ETIMEDOUT') {
            this.log('⚠️ Socket - Timeout detected, recreating HTTP agent');
            await updateCapability(this, 'connection_error', 'Timeout').catch(this.error);

            agent = new http.Agent({
              keepAlive: true,
              keepAliveMsecs: 10000,
              maxSockets: 1
            });

            setTimeout(() => {
              this.onPoll(); // or this.onPollState() depending on context
            }, 2000);
          } else {
            await updateCapability(this, 'connection_error', err.message || 'Polling error').catch(this.error);
            this.error(err);
          }

          await this.setUnavailable(err).catch(this.error);
        }


}


async onPollState() {
  if (!this.url) return;

  // Guard against deleted device
  if (!this.getData()) {
    this.error('Device no longer exists — skipping state poll');
    return;
  }

  try {
    const res = await fetch(`${this.url}/state`, {
      agent,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      this.error(`Polling failed with status ${res.status}: ${res.statusText}`);
      throw new Error(res.statusText);
    }

    const data = await res.json();

    if (!data || typeof data !== 'object') {
      throw new Error('Invalid response format');
    }

    // Update capabilities using helper
    await updateCapability(this, 'onoff', data.power_on).catch(this.error);
    await updateCapability(this, 'dim', data.brightness * (1 / 255)).catch(this.error);
    await updateCapability(this, 'locked', data.switch_lock).catch(this.error);
    await updateCapability(this, 'connection_error', 'No error').catch(this.error);

    } catch (err) {
      if (err.code === 'ECONNRESET') {
        this.log('Socket - Connection was reset');
        await updateCapability(this, 'connection_error', 'Connection reset').catch(this.error);
      } else if (err.code === 'EHOSTUNREACH') {
        await updateCapability(this, 'connection_error', 'Socket unreachable').catch(this.error);
      } else if (err.code === 'ETIMEDOUT') {
        this.log('⚠️ Socket - Timeout detected, recreating HTTP agent');
        await updateCapability(this, 'connection_error', 'Timeout').catch(this.error);

        agent = new http.Agent({
          keepAlive: true,
          keepAliveMsecs: 10000,
          maxSockets: 1
        });

        setTimeout(() => {
          this.onPollState(); 
        }, 2000);
      } else {
        await updateCapability(this, 'connection_error', err.message || 'Polling error').catch(this.error);
        this.error(err);
      }

      await this.setUnavailable(err).catch(this.error);
    }

}




  // Catch offset updates
  async onSettings(oldSettings, newSettings) {
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

            await this.setCapabilityValue(cap, value + delta)
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

        try {
          if (oldSettings.newSettings.cloud == 1) {
            await this.setCloudOn();  
          } else if (oldSettings.newSettings.cloud == 0) {
            await this.setCloudOff();
          }
        } catch (err) {
          this.error('Failed to update cloud connection:', err);
        }
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

};
