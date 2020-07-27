"use strict";

const Homey = require('homey');

class HomeWizardApp extends Homey.App {
	onInit() {
		this.log("HomeWizard app ready!");
	}
}

// function init() {
// 	var request = require('request');
//
//
// }

module.exports = HomeWizardApp;