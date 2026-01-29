'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const API_BASE_URL = 'https://api.homewizardeasyonline.com/v1';
const TSDB_URL = 'https://tsdb-reader.homewizard.com';
const TOKEN_REFRESH_MARGIN = 60; // seconds
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 30000; // 30 seconds

module.exports = class HomeWizardCloudWatermeterDevice extends Homey.Device {

  async onInit() {
    this.log('Cloud Watermeter initialized:', this.getName());

    // Get stored credentials
    this.username = this.getStoreValue('username');
    this.password = this.getStoreValue('password');
    this.token = this.getStoreValue('token');
    this.tokenExpiresAt = this.getStoreValue('token_expires_at');
    this.deviceIdentifier = this.getStoreValue('identifier');
    this.homeId = this.getStoreValue('homeId');

    // Set polling interval (every 15 minutes)
    this.pollInterval = this.getSetting('poll_interval') || 900; // 15 minutes default

    // Initialize retry tracking
    this.retryAttempt = 0;

    // Initialize cumulative meter if not exists
    if (!this.getStoreValue('cumulative_water')) {
      await this.setStoreValue('cumulative_water', 0);
    }

    // Track last processed date to detect day changes
    if (!this.getStoreValue('last_date')) {
      await this.setStoreValue('last_date', new Date().toDateString());
    }

    // Add meter_water.daily capability if it doesn't exist
    if (!this.hasCapability('meter_water.daily')) {
      await this.addCapability('meter_water.daily');
    }
    
    // Initial data fetch
    await this.fetchWaterData();

    // Start polling
    this.startPolling();

    this.log(`Device initialized: ${this.deviceIdentifier}`);
  }

  /**
   * Start polling for water data
   */
  startPolling() {
    if (this.pollingTimer) {
      this.homey.clearInterval(this.pollingTimer);
    }

    this.pollingTimer = this.homey.setInterval(
      async () => {
        await this.fetchWaterData();
      },
      this.pollInterval * 1000
    );
  }

  /**
   * Calculate exponential backoff delay
   * @param {number} attempt - Current retry attempt (0-based)
   * @returns {number} Delay in milliseconds
   */
  calculateBackoffDelay(attempt) {
    // Exponential backoff 30s, 60s, 120s, 240s, etc.
    const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
    // Add jitter (random 0-20% variation) to avoid thundering herd
    const jitter = delay * 0.2 * Math.random();
    return Math.floor(delay + jitter);
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
  }

  /**
   * Ensure we have a valid token, refresh if needed
   * @returns {Promise<string>} Valid access token
   */
  async ensureToken() {
    const now = Date.now();
    
    if (!this.token || now >= this.tokenExpiresAt) {
      this.log('Token expired or missing, refreshing...');
      await this.authenticate();
    }
    
    return this.token;
  }

  /**
   * Authenticate and get new token
   */
  async authenticate() {
    const url = `${API_BASE_URL}/auth/account/token`;
    const credentials = Buffer.from(`${this.username}:${this.password}`).toString('base64');

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'User-Agent': 'HomeWizardHomey/1.0',
        },
        timeout: 10000,
      });

      if (!response.ok) {
        throw new Error(`Authentication failed: ${response.status}`);
      }

      const data = await response.json();
      
      this.token = data.access_token;
      this.tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - TOKEN_REFRESH_MARGIN) * 1000;
      
      // Store for persistence
      await this.setStoreValue('token', this.token);
      await this.setStoreValue('token_expires_at', this.tokenExpiresAt);

      this.log('Token refreshed successfully');
    } catch (err) {
      this.error('Authentication failed:', err.message);
      await this.setUnavailable(this.homey.__('errors.auth_failed'));
      throw err;
    }
  }

  /**
   * Fetch water consumption data from TSDB with exponential backoff
   */
  async fetchWaterData() {
    let attempt = 0;
    
    while (attempt < MAX_RETRY_ATTEMPTS) {
      try {
        const token = await this.ensureToken();
        const now = new Date();
        const timezone = this.homey.clock.getTimezone();

        const url = `${TSDB_URL}/devices/date/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

        const payload = {
          devices: [
            {
              identifier: this.deviceIdentifier,
              measurementType: 'water',
            },
          ],
          type: 'water',
          values: true,
          wattage: false,
          gb: '15m',
          tz: timezone,
          fill: 'linear',
          three_phases: false,
        };

        if (attempt > 0) {
          this.log(`Fetching water data from TSDB (retry ${attempt}/${MAX_RETRY_ATTEMPTS})...`);
        } else {
          this.log(`Fetching water data from TSDB...`);
        }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'HomeWizardHomey/1.0',
          },
          body: JSON.stringify(payload),
          timeout: 10000,
        });

        if (!response.ok) {
          const errorText = await response.text();
          
          // Check if it's a retryable error (5xx or rate limiting)
          if (response.status >= 500 || response.status === 429) {
            throw new Error(`TSDB request failed (retryable): ${response.status} - ${errorText}`);
          }
          
          // Non-retryable error (4xx except 429)
          this.error(`TSDB request failed (non-retryable): ${response.status} - ${errorText}`);
          await this.setUnavailable(`API error: ${response.status}`);
          return;
        }

        const data = await response.json();
        this.log(`TSDB data received: ${data.values?.length || 0} datapoints`);
        
        // Process the data
        await this.processWaterData(data);
        
        // Mark device as available
        if (!this.getAvailable()) {
          await this.setAvailable();
        }
        
        // Reset retry counter on success
        this.retryAttempt = 0;
        return;

      } catch (err) {
        this.error(`Error fetching water data (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}):`, err.message);
        
        attempt++;
        
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          this.error('Max retry attempts reached, giving up');
          await this.setUnavailable(err.message);
          return;
        }
        
        // Calculate backoff delay
        const delay = this.calculateBackoffDelay(attempt - 1);
        this.log(`Retrying in ${(delay / 1000).toFixed(1)}s...`);
        
        // Wait before retry
        await this.sleep(delay);
      }
    }
  }

  /**
 * Process and update water consumption data
 * @param {Object} data - TSDB response data
 */
async processWaterData(data) {
  if (!data || !data.values || data.values.length === 0) {
    this.log('No water data available');
    return;
  }

  const today = new Date().toDateString();
  const lastDate = this.getStoreValue('last_date');
  const previousDailyUsage = this.getStoreValue('previous_daily_usage') || 0;

  // Find the latest non-zero water value
  let latestWaterValue = null;
  let dailyTotal = 0;

  // Iterate through values to find the most recent reading and calculate daily total
  for (let i = data.values.length - 1; i >= 0; i--) {
    const datapoint = data.values[i];
    
    if (datapoint.water !== null && datapoint.water !== undefined) {
      // Sum up all water usage for the day (these are liters per interval)
      dailyTotal += datapoint.water;
      
      // Get the latest reading if we haven't found one yet
      if (latestWaterValue === null && datapoint.water > 0) {
        latestWaterValue = datapoint.water;
        this.log(`Latest water reading: ${latestWaterValue}L at ${datapoint.time}`);
      }
    }
  }

  // Convert daily total from liters to m³
  const dailyTotalM3 = dailyTotal / 1000;
  
  this.log(`Daily water usage: ${dailyTotalM3.toFixed(3)} m³ (${dailyTotal.toFixed(1)}L)`);

  // Check if day changed - if so, add previous day's total to cumulative
  if (lastDate !== today) {
    this.log(`Day changed from ${lastDate} to ${today}`);
    
    // Add previous day's usage to cumulative total
    const cumulativeWater = this.getStoreValue('cumulative_water') || 0;
    const newCumulative = cumulativeWater + previousDailyUsage;
    
    await this.setStoreValue('cumulative_water', newCumulative);
    await this.setStoreValue('last_date', today);
    
    this.log(`Added ${previousDailyUsage.toFixed(3)} m³ to cumulative. New total: ${newCumulative.toFixed(3)} m³`);
  }

  // Store current daily usage for next day rollover
  await this.setStoreValue('previous_daily_usage', dailyTotalM3);

  // Update daily water usage capability
  if (this.hasCapability('meter_water.daily')) {
    await this.setCapabilityValue('meter_water.daily', dailyTotalM3);
    this.log(`Daily water meter updated: ${dailyTotalM3.toFixed(3)} m³`);
  }

  // Update cumulative water usage capability (including manual offset)
  if (this.hasCapability('meter_water')) {
    const cumulativeWater = this.getStoreValue('cumulative_water') || 0;
    const manualOffset = parseFloat(this.getSetting('manual_offset')) || 0;
    const totalWater = cumulativeWater + dailyTotalM3 + manualOffset;
    
    await this.setCapabilityValue('meter_water', totalWater);
    this.log(`Cumulative water meter updated: ${totalWater.toFixed(3)} m³ (cumulative: ${cumulativeWater.toFixed(3)} m³, daily: ${dailyTotalM3.toFixed(3)} m³, offset: ${manualOffset.toFixed(3)} m³)`);
  }
}

  /**
   * Handle settings changes
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('poll_interval')) {
      this.pollInterval = newSettings.poll_interval;
      this.log(`Polling interval changed to ${this.pollInterval}s`);
      this.startPolling(); // Restart with new interval
    }

    if (changedKeys.includes('manual_offset')) {
      this.log(`Manual offset changed to ${newSettings.manual_offset} m³`);
      // Trigger an update to reflect the new offset
      await this.fetchWaterData();
    }
  }

  /**
   * Clean up on device deletion
   */
  async onDeleted() {
    this.log('Cloud Watermeter deleted');
    
    if (this.pollingTimer) {
      this.homey.clearInterval(this.pollingTimer);
    }
  }

  /**
   * Clean up on device unavailable
   */
  async onUninit() {
    if (this.pollingTimer) {
      this.homey.clearInterval(this.pollingTimer);
    }
  }
};