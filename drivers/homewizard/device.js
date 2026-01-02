'use strict';

const Homey = require('homey');
// const { ManagerDrivers } = require('homey');
// const drivers = ManagerDrivers.getDriver('homewizard');
// const { ManagerI18n } = require('homey');

const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;
const homeWizard_devices = {};

const preset_text = '';
const preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie'];
const preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday'];

const debug = false;

function callnewAsync(device_id, uri_part, {
  timeout = 4000,      // iets ruimer dan 3000ms
  retries = 1,         // verificatie hoeft niet agressief te zijn
  retryDelay = 1500    // rustiger retry
} = {}) {

  return new Promise((resolve, reject) => {
    let attempts = 0;

    const attempt = () => {
      attempts++;

      let finished = false;

      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          console.log(`[callnewAsync] Timeout on ${device_id}${uri_part}, retry ${attempts}/${retries}`);
          return setTimeout(attempt, retryDelay);
        }

        console.log(`[callnewAsync] FINAL TIMEOUT on ${device_id}${uri_part}`);
        return reject(new Error(`Timeout calling ${uri_part} on device ${device_id}`));
      }, timeout);

      homewizard.callnew(device_id, uri_part, (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);

        if (err) {
          if (attempts <= retries) {
            console.log(`[callnewAsync] Error on ${device_id}${uri_part}: ${err.message}, retry ${attempts}/${retries}`);
            return setTimeout(attempt, retryDelay);
          }

          console.log(`[callnewAsync] FINAL ERROR on ${device_id}${uri_part}: ${err.message}`);
          return reject(err);
        }

        console.log(`[callnewAsync] OK ${device_id}${uri_part}`);
        return resolve(result);
      });
    };

    attempt();
  });
}




class HomeWizardDevice extends Homey.Device {

  async onInit() {

    // await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);

    if (debug) { this.log('HomeWizard Appliance has been inited'); }

    if (!this.hasCapability('preset')) {
      await this.addCapability('preset').catch(this.error);
    }


    const devices = this.homey.drivers.getDriver('homewizard').getDevices();

    devices.forEach((device) => {
      this.log(`add device: ${JSON.stringify(device.getName())}`);

      homeWizard_devices[device.getData().id] = {};
      homeWizard_devices[device.getData().id].name = device.getName();
      homeWizard_devices[device.getData().id].settings = device.getSettings();
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

    //
    // 1. Homey bepaalt de preset → capability direct zetten
    //
    await this.setCapabilityValue('preset', String(presetId));
    await this.setStoreValue('preset', presetId);

    //
    // 2. Naar HomeWizard sturen
    //
    await callnewAsync(id, `/preset/${presetId}`);

    //
    // 3. Best-effort verificatie (mag falen!)
    //
    try {
      const sensors = await callnewAsync(id, '/get-sensors');
      const hwPreset = sensors?.preset;

      if (hwPreset !== presetId) {
        this.log(`WARN: HW returned preset ${hwPreset} but Homey set ${presetId}. Ignoring.`);
      }
    } catch (verifyErr) {
      this.log(`WARN: Verification failed after setting preset ${presetId}: ${verifyErr.message}`);
      // NIET throwen → Homey blijft leidend
    }

    //
    // 4. Flow triggeren
    //
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
          const callback = await homewizard.getDeviceData(device.getData().id, 'preset');
          const hwPreset = typeof callback === 'object' ? callback.id : callback;

          // Homey is leidend: store bevat de "waarheid" zoals Homey die gezet heeft
          const homeyPreset = await device.getStoreValue('preset');

          // Eerste init (bij lege store) → alleen store vullen, capability NIET aanpassen
          if (homeyPreset === null || homeyPreset === undefined) {
            if (debug) {
              this.log(`Initial preset store set to ${hwPreset} for device ${device.getName()}`);
            }
            await device.setStoreValue('preset', hwPreset);
            continue;
          }

          // Als HW afwijkt van Homey → alleen loggen, NIET aanpassen
          if (hwPreset !== homeyPreset) {
            this.log(
              `WARN: Polling detected HW preset ${hwPreset} but Homey preset ${homeyPreset} for device ${device.getName()}. Ignoring.`
            );
          }

          // Hier kun je andere capabilities updaten, maar preset NIET
          // (dus geen setCapabilityValue('preset') meer vanuit polling)

        } catch (err) {
          this.log('HomeWizard data corrupt');
          this.log(err);
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
} //end of getStatus

}

module.exports = HomeWizardDevice;