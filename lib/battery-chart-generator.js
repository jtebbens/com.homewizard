'use strict';

/**
 * Battery Policy Chart Generator (Placeholder)
 * Chart generation disabled - users should use the HTML planning view in app settings
 * See HomeWizard app settings → Battery Planning tab
 */
class BatteryChartGenerator {
  constructor(homey) {
    this.homey = homey;
    this.enabled = false;
    this.homey.log('📊 Chart generation: Use Battery Planning view in app settings (Settings → Battery Planning tab)');
  }

  /**
   * Generate chart - returns null (feature disabled)
   * @returns {null}
   */
  generateChart(data) {
    // Chart generation not available - users should access Battery Planning via app settings
    return null;
  }
}

module.exports = BatteryChartGenerator;
