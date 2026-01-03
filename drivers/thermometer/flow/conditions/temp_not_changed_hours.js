'use strict';

module.exports = {
  async run({ device, hours }) {
    const last = await device.getStoreValue('lastTempUpdate');
    if (!last) return false;

    const diffHours = (Date.now() - last) / 1000 / 3600;
    return diffHours >= hours;
  }
};
