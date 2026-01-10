'use strict';

const Homey = require('homey');
const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;
const homeWizard_devices = {};

const preset_text = '';
const preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie'];
const preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday'];

const debug = false;

function callnewAsync(
  device_id,
  uri_part,
  {
    timeout = 12000,
    retries = 2,
    retryDelay = 1500
  } = {},
  deviceInstance
) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const attempt = () => {
      attempts++;

      let finished = false;

      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          console.log(
            `[callnewAsync] Timeout on ${device_id}${uri_part}, retry ${attempts}/${retries}`
          );
          return setTimeout(attempt, retryDelay);
        }

        console.log(
          `[callnewAsync] FINAL TIMEOUT on ${device_id}${uri_part}`
        );
        if (deviceInstance?.syncLegacyDebugToSettings) {
          deviceInstance.syncLegacyDebugToSettings();
        }
        return reject(new Error(`Timeout calling ${uri_part} on device ${device_id}`));
      }, timeout);

      homewizard.callnew(device_id, uri_part, (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);

        if (err) {
          if (attempts <= retries) {
            if (debug) console.log(
              `[callnewAsync] Error on ${device_id}${uri_part}: ${err.message}, retry ${attempts}/${retries}`
            );
            return setTimeout(attempt, retryDelay);
          }

          if (debug) console.log(
            `[callnewAsync] FINAL ERROR on ${device_id}${uri_part}: ${err.message}`
          );
          if (deviceInstance?.syncLegacyDebugToSettings) {
            deviceInstance.syncLegacyDebugToSettings();
          }
          return reject(err);
        }

        if (debug) console.log(`[callnewAsync] OK ${device_id}${uri_part}`);
        if (deviceInstance?.syncLegacyDebugToSettings) {
          deviceInstance.syncLegacyDebugToSettings();
        }
        return resolve(result);
      });
    };

    attempt();
  });
}

class HomeWizardDevice extends Homey.Device {

  async onInit() {

    // ⬅️ BELANGRIJK: bind device instance mee als laatste argument
    this.callnewAsyncBound = (...args) => callnewAsync(...args, this);
    this._lastLegacySync = 0;

    
    homewizard.setDeviceInstance(this.getData().id, this);

    if (!this.homey.settings.get('debug_legacy_fetch')) {
      this.homey.settings.set('debug_legacy_fetch', []);
    }


    if (debug) { this.log('HomeWizard Appliance has been inited'); }

    if (!this.hasCapability('preset')) {
      await this.addCapability('preset').catch(this.error);
    }

    const devices = this.homey.drivers.getDriver('homewizard').getDevices();

    devices.forEach((device) => {
      const id = device.getData().id;
      const name = device.getName();

      if (debug) this.log(`add device: ${JSON.stringify(name)} (${id})`);

      homeWizard_devices[id] = {
        id,
        name,
        settings: device.getSettings(),
        hasEverReturnedPreset: false
      };
    });


    homewizard.setDevices(homeWizard_devices);
    homewizard.startpoll();

    if (Object.keys(homeWizard_devices).length > 0) {
      this.startPolling(devices);
    }

    // Init flow triggers
    this._flowTriggerPresetChanged = this.homey.flow.getDeviceTriggerCard('preset_changed');

    this.registerCapabilityListener('preset', async (value) => {
      const presetId = Number(value);
      const id = this.getData().id;

      try {
        this.log('Setting preset to', presetId);

        // 1. Homey bepaalt de preset → capability direct zetten
        await this.setCapabilityValue('preset', String(presetId));
        await this.setStoreValue('preset', presetId);

        // 2. Naar HomeWizard sturen
        await this.callnewAsyncBound(id, `/preset/${presetId}`);

        // 3. Best-effort verificatie (mag falen!)
        try {
          const sensors = await this.callnewAsyncBound(id, '/get-status', { timeout: 8000 });
          console.log(sensors);

          // sensors is het volledige object van callnew: { status, version, request, response }
          const hwPreset = sensors?.response?.preset;

          // Alleen loggen als HW een *andere* preset teruggeeft, niet bij undefined
          if (hwPreset !== undefined && hwPreset !== presetId) {
            this.log(`WARN: HW returned preset ${hwPreset} but Homey set ${presetId}. Ignoring.`);
          }
        } catch (verifyErr) {
          this.log(`WARN: Verification failed after setting preset ${presetId}: ${verifyErr.message}`);
          // NIET throwen → Homey blijft leidend
        }


        // 4. Flow triggeren
        const lang = this.homey.i18n.getLanguage();
        const preset_text = (lang === 'nl')
          ? preset_text_nl[presetId]
          : preset_text_en[presetId];

        this.flowTriggerPresetChanged(this, {
          preset: presetId,
          preset_text
        });

        return true;

      } catch (err) {
        this.error('Failed to set preset (HW call failed):', err.message);
        return false; // alleen falen als /preset/<id> faalt
      }
    });

  }

