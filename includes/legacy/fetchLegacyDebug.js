'use strict';

const Homey = require('homey');

module.exports = class FetchLegacyDebug {
  constructor(device, size = 100) {
    this.device = device;
    this.size = size;

    this.deviceId =
      device?.id ||
      device?.getData?.()?.id ||
      device?.deviceInstance?.getData?.()?.id ||
      'unknown-device';

    this.deviceName =
      device?.name ||
      device?.deviceInstance?.getName?.() ||
      'unknown';

    this.key = `fetchLegacyDebug_${this.deviceId}`;

    this.settings =
      Homey &&
      Homey.settings &&
      typeof Homey.settings.get === 'function' &&
      typeof Homey.settings.set === 'function'
        ? Homey.settings
        : null;

    let stored = [];
    if (this.settings) {
      try {
        stored = this.settings.get(this.key) || [];
      } catch (_) {}
    }

    this.buffer = Array.isArray(stored) ? stored : [];

    // throttle state
    this._lastFlush = 0;
  }

  log(entry) {
    const iso = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', hour12: false });

    this.buffer.push({
      t: iso,
      id: this.deviceId,
      name: this.deviceName,
      ...entry,
    });

    if (this.buffer.length > this.size) {
      this.buffer = this.buffer.slice(-this.size);
    }

    this.flush();
  }

  flush() {
    if (!this.settings) return;

    const now = Date.now();
    if (now - this._lastFlush < 1000) return; // max 1 write per seconde

    this._lastFlush = now;

    try {
      this.settings.set(this.key, this.buffer);
    } catch (_) {}
  }

  get() {
    return this.buffer;
  }

  clear() {
    this.buffer = [];
    if (this.settings) {
      try {
        this.settings.set(this.key, []);
      } catch (_) {}
    }
  }
};
