'use strict';

const Homey = require('homey');
//const request = require('request');

const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('homewizard');
var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var homewizard_devices;

class HomeWizardHeatlink extends Homey.Driver {

    onInit() {
        console.log('HomeWizard Heatlink has been inited');

        new Homey.FlowCardAction('heatlink_off')
            .register()
            .registerRunListener( async (args, state) => {
                if (!args.device) {
                    return false;
                }

                return new Promise((resolve, reject) => {

                    homewizard.call(args.device.getData().id, '/hl/0/settarget/0', function(err, response) {
                        if(err) {
                            console.log('ERR flowCardAction heatlink_off  -> returned false');
                            return resolve(false);
                        }

                        console.log('flowCardAction heatlink_off  -> returned true');
                        return resolve(true);
                    });

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
        socket.on('showView', (viewId, callback) => {
            callback();
            console.log('View: ' + viewId);
        });

        socket.on('get_homewizards', function () {

            homewizard_devices = driver.getDevices();

            homewizard.getDevices(function ( homewizard_devices)  {
                var hw_devices = {};

                Object.keys(homewizard_devices).forEach(function (key) {
                    hw_devices[key] = homewizard_devices[key];
                });

                console.log(hw_devices);
                socket.emit('hw_devices', hw_devices);

            });
        });

        socket.on('manual_add', function (device, callback) {

            if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
                //true
                console.log('HeatLink added ' + device.data.id);
                devices[device.data.id] = {
                  id: device.data.id,
                  name: device.name,
                  settings: device.settings,
                };
                callback( null, devices );
                socket.emit("success", device);

            } else {
                socket.emit("error", "No valid HomeWizard found, re-pair if problem persists");
            }
        });

        socket.on('disconnect', function(){
            console.log("User aborted pairing, or pairing is finished");
        });

    }

}

module.exports = HomeWizardHeatlink;

// var devices = {};
// var homewizard = require('./../../includes/homewizard.js');
// var refreshIntervalId = 0;
//
// // SETTINGS
// module.exports.settings = function( device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback ) {
//     console.log ('Changed settings: ' + JSON.stringify(device_data) + ' / ' + JSON.stringify(newSettingsObj) + ' / old = ' + JSON.stringify(oldSettingsObj));
//     try {
// 	    changedKeysArr.forEach(function (key) {
// 		    devices[device_data.id].settings[key] = newSettingsObj[key];
// 		});
// 		callback(null, true);
//     } catch (error) {
//       callback(error);
//     }
// };

//
// module.exports.deleted = function( device_data ) {
//     delete devices[device_data.id];
//     if (Object.keys(devices).length === 0) {
//         clearInterval(refreshIntervalId);
//         console.log("--Stopped Polling--");
//     }
//     console.log('deleted: ' + JSON.stringify(device_data));
// };
//
//
// module.exports.capabilities = {
//
//   measure_temperature: {
//     get: function (device, callback) {
//       if (device instanceof Error) return callback(device);
//       console.log("measure_temperature");
//       getStatus(device.id);
//       var newvalue = devices[device.id].temperature;
//       // Callback ambient temperature
//       callback(null, newvalue);
//     }
//   },
//   target_temperature: {
//
//     get: function (device, callback) {
//       if (device instanceof Error) return callback(device);
//       console.log("target_temperature:get");
//       // Retrieve updated data
//       getStatus(device.id);
//       var newvalue;
//       if (devices[device.id].setTemperature !== 0) {
//         newvalue = devices[device.id].setTemperature;
//       } else {
//         newvalue = devices[device.id].thermTemperature;
//       }
//       callback(null, newvalue);
//     },
//
//     set: function (device, temperature, callback) {
//       if (device instanceof Error) return callback(device);
//         // Catch faulty trigger and max/min temp
//         if (!temperature) {
//           callback(true, temperature);
//           return false;
//         }
//         else if (temperature < 5) {
//           temperature = 5;
//         }
//         else if (temperature > 35) {
//           temperature = 35;
//         }
//         temperature = Math.round(temperature.toFixed(1) * 2) / 2;
//         var url = '/hl/0/settarget/'+temperature;
//         console.log(url);
//         var homewizard_id = devices[device.id].settings.homewizard_id;
//         homewizard.call(homewizard_id, '/hl/0/settarget/'+temperature, function(err, response) {
//             console.log(err);
//             if (callback) callback(err, temperature);
//         });
//     }
//   },
// };
//
// Homey.manager('flow').on('action.heatlink_off', function( callback, args ){
//     homewizard.call(args.device.id, '/hl/0/settarget/0', function(err, response) {
//       if (err === null) {
//         console.log('Heatlink Off');
//         callback( null, true );
//       } else {
//         callback(err, false); // err
//       }
//     });
// });
//
// function getStatus(device_id) {
//     if(devices[device_id].settings.homewizard_id !== undefined ) {
//         var homewizard_id = devices[device_id].settings.homewizard_id;
//         homewizard.getDeviceData(homewizard_id, 'heatlinks', function(callback) {
//             if (Object.keys(callback).length > 0) {
//            	try {
//                 var rte = (callback[0].rte.toFixed(1) * 2) / 2;
//                 var rsp = (callback[0].rsp.toFixed(1) * 2) / 2;
//                 var tte = (callback[0].tte.toFixed(1) * 2) / 2;
//
//                 //Check current temperature
//                 if (devices[device_id].temperature != rte) {
//                   console.log("New RTE - "+ rte);
//                   module.exports.realtime( { id: device_id }, "measure_temperature", rte );
//                   devices[device_id].temperature = rte;
//                 } else {
//                   console.log("RTE: no change");
//                 }
//
//                 //Check thermostat temperature
//                 if (devices[device_id].thermTemperature != rsp) {
//                   console.log("New RSP - "+ rsp);
//                   if (devices[device_id].setTemperature === 0) {
//                     module.exports.realtime( { id: device_id }, "target_temperature", rsp );
//                   }
//                   devices[device_id].thermTemperature = rsp;
//                 } else {
//                   console.log("RSP: no change");
//                 }
//
//                 //Check heatlink set temperature
//                 if (devices[device_id].setTemperature != tte) {
//                   console.log("New TTE - "+ tte);
//                   if (tte > 0) {
//                     module.exports.realtime( { id: device_id }, "target_temperature", tte );
//                   } else {
//                     module.exports.realtime( { id: device_id }, "target_temperature", devices[device_id].thermTemperature );
//                   }
//                   devices[device_id].setTemperature = tte;
//                 } else {
//                   console.log("TTE: no change");
//                 }
//             } catch(err) {
//                       console.log ("Heatlink data corrupt");
//                 }
//             }
//         });
//     } else {
//         console.log('Removed Heatlink '+ device_id +' (old settings)');
//         module.exports.setUnavailable({id: device_id}, "No Heatlink found" );
//         // Only clear interval when the unavailable device is the only device on this driver
//         // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
//         // In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem
//         if(Object.keys(devices).length === 1) {
//             clearInterval(refreshIntervalId);
//         }
//     }
//  }
//
//  function startPolling() {
// 	   if (refreshIntervalId) {
// 		     clearInterval(refreshIntervalId);
// 	   }
//      refreshIntervalId = setInterval(function () {
//          console.log("--Start Heatlink Polling-- ");
//          Object.keys(devices).forEach(function (device_id) {
//              getStatus(device_id);
//          });
//      }, 1000 * 10);
//  }
