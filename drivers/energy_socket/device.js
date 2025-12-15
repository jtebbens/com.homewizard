'use strict';

const Homey = require('homey');

// const fetch = require('../../includes/utils/fetchQueue');
const fetch = require('node-fetch');

const http = require('http');

let agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,  // avoids stale sockets
  maxSockets: 2          // only one active connection per host
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
    // device.log(`✅ Updated "${capability}" from ${current} to ${value}`);
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}


module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    await this.setCapabilityValue('connection_error', 'No errors');

    // Pull custom polling interval, if not set default is 10s with minimum of 2s
    const custom_interval = Math.max(this.getSetting('offset_polling') || 10, 2);

    const offset = Math.floor(Math.random() * custom_interval * 1000);

    if (this.onPollInterval) clearInterval(this.onPollInterval);
    if (this.onPollStateInterval) clearInterval(this.onPollStateInterval);
    
    setTimeout(() => {
      this.onPoll(); // run once after offset
      this.onPollInterval = setInterval(this.onPoll.bind(this), custom_interval * 1000);
    }, offset);

      // stagger state poll separately (small extra offset)
    setTimeout(() => {
      this.onPollState(); // run once
      this.onPollStateInterval = setInterval(this.onPollState.bind(this), custom_interval * 1000);
    }, offset + 500); // adjust as needed

    
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
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Optional backoff
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

      // Guard against deleted device
      if (!this.getData()) {
        this.error('Device no longer exists — skipping poll');
        return;
      }

      // Prevent overlapping polls
      if (this.pollingActive) {
        this.log('⏸️ Skipping poll — previous request still active');
        return;
      }
      this.pollingActive = true;

      try {
        // Use timeout wrapper to avoid hanging requests
        const res = await fetchWithTimeout(`${this.url}/data`, {
          agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }, 5000); // 5s timeout

        if (!res || !res.ok) {
          throw new Error(res ? res.statusText : 'Unknown error during fetch');
        }

        const data = await res.json();
        const offset_socket = this.getSetting('offset_socket') || 0;
        const temp_socket_watt = data.active_power_w + offset_socket;

        // Update capabilities
        await updateCapability(this, 'measure_power', temp_socket_watt).catch(this.error);
        await updateCapability(this, 'meter_power.consumed.t1', data.total_power_import_t1_kwh).catch(this.error);
        await updateCapability(this, 'measure_power.l1', data.active_power_l1_w).catch(this.error);
        await updateCapability(this, 'rssi', data.wifi_strength).catch(this.error);

        const solarExport = data.total_power_export_t1_kwh;
        await updateCapability(this, 'meter_power.produced.t1', solarExport > 1 ? solarExport : null).catch(this.error);

        const netImport = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
        await updateCapability(this, 'meter_power', netImport).catch(this.error);

        await updateCapability(this, 'measure_voltage', data.active_voltage_v ?? null).catch(this.error);
        await updateCapability(this, 'measure_current', data.active_current_a ?? null).catch(this.error);

        // Update settings.url if changed
        if (this.url && this.url !== settings.url) {
          this.log(`Socket - Updating settings url from ${settings.url} → ${this.url}`);
          try {
            await this.setSettings({ url: this.url });
          } catch (err) {
            this.error('Socket - Failed to update settings url', err);
          }
        }

        await this.setAvailable().catch(this.error);
        this.failCount = 0; // reset on success

      } catch (err) {
        if (err.code === 'ECONNRESET') {
          this.log('Socket - Connection was reset');
          await updateCapability(this, 'connection_error', 'Connection reset').catch(this.error);
        } else if (err.code === 'EHOSTUNREACH') {
          this.log('Socket polling with unreachable error:', settings.offset_polling);
          await updateCapability(this, 'connection_error', 'Socket unreachable').catch(this.error);
        } else if (err.code === 'ETIMEDOUT') {
          this.log('⚠️ Socket - Timeout detected, recreating HTTP agent');
          await updateCapability(this, 'connection_error', 'Timeout').catch(this.error);
          agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1 });
          setTimeout(() => this.onPoll(), 2000);
        } else {
          await updateCapability(this, 'connection_error', err.message || 'Polling error').catch(this.error);
          this.error(err);
        }

        this.failCount = (this.failCount || 0) + 1;
        if (this.failCount > 3) {
          this.log('❌ Too many failures, stopping poll until rediscovery');
          clearInterval(this.onPollInterval);
          clearInterval(this.onPollStateInterval);
          await this.setUnavailable('Device unreachable');
        } else {
          await this.setUnavailable(err.message || 'Polling error').catch(this.error);
        }
      } finally {
        this.pollingActive = false;
      }
    }



    async onPollState() {
      const settings = this.getSettings();

      // Ensure URL is set
      if (!this.url) {
        if (settings.url) {
          this.url = settings.url;
          this.log(`ℹ️ this.url was empty, restored from settings: ${this.url}`);
        } else {
          this.error('❌ this.url is empty and no fallback settings.url found — aborting state poll');
          await this.setUnavailable().catch(this.error);
          return;
        }
      }

      // Guard against deleted device
      if (!this.getData()) {
        this.error('Device no longer exists — skipping state poll');
        return;
      }

      // Prevent overlapping polls
      if (this.pollingStateActive) {
        this.log('⏸️ Skipping state poll — previous request still active');
        return;
      }
      this.pollingStateActive = true;

      try {
        // Use timeout wrapper
        const res = await fetchWithTimeout(`${this.url}/state`, {
          agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }, 5000); // 5s timeout

        if (!res.ok) {
          this.error(`Polling failed with status ${res.status}: ${res.statusText}`);
          throw new Error(res.statusText);
        }

        const data = await res.json();
        if (!data || typeof data !== 'object') {
          throw new Error('Invalid response format');
        }

        // Update capabilities
        await updateCapability(this, 'onoff', data.power_on).catch(this.error);
        await updateCapability(this, 'dim', data.brightness * (1 / 255)).catch(this.error);
        await updateCapability(this, 'locked', data.switch_lock).catch(this.error);
        await updateCapability(this, 'connection_error', 'No error').catch(this.error);

        await this.setAvailable().catch(this.error);
        this.failCount = 0; // reset on success

      } catch (err) {
        switch (err.code) {
          case 'ECONNRESET':
            this.log('Socket - Connection was reset');
            await updateCapability(this, 'connection_error', 'Connection reset').catch(this.error);
            break;
          case 'EHOSTUNREACH':
            await updateCapability(this, 'connection_error', 'Socket unreachable').catch(this.error);
            break;
          case 'ETIMEDOUT':
            this.log('⚠️ Socket - Timeout detected, recreating HTTP agent');
            await updateCapability(this, 'connection_error', 'Timeout').catch(this.error);
            agent.destroy?.();
            agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 1 });
            setTimeout(() => this.onPollState(), 2000);
            break;
          case 'ECONNREFUSED':
            await updateCapability(this, 'connection_error', 'Connection refused').catch(this.error);
            break;
          case 'EPIPE':
            await updateCapability(this, 'connection_error', 'Broken pipe').catch(this.error);
            break;
          case 'ENOTFOUND':
            await updateCapability(this, 'connection_error', 'Host not found').catch(this.error);
            break;
          default:
            await updateCapability(this, 'connection_error', err.message || 'Polling error').catch(this.error);
            this.error(err);
        }

        this.failCount = (this.failCount || 0) + 1;
        if (this.failCount > 3) {
          this.log('❌ Too many failures, stopping state poll until rediscovery');
          clearInterval(this.onPollInterval);
          clearInterval(this.onPollStateInterval);
          await this.setUnavailable('Device unreachable');
        } else {
          await this.setUnavailable(err.message || 'Polling error').catch(this.error);
        }
      } finally {
        this.pollingStateActive = false;
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
