"use strict";

const Homey = require('homey');


class HomeWizardApp extends Homey.App {
	onInit() {
		console.log("HomeWizard app ready!");
		if (process.env.DEBUG === '1') {
			require('inspector').open(9229, '0.0.0.0');
			//require('inspector').waitForDebugger();
		}

	}
}

module.exports = HomeWizardApp;
