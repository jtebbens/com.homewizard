'use strict';
//var tcpPortUsed = require('tcp-port-used');
//const fetch = require('node-fetch');
//const AbortController = require('abort-controller');

//const Promise = require("bluebird");
const axios = require("axios");
const getJson = require("axios-get-json-response");
axios.defaults.timeout === 15000;
const Homey = require('homey');

var debug = false;

module.exports = (function(){
   var homewizard = {};
   var self = {};
   self.devices = [];
   self.polls = [];

   homewizard.setDevices = function(devices){
     self.devices = devices;
   };

   homewizard.getRandom = function(min, max) {
      return Math.random() * (max - min) + min;
   };

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

   homewizard.callnew = async function (device_id, uri_part, callback) {
    const controller = new AbortController();
    try {
     if ((typeof self.devices[device_id] !== 'undefined') && ("settings" in self.devices[device_id]) && ("homewizard_ip" in self.devices[device_id].settings) && ("homewizard_pass" in self.devices[device_id].settings)) {
       var homewizard_ip = self.devices[device_id].settings.homewizard_ip;
       var homewizard_pass = self.devices[device_id].settings.homewizard_pass;
       // Using the Request Config
       await axios.get('http://' + homewizard_ip + '/' + homewizard_pass + uri_part, getJson.axiosConfiguration, {signal: controller.signal})
       .then((response) => {
          let parsedJson = getJson.parse(response);
          return parsedJson;
        })
        .then((jsonData) => {
          callback(null, jsonData.response)
        })
        .catch((error) => {
          // Error
            controller.abort();
            if (error.response) {
            /*
             * The request was made and the server responded with a
             * status code that falls out of the range of 2xx
             */
            console.log('Error Response Data', error.response.data);
            console.log('Error Response Status', error.response.status);
            console.log('Error Response Headers', error.response.headers);
        } else if (error.request) {
            /*
             * The request was made but no response was received, `error.request`
             * is an instance of XMLHttpRequest in the browser and an instance
             * of http.ClientRequest in Node.js
             */
            console.log('Error Homewizard Request - CONNECTION PROBLEM');
            controller.abort();
        } else {
            // Something happened in setting up the request and triggered an Error
            console.log('Error', error.message);
            controller.abort();
        }

        });
      }
   } catch (error) {
     controller.abort();
     console.error(error);
   }
   controller.abort();
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

   homewizard.startpoll = async function() {
         await homewizard.poll();
         self.polls.device_id = setInterval(async function () {
            await homewizard.poll();
         }, 1000 * 20);
   };

   homewizard.poll = async function() {

   await Object.keys(self.devices).forEach(async function (device_id) {
            if (typeof self.devices[device_id].polldata === 'undefined') {
               self.devices[device_id].polldata = [];
            }
            await homewizard.callnew(device_id, '/get-sensors', function(err, response) {
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


   };

   return homewizard;
})();
