'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const API_BASE_URL = 'https://api.homewizardeasyonline.com/v1';
const TSDB_URL = 'https://tsdb-reader.homewizard.com';
const TOKEN_REFRESH_MARGIN = 60; // seconds
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 30000; // 30 seconds
const debug = false

module.exports = class HomeWizardCloudWatermeterDevice extends Homey.Device {

  async onInit() {
    this.homey.app.bumpDeviceCount?.('cloud_watermeter');
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

    for (const cap of ['meter_water.daily', 'alarm_water']) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
        } catch (err) {
          if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
            this.log(`Capability already exists: ${cap} — ignoring`);
          } else {
            throw err;
          }
        }
      }
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
          if (debug) this.log(`Fetching water data from TSDB...`);
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
        if (debug) this.log(`TSDB data received: ${data.values?.length || 0} datapoints`);
        
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
        if (debug) this.log(`Latest water reading: ${latestWaterValue}L at ${datapoint.time}`);
      }
    }
  }

  // Convert daily total from liters to m³
  const dailyTotalM3 = dailyTotal / 1000;
  
  if (debug) this.log(`Daily water usage: ${dailyTotalM3.toFixed(3)} m³ (${dailyTotal.toFixed(1)}L)`);

  // Check if day changed - if so, add previous day's total to cumulative
  if (lastDate !== today) {
    if (debug) this.log(`Day changed from ${lastDate} to ${today}`);
    
    // Add previous day's usage to cumulative total
    const cumulativeWater = this.getStoreValue('cumulative_water') || 0;
    const newCumulative = cumulativeWater + previousDailyUsage;
    
    await this.setStoreValue('cumulative_water', newCumulative);
    await this.setStoreValue('last_date', today);
    
    if (debug) this.log(`Added ${previousDailyUsage.toFixed(3)} m³ to cumulative. New total: ${newCumulative.toFixed(3)} m³`);
  }

  // Store current daily usage for next day rollover
  await this.setStoreValue('previous_daily_usage', dailyTotalM3);

  // Update daily water usage capability
  if (this.hasCapability('meter_water.daily')) {
    await this.setCapabilityValue('meter_water.daily', dailyTotalM3);
    if (debug) this.log(`Daily water meter updated: ${dailyTotalM3.toFixed(3)} m³`);
  }

  // Update cumulative water usage capability (including manual offset)
  if (this.hasCapability('meter_water')) {
    const cumulativeWater = this.getStoreValue('cumulative_water') || 0;
    const manualOffset = parseFloat(this.getSetting('manual_offset')) || 0;
    const totalWater = cumulativeWater + dailyTotalM3 + manualOffset;

    await this.setCapabilityValue('meter_water', totalWater);
    if (debug) this.log(`Cumulative water meter updated: ${totalWater.toFixed(3)} m³ (cumulative: ${cumulativeWater.toFixed(3)} m³, daily: ${dailyTotalM3.toFixed(3)} m³, offset: ${manualOffset.toFixed(3)} m³)`);
  }

  // --- Leak detection (pattern-based) ---
  await this._updateLeakPattern(data.values);
}

  /**
   * Pattern-based leak detection.
   *
   * Day split into 4 blocks of 6h. 28 EMA slots (7 days × 4 blocks).
   * A completed block is committed to EMA once, 30 min after block end.
   * Alarm fires when block usage > ema × multiplier (min 4 readings).
   */
  async _updateLeakPattern(values) {
    if (!this.hasCapability('alarm_water')) return;

    const SLOTS_PER_BLOCK = 24; // 6h / 15min
    const ALPHA = 0.2;
    const MIN_COUNT = 4;
    const BLOCK_BUFFER_MIN = 30;

    // Sum liters per 6h block from today's 15-min slots
    const blockTotals = [0, 0, 0, 0];
    values.forEach((d, i) => {
      if (d.water == null) return;
      const b = Math.floor(i / SLOTS_PER_BLOCK);
      if (b < 4) blockTotals[b] += d.water;
    });

    const now = new Date();
    const dayOfWeek = now.getDay();
    const hourFrac = now.getHours() + now.getMinutes() / 60;
    const currentBlock = Math.floor(hourFrac / 6);
    const minutesPastBlockStart = (hourFrac - currentBlock * 6) * 60;

    const pattern = this.getStoreValue('water_pattern') || {};
    const committed = this.getStoreValue('water_pattern_committed') || [];
    const today = now.toDateString();

    let leakDetected = false;
    const multiplier = this.getSetting('leak_multiplier') ?? 5;

    for (let b = 0; b < 4; b++) {
      const slotKey = `${dayOfWeek}-${b}`;
      const commitKey = `${today}-${b}`;

      const isCompleted = b < currentBlock ||
        (b === currentBlock - 1 && minutesPastBlockStart >= BLOCK_BUFFER_MIN);

      if (!isCompleted) {
        // Current incomplete block: check anomaly only, don't commit
        if (b === currentBlock) {
          const entry = pattern[slotKey];
          if (entry && entry.count >= MIN_COUNT && entry.ema > 0) {
            if (blockTotals[b] > entry.ema * multiplier) {
              leakDetected = true;
              if (debug) this.log(`⚠️ Leak (current block ${b}): ${blockTotals[b].toFixed(0)}L > ${(entry.ema * multiplier).toFixed(0)}L (ema=${entry.ema.toFixed(0)}L×${multiplier})`);
            }
          }
        }
        continue;
      }

      if (committed.includes(commitKey)) continue;

      // Check anomaly before updating EMA
      const entry = pattern[slotKey] || { ema: null, count: 0 };
      if (entry.count >= MIN_COUNT && entry.ema > 0) {
        if (blockTotals[b] > entry.ema * multiplier) {
          leakDetected = true;
          this.log(`⚠️ Leak (block ${b}, day ${dayOfWeek}): ${blockTotals[b].toFixed(0)}L > ${(entry.ema * multiplier).toFixed(0)}L (ema=${entry.ema.toFixed(0)}L×${multiplier})`);
        }
      }

      // Update EMA
      entry.ema = entry.ema === null ? blockTotals[b] : ALPHA * blockTotals[b] + (1 - ALPHA) * entry.ema;
      entry.count++;
      pattern[slotKey] = entry;

      // Mark as committed (keep last 28 entries)
      committed.push(commitKey);
      if (committed.length > 28) committed.splice(0, committed.length - 28);

      if (debug) this.log(`Pattern updated slot ${slotKey}: ema=${entry.ema.toFixed(0)}L count=${entry.count}`);
    }

    await this.setStoreValue('water_pattern', pattern);
    await this.setStoreValue('water_pattern_committed', committed);

    const currentAlarm = this.getCapabilityValue('alarm_water');
    if (leakDetected && !currentAlarm) {
      await this.setCapabilityValue('alarm_water', true);
    } else if (!leakDetected && currentAlarm) {
      this.log('✅ Leak alarm cleared');
      await this.setCapabilityValue('alarm_water', false);
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