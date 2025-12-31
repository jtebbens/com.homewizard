'use strict';

const Homey = require('homey');

const MAX_LOG = 50; // ringbuffer size

module.exports = {
  log(type, url, message) {
    try {
      let dbg = Homey.settings.get('debug_fetch');
      if (!Array.isArray(dbg)) dbg = [];

      dbg.push({
        ts: new Date().toISOString(),
        type,
        url,
        message
      });


      // ringbuffer
      Homey.settings.set('debug_fetch', dbg.slice(-MAX_LOG));
    } catch (err) {
      console.error('fetchQueueDebug failed:', err.message);
    }
  }
};
