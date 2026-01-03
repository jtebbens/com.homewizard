'use strict';

module.exports = {
  async runListener(args, state) {
    // Homey gebruikt runListener voor triggers
    // We matchen op hours zodat de trigger alleen afgaat als de gebruiker dat getal instelt
    return args.hours === state.hours;
  }
};
