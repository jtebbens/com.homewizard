var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var refreshIntervalId = 0;

// SETTINGS
module.exports.settings = function( device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback ) {
    Homey.log ('Changed settings: ' + JSON.stringify(device_data) + ' / ' + JSON.stringify(newSettingsObj) + ' / old = ' + JSON.stringify(oldSettingsObj));
    try {
	    changedKeysArr.forEach(function (key) {
		    devices[device_data.id].settings[key] = newSettingsObj[key];
		});
		callback(null, true);
    } catch (error) {
      callback(error);
    }
};

module.exports.pair = function( socket ) {
    socket.on('get_homewizards', function () {
        homewizard.getDevices(function(homewizard_devices) {
            Homey.log(homewizard_devices);
            var hw_devices = {};
            Object.keys(homewizard_devices).forEach(function(key) {
                hw_devices[key] = homewizard_devices[key];
            });

            socket.emit('hw_devices', hw_devices);
        });
    });

    socket.on('manual_add', function (device, callback) {
        if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
            //true
            Homey.log('Rainmeter added ' + device.data.id);
            devices[device.data.id] = {
              id: device.data.id,
              name: device.name,
              settings: device.settings,
            };
            callback( null, devices );
            socket.emit("success", device);
            startPolling();
        } else {
            socket.emit("error", "No valid HomeWizard found, re-pair if problem persists");
        }
    });

    socket.on('disconnect', function(){
        console.log("User aborted pairing, or pairing is finished");
    });
}

module.exports.init = function(devices_data, callback) {
    devices_data.forEach(function initdevice(device) {
        Homey.log('add device: ' + JSON.stringify(device));
        devices[device.id] = device;
        module.exports.getSettings(device, function(err, settings){
            devices[device.id].settings = settings;
        });
    });
    if (Object.keys(devices).length > 0) {
      startPolling();
    }
	Homey.log('Rainmeter driver init done');

	callback (null, true);
};

module.exports.deleted = function( device_data ) {
    delete devices[device_data.id];
    if (Object.keys(devices).length === 0) {
        clearInterval(refreshIntervalId);
        console.log("--Stopped Polling Rainmeter--");
    }
    Homey.log('deleted: ' + JSON.stringify(device_data));
};

module.exports.capabilities = {
    "measure_rain.last3h": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_rainlast3h);
            }
        }
    },
	"measure_rain.total": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_raintotal);
            }
        }
    }
};

// Start polling
function startPolling() {
    if(refreshIntervalId){
        clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(function () {
        console.log("--Start Rainmeter Polling-- ");
        Object.keys(devices).forEach(function (device_id) {
          getStatus(device_id);
        });
    }, 1000 * 10);
}

function getStatus(device_id) {
    if(devices[device_id].settings.homewizard_id !== undefined ) {
        var homewizard_id = devices[device_id].settings.homewizard_id;
        homewizard.getDeviceData(homewizard_id, 'rainmeters', function(callback) {
            if (Object.keys(callback).length > 0) {
                try {
					Homey.log ("Callback: ") + JSON.stringify(callback);
                    module.exports.setAvailable({id: device_id});
					var rain_daytotal = ( callback[0].mm ); // Total Rain in mm used JSON $rainmeters[0]['mm']
                    var rain_last3h = ( callback[0]['3h'] ); // Last 3 hours rain in mm used JSON $rainmeters[0]['3h']
                    // Rain last 3 hours
                    module.exports.realtime( { id: device_id }, "measure_rain.last3h", rain_last3h );
                    // Rain total day
                    module.exports.realtime( { id: device_id }, "measure_rain.total", rain_daytotal );

                    console.log("Rainmeter 3h- "+ rain_last3h);
                    console.log("Rainmeter Daytotal- "+ rain_daytotal);

                    // Trigger flows
                    if (rain_daytotal != devices[device_id].last_raintotal) {
                        console.log("Current Total Rainfall - "+ rain_daytotal);
                        Homey.manager('flow').triggerDevice('rainmeter_value_changed', { rainmeter_changed: rain_daytotal }, null, { id: device_id } );
                    }

                } catch (err) {
                    // Error with Rain no data in Rainmeters
                    console.log ("No Rainmeter found");
                    module.exports.setUnavailable({id: device_id}, "No Rainmeter found" );
                }
            }
        });
    } else {
        Homey.log('Removed Rainmeter '+ device_id +' (old settings)');
        module.exports.setUnavailable({id: device_id}, "No Rainmeter found" );
        // Only clear interval when the unavailable device is the only device on this driver
        // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
        // In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem
        if(Object.keys(devices).length === 1) {
            clearInterval(refreshIntervalId);
        }
    }
}
