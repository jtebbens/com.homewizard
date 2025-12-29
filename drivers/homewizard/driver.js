'use strict';

const Homey = require('homey');
// const request = require('request');
// const fetch = require('node-fetch');
const fetch = require('../../includes/utils/fetchQueue');

const devices = {};
const homewizard = require('../../includes/legacy/homewizard.js');

let refreshIntervalId;

class HomeWizardDriver extends Homey.Driver {
  onInit() {
    // this.log('HomeWizard has been inited');

    const me = this;

    // PRESETS
    this.homey.flow.getConditionCard('check_preset')
    .registerRunListener(async (args, state) => {
      if (!args.device) return false;

      try {
        const response = await homewizard.callnew(args.device.getData().id, '/get-status/');
        return args.preset === response.preset;
      } catch (err) {
        this.log('ERR flowCardCondition -> returned false', err);
        return false;
      }
    });


    this.homey.flow.getActionCard('set_preset')
  .registerRunListener(async (args, state) => {
    if (!args.device) return false;

    const uri = `/preset/${args.preset}`;
    try {
      await homewizard.callnew(args.device.getData().id, uri);
      me.log('flowCardAction set_preset -> returned true');
      return true;
    } catch (err) {
      me.log('ERR flowCardAction set_preset -> returned false', err);
      return false;
    }
  });


    // SCENES
    this.homey.flow.getActionCard('switch_scene_on')
  .registerRunListener(async (args, state) => {
    if (!args.device) return false;

    try {
      await homewizard.callnew(args.device.getData().id, `/gp/${args.scene.id}/on`);
      me.log('flowCardAction switch_scene_on -> returned true');
      return true;
    } catch (err) {
      me.log('ERR flowCardAction switch_scene_on -> returned false', err);
      return false;
    }
  })
  .getArgument('scene')
  .registerAutocompleteListener(async (query, args) => {
    this.log('CALLED flowCardAction switch_scene_on autocomplete');
    return this._onGetSceneAutocomplete(args);
  });


    // SCENES
    this.homey.flow.getActionCard('switch_scene_off')
  .registerRunListener(async (args, state) => {
    if (!args.device) return false;

    try {
      await homewizard.callnew(args.device.getData().id, `/gp/${args.scene.id}/off`);
      me.log('flowCardAction switch_scene_off -> returned true');
      return true;
    } catch (err) {
      this.log('ERR flowCardAction switch_scene_off -> returned false', err);
      return false;
    }
  })
  .getArgument('scene')
  .registerAutocompleteListener(async (query, args) => {
    return this._onGetSceneAutocomplete(args);
  });


  }

 async _onGetSceneAutocomplete(args) {
  const me = this;

  if (!args.device) {
    me.log('ERR flowCardAction switch_scene_on autocomplete - NO DEVICE');
    return false;
  }

  try {
    const response = await homewizard.callnew(args.device.getData().id, '/gplist');
    const arrayAutocomplete = response.map(item => ({
      name: item.name,
      id: item.id,
    }));

    me.log('_onGetSceneAutocomplete result', arrayAutocomplete);
    return arrayAutocomplete;
  } catch (err) {
    me.log('ERR flowCardAction switch_scene_on autocomplete', err);
    return false;
  }
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

    socket.setHandler('manual_add', async (device) => {
  const url = `http://${device.settings.homewizard_ip}/${device.settings.homewizard_pass}/get-sensors/`;
  this.log(`Calling ${url}`);

  try {
    const res = await fetch(url);
    const json = await res.json();

    if (json.status === 'ok') {
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

    socket.emit('error', 'http error');
  } catch (err) {
    this.log('Pair manual_add error:', err);
    socket.emit('error', 'http error');
  }
});


    socket.setHandler('disconnect', async () => {
      this.log('User aborted pairing, or pairing is finished');
    });
  }

}

module.exports = HomeWizardDriver;
