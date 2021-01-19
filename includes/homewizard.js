'use strict';

const fetch = require('node-fetch');
const AbortController = require('abort-controller');

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

  async function fetchWithTimeout(resource, options) {
    const { timeout = 8000 } = options;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(resource, {
      ...options,
    signal: controller.signal
    });
    clearTimeout(id);

  return response;
  }

   homewizard.call = async function(device_id, uri_part, callback) {
         var me = this;
         let status;
         if (debug) {console.log('Call device ' + device_id);}
         if ((typeof self.devices[device_id] !== 'undefined') && ("settings" in self.devices[device_id]) && ("homewizard_ip" in self.devices[device_id].settings) && ("homewizard_pass" in self.devices[device_id].settings)) {
            var homewizard_ip = self.devices[device_id].settings.homewizard_ip;
            var homewizard_pass = self.devices[device_id].settings.homewizard_pass;
            //const json = await fetch('http://' + homewizard_ip + '/' + homewizard_pass + uri_part)
            const json = await fetchWithTimeout('http://' + homewizard_ip + '/' + homewizard_pass + uri_part, {
              timeout: 5000
            })
            .then(async(res) => {
              try {
              status = res.status;
              return await res.json();
            } catch (err) {
               console.error(err);
            }
            })
            .then((jsonData) => {

              if (status == 200) {
                 try {
                    if (jsonData.status == 'ok') {
                       if(typeof callback === 'function') {
                           callback(null, jsonData.response);
                       } else {
                           console.log('Not typeoffunction');
                       }
                    }
                 } catch (exception) {
                     console.log(exception);
                    console.log('EXCEPTION JSON : '+ body);
                    jsonObject = null;
                    callback('Invalid data', []);
                 }
              } else {
                 if(typeof callback === 'function') {
                   callback('Error', []);
                 }
                 console.log('Error: no clue what is going on here.');
              }
            })

            .catch((err) => {
              console.error(err);
            });

         } else {
            console.log('Homewizard '+ device_id +': settings not found!');
         }

   };

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
         }, 1000 * 10);
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
            homewizard.call(device_id, '/get-sensors', function(err, response) {
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

                     homewizard.call(device_id, '/el/get/0/readings', function(err, response2) {
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
