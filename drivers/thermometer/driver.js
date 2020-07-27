'use strict';

const Homey = require('homey');
const request = require('request');


const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('homewizard');

var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var homewizard_devices;

class HomeWizardThermometer extends Homey.Driver {

    onInit() {
        this.log('HomeWizard Thermometer has been inited');
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
                    var thermometers = JSON.stringify(homewizard_devices[key].polldata.thermometers);

                    hw_devices[key] = homewizard_devices[key];
                    hw_devices[key].polldata = {}
                    hw_devices[key].thermometers = thermometers;
                });

                console.log(hw_devices);
                socket.emit('hw_devices', hw_devices);

            });
        });

        socket.on('manual_add', function (device, callback) {
            if (typeof device.settings.homewizard_id == "string" && device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
                //true
                console.log('Thermometer added ' + device.data.id);
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

        socket.on('disconnect', () => {
            console.log("User aborted pairing, or pairing is finished");
        });
    };

    onPairListDevices( data, callback ) {
        const devices = [

        ]

        callback(null, devices);
    };

}

module.exports = HomeWizardThermometer;

// var devices = {};
// var homewizard = require('./../../includes/homewizard.js');
// var refreshIntervalId = 0;
//
// // SETTINGS
// module.exports.settings = function( device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback ) {
//     Homey.log ('Changed settings: ' + JSON.stringify(device_data) + ' / ' + JSON.stringify(newSettingsObj) + ' / old = ' + JSON.stringify(oldSettingsObj));
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
// module.exports.pair = function( socket ) {
//     socket.on('get_homewizards', function () {
//         homewizard.getDevices(function(homewizard_devices) {
//             var hw_devices = {};
//             Object.keys(homewizard_devices).forEach(function(key) {
//                 var thermometers = JSON.stringify(homewizard_devices[key].polldata.thermometers);
//
//                 hw_devices[key] = homewizard_devices[key];
//                 hw_devices[key].polldata = {};
//                 hw_devices[key].thermometers = thermometers;
//             });
//             socket.emit('hw_devices', hw_devices);
//         });
//     });
//
//     socket.on('manual_add', function (device, callback) {
//         if (typeof device.settings.homewizard_id == "string" && device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
//             //true
//             Homey.log('Thermometer added ' + device.data.id);
//             devices[device.data.id] = {
//               id: device.data.id,
//               name: device.name,
//               settings: device.settings,
//             };
//             callback( null, devices );
//             socket.emit("success", device);
//             startPolling();
//         } else {
//             socket.emit("error", "No valid HomeWizard found, re-pair if problem persists");
//         }
//     });
//
//     socket.on('disconnect', function(){
//         console.log("User aborted pairing, or pairing is finished");
//     });
// }
//
// module.exports.init = function(devices_data, callback) {
//     devices_data.forEach(function initdevice(device) {
//         Homey.log('add device: ' + JSON.stringify(device));
//         devices[device.id] = device;
//         module.exports.getSettings(device, function(err, settings){
//             devices[device.id].settings = settings;
//         });
//
//     });
//     if (Object.keys(devices).length > 0) {
//       startPolling();
//     }
// 	Homey.log('Thermometer driver init done');
//
// 	callback (null, true);
// };
//
// module.exports.deleted = function( device_data ) {
//     delete devices[device_data.id];
//     if (Object.keys(devices).length === 0) {
//         clearInterval(refreshIntervalId);
//         Homey.log("--Stopped Polling--");
//     }
//     Homey.log('deleted: ' + JSON.stringify(device_data));
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
// };
//
// function getStatus(device_id) {
//     if(devices[device_id].settings.homewizard_id !== undefined ) {
//         var homewizard_id = devices[device_id].settings.homewizard_id;
//         var thermometer_id = devices[device_id].settings.thermometer_id;
//         homewizard.getDeviceData(homewizard_id, 'thermometers', function(callback) {
//
//             if (Object.keys(callback).length > 0) {
//                 try {
//                     for (var index in callback){
//                         if (callback[index].id == thermometer_id) {
//                             var te = (callback[index].te.toFixed(1) * 2) / 2;
//                             var hu = (callback[index].hu.toFixed(1) * 2) / 2;
//
//                             //Check current temperature
//                             if (devices[device_id].temperature != te) {
//                               console.log("New TE - "+ te);
//                               module.exports.realtime( { id: device_id }, "measure_temperature", te );
//                               devices[device_id].temperature = te;
//                             } else {
//                               //console.log("TE: no change");
//                             }
//
//                             //Check current humidity
//                             if (devices[device_id].humidity != hu) {
//                               console.log("New HU - "+ hu);
//                               module.exports.realtime( { id: device_id }, "measure_humidity", hu );
//                               devices[device_id].humidity = hu;
//                             } else {
//                               //console.log("HU: no change");
//                             }
//                         }
//                     }
//                 } catch(err) {
//                       console.log ("Thermometer data corrupt");
//                 }
//             }
//         });
//     } else {
//         this.log('Removed Thermometer '+ device_id +' (old settings)');
//         module.exports.setUnavailable({id: device_id}, "No Thermometer found" );
//         // Only clear interval when the unavailable device is the only device on this driver
//         // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
//         // In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem
//         if(Object.keys(devices).length === 1) {
//             clearInterval(refreshIntervalId);
//         }
//     }
//  }
//
// function startPolling() {
//     if (refreshIntervalId) {
//       clearInterval(refreshIntervalId);
//     }
//     refreshIntervalId = setInterval(function () {
//         Homey.log("--Start Thermometer Polling-- ");
//         Object.keys(devices).forEach(function (device_id) {
//             getStatus(device_id);
//         });
//     }, 1000 * 10);
//  }