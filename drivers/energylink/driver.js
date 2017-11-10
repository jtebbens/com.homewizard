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
            Homey.log('Energylink added ' + device.data.id);
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
	Homey.log('Energylink driver init done');

	callback (null, true);
};

module.exports.deleted = function( device_data ) {
    delete devices[device_data.id];
    if (Object.keys(devices).length === 0) {
        clearInterval(refreshIntervalId);
        console.log("--Stopped Polling Energy Link--");
    }
    Homey.log('deleted: ' + JSON.stringify(device_data));
};

module.exports.capabilities = {
    "measure_power.used": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_measure_power_used);
            }
        }
    },
    "measure_power.s1": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_measure_power_s1);
            }
        }
    },
    "meter_power.used": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_meter_power_used);
            }
        }
    },
    "meter_power.aggr": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_meter_power_aggr);
            }
        }
    },
    "meter_power.s1": {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_meter_power_s1);
            }
        }
    },
    meter_gas: {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_meter_gas);
            }
        }
    },
    meter_water: {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_meter_water);
            }
        }
    },
	measure_water: {
        get: function (device_data, callback) {
            var device = devices[device_data.id];

            if (device === undefined) {
                callback(null, 0);
            } else {
                callback(null, device.last_measure_water);
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
        console.log("--Start Energylink Polling-- ");
        Object.keys(devices).forEach(function (device_id) {
            getStatus(device_id);
        });
    }, 1000 * 10);
}

