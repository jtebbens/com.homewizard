'use strict';

const Homey = require('homey');
const request = require('request');
const util = require('util');

var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var refreshIntervalId;

class HomeWizardDriver extends Homey.Driver {
    onInit() {
        this.log('HomeWizard has been inited');

        var me = this;

        new Homey.FlowCardCondition('check_preset')
            .register()
            .registerRunListener(HomeWizardDriver._onFlowCardConditionCheckPreset.bind(this));

        // new Homey.FlowCardCondition('check_preset')
        //     .register()
        //     .registerRunListener( async (args, state) => {
        //
        //     let myCall = util.promisify(homewizard.call);
        //
        //     myCall(args.device.getData().id, '/get-status/', function(err, response) {
        //
        //       if (err === null) {
        //           me.log('arg.preset '+ args.preset + ' - hw preset ' +response.preset);
        //
        //           if(args.preset == response.preset) {
        //               me.log('Return True');
        //               return Promise.resolve(true)
        //           } else {
        //               me.log('Return False');
        //               return Promise.reject(false)
        //           }
        //           // var result = (args.preset == response.preset);
        //           // me.log('FlowCardCondition(\'check_preset\') result ' + result);
        //           // return result;
        //
        //       } else {
        //           me.log('Err != null');
        //         return false;
        //         // callback(err, false); // err
        //       }
        //     });
        // });
    }

    static async _onFlowCardConditionCheckPreset(args = {}) {

        if (Object.prototype.hasOwnProperty.call(args, 'device')) {

            var me = this;
            const result = false;

            homewizard.call(args.device.getData().id, '/get-status/', function(err, response) {
                if (response) {
                    me.log('arg.preset '+ args.preset + ' - hw preset ' +response.preset);

                    me.log('_onFlowCardConditionCheckPreset() -> returned', (args.preset == response.preset));
                    return args.preset == response.preset;
                    // if(args.preset == response.preset) {
                    //     const result = true;
                    // }
                } else {
                    this.log('ERR _onFlowCardConditionCheckPreset() -> returned', result);
                    return result;
                }
            });

            this.log('NOCALL _onFlowCardConditionCheckPreset() -> returned', result);
            return result;
        }

        throw new Error(Homey.__('error.missing_argument'));

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

        socket.on('manual_add', function (device, callback) {

            var url = 'http://' + device.settings.homewizard_ip + '/' + device.settings.homewizard_pass + '/get-status/';

            console.log('Calling '+ url);

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
        });

        socket.on('disconnect', () => {
            console.log("User aborted pairing, or pairing is finished");
        });
    }



}

module.exports = HomeWizardDriver;

// // SCENES
// Homey.manager('flow').on('action.switch_scene_on.scene.autocomplete', function( callback, args ){
// 	Homey.log('getScenes autocomplete called');
//     homewizard.getScenes(args, function(err, response) {
//       callback(err, response ); // err, results
//     });
// });
//
// Homey.manager('flow').on('action.switch_scene_on', function( callback, args ){
// 	Homey.log('args.device.id: ' + JSON.stringify(args.device.id));
// 	Homey.log('args.scene.id: ' + JSON.stringify(args.scene.id));
//     homewizard.call(args.device.id, '/gp/' + args.scene.id + '/on', function(err, response) {
//       if (err === null) {
//         Homey.log('Scene is on');
//         callback( null, true );
//       } else {
//         callback(err, false); // err
//       }
//     });
// });
//
// Homey.manager('flow').on('action.switch_scene_off.scene.autocomplete', function( callback, args ){
//     homewizard.getScenes(args, function(err, response) {
//       callback(err, response ); // err, results
//     });
// });
//
// Homey.manager('flow').on('action.switch_scene_off', function( callback, args ){
//     homewizard.call(args.device.id, '/gp/' + args.scene.id + '/off', function(err, response) {
//       if (err === null) {
//         Homey.log('Scene is off');
//         callback( null, true );
//       } else {
//         callback(err, false); // err
//       }
//     });
// });
//
//
// // PRESETS
// Homey.manager('flow').on('condition.check_preset', function( callback, args ){
//     homewizard.call(args.device.id, '/get-status/', function(err, response) {
//       if (err === null) {
//         if (response.preset == args.preset) {
//             Homey.log('Yes, preset is: '+ response.preset+'!');
//             if(typeof callback === 'function') {
//                 callback(null, true);
//             }
//         } else {
//             Homey.log('Preset is: ' + response.preset+', not '+args.preset);
//             if(typeof callback === 'function') {
//                 callback(null, false);
//             }
//         }
//       } else {
//         callback(err, false); // err
//       }
//     });
// });
//
//
// Homey.manager('flow').on('action.set_preset', function( callback, args ){
//     var uri = '/preset/' + args.preset;
//     homewizard.call(args.device.id, uri, function(err, response) {
//       if (err === null) {
//         homewizard.ledring_pulse(args.device.id, 'green');
//         callback(null, true);
//       } else {
//         homewizard.ledring_pulse(args.device.id, 'red');
//         callback(err, false); // err
//       }
//     });
// });
