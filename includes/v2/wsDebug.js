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
      const dbg = HomeyRef.settings.get('debug_ws') || [];

      dbg.push({
        ts: new Date().toISOString(),
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