function getStatus(device_id) {
    if(devices[device_id].settings.homewizard_id !== undefined ) {
        var homewizard_id = devices[device_id].settings.homewizard_id;
        homewizard.getDeviceData(homewizard_id, 'energylinks', function(callback) {
            if (Object.keys(callback).length > 0) {
                try {
                    module.exports.setAvailable({id: device_id});
                    
                    var value_s1 = ( callback[0].t1 ) ; // Read t1 from energylink (solar/water/null)
                    var value_s2 = ( callback[0].t2 ) ; // Read t2 from energylink (solar/water/null)
                    
                    console.log("t1- " + value_s1);
                    console.log("t2- " + value_s2);
                    
                    // Common Energylink data                 
                    var energy_current_cons = ( callback[0].used.po ); // WATTS Energy used JSON $energylink[0]['used']['po']
                    var energy_daytotal_cons = ( callback[0].used.dayTotal ); // KWH Energy used JSON $energylink[0]['used']['dayTotal']
                    var energy_daytotal_aggr = ( callback[0].aggregate.dayTotal ) ; // KWH Energy aggregated is used - generated $energylink[0]['aggregate']['dayTotal']
                                       
                    // Some Energylink do not have gas information so try to get it else fail silently
                    try {
                           var gas_daytotal_cons = ( callback[0].gas.dayTotal ); // m3 Energy produced via S1 $energylink[0]['gas']['dayTotal']
                            // Consumed gas      
                           module.exports.realtime( { id: device_id }, "meter_gas", gas_daytotal_cons );
                    }
                    catch(err) {
                      // Error with Energylink no data in Energylink
                      console.log ("No Gas information found");
                    }
                    
                    // Consumed elec current
                    module.exports.realtime( { id: device_id }, "measure_power.used", energy_current_cons );
                    // Consumed elec total day
                    module.exports.realtime( { id: device_id }, "meter_power.used", energy_daytotal_cons );
                    // Consumed elec total day
                    module.exports.realtime( { id: device_id }, "meter_power.aggr", energy_daytotal_aggr );

                    
                    if (value_s1 == 'solar' ) {
                    	  var energy_current_prod = ( callback[0].s1.po ); // WATTS Energy produced via S1 $energylink[0]['s1']['po']
                        var energy_daytotal_prod = ( callback[0].s1.dayTotal ); // KWH Energy produced via S1 $energylink[0]['s1']['po']
                        
                        // Produced elec current
                        module.exports.realtime( { id: device_id }, "measure_power.s1", energy_current_prod );
                        // Produced elec total day
                        module.exports.realtime( { id: device_id }, "meter_power.s1", energy_daytotal_prod );
                    }
                    
                    if (value_s2 == 'solar' ) {
                    	  var energy_current_prod = ( callback[0].s2.po ); // WATTS Energy produced via S1 $energylink[0]['s2']['po']
                        var energy_daytotal_prod = ( callback[0].s2.dayTotal ); // KWH Energy produced via S1 $energylink[0]['s2']['dayTotal']
                        
                        // Produced elec current
                        module.exports.realtime( { id: device_id }, "measure_power.s2", energy_current_prod );
                        // Produced elec total day
                        module.exports.realtime( { id: device_id }, "meter_power.s2", energy_daytotal_prod );
                    }
                    
                    if (value_s1 == 'water' ) {
                    	var water_current_cons = ( callback[0].s1.po ); // Water used via S1 $energylink[0]['s1']['po']
                        var water_daytotal_cons = ( callback[0].s1.dayTotal / 1000 ); // Water used via S1 $energylink[0]['s1']['dayTotal']
                        console.log("Water- " + water_daytotal_cons);
                        // Used water m3
                        module.exports.realtime( { id: device_id }, "meter_water", water_daytotal_cons );
						module.exports.realtime( { id: device_id }, "measure_water", water_current_cons );
						
                    }
                                        
                    if (value_s2 == 'water' ) {
                    	var water_current_cons = ( callback[0].s2.po ); // Water used via S2 $energylink[0]['s1']['po']
                        var water_daytotal_cons = ( callback[0].s2.dayTotal / 1000 ); // Water used via S1 $energylink[0]['s2']['dayTotal']
                        console.log("Water- " + water_daytotal_cons);
                        // Used water m3
                        module.exports.realtime( { id: device_id }, "meter_water", water_daytotal_cons );
						module.exports.realtime( { id: device_id }, "measure_water", water_current_cons );
                    }   
                    
                    // Trigger flows
                    if (energy_current_cons != devices[device_id].last_measure_power_used) {
                        console.log("Current Power - "+ energy_current_cons);
                        Homey.manager('flow').triggerDevice('power_used_changed', { power_used: energy_current_cons }, null, { id: device_id } );
                    }
                    if (energy_current_prod != devices[device_id].last_measure_power_s1) {
                        console.log("Current S1 - "+ energy_current_prod);
                        Homey.manager('flow').triggerDevice('power_s1_changed', { power_s1: energy_current_prod }, null, { id: device_id } );
                    }
                    if (energy_daytotal_cons != devices[device_id].last_meter_power_used) {
                        console.log("Used Daytotal- "+ energy_daytotal_cons);                                
                        Homey.manager('flow').triggerDevice('meter_power_used_changed', { power_daytotal_used: energy_daytotal_cons }, null, { id: device_id });
                    }
                    if (energy_daytotal_prod != devices[device_id].last_meter_power_s1) {                                
                        console.log("S1 Daytotal- "+ energy_daytotal_prod);                                
                        Homey.manager('flow').triggerDevice('meter_power_s1_changed', { power_daytotal_s1: energy_daytotal_prod }, null, { id: device_id });                                                                                    
                    }
                    if (energy_daytotal_aggr != devices[device_id].last_meter_power_aggr) {
                        console.log("Aggregated Daytotal- "+ energy_daytotal_aggr);                                
                        Homey.manager('flow').triggerDevice('meter_power_aggregated_changed', { power_daytotal_aggr: energy_daytotal_aggr }, null, { id: device_id });
                    }
                    
                }
                catch(err) {
                      // Error with Energylink no data in Energylink
                      console.log ("No Energylink found");
                      module.exports.setUnavailable({id: device_id}, "No Energylink found" );
                }
            }
        });
    } else {
        Homey.log('Removed Energylink '+ device_id +' (wrong settings)');
        module.exports.setUnavailable({id: device_id}, "No Energylink found" );
        // Only clear interval when the unavailable device is the only device on this driver
        // This will prevent stopping the polling when a user has 1 device with old settings and 1 with new
        // In the event that a user has multiple devices with old settings this function will get called every 10 seconds but that should not be a problem
        if(Object.keys(devices).length === 1) {
            clearInterval(refreshIntervalId);
        }
    }
}
