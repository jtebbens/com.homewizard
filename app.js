"use strict";

const Homey = require('homey');
//SDK3
//const HomewizardAPI = require('./../../includes/homewizard.js');

class HomeWizardApp extends Homey.App {
	onInit() {
		console.log("HomeWizard app ready!");
	//	this.driver = new HomewizardAPI();
	}
}

module.exports = HomeWizardApp;
