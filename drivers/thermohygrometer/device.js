/*
 * HomeWizard Cloud Thermo/Hygrometer Device Driver
 * 
 * Based on HomeWizard Cloud API research and documentation by Sven Serlier
 * 
 * Copyright (c) 2026 Jeroen Tebbens and contributors to com.homewizard
 * Cloud API research (c) 2025 Sven Serlier
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const { Device } = require('homey');
const HomeWizardCloudAPI = require('../../lib/homewizard-cloud-api');

const debug = false;

class CloudThermoHygroDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('CloudThermoHygroDevice has been initialized');

    // Get device data
    this.deviceId = this.getData().id;
    this.settings = this.getSettings();
    
    // Initialize cloud API client
    this.cloudAPI = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    
    // Track last update to detect stale data
    this.lastUpdate = null;
    this.staleDataTimeout = null;

    // Update rate monitoring to prevent spam
    this.updateCount = 0;
    this.updateRateWindow = 10000; // 10 seconds
    this.updateRateThreshold = 8; // More than 8 updates in 10s = too fast (< 1.25s average)
    this.updateRateTimer = null;
    this.spamDetected = false;
    this.spamLogged = false;

    // Initialize capabilities if needed
    await this.initializeCapabilities();

    // Connect to cloud
    await this.connectToCloud();

    // Register capability listeners
    this.registerCapabilityListeners();

    this.log(`Cloud Thermo/Hygrometer device initialized: ${this.getName()} (${this.deviceId})`);
  }

  /**
   * Initialize device capabilities
   */
  async initializeCapabilities() {
    // Ensure all required capabilities exist
    const requiredCapabilities = [
      'measure_temperature',
      'measure_humidity',
      'measure_battery'
    ];

    for (const capability of requiredCapabilities) {
      if (!this.hasCapability(capability)) {
        try {
          await this.addCapability(capability);
        } catch (err) {
          if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
            this.log(`Capability already exists: ${capability} — ignoring`);
          } else {
            this.error(`Failed to add capability ${capability}:`, err);
          }
        }
      }
    }
  }

  /**
   * Connect to HomeWizard cloud
   */
  async connectToCloud() {
    try {
      const email = this.getSetting('cloud_email');
      const password = this.getSetting('cloud_password');

      if (!email || !password) {
        throw new Error('Cloud credentials not configured');
      }

      // Create cloud API instance
      this.cloudAPI = new HomeWizardCloudAPI({
        email: email,
        password: password
      });

      // Set up event listeners
      this.setupCloudEventListeners();

      // Authenticate
      await this.cloudAPI.authenticate();
      this.log('Successfully authenticated with HomeWizard cloud');

      // Connect to main WebSocket
      await this.cloudAPI.connectMainWebSocket();

      // Subscribe to this device
      this.cloudAPI.subscribeToDevice(this.deviceId);

      // Note: Realtime WebSocket (1-second updates) is not used
      // to avoid potential cloud-side issues and excessive update rates

      // Mark device as available
      await this.setAvailable();
      this.reconnectAttempts = 0;

      // Set up stale data detection
      this.setupStaleDataDetection();

    } catch (error) {
      this.error('Failed to connect to cloud:', error);
      await this.setUnavailable(`Cloud connection failed: ${error.message}`);
      
      // Schedule reconnect
      this.scheduleReconnect();
    }
  }

  /**
   * Set up cloud API event listeners
   */
  setupCloudEventListeners() {
    // Handle full device updates
    this.cloudAPI.on('device_update', (deviceData) => {
      if (deviceData.device === this.deviceId) {
        this.log('[MAIN WS] Full device update received');
        this.handleDeviceUpdate(deviceData);
      }
    });

    // Handle incremental updates (JSON patches)
    this.cloudAPI.on('device_patch', (patchData) => {
      if (patchData.deviceId === this.deviceId) {
        if (debug) this.log('[MAIN WS] JSON patch received');
        this.handleDeviceUpdate(patchData.state);
      }
    });

    // Handle connection issues
    this.cloudAPI.on('mainws_closed', () => {
      this.log('Main WebSocket closed');
      this.setWarning('Cloud connection lost, reconnecting...').catch(this.error);
    });
    
    this.cloudAPI.on('mainws_connected', () => {
      this.log('Main WebSocket reconnected');
      this.unsetWarning().catch(this.error);
    });

    this.cloudAPI.on('mainws_error', (error) => {
      this.error('Main WebSocket error:', error);
    });
  }

  /**
   * Handle device update from cloud
   */
  handleDeviceUpdate(deviceData) {
    try {
      this.lastUpdate = Date.now();
      
      // Monitor update rate and potentially unsubscribe if spam detected
      //this.monitorUpdateRate();
      
      const state = deviceData.state;

      if (!state) {
        this.error('Device update missing state data');
        return;
      }
      
      // Clear any warnings - we're receiving data successfully
      this.unsetWarning().catch(this.error);

      // Update online status
      if (deviceData.online !== undefined) {
        if (deviceData.online) {
          this.setAvailable();
        } else {
          this.setUnavailable('Device is offline');
        }
      }

      // Update power measurements
      if (state.temperature !== null && state.temperature !== undefined) {
        this.setCapabilityValue('measure_temperature', state.temperature).catch(this.error);
      }

      if (state.humidity !== null && state.humidity !== undefined) {
        this.setCapabilityValue('measure_humidity', state.humidity).catch(this.error);
      }

      if (state.batteryLevel !== null && state.batteryLevel !== undefined) {
        this.setCapabilityValue('measure_battery', state.batteryLevel).catch(this.error);
      }

      if (debug) this.log('Device updated successfully');

    } catch (error) {
      this.error('Failed to handle device update:', error);
    }
  }

  /**
   * Monitor update rate and stop spam
   */
  monitorUpdateRate() {
    // Increment update counter
    this.updateCount++;

    // Start timer on first update
    if (!this.updateRateTimer) {
      this.updateRateTimer = setTimeout(() => {
        // Check if we exceeded threshold
        if (this.updateCount > this.updateRateThreshold && !this.spamDetected) {
          this.spamDetected = true;
          const updatesPerSecond = (this.updateCount / (this.updateRateWindow / 1000)).toFixed(2);
          this.log(`⚠️ Excessive update rate detected: ${this.updateCount} updates in ${this.updateRateWindow/1000}s (${updatesPerSecond}/s)`);
          this.log('Unsubscribing from device to stop spam. Will retry in 60 seconds...');
          
          // Unsubscribe from this device to stop the updates
          if (this.cloudAPI) {
            this.cloudAPI.unsubscribeFromDevice(this.deviceId);
          }
          
          // Set warning
          this.setWarning('Excessive updates detected. Paused for 60 seconds.').catch(this.error);
          
          // Resubscribe after 60 seconds
          setTimeout(() => {
            this.log('Resubscribing to device after spam cooldown...');
            if (this.cloudAPI) {
              // Re-add to subscribed devices set
              this.cloudAPI.subscribedDevices.add(this.deviceId);
              // Send subscribe message
              this.cloudAPI._sendSubscribeMessage(this.deviceId);
            }
            this.spamDetected = false;
            this.spamLogged = false;
            this.unsetWarning().catch(this.error);
          }, 60000); // 60 seconds
        }
        
        // Reset counter
        this.updateCount = 0;
        this.updateRateTimer = null;
      }, this.updateRateWindow);
    }
  }

  /**
   * Set up stale data detection
   */
  setupStaleDataDetection() {
    // Clear existing timeout
    if (this.staleDataTimeout) {
      clearTimeout(this.staleDataTimeout);
    }

    // Check for stale data every 24 hours
    this.staleDataTimeout = setInterval(() => {
      const timeSinceUpdate = Date.now() - (this.lastUpdate || 0);
      const maxStaleTime = 86400*1000; // 24 hrs

      if (timeSinceUpdate > maxStaleTime) {
        this.log('Data appears stale, marking device as unavailable');
        this.setUnavailable('No recent data from cloud');

        // Forceer een harde WebSocket reset
        if (this.cloudAPI && this.cloudAPI.mainWs) {
          this.log('Data stale → forcing WebSocket reconnect');
          try {
            this.cloudAPI.mainWs.terminate(); // hard close
          } catch (err) {
            this.error('Failed to terminate WS:', err);
          }
        }
      }

    }, 60000); // Check every minute
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.error('Max reconnect attempts reached');
      this.setUnavailable('Unable to connect to cloud after multiple attempts');
      return;
    }

    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    this.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      await this.connectToCloud();
    }, delay);
  }

  /**
   * Register capability listeners
   */
  registerCapabilityListeners() {
    // Currently, Thermo/Hygrometers don't have controllable capabilities via cloud API
    // This is a placeholder for future functionality
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('CloudThermoHygroDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('CloudThermoHygroDevice settings were changed');

    // If credentials changed, reconnect
    if (changedKeys.includes('cloud_email') || changedKeys.includes('cloud_password')) {
      this.log('Cloud credentials changed, reconnecting...');
      if (this.cloudAPI) {
        this.cloudAPI.disconnect();
      }
      await this.connectToCloud();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log('CloudThermoHygroDevice was renamed to:', name);
  }

  /**
   * onUninit is called when the app stops/crashes
   */
  async onUninit() {
    // Clean up timers
    if (this.staleDataTimeout) {
      clearInterval(this.staleDataTimeout);
      this.staleDataTimeout = null;
    }
    
    if (this.updateRateTimer) {
      clearTimeout(this.updateRateTimer);
      this.updateRateTimer = null;
    }

    if (this.cloudAPI) {
      this.cloudAPI.disconnect();
    }
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('CloudThermoHygroDevice has been deleted');

    // Unsubscribe from device (only on explicit deletion)
    if (this.cloudAPI) {
      this.cloudAPI.unsubscribeFromDevice(this.deviceId);
    }

    // Call onUninit to cleanup timers
    await this.onUninit();
  }

}

module.exports = CloudThermoHygroDevice;