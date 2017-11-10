var devices = {};
var homewizard = require('./../../includes/homewizard.js');
var request = require('request');
var refreshIntervalId;

var preset_text = '';
var preset_text_nl = ['Thuis', 'Afwezig', 'Slapen', 'Vakantie'];
var preset_text_en = ['Home', 'Away', 'Sleep', 'Holiday'];
var homey_lang = Homey.manager('i18n').getLanguage();

// SETTINGS
module.exports.settings = function( device_data, newSettingsObj, oldSettingsObj, changedKeysArr, callback ) {
    Homey.log ('Changed settings: ' + JSON.stringify(device_data) + ' / ' + JSON.stringify(newSettingsObj) + ' / old = ' + JSON.stringify(oldSettingsObj));
    try {
	    changedKeysArr.forEach(function (key) {
		    devices[device_data.id].settings[key] = newSettingsObj[key];
		});
        homewizard.setDevices(devices);
		callback(null, true);
    } catch (error) {
      callback(error); 
    }
};

module.exports.pair = function( socket ) {
    socket.on('manual_add', function (device, callback) {
        var url = 'http://' + device.settings.homewizard_ip + '/' + device.settings.homewizard_pass + '/get-status/';
        //Homey.log('Calling '+ url);
        request(url, function (error, response, body) {
          if (response === null || response === undefined) {
            socket.emit("error", "http error");
            return;
          }
		  if (!error && response.statusCode == 200) {
			var jsonObject = JSON.parse(body);
			if (jsonObject.status == 'ok') {
				//true
                Homey.log('HW added');
                devices[device.data.id] = {
                  id: device.data.id,
                  name: device.name,
                  settings: device.settings,
                  capabilities: device.capabilities
                };
                homewizard.setDevices(devices);
                callback( null, devices );
                socket.emit("success", device);
                startPolling();
      } else {
				//false
                socket.emit("error", "no response");
			}
		  } else {
			// false
            socket.emit("error", "http error: "+response.statusCode);
		  }
		});
    });
    
    socket.on('disconnect', function(){
        console.log("User aborted pairing, or pairing is finished");
    });
}

module.exports.init = function(devices_data, callback) {
    if (homewizard.debug) {
        devices_data = homewizard.debug_devices_data;
    }
    
    devices_data.forEach(function initdevice(device) {
        Homey.log('add device: ' + JSON.stringify(device));
        devices[device.id] = device;
        module.exports.getSettings(device, function(err, settings){
            devices[device.id].settings = settings;
        });
    });
    homewizard.setDevices(devices);
    homewizard.startpoll();
    
    if (Object.keys(devices).length > 0) {
      startPolling();
    }
    
	Homey.log('HomeWizard driver init done');
	callback (null, true);
};

module.exports.deleted = function( device_data ) {
    delete devices[device_data.id];
    if (Object.keys(devices).length === 0) {
      clearInterval(refreshIntervalId);
      Homey.log("--Stopped Polling--");
    }
    Homey.log('deleted: ' + JSON.stringify(device_data));
};

// SCENES
Homey.manager('flow').on('action.switch_scene_on.scene.autocomplete', function( callback, args ){
	Homey.log('getScenes autocomplete called');
    homewizard.getScenes(args, function(err, response) {
      callback(err, response ); // err, results
    });
});

Homey.manager('flow').on('action.switch_scene_on', function( callback, args ){
	Homey.log('args.device.id: ' + JSON.stringify(args.device.id));
	Homey.log('args.scene.id: ' + JSON.stringify(args.scene.id));
    homewizard.call(args.device.id, '/gp/' + args.scene.id + '/on', function(err, response) {
      if (err === null) {
        Homey.log('Scene is on');
        callback( null, true );
      } else {
        callback(err, false); // err
      }
    });
});  

Homey.manager('flow').on('action.switch_scene_off.scene.autocomplete', function( callback, args ){
    homewizard.getScenes(args, function(err, response) {
      callback(err, response ); // err, results
    });
});

Homey.manager('flow').on('action.switch_scene_off', function( callback, args ){
    homewizard.call(args.device.id, '/gp/' + args.scene.id + '/off', function(err, response) {
      if (err === null) {
        Homey.log('Scene is off');
        callback( null, true );
      } else {
        callback(err, false); // err
      }
    });
});  


// PRESETS
Homey.manager('flow').on('condition.check_preset', function( callback, args ){
    homewizard.call(args.device.id, '/get-status/', function(err, response) {
      if (err === null) {
        if (response.preset == args.preset) {
            Homey.log('Yes, preset is: '+ response.preset+'!');
            if(typeof callback === 'function') {
                callback(null, true);
            }
        } else {
            Homey.log('Preset is: ' + response.preset+', not '+args.preset);
            if(typeof callback === 'function') {
                callback(null, false);
            }
        }
      } else {
        callback(err, false); // err
      }
    });
});
	
	
Homey.manager('flow').on('action.set_preset', function( callback, args ){
    var uri = '/preset/' + args.preset;
    homewizard.call(args.device.id, uri, function(err, response) {
      if (err === null) {
        homewizard.ledring_pulse(args.device.id, 'green');
        callback(null, true);
      } else {
        homewizard.ledring_pulse(args.device.id, 'red');
        callback(err, false); // err
      }
    });
});


function getStatus(device_id) {
    homewizard.getDeviceData(device_id, 'preset', function(callback) {
        Homey.log('PRESET:' + callback);
        try {
            if (!('preset' in devices[device_id])) {
                Homey.log('Preset was set to ' + callback);
                devices[device_id].preset = callback;
            }
            
            if (('preset' in devices[device_id]) && devices[device_id].preset != callback) {
                devices[device_id].preset = callback;
                Homey.log('Flow call!' + callback);
                if (homey_lang == "nl") {
                    preset_text = preset_text_nl[callback];
                } else {
                    preset_text = preset_text_en[callback];
                }
                Homey.log(preset_text);
                Homey.manager('flow').triggerDevice('preset_changed', { preset: callback, preset_text: preset_text }, null, { id: device_id } , (err) => {
                if (err) return Homey.error('Error triggeringDevice:', err);
            });
                Homey.log('Preset was changed!');
            }
        } catch(err) {
            console.log ("HomeWizard data corrupt");
        }
    });
}
 
function startPolling() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
    }
    refreshIntervalId = setInterval(function () {
        Homey.log("--Start HomeWizard Polling-- ");
        Object.keys(devices).forEach(function (device_id) {
            getStatus(device_id);
        });
    }, 1000 * 10);
}