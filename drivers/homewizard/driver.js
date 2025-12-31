'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');


const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;

function callnewAsync(device_id, uri_part, {
  timeout = 3000,
  retries = 2,
  retryDelay = 250
} = {}) {

  return new Promise((resolve, reject) => {

    let attempts = 0;

    const attempt = () => {
      attempts++;

      let timeoutId;
      let finished = false;

      // Timeout mechanisme
      timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;

        if (attempts <= retries) {
          return setTimeout(attempt, retryDelay);
        }

        return reject(new Error(`Timeout after ${timeout}ms`));
      }, timeout);

      // De echte call
      homewizard.callnew(device_id, uri_part, (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);

        if (err) {
          if (attempts <= retries) {
            return setTimeout(attempt, retryDelay);
          }
          return reject(err);
        }

        return resolve(result);
      });
    };

    attempt();
  });
}


class HomeWizardDriver extends Homey.Driver {
  onInit() {
    // this.log('HomeWizard has been inited');

    const me = this;

    // PRESETS
    this.homey.flow.getConditionCard('check_preset')
    .registerRunListener(async (args) => {
      if (!args.device) return false;

      try {
        const response = await callnewAsync(args.device.getData().id, '/get-status/');
        return args.preset == response.preset;

      } catch (err) {
        this.log('ERR flowCardCondition check_preset -> false');
        return false;
      }
    });


  this.homey.flow.getActionCard('set_preset')
  .registerRunListener(async (args, state) => {
    if (!args.device) return false;

    const uri = `/preset/${args.preset}`;

    try {
      await callnewAsync(args.device.getData().id, uri);
      this.log('flowCardAction set_preset -> returned true');
      return true;

    } catch (err) {
      this.log('ERR flowCardAction set_preset -> returned false');
      return false;
    }
  });


    // SCENES
    this.homey.flow.getActionCard('switch_scene_on')
    .registerRunListener(async (args) => {
      if (!args.device) return false;

      const uri = `/gp/${args.scene.id}/on`;

      try {
        await callnewAsync(args.device.getData().id, uri);
        this.log('flowCardAction switch_scene_on -> true');
        return true;

      } catch (err) {
        this.log('ERR flowCardAction switch_scene_on -> false');
        return false;
      }
    })
    .getArgument('scene')
    .registerAutocompleteListener(async (query, args) => {
      return this._onGetSceneAutocomplete(args);
    });


    // SCENES
    this.homey.flow.getActionCard('switch_scene_off')
    .registerRunListener(async (args) => {
      if (!args.device) return false;

      const uri = `/gp/${args.scene.id}/off`;

      try {
        await callnewAsync(args.device.getData().id, uri);
        this.log('flowCardAction switch_scene_off -> true');
        return true;

      } catch (err) {
        this.log('ERR flowCardAction switch_scene_off -> false');
        return false;
      }
    })
    .getArgument('scene')
    .registerAutocompleteListener(async (query, args) => {
      return this._onGetSceneAutocomplete(args);
    });


  }

  _onGetSceneAutocomplete(args) {

    if (!args.device) {
      this.log('ERR autocomplete - NO DEVICE');
      return [];
    }

    return callnewAsync(args.device.getData().id, '/gplist')
      .then(response => {
        if (!Array.isArray(response)) {
          this.log('ERR autocomplete - invalid response');
          return [];
        }

        return response.map(scene => ({
          name: scene.name,
          id: scene.id
        }));
      })
      .catch(err => {
        this.log('ERR autocomplete gplist', err);
        return [];
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
    /*socket.setHandler('showView', async (viewId) => {
      if (errorMsg) {
        this.log('[Driver] - Show errorMsg:', errorMsg);
        socket.emit('error_msg', errorMsg);
        errorMsg = false;
      }
    });
    */

    socket.setHandler('manual_add', async (device) => {

      const url = `http://${device.settings.homewizard_ip}/${device.settings.homewizard_pass}/get-sensors/`;

      let json;
      try {
        const res = await fetch(url, { timeout: 3000 });
        json = await res.json();
      } catch (err) {
        this.log('Pairing fetch error:', err);
        socket.emit('error', 'HomeWizard niet bereikbaar');
        return;
      }


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
