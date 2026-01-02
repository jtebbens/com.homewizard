'use strict';

const Homey = require('homey');
// const request = require('request');
const fetch = require('node-fetch');
// const fetch = require('../../includes/utils/fetchQueue');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');
const debug = false;

let refreshIntervalId;

class HomeWizardDriver extends Homey.Driver {
  onInit() {
    // this.log('HomeWizard has been inited');

    const me = this;

    // PRESETS
    this.homey.flow.getConditionCard('check_preset')
  .registerRunListener(async (args) => {
    if (!args.device) return false;

    const device = args.device;
    const flowPreset = String(args.preset);

    //
    // 1. Eerst proberen de unit te lezen
    //
    try {
      const response = await new Promise((resolve, reject) => {
        homewizard.callnew(device.getData().id, '/get-status/', (err, res) => {
          if (err) return reject(err);
          resolve(res);
        });
      });

      const hwPreset = response?.preset;

      if (hwPreset !== undefined && hwPreset !== null) {
        if (debug) this.log(`check_preset: HW=${hwPreset}, flow=${flowPreset}`);
        return String(hwPreset) === flowPreset;
      }

      this.log('check_preset: HW returned no preset, falling back to capability');
    }

    //
    // 2. Als HW faalt → capability fallback
    //
    catch (err) {
      this.log(`check_preset: HW error "${err.message}", falling back to capability`);
    }

    //
    // 3. Capability fallback
    //
    const capPreset = device.getCapabilityValue('preset');

    if (capPreset === null || capPreset === undefined) {
      this.log('check_preset: capability preset missing → false');
      return false;
    }

    this.log(`check_preset (fallback): cap=${capPreset}, flow=${flowPreset}`);
    return String(capPreset) === flowPreset;
  });



    this.homey.flow.getActionCard('set_preset')
  .registerRunListener(async (args) => {
    if (!args.device) return false;

    const device = args.device;
    const presetId = Number(args.preset);
    const id = device.getData().id;

    try {
      this.log(`ActionCard set_preset: setting preset ${presetId} on HW device ${id}`);

      //
      // 1. HomeWizard aansturen
      //
      await new Promise((resolve, reject) => {
        homewizard.callnew(id, `/preset/${presetId}`, (err, response) => {
          if (err) return reject(err);
          resolve(response);
        });
      });

      //
      // 2. Controleren of HW het accepteert
      //
      let hwPreset = null;

      try {
        const sensors = await new Promise((resolve, reject) => {
          homewizard.callnew(id, '/get-sensors', (err, res) => {
            if (err) return reject(err);
            resolve(res);
          });
        });

        hwPreset = sensors?.preset;

      } catch (err) {
        this.log(`WARN: set_preset → HW verification failed (${err.message}). Falling back to Homey state.`);
      }

      //
      // 3. Logging van mismatch (maar Homey blijft leidend)
      //
      if (hwPreset !== null && hwPreset !== presetId) {
        this.log(`WARN: HW returned preset ${hwPreset} but action set ${presetId}. Homey remains authoritative.`);
      }

      //
      // 4. Homey state NIET aanpassen hier
      //    → dat doet de capability listener in device.js
      //

      this.log('ActionCard set_preset -> returned true');
      return true;

    } catch (err) {
      this.log(`ERR ActionCard set_preset -> returned false: ${err.message}`);
      return false;
    }
  });

    // SCENES
    this.homey.flow.getActionCard('switch_scene_on')
    // .register()
      .registerRunListener(async (args, state) => {
        if (!args.device) {
          return false;
        }

        return new Promise((resolve, reject) => {
          homewizard.callnew(args.device.getData().id, `/gp/${args.scene.id}/on`, (err, response) => {
            if (err) {
              me.log('ERR flowCardAction switch_scene_on  -> returned false');
              return resolve(false);
            }

            me.log('flowCardAction switch_scene_on  -> returned true');
            return resolve(true);

          });
        });
      })
      .getArgument('scene')
      .registerAutocompleteListener(async (query, args) => {
        this.log('CALLED flowCardAction switch_scene_on autocomplete');

        return this._onGetSceneAutocomplete(args);

      });

    // SCENES
    this.homey.flow.getActionCard('switch_scene_off')
    // .register()
      .registerRunListener(async (args, state) => {
        if (!args.device) {
          return false;
        }

        return new Promise((resolve, reject) => {
          homewizard.callnew(args.device.getData().id, `/gp/${args.scene.id}/off`, (err, response) => {
            if (err) {
              this.log('ERR flowCardAction switch_scene_off  -> returned false');
              return resolve(false);
            }

            me.log('flowCardAction switch_scene_off  -> returned true');
            return resolve(true);

          });
        });
      })
      .getArgument('scene')
      .registerAutocompleteListener(async (query, args) => {
        return this._onGetSceneAutocomplete(args);
      });

  }

  _onGetSceneAutocomplete(args) {

    const me = this;

    if (!args.device) {
      me.log('ERR flowCardAction switch_scene_on autocomplete - NO DEVICE');
      return false;
    }

    return new Promise((resolve, reject) => {
      homewizard.callnew(args.device.getData().id, '/gplist', (err, response) => {
        if (err) {
          me.log('ERR flowCardAction switch_scene_on autocomplete');

          return resolve(false);
        }

        const arrayAutocomplete = [];

        for (let i = 0, len = response.length; i < len; i++) {
          arrayAutocomplete.push({
            name: response[i].name,
            id: response[i].id,
          });
        }

        me.log('_onGetSceneAutocomplete result', arrayAutocomplete);

        return resolve(arrayAutocomplete);
      });
    });
  }

  onPair(socket) {
    // Show a specific view by ID
    socket.showView('start');

    // Show the next view
    socket.nextView();

    // Show the previous view
    socket.prevView();

    // Close the pair session
    socket.done();

    // Received when a view has changed
    socket.setHandler('showView', async (viewId) => {
      if (errorMsg) {
        this.log('[Driver] - Show errorMsg:', errorMsg);
        socket.emit('error_msg', errorMsg);
        errorMsg = false;
      }
    });

    socket.setHandler('manual_add', async (device) => {

      const url = `http://${device.settings.homewizard_ip}/${device.settings.homewizard_pass}/get-sensors/`;

      const json = await fetch(url).then((res) => res.json());

      this.log(`Calling ${url}`);

      if (json.status == 'ok') {
        this.log('Call OK');

        devices[device.data.id] = {
          id: device.data.id,
          name: device.name,
          settings: device.settings,
          capabilities: device.capabilities,
        };
        homewizard.setDevices(devices);

        socket.emit('success', device);
        return devices;

      }
      /*
            request(url, function (error, response, body) {
                if (response === null || response === undefined) {
                            socket.emit("error", "http error");
                            return;
                }
                if (!error && response.statusCode == 200) {
                    var jsonObject = JSON.parse(body);

                    if (jsonObject.status == 'ok') {
                        this.log('Call OK');

                        devices[device.data.id] = {
                            id: device.data.id,
                            name: device.name,
                            settings: device.settings,
                            capabilities: device.capabilities
                        };
                        homewizard.setDevices(devices);

                        callback( null, devices );
                        socket.emit("success", device);
                    }
                }
            });
  */
    });

    socket.setHandler('disconnect', async () => {
      this.log('User aborted pairing, or pairing is finished');
    });
  }

}

module.exports = HomeWizardDriver;
