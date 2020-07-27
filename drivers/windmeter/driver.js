//
//
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
//             Homey.log('Windmeter added ' + device.data.id);
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
// 	Homey.log('Windmeter driver init done');
//
// 	callback (null, true);
// };
//
// module.exports.deleted = function( device_data ) {
//     delete devices[device_data.id];
//     if (Object.keys(devices).length === 0) {
//         clearInterval(refreshIntervalId);
//         console.log("--Stopped Polling Windmeter--");
//     }
//     Homey.log('deleted: ' + JSON.stringify(device_data));
// };
//
// module.exports.capabilities = {
//     "measure_wind_angle": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_wind_angle);
//             }
//         }
//     },
// 	"measure_wind_strength.cur": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_wind_strength_current);
//             }
//         }
//     },
// 	"measure_wind_strength.min": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_wind_strength_min);
//             }
//         }
//     },
// 	"measure_wind_strength.max": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_wind_strength_max);
//             }
//         }
//     },
// 	"measure_gust_strength": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_gust_strength);
//             }
//         }
//     },
// 	"measure_temperature.real": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_temperature_real);
//             }
//         }
//     },
// 	"measure_temperature.windchill": {
//         get: function (device_data, callback) {
//             var device = devices[device_data.id];
//
//             if (device === undefined) {
//                 callback(null, 0);
//             } else {
//                 callback(null, device.last_measure_temperature_windchill);
//             }
//         }
//     }
// };
//
// // Start polling
// function startPolling() {
//     if(refreshIntervalId){
//         clearInterval(refreshIntervalId);
//     }
//     refreshIntervalId = setInterval(function () {
//         console.log("--Start Windmeter Polling-- ");
//         Object.keys(devices).forEach(function (device_id) {
//           getStatus(device_id);
//         });
//     }, 1000 * 10);
// }
//
// function getStatus(device_id) {
//     if(devices[device_id].settings.homewizard_id !== undefined ) {
//         var homewizard_id = devices[device_id].settings.homewizard_id;
//         homewizard.getDeviceData(homewizard_id, 'windmeters', function(callback) {
//             if (Object.keys(callback).length > 0) {
//                 try {
// 					Homey.log ("Callback: ") + JSON.stringify(callback);
//                     module.exports.setAvailable({id: device_id});
// 					console.log ("Start capture var data");
// 					var wind_angle_tmp = ( callback[0].dir ); // $windmeters[0]['dir'] SW 225
// 					var wind_angle_int = wind_angle_tmp.split(" ");
// 					// var wind_angle = parseInt(wind_angle_tmp); // Capture only the angle portion (number)
// 					var wind_strength_current = ( callback[0].ws ); // $windmeters[0]['ws'] Windspeed in km/h
// 					var wind_strength_min = ( callback[0]["ws-"] ); // $windmeters[0]['ws-'] Min Windspeed in km/h
// 					var wind_strength_max = ( callback[0]["ws+"] ); // $windmeters[0]['ws+'] Max Windspeed in km/h
//                     var gust_strength = ( callback[0].gu ); // $windmeters[0]['gu'] Gust speed in km/h
// 					var temp_real = ( callback[0].te ); // $windmeters[0]['te'] Temperature
// 					var temp_windchill = ( callback[0].wc); // $windmeters[0]['wc'] Windchill temperature
// 					console.log ("End capture var data");
// 					// Export the data
// 					// Console data
// 				    var wind_angle_str = wind_angle_int[1];
// 				    var wind_angle = parseInt(wind_angle_str);
// 				    console.log("Windangle in degrees: "+ wind_angle);
//                     console.log("Windspeed in km/u: "+ wind_strength_current);
// 					console.log("Min Windspeed in km/u: "+ wind_strength_min);
// 					console.log("Min Windspeed in km/u: "+ wind_strength_max);
// 					console.log("Gust strength in km/u: "+ gust_strength);
// 					console.log("Temperature current: "+ temp_real);
// 					console.log("Temperature windchill: "+ temp_windchill);
//                     // Wind angle
// 					module.exports.realtime( { id: device_id }, "measure_wind_angle", wind_angle );
//                     // Wind speed current
//                     module.exports.realtime( { id: device_id }, "measure_wind_strength.cur", wind_strength_current );
// 					// Wind speed min
//                     module.exports.realtime( { id: device_id }, "measure_wind_strength.min", wind_strength_min );
// 					// Wind speed max
//                     module.exports.realtime( { id: device_id }, "measure_wind_strength.max", wind_strength_max );
// 					// Wind speed
//                     module.exports.realtime( { id: device_id }, "measure_gust_strength", gust_strength );
//                     // Temp real
//                     module.exports.realtime( { id: device_id }, "measure_temperature.real", temp_real );
// 					// Temp Windchill
//                     module.exports.realtime( { id: device_id }, "measure_temperature.windchill", temp_windchill );
// 					// Console data
// 					console.log("Windangle in degrees: "+ wind_angle);
//                     console.log("Windspeed in km/u: "+ wind_strength_current);
// 					console.log("Min Windspeed in km/u: "+ wind_strength_min);
// 					console.log("Min Windspeed in km/u: "+ wind_strength_max);
// 					console.log("Gust strength in km/u: "+ gust_strength);
// 					console.log("Temperature current: "+ temp_real);
// 					console.log("Temperature windchill: "+ temp_windchill);
//                 } catch (err) {
//                     // Error with Wind no data in Rainmeters
//                     console.log ("No Windmeter found");
//                     module.exports.setUnavailable({id: device_id}, "No Windmeter found" );
//                 }
//             }
//         });
//     } else {
//         Homey.log('Removed Windmeter '+ device_id +' (old settings)');
//         module.exports.setUnavailable({id: device_id}, "No Windmeter found" );
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
