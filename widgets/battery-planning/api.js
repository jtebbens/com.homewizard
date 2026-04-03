'use strict';

module.exports = {
  async getPlanningData({ homey }) {
    return homey.settings.get('policy_widget_data') || null;
  }
};
