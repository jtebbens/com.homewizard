"use strict";

const Homey = require('homey');


class HomeWizardApp extends Homey.App {
	onInit() {
		console.log("HomeWizard app ready!");
		if (process.env.DEBUG === '1') {
			try{ 
				require('inspector').waitForDebugger();
			}
			catch(error){
				require('inspector').open(9225, '0.0.0.0', true);
			}
		}

	}
}

module.exports = HomeWizardApp;
