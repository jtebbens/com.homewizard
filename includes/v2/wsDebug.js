'use strict';

let HomeyRef = null;

module.exports = {

  init(homeyInstance) {
    HomeyRef = homeyInstance;
  },

  log(type, deviceId, message) {
    if (!HomeyRef) {
      console.error('wsDebug: Homey not initialized');
      return;
    }

    try {
      const stored = HomeyRef.settings.get('debug_ws');
      const dbg = Array.isArray(stored) ? stored : [];

      dbg.push({
        ts: new Date().toLocaleString('nl-NL', {
          timeZone: 'Europe/Amsterdam',
          hour12: false
        }),
        type,
        deviceId,
        message
      });

      HomeyRef.settings.set('debug_ws', dbg.slice(-50));

    } catch (err) {
      console.error('wsDebug failed:', err.message);
    }
  }
};
