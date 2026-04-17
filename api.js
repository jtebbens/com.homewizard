'use strict';

// App-level API exposed to the settings page.
// getLiveState returns in-memory rebuildable policy state (explainability,
// policy state, optimizer schedule, debug info, weather, etc.) that used to
// be persisted via homey.settings.set. Each settings.set allocates ~30 MB on
// the Homey runtime, so keeping this data purely in-memory and fetching it
// here avoids dozens of heap spikes per policy run.
module.exports = {
  async getLiveState({ homey }) {
    try {
      const devices = homey.drivers.getDriver('battery-policy').getDevices();
      const device = devices && devices[0];
      return device?._liveState || {};
    } catch (e) {
      return {};
    }
  }
};
