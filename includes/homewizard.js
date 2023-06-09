'use strict';

const fetch = require('node-fetch');
const Homey = require('homey');
const AbortController = require('abort-controller');

const Homey2023 = Homey.platform === 'local' && Homey.platformVersion === 2;


module.exports = (function(){
   var homewizard = {};
   var self = {};
   self.devices = [];
   self.polls = [];
   var debug = false;

   homewizard.setDevices = function(devices){
     self.devices = devices;
   };

   homewizard.getRandom = function(min, max) {
      return Math.random() * (max - min) + min;
   };

   homewizard.getDevices = function(callback) {
      callback(self.devices);
   };

   /*
   homewizard.getDeviceData = function(device_id, data_part, callback) {

      if (typeof self.devices[device_id] === 'undefined' || 
          typeof self.devices[device_id].polldata === 'undefined' || 
          typeof self.devices[device_id].polldata[data_part] === 'undefined' ||
          typeof self.devices[device_id] === undefined ||
          typeof self.devices[device_id].polldata === undefined || 
          typeof self.devices[device_id].polldata[data_part] === undefined)
          {
         callback([]);
      } else {
         callback(self.devices[device_id].polldata[data_part]);
      }
   };

   */

   homewizard.getDeviceData = function(device_id, data_part) {
    return new Promise((resolve, reject) => {
      if (
        typeof self.devices[device_id] === 'undefined' ||
        typeof self.devices[device_id].polldata === 'undefined' ||
        typeof self.devices[device_id].polldata[data_part] === 'undefined' ||
        typeof self.devices[device_id] === undefined ||
        typeof self.devices[device_id].polldata === undefined || 
        typeof self.devices[device_id].polldata[data_part] === undefined
      ) {
        resolve([]);
      } else {
        resolve(self.devices[device_id].polldata[data_part]);
      }
    });
  };
  
   async function fetchWithRetry(url, options, maxRetries = 3) {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, options.timeout);
    
      try {
        options.signal = controller.signal;
        options.redirect = 'manual'; //try
        options.follow = 0; //try
        let retries = 0;
        while (retries < maxRetries) {
          try {
            const response = await fetch(url, options);
            clearTimeout(timeout);
            return response;
          } catch (error) {
            retries++;
            console.error(`Retry attempt ${retries}: ${error}`);
          }
        }
        throw new Error(`Failed to fetch after ${maxRetries} retries.`);
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }
    }

    homewizard.callnew = async function (device_id, uri_part, callback) {
      try {
        if (debug) {
          console.log('Call device ' + device_id);
        }
        if (
          typeof self.devices[device_id] !== 'undefined' &&
          "settings" in self.devices[device_id] &&
          "homewizard_ip" in self.devices[device_id].settings &&
          "homewizard_pass" in self.devices[device_id].settings
        ) {
          const homewizard_ip = self.devices[device_id].settings.homewizard_ip;
          const homewizard_pass = self.devices[device_id].settings.homewizard_pass;
    
          const response = await fetchWithRetry('http://' + homewizard_ip + '/' + homewizard_pass + uri_part, {
            timeout: 18000
          });
    
          if (response.status === 200) {
            const jsonData = await response.json();
            if (
              jsonData.status !== undefined &&
              jsonData.status === 'ok'
            ) {
              if (typeof callback === 'function') {
                callback(null, jsonData.response);
              } else {
                console.log('Not typeof function');
              }
            } else {
              console.log('jsonData.status not ok');
              callback('Invalid data', []);
            }
          } else {
            console.log('Error: no clue what is going on here.');
            callback('Error', []);
          }
        } else {
          console.log('Homewizard ' + device_id + ': settings not found!');
        }
      } catch (error) {
        if (error.code === 'ECONNRESET') {
          console.log('Connection was reset');
        }
        console.error('FETCH PROBLEM -> ' + error);
      }
    };

  if (!Homey2023) {
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
           function(err) { // callback
               if(err) return Homey.error(err);
               console.log("Ledring pulsing "+colorName);
           }
       );
     }
  };
};

homewizard.startpoll = function() {
   homewizard.poll(); // Initial poll
 
   self.polls.device_id = setInterval(async function() {
     try {
       await homewizard.poll();
     } catch (error) {
       console.error('Error occurred during polling:', error);
     }
   }, 1000 * 20);
 };

/*
 homewizard.poll = function() {

   Object.keys(self.devices).forEach(async function (device_id) {
      if ((typeof self.devices[device_id].polldata === 'undefined') || (typeof self.devices[device_id].polldata == 'undefined') || (typeof self.devices[device_id].polldata == undefined)) {
               self.devices[device_id].polldata = [];
            }
            await homewizard.callnew(device_id, '/get-sensors', function(err, response) {
               if ((err === null) || (err == null)) {
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
   */
  
   homewizard.poll = async function() {
      for (const device_id in self.devices) {
        if (
          typeof self.devices[device_id].polldata === 'undefined' ||
          typeof self.devices[device_id].polldata == 'undefined' ||
          typeof self.devices[device_id].polldata == undefined
        ) {
          self.devices[device_id].polldata = [];
        }
    
        const response = await new Promise((resolve, reject) => {
          homewizard.callnew(device_id, '/get-sensors', (err, response) => {
            if (err === null || err == null) {
              resolve(response);
            } else {
              reject(err);
            }
          });
        });
    
        if (response) {
          self.devices[device_id].polldata.preset = response.preset;
          self.devices[device_id].polldata.heatlinks = response.heatlinks;
          self.devices[device_id].polldata.energylinks = response.energylinks;
          self.devices[device_id].polldata.energymeters = response.energymeters;
          self.devices[device_id].polldata.thermometers = response.thermometers;
          self.devices[device_id].polldata.rainmeters = response.rainmeters;
          self.devices[device_id].polldata.windmeters = response.windmeters;
          self.devices[device_id].polldata.kakusensors = response.kakusensors;
    
          if (Object.keys(response.energylinks).length !== 0) {
            await new Promise((resolve, reject) => {
              homewizard.callnew(device_id, '/el/get/0/readings', (err, response2) => {
                if (err == null) {
                  self.devices[device_id].polldata.energylink_el = response2;
                  if (debug) {
                    console.log('HW-Data polled for slimme meter: ' + device_id);
                  }
                  resolve();
                } else {
                  reject(err);
                }
              });
            });
          }
        }
      }
    };
    

   return homewizard;
})();