  async onUninit() {
    homewizard.stoppoll();
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
  }

  flowTriggerPresetChanged(device, tokens) {
    this._flowTriggerPresetChanged.trigger(device, tokens).catch(this.error);
  }

  syncLegacyDebugToSettings() {
  try {
    const now = Date.now();
    if (now - (this._lastLegacySync || 0) < 2000) {
      // max 1 sync per 2 seconden
      return;
    }
    this._lastLegacySync = now;

    const devices = homewizard.self?.devices || {};
    const LEGACY_MAX_LOG = 500;

    const all = Object.values(devices)
      .map(d => d.fetchLegacyDebug?.get?.() || [])
      .flat()
      .filter(entry => entry && typeof entry === 'object')
      .filter(entry => !(entry.type === 'raw_response' && entry.status === 200));


    const formatted = all.map(entry => {
      const iso = entry.t || entry.ts || new Date().toISOString();
      const ts = iso;
      const name = entry.name || entry.id || '—';
      const type = entry.type || 'unknown';

      let msg = '';
      switch (type) {
        case 'timeout': msg = entry.ms ? `timeout ${entry.ms}ms` : 'timeout'; break;
        case 'http_error': msg = entry.status ? `HTTP ${entry.status}` : 'HTTP fout'; break;
        case 'socket_hangup':
        case 'error': msg = entry.error || 'socket hangup'; break;
        case 'circuit_open': {
          if (!entry.openUntil) {
            msg = 'circuit open';
            break;
          }
          const remaining = Math.max(0, Math.round((entry.openUntil - Date.now()) / 1000));
          msg = `circuit open (${remaining}s resterend)`;
          break;
        }
        case 'settings_missing': msg = 'instellingen ontbreken'; break;
        case 'parse_error': msg = entry.error ? `parse error: ${entry.error}` : 'parse error'; break;
        case 'device_error': msg = entry.message || entry.error || 'device error'; break;
        default: msg = entry.error || entry.message || entry.status || '(geen details)';
      }

      return { ts, name, msg, type };
    });

    const trimmed = formatted.slice(-LEGACY_MAX_LOG);
    this.homey.settings.set('debug_legacy_fetch', trimmed);

  } catch (e) {
    this.log('Legacy debug sync failed:', e.message);
  }
}


  startPolling(devices) {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
    this.refreshIntervalId = setInterval(() => {
      if (debug) { this.log('--Start HomeWizard Polling-- '); }
      this.getStatus(devices);
    }, 1000 * 20);
  }

  getStatus(devices) {
    Promise.resolve()
      .then(async () => {

        const homey_lang = this.homey.i18n.getLanguage();

        for (const device of devices) {
  try {
    const id = device.getData().id;

    // Altijd via /get-status, nooit meer via legacy wrapper
    const sensors = await this.callnewAsyncBound(id, '/get-status', { timeout: 8000 });
    const hwPreset = sensors?.response?.preset;

    // Markeer dat HW ooit een geldige preset heeft teruggegeven
    if (hwPreset !== null && hwPreset !== undefined && hwPreset !== '') {
      homeWizard_devices[id].hasEverReturnedPreset = true;
    }

    // Homey is leidend
    const homeyPreset = await device.getStoreValue('preset');

    // Eerste init
    if (homeyPreset === null || homeyPreset === undefined) {
      if (debug) this.log(`Initial preset store set to ${hwPreset} for device ${device.getName()}`);
      await device.setStoreValue('preset', hwPreset);
      continue;
    }

    // Als HW geen preset geeft → stil blijven
    if (hwPreset === undefined || hwPreset === null || hwPreset === '') {
      if (debug && homeWizard_devices[id].hasEverReturnedPreset) {
        if (debug) this.log(`check_preset: HW returned no preset, using Homey preset=${homeyPreset}`);
      }
      continue;
    }

    // Alleen loggen bij echte afwijking
    if (hwPreset !== homeyPreset) {
      this.log(`WARN: HW preset ${hwPreset} differs from Homey preset ${homeyPreset}. Ignoring.`);
    }

    } catch (err) {
      // Log naar legacy debug buffer
      try {
        const dev = homewizard.self?.devices?.[device.getData().id];
        dev?.fetchLegacyDebug?.log({
          type: err?.message || err || 'device_error',
          message: 'poll_failed',
          error: err?.message || String(err),
          ts: Date.now()
        });
      } catch (_) {}

      // Sync naar settings zodat het zichtbaar wordt in de UI
      this.syncLegacyDebugToSettings?.();

      // Alleen in debug naar de Homey-log
      if (debug) {
        this.log('HomeWizard data corrupt');
        this.log(err);
      }
}

}

      })
      .then(() => {
        this.setAvailable().catch(this.error);
      })
      .catch((err) => {
        this.error(err);
        this.setUnavailable(err).catch(this.error);
      });
  } // end of getStatus

}

module.exports = HomeWizardDevice;
