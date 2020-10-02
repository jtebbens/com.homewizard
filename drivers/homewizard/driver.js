'use strict';

const Homey = require('homey');
//const request = require('request');
const fetch = require('node-fetch');

var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var refreshIntervalId;

class HomeWizardDriver extends Homey.Driver {
    onInit() {
        console.log('HomeWizard has been inited');

        var me = this;

        // PRESETS
        new Homey.FlowCardCondition('check_preset')
            .register()
            .registerRunListener( async (args, state) => {
                if (! args.device) {
                    return false;
                }

                return new Promise((resolve, reject) => {
                    homewizard.call(args.device.getData().id, '/get-status/', (err, response) => {
                        if (err) {
                            console.log('ERR flowCardCondition  -> returned false');
                            // You can make a choice here: reject the promise with the error,
                            // or resolve it to return "false" return resolve(false); // OR: return reject(err)
                        }
                        console.log('arg.preset '+ args.preset + ' - hw preset ' +response.preset);
                        console.log(' flowCardCondition CheckPreset -> returned', (args.preset == response.preset));
                        return resolve(args.preset == response.preset);
                    });
                });
            });

        new Homey.FlowCardAction('set_preset')
            .register()
            .registerRunListener( async (args, state) => {
                if (! args.device) {
                    return false;
                }

                return new Promise((resolve, reject) => {

                    var uri = '/preset/' + args.preset;

                    homewizard.call(args.device.getData().id, uri, function(err, response) {
                        if(err) {
                            me.log('ERR flowCardAction set_preset  -> returned false');
                            return resolve(false);
                        }

                        me.log('flowCardAction set_preset  -> returned true');
                        return resolve(true);

                    });
                });
            });

        // SCENES
        new Homey.FlowCardAction('switch_scene_on')
            .register()
            .registerRunListener( async (args, state) => {
                if (! args.device) {
                    return false;
                }

                return new Promise((resolve, reject) => {
                    homewizard.call(args.device.getData().id, '/gp/' + args.scene.id + '/on', function(err, response) {
                        if(err) {
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
                console.log('CALLED flowCardAction switch_scene_on autocomplete');

                return this._onGetSceneAutocomplete(args);


            });

        // SCENES
        new Homey.FlowCardAction('switch_scene_off')
            .register()
            .registerRunListener( async (args, state) => {
                if (! args.device) {
                    return false;
                }

                return new Promise((resolve, reject) => {
                    homewizard.call(args.device.getData().id, '/gp/' + args.scene.id + '/off', function(err, response) {
                        if(err) {
                            console.log('ERR flowCardAction switch_scene_off  -> returned false');
                            return resolve(false);
                        }

                        me.log('flowCardAction switch_scene_off  -> returned true');
                        return resolve(true);

                    });
                });
            })
            .getArgument('scene')
            .registerAutocompleteListener(async (query, args) => {
                return this._onGetSceneAutocomplete(args)
            });

    }

    _onGetSceneAutocomplete(args) {

        var me = this;

        if (! args.device) {
            me.log('ERR flowCardAction switch_scene_on autocomplete - NO DEVICE');
            return false;
        }

        return new Promise((resolve, reject) => {
            homewizard.call(args.device.getData().id, '/gplist', function(err, response) {
                if(err) {
                    me.log('ERR flowCardAction switch_scene_on autocomplete');

                    return resolve(false);
                }

                var arrayAutocomplete = [];

                for (var i = 0, len = response.length; i < len; i++) {
                    arrayAutocomplete.push({
                        name: response[i].name,
                        id: response[i].id
                    });
                }

                me.log('_onGetSceneAutocomplete result', arrayAutocomplete);

                return resolve(arrayAutocomplete);
            });
        });
    }

    onPair( socket ) {
        // Show a specific view by ID
        socket.showView('start');

        // Show the next view
        socket.nextView();

        // Show the previous view
        socket.prevView();

        // Close the pair session
        socket.done();

        // Received when a view has changed
        socket.on('showView', ( viewId, callback ) => {
            callback();
            console.log('View: ' + viewId);
        });

        socket.on('manual_add', async function (device, callback) {

            var url = 'http://' + device.settings.homewizard_ip + '/' + device.settings.homewizard_pass + '/get-sensors/';

            const json = await fetch(url).then(res => res.json())

            console.log('Calling '+ url);

            if (json.status == 'ok') {
              console.log('Call OK');

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
/*
            request(url, function (error, response, body) {
                if (response === null || response === undefined) {
                            socket.emit("error", "http error");
                            return;
                }
                if (!error && response.statusCode == 200) {
                    var jsonObject = JSON.parse(body);

                    if (jsonObject.status == 'ok') {
                        console.log('Call OK');

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

        socket.on('disconnect', () => {
            console.log("User aborted pairing, or pairing is finished");
        });
    }



}

module.exports = HomeWizardDriver;
