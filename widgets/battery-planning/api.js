'use strict';

module.exports = {
  async getPlanningData({ homey }) {
    try {
      const devices = homey.drivers.getDriver('battery-policy').getDevices();
      const device = devices && devices[0];
      return device?._widgetData || null;
    } catch (e) {
      return null;
    }
  }
};
