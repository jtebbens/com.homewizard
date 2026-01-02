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
  }

  get() {
    return this.buffer;
  }

  clear() {
    this.buffer = [];
  }
};
