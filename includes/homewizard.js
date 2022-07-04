'use strict';
//var tcpPortUsed = require('tcp-port-used');
const fetch = require('node-fetch');
//const AbortController = require('abort-controller');

//const Promise = require("bluebird");
//const axios = require("axios");
//const getJson = require("axios-get-json-response");
//axios.defaults.timeout === 8000;
const Homey = require('homey');

var debug = false;

module.exports = (function(){
   var homewizard = {};
   var self = {};
   self.devices = [];
   self.polls = [];
   //var testdata = {"preset":0,"time":"2016-12-07 20:26","switches":[{"id":0,"type":"dimmer","status":"on","dimlevel":39},{"id":1,"type":"switch","status":"on"},{"id":2,"type":"dimmer","status":"off","dimlevel":0},{"id":3,"type":"switch","status":"off"},{"id":4,"type":"dimmer","status":"off","dimlevel":0},{"id":5,"type":"virtual"},{"id":6,"type":"hue","status":"on","color":{"hue":60,"sat":57,"bri":65}},{"id":7,"type":"virtual"},{"id":8,"type":"virtual"},{"id":9,"type":"switch","status":"on"},{"id":10,"type":"hue","status":"off","color":{"hue":175,"sat":0,"bri":100}},{"id":11,"type":"hue","status":"off","color":{"hue":60,"sat":59,"bri":66}},{"id":12,"type":"virtual"},{"id":13,"type":"hue","status":"off","color":{"hue":68,"sat":88,"bri":10}},{"id":14,"type":"hue","status":"off","color":{"hue":68,"sat":88,"bri":57}},{"id":15,"type":"hue","status":"off","color":{"hue":68,"sat":88,"bri":98}},{"id":16,"type":"hue","status":"off","color":{"hue":68,"sat":88,"bri":19}},{"id":17,"type":"hue","status":"off","color":{"hue":8,"sat":0,"bri":0}},{"id":18,"type":"hue","status":"off","color":{"hue":43,"sat":96,"bri":21}},{"id":19,"type":"hue","status":"on","color":{"hue":307,"sat":99,"bri":18}},{"id":20,"type":"virtual"},{"id":21,"type":"virtual"},{"id":22,"type":"virtual"}],"uvmeters":[],"windmeters":[],"rainmeters":[],"thermometers":[{"id":0,"te":20.3,"hu":47,"favorite":"no"},{"id":1,"te":6.9,"hu":78,"favorite":"no"},{"id":2,"te":20.4,"hu":44,"favorite":"no"},{"id":3,"te":24.7,"hu":43,"favorite":"no"},{"id":4,"te":23.1,"hu":45,"favorite":"no"},{"id":5,"te":7.1,"hu":32,"favorite":"no"}],"weatherdisplays":[], "energymeters":[{"id": 0, "name": "Wattcher", "key": "0", "code": "xxxxxxxxxx", "po": 320, "dayTotal": 5.33, "po+": 2730, "po+t": "6:23", "po-": 120, "po-t": "8:25", "lowBattery": "no", "favorite": "no"}], "energylinks": [{"id":0,"tariff":2,"s1":{"po":114,"dayTotal":0.00,"po+":114,"po+t":"00:01","po-":114,"po-t":"00:01"},"s2":null,"aggregate":{"po":264,"dayTotal":0.00,"po+":264,"po+t":"00:01","po-":264,"po-t":"00:01"},"used":{"po":378,"dayTotal":0.00,"po+":378,"po+t":"00:01","po-":378,"po-t":"00:01"},"gas":{"lastHour":0.23,"dayTotal":0.00},"kwhindex":0.73}], "heatlinks": [{"id": 0, "pump": "off", "heating": "off", "dhw": "off", "rte": 20.230, "rsp": 20.000, "tte": 0.000, "ttm": null, "wp": 1.359, "wte": 0.000, "ofc": 0, "odc": 0}], "kakusensors": [{"id":0,"status":"yes","timestamp":"20:25"},{"id":1,"status":"no","timestamp":"19:17"},{"id":2,"status":"yes","timestamp":"20:25"}]};
   var testdata = {
      "preset":0,
      "time":"2017-01-21 20:07",
      "switches":[],
      "uvmeters":[],
      "windmeters":[{"id":3,"name":"Windmeter","code":"6219442","model":1,"lowBattery":"no","version":2.32,"unit":0,"ws":4.1,"dir":"W 270","gu":7.8,"wc":19.6,"te":19.6,"ws+":12.8,"ws+t":"11:03","ws-":0.0,"ws-t":"01:45","favorite":"no"}],
      "rainmeters":[{"id":1,"name":"Regenmeter","code":"6996438","model":1,"lowBattery":"no","version":2.32,"mm":3.0,"3h":1.0,"favorite":"no"}],
      "thermometers":[
         {"id":1,"name":"Kantoor","channel":2,"model":0,"te":20.0,"hu":5,"te+":20.4,"te+t":"12:15","te-":19.6,"te-t":"07:06","hu+":5,"hu+t":"00:00","hu-":5,"hu-t":"00:00","outside":"no","favorite":"no"},
         {"id":2,"name":"Slaapkamer","channel":5,"model":0,"te":18.8,"hu":47,"te+":19.1,"te+t":"09:06","te-":17.7,"te-t":"11:34","hu+":49,"hu+t":"07:39","hu-":43,"hu-t":"10:51","outside":"no","favorite":"no"}
      ],
      "weatherdisplays":[],
      "energymeters": [],
      //"energylinks": [
      //   {"id":0,"favorite":"no","name":"EnergyLink","code":"942991","t1":"solar","c1":1000,"t2":"water","c2":1,"tariff":1,"s1":{"po":0,"dayTotal":10.24,"po+":2498,"po+t":"11:22","po-":0,"po-t":"00:01"},"s2":{"po":4,"dayTotal":162.00,"po+":7,"po+t":"08:49","po-":0,"po-t":"00:01"},"aggregate":{"po":511,"dayTotal":-3.19,"po+":2873,"po+t":"09:22","po-":-1857,"po-t":"11:55"},"used":{"po":511,"dayTotal":7.04,"po+":3791,"po+t":"11:45","po-":204,"po-t":"16:34"},"gas":{"lastHour":0.44,"dayTotal":4.07},"kwhindex":2.87,"wp":3570}
      //],
      "energylinks": [{"id":0,"favorite":"no","name":"EnergyLink","code":"485352","t1":"other","c1":2000,"t2":"other","c2":2000,"tariff":1,"s1":{"po":181,"dayTotal":0.18,"po+":347,"po+t":"00:56","po-":57,"po-t":"00:07"},"s2":{"po":93,"dayTotal":0.20,"po+":1617,"po+t":"00:38","po-":90,"po-t":"00:02"},"aggregate":{"po":413,"dayTotal":0.52,"po+":996,"po+t":"01:04","po-":180,"po-t":"00:06"},"used":{"po":413,"dayTotal":0.52,"po+":996,"po+t":"01:04","po-":180,"po-t":"00:06"},"gas":{"lastHour":0.03,"dayTotal":0.03},"kwhindex":0.00,"wp":0}],
      "heatlinks": [{"id": 0, "favorite": "no", "name": "HeatLink", "code": "384699", "pump": "on", "heating": "off", "dhw": "off", "rte": 19.1, "rsp": 20.000, "tte": 0.000, "ttm": null, "wp": 1.628, "wte": 52.988, "ofc": 0, "odc": 0, "presets": [{ "id": 0, "te": 20.00},{ "id": 1, "te": 15.00},{ "id": 2, "te": 21.00},{ "id": 3, "te": 12.00}]}],
      "hues": [],
      "kakusensors": [{"id":0,"name":"Beweging","status":"no","type":"motion","favorite":"no","timestamp":"13:56","cameraid":null},{"id":1,"name":"Kantoor","status":"yes","type":"motion","favorite":"no","timestamp":"14:43","cameraid":null},{"id":5,"name":"Rookmelder Keuken","status":"no","type":"smoke868","favorite":"no","timestamp":"09:35","cameraid":null,"lowBattery":"no","lastSeen":"2020-08-19 09:35:14"}],
    };

   homewizard.debug = false;
   homewizard.debug_devices = [];
   homewizard.debug_devices.HW12345 = {
      id: 'HW12345',
      name: 'HomeWizard',
      settings: {
         homewizard_ip: '192.168.1.123',
         homewizard_pass: 'xxxxx',
         homewizard_ledring: true,
      }
   };
   homewizard.debug_devices_data =  [ { id: 'HW12345' }];

   homewizard.setDevices = function(devices){
      if (homewizard.debug) {
         self.devices = homewizard.debug_devices;
      } else {
         self.devices = devices;
      }
   };

   homewizard.getRandom = function(min, max) {
      return Math.random() * (max - min) + min;
   }

   homewizard.getDevices = function(callback) {
      callback(self.devices);
   };

   homewizard.getDeviceData = function(device_id, data_part, callback) {

      if (typeof self.devices[device_id] === 'undefined' || typeof self.devices[device_id].polldata === 'undefined' || typeof self.devices[device_id].polldata[data_part] === 'undefined') {
         callback([]);
      } else {
         callback(self.devices[device_id].polldata[data_part]);
      }
   };

/*
 class HTTPResponseError extends Error {
    	constructor(response, ...args) {
   		super(`HTTP Error Response: ${response.status} ${response.statusText}`, ...args);
   		this.response = response;
   	}
};

const checkStatus = response => {
	if (response.ok) {
 		// response.status >= 200 && response.status < 300
 		return response;
 	} else {
 		throw new HTTPResponseError(response);
 	}
};

async function fetchWithTimeout(resource, options) {
    const { timeout = 25000 } = options;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

  const response = await fetch(resource, {
      ...options,
    signal: controller.signal
    });
    clearTimeout(id);

  return response;
    try {
	      checkStatus(response);
        } catch (error) {
	        console.error(error);

	       const errorBody = await error.response.text();
	        console.error(`Error body: ${errorBody}`);
        }
      return response;
  }
*/

/*
  homewizard.call = function (device_id, uri_part, callback) {
     if ((typeof self.devices[device_id] !== 'undefined') && ("settings" in self.devices[device_id]) && ("homewizard_ip" in self.devices[device_id].settings) && ("homewizard_pass" in self.devices[device_id].settings)) {
       var homewizard_ip = self.devices[device_id].settings.homewizard_ip;
       var homewizard_pass = self.devices[device_id].settings.homewizard_pass;
       // Using the Request Config
       axios.get('http://' + homewizard_ip + '/' + homewizard_pass + uri_part, getJson.axiosConfiguration, { timeout: 8000 })
       .then((response) => {
          let parsedJson = getJson.parse(response);
          return parsedJson;
        })
        .then((jsonData) => {
          callback(null, jsonData.response)
        })
        .catch((error) => {
            console.error(error);
        });
      }
   }
*/
   homewizard.callnew = function (device_id, uri_part, callback) {
      if ((typeof self.devices[device_id] !== 'undefined') && ("settings" in self.devices[device_id]) && ("homewizard_ip" in self.devices[device_id].settings) && ("homewizard_pass" in self.devices[device_id].settings)) {
        var homewizard_ip = self.devices[device_id].settings.homewizard_ip;
        var homewizard_pass = self.devices[device_id].settings.homewizard_pass;
        let status;
        // Using the Request Config
        const json = fetch('http://' + homewizard_ip + '/' + homewizard_pass + uri_part)
        .then(async(res) => {
                try {
                    if (status !== 'undefined') {
                       status = res.status;
                       return await res.json();
                    }
                    else {
                        console.log('Status undefined');
                    }
                }
                catch (err) {
                console.error(err);
              }
            })
        .then((jsonData) => {
          try {
            if (status == 200) {
              try {
                if (jsonData.status !== undefined && jsonData.status == 'ok') {
                  if(typeof callback === 'function') {
                    callback(null, jsonData.response);
                  } else {
                    console.log('Not typeoffunction');
               }
             } else {
               console.log('jsonData.status not ok');
             }
           } catch (exception) {
             console.log(exception); // Old "Device timeout message in log"
             jsonData = null;
             callback('Invalid data', []);
           }
         } else {
            if(typeof callback === 'function') {
              callback('Error', []);
            }
            console.log('Error: no clue what is going on here.');
        }
      } catch (exception) {
            console.log(exception);
        }
    })
       }
}


/*
   homewizard.call = async function(device_id, uri_part, callback) {
     try {
         var me = this;
         var inUse = true; // wait until port in use
         let status;
         const regexExp = /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/gi;
         var timeout_options = 19000;
         if (debug) {console.log('Call device ' + device_id);}
         if ((typeof self.devices[device_id] !== 'undefined') && ("settings" in self.devices[device_id]) && ("homewizard_ip" in self.devices[device_id].settings) && ("homewizard_pass" in self.devices[device_id].settings)) {
            var homewizard_ip = self.devices[device_id].settings.homewizard_ip;
            var homewizard_pass = self.devices[device_id].settings.homewizard_pass;
            const json = await fetch('http://' + homewizard_ip + '/' + homewizard_pass + uri_part)
//            if (uri_part == '/get-sensors') {
//              timeout_options = 19000
//            } else {timeout_options = 59000}
//            // check if homewizard_ip is an ip or fqdn
            // console.log("Before test homewizard_ip: ", homewizard_ip);
            if (!regexExp.test(homewizard_ip)) {
              var fields = homewizard_ip.split(':');
              var homewizard_ip_temp = fields[0];
              var homewizard_port_temp = parseInt(fields[1]);
              //console.log("Not valid IP - homewizard_ip_temp: ", homewizard_ip_temp);
              //console.log("Not valid IP - homewizard_port_temp: ", homewizard_port_temp);
            } else {
                  var homewizard_ip_temp = homewizard_ip;
                  var homewizard_port_temp = 80;
                // console.log("Valid IP - homewizard_ip_temp: ", homewizard_ip_temp);
                // console.log("Valid IP - homewizard_port_temp: ", +homewizard_port_temp);
            }
            // port reachable checkStatus
            tcpPortUsed.waitForStatus(homewizard_port_temp, homewizard_ip_temp, inUse, 8000, 19000)
            .then(function() {
                let json = fetchWithTimeout('http://' + homewizard_ip + '/' + homewizard_pass + uri_part, {
                    timeout: timeout_options
                  })
                  .then(async(res) => {
                          try {
                              if (status !== 'undefined') {
                                 status = res.status;
                                 return await res.json();
                              }
                              else {
                                  console.log('Status undefined');
                              }
                          }
                          catch (err) {
                          console.error(err);
                        }
                      })
                  .then((jsonData) => {
                    try {
                      if (status == 200) {
                        try {
                          if (jsonData.status !== undefined && jsonData.status == 'ok') {
                            if(typeof callback === 'function') {
                              callback(null, jsonData.response);
                            } else {
                              console.log('Not typeoffunction');
                         }
                       } else {
                         console.log('jsonData.status not ok');
                       }
                     } catch (exception) {
                       console.log(exception); // Old "Device timeout message in log"
                       jsonData = null;
                       callback('Invalid data', []);
                 }
              } else {
                 if(typeof callback === 'function') {
                   callback('Error', []);
                 }
                 console.log('Error: no clue what is going on here.');
              }
            } catch (exception) {
                console.log(exception);
              }
            })
            .catch((error) => {
                console.error(error);//
                if (error.name === "AbortError") {
                  // fetch aborted either due to timeout or due to user clicking the cancel button
                  console.log(error.name === 'AbortError: ' + error);
                }
                if (error.name === "FetchError") {
                  // fetch aborted either due to timeout or due to user clicking the cancel button
                  console.log(error.name === 'FetchError: ' + error);
            }
            });
//
              }, function(error) {

            console.log('Error:', error.message);
          });
// Here tcpPortUsed
         } else {
            console.log('Homewizard '+ device_id +': settings not found!');
         }
       } // end of try
         catch (error) {
           if (error.name === "AbortError") {
            // fetch aborted either due to timeout or due to user clicking the cancel button
            console.log(error.name === 'AbortError');
         }
         if (error.name === "FetchError") {
          // fetch aborted either due to timeout or due to user clicking the cancel button
          console.log(error.name === 'FetchError');
         }
         else {
            // network error or json parsing error
            console.log('Network problem or JSON parsing error' +error)
        }
      }
   };

*/

   homewizard.ledring_pulse = function(device_id, colorName) {
      var homewizard_ledring =  self.devices[device_id].settings.homewizard_ledring;
      if (homewizard_ledring) {
        Homey.manager('ledring').animate(
            'pulse', // animation name (choose from loading, pulse, progress, solid)
            {
                color: colorName,
            },
            'INFORMATIVE', // priority
            3000, // duration
            function(err, success) { // callback
                if(err) return Homey.error(err);
                console.log("Ledring pulsing "+colorName);
            }
        );
      }
   };

   homewizard.startpoll = function() {
         homewizard.poll();
         self.polls.device_id = setInterval(function () {
            homewizard.poll();
         }, 1000 * 20);
   };

   homewizard.poll = function() {

      if (homewizard.debug) {

         var response = testdata;

         self.devices['HW12345'].polldata = [];
         self.devices['HW12345'].polldata.preset = response.preset;
         self.devices['HW12345'].polldata.heatlinks = response.heatlinks;
         self.devices['HW12345'].polldata.energylinks = response.energylinks;
         self.devices['HW12345'].polldata.energymeters = response.energymeters;
         self.devices['HW12345'].polldata.thermometers = response.thermometers;
         self.devices['HW12345'].polldata.rainmeters = response.rainmeters;
         self.devices['HW12345'].polldata.windmeters = response.windmeters;
         self.devices['HW12345'].polldata.kakusensors = response.kakusensors;

      } else {
         Object.keys(self.devices).forEach(function (device_id) {
            if (typeof self.devices[device_id].polldata === 'undefined') {
               self.devices[device_id].polldata = [];
            }
            homewizard.callnew(device_id, '/get-sensors', function(err, response) {
               if (err === null) {
                  self.devices[device_id].polldata.preset = response.preset;
                  self.devices[device_id].polldata.heatlinks = response.heatlinks;
                  self.devices[device_id].polldata.energylinks = response.energylinks;
                  self.devices[device_id].polldata.energymeters = response.energymeters;
                  self.devices[device_id].polldata.thermometers = response.thermometers;
                  self.devices[device_id].polldata.rainmeters = response.rainmeters;
                  self.devices[device_id].polldata.windmeters = response.windmeters;
                  self.devices[device_id].polldata.kakusensors = response.kakusensors;

                  if (Object.keys(response.energylinks).length !== 0) {

                     homewizard.callnew(device_id, '/el/get/0/readings', function(err, response2) {
                        if(err == null) {
                           self.devices[device_id].polldata.energylink_el = response2;
                           if (debug) {console.log('HW-Data polled for slimme meter: '+device_id);}
                        }
                     });
                  }
               }
            });

         });
      }

   };

   return homewizard;
})();
