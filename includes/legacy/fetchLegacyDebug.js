'use strict';

module.exports = class FetchLegacyDebug {
  constructor(device, size = 50) {
    this.device = device;
    this.size = size;
    this.buffer = [];
  }

  log(entry) {
    const timestamp = new Date().toISOString();
    const devId = this.device?.getData?.().id || 'unknown-device';

    this.buffer.push({
      t: timestamp,
      id: devId,
      ...entry
    });

    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }

    // No Homey.settings here — this file has no access to it.
    // Buffer stays in memory. Caller must sync to settings if needed.
  }

  get() {
    return this.buffer;
  }

  clear() {
    this.buffer = [];
  }
};
