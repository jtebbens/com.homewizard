'use strict';

const Homey = require('homey');

class HomeWizardWattcher extends Homey.Device {
}

module.exports = HomeWizardWattcher;

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
//             Homey.log(homewizard_devices);
//             var hw_devices = {};
//             Object.keys(homewizard_devices).forEach(function(key) {
//                 hw_devices[key] = homewizard_devices[key];
//             });
//
//             socket.emit('hw_devices', hw_devices);
//         });
//     });
//
//     socket.on('manual_add', function (device, callback) {
//         if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
//             //true
//             Homey.log('Wattcher added ' + device.data.id);
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
//     });
//     if (Object.keys(devices).length > 0) {
//       startPolling();
//     }
// 	Homey.log('Wattcher driver init done');
//
// 	callback (null, true);
// };
//
// module.exports.deleted = function( device_data ) {
//     delete devices[device_data.id];
//     if (Object.keys(devices).length === 0) {
//         clearInterval(refreshIntervalId);
//         console.log("--Stopped Polling Wattcher--");
//     }
//     Homey.log('deleted: ' + JSON.stringify(device_data));
// };
//
// module.exports.capabilities = {
//     measure_power: {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.power);
//             }
//         }
//     },
//     meter_power: {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.energy);
//             }
//         }
//     }
//
// };
//
// // Start polling
// function startPolling() {
//     if(refreshIntervalId){
//         clearInterval(refreshIntervalId);
//     }
//     refreshIntervalId = setInterval(function () {
//         console.log("--Start Wattcher Polling-- ");
//         Object.keys(devices).forEach(function (device_id) {
//           getStatus(device_id);
//         });
//     }, 1000 * 10);
// }
//
// function getStatus(device_id) {
//     if(devices[device_id].settings.homewizard_id !== undefined ) {
//         var homewizard_id = devices[device_id].settings.homewizard_id;
//         homewizard.getDeviceData(homewizard_id, 'energymeters', function(callback) {
//             if (Object.keys(callback).length > 0) {
//                 try {
//                     module.exports.setAvailable({id: device_id});
//                     var energy_current_cons = ( callback[0].po ); // WATTS Energy used JSON $energymeters[0]['po']
//                     var energy_daytotal_cons = ( callback[0].dayTotal ); // KWH Energy used JSON $energymeters[0]['dayTotal']
//
//                      // Wattcher elec current
//                      module.exports.realtime( { id: device_id }, "measure_power", energy_current_cons );
//                      // Wattcher elec total day
//                      module.exports.realtime( { id: device_id }, "meter_power", energy_daytotal_cons );
//
//                      console.log("Wattcher usage- "+ energy_current_cons);
//                      console.log("Wattcher Daytotal- "+ energy_daytotal_cons);
//                 } catch (err) {
//                     // Error with Wattcher no data in Energymeters
//                     console.log ("No Wattcher found");
//                     module.exports.setUnavailable({id: device_id}, "No Wattcher found" );
//                 }
//             }
//         });
//     } else {
//         Homey.log('Removed Wattcher '+ device_id +' (old settings)');
//         module.exports.setUnavailable({id: device_id}, "No Wattcher found" );
//         // Only clear interval when the unavailable device is the only device on this driver
//         // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
//         // In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem
//         if(Object.keys(devices).length === 1) {
//             clearInterval(refreshIntervalId);
//         }
//     }
// }
//
//
