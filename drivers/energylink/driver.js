'use strict';

const Homey = require('homey');

const { ManagerDrivers } = require('homey');
const driver = ManagerDrivers.getDriver('homewizard');

var homewizard = require('./../../includes/homewizard.js');
var homewizard_devices;
var devices = {};

class HomeWizardEnergyLink extends Homey.Driver {

    onInit() {
        console.log('HomeWizard EnergyLink has been inited');
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
        socket.on('showView', ( viewId, callback ) => {
            callback();
            console.log('View: ' + viewId);
        });

        socket.on('get_homewizards', function () {

            homewizard_devices = driver.getDevices();

            homewizard.getDevices(function ( homewizard_devices)  {
                var hw_devices = {};

                Object.keys(homewizard_devices).forEach(function (key) {
                    var energylinks = JSON.stringify(homewizard_devices[key].polldata.energylinks);

                    hw_devices[key] = homewizard_devices[key];
                    hw_devices[key].id = key;
                    hw_devices[key].polldata = {}
                    hw_devices[key].energylinks = energylinks;

                });

                socket.emit('hw_devices', hw_devices);

            });
        });

        socket.on('manual_add', function (device, callback) {

            console.log(device.settings.homewizard_id);
            console.log(device.settings.homewizard_id.indexOf('HW_'));

            console.log(device.settings.homewizard_id);
            console.log(device.settings.homewizard_id.indexOf('HW'));

            if (device.settings.homewizard_id.indexOf('HW_') === -1 && device.settings.homewizard_id.indexOf('HW') === 0) {
                //true
                console.log('Energylink added ' + device.data.id);

                devices[device.data.id] = {
                    id: device.data.id,
                    name: "EnergyLink",
                    settings: device.settings,
                };
                callback( null, devices );
                socket.emit("success", device);

            } else {
                socket.emit("error", "No valid HomeWizard found, re-pair if problem persists");
            }
        });

        socket.on('disconnect', function(){
            console.log("User aborted pairing, or pairing is finished");
        });
    }

}

module.exports = HomeWizardEnergyLink;
