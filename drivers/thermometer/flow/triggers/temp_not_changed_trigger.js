'use strict';

module.exports = {
  async runListener(args, state) {
    // Homey uses runListener for triggers
    // We match on hours so the trigger only fires if the user sets that number
    return args.hours === state.hours;
  }
};
