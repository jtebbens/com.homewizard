'use strict';

const Homey = require('homey');
var homewizard = require('./../../includes/homewizard.js');

class HomeWizardHeatlink extends Homey.Device {

	onInit() {

		this.log('Heatlink Thermometer '+this.getName() +' has been inited');
	}

}

module.exports = HomeWizardHeatlink;