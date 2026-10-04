'use strict';

const driver = require('../../includes/v1/driver.js');

module.exports = class extends driver {

  // Must match the txt.product_type conditions of this driver's mDNS discovery
  get productTypes() {
    return ['SDM230-wifi', 'HWE-KWH1'];
  }

};
