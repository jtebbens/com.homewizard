/*
 * HomeWizard Cloud P1 Driver
 * 
 * Based on HomeWizard Cloud API research and documentation by Sven Serlier
 * Original repository: https://github.com/smarthomesven/homey-homewizard-energy-cloud
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

const { Driver } = require('homey');
const HomeWizardCloudAPI = require('../../lib/homewizard-cloud-api');

class CloudP1Driver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('CloudP1Driver has been initialized');
  }

  /**
   * onPairListDevices is called when the user starts pairing
   */
  async onPairListDevices() {
    this.log('onPairListDevices called');
    
    // Return empty array - devices will be discovered through pair flow
    return [];
  }

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('CloudP1Driver has been initialized');
    
    // Store active pairing sessions at driver level
    this.pairingSessions = new Map();
  }

  /**
   * onPair is called when a user wants to pair a device
   */
  async onPair(session) {
    this.log('Pairing session started');
    
    // Create a unique session ID
    const sessionId = Date.now().toString();
    
    // Store session data at driver level so it persists across views
    const sessionData = {
      cloudAPI: null,
      locations: [],
      credentials: {
        email: null,
        password: null
      }
    };
    
    this.pairingSessions.set(sessionId, sessionData);
    this.log(`Created pairing session: ${sessionId}`);

    // TEST HANDLER - to verify emit is working
    session.setHandler('test', async () => {
      this.log('TEST HANDLER CALLED - emit is working!');
      return { success: true, message: 'Test successful' };
    });

    // Step 1: Get cloud credentials
    session.setHandler('cloud_login', async (data) => {
      try {
        const { email, password } = data;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        const sd = this.pairingSessions.get(sessionId);
        
        // Store credentials for later use
        sd.credentials.email = email;
        sd.credentials.password = password;

        // Create cloud API instance
        sd.cloudAPI = new HomeWizardCloudAPI({
          email: email,
          password: password
        });

        // Authenticate
        await sd.cloudAPI.authenticate();
        this.log('Successfully authenticated');

        return { success: true };

      } catch (error) {
        this.error('Cloud login failed:', error);
        throw new Error(`Authentication failed: ${error.message}`);
      }
    });

    // Step 2: Get locations (homes)
    session.setHandler('list_locations', async () => {
      try {
        this.log('list_locations handler called');
        
        const sd = this.pairingSessions.get(sessionId);
        
        if (!sd || !sd.cloudAPI) {
          this.error('CloudAPI not initialized');
          throw new Error('Not authenticated. Please login first.');
        }

        this.log('Fetching locations from cloud...');
        sd.locations = await sd.cloudAPI.getLocations();
        this.log(`Found ${sd.locations.length} location(s)`);

        // Format locations for display
        const formattedLocations = sd.locations.map(location => ({
          id: location.id.toString(),
          name: location.name,
          location: location.location,
          deviceCount: location.devices ? location.devices.length : 0
        }));
        
        this.log('Formatted locations:', JSON.stringify(formattedLocations, null, 2));
        return formattedLocations;

      } catch (error) {
        this.error('Failed to get locations:', error);
        this.error('Error stack:', error.stack);
        throw new Error(`Failed to retrieve locations: ${error.message}`);
      }
    });

    // Step 3: Get devices for selected location
    session.setHandler('list_devices_for_location', async (data) => {
      try {
        const { locationId } = data;

        const sd = this.pairingSessions.get(sessionId);
        
        if (!sd || !sd.cloudAPI) {
          throw new Error('Not authenticated. Please login first.');
        }

        const location = sd.locations.find(loc => loc.id.toString() === locationId);
        
        if (!location) {
          throw new Error('Location not found');
        }

        // Filter for P1 dongles only
        const p1Devices = (location.devices || []).filter(device => 
          device.type === 'p1dongle'
        );

        this.log(`Found ${p1Devices.length} P1 device(s) in location ${location.name}`);

        // Format devices for display
        return p1Devices.map(device => ({
          name: device.name || 'P1 Meter',
          data: {
            id: device.device_id
          },
          settings: {
            cloud_email: sd.credentials.email,
            cloud_password: sd.credentials.password,
            location_id: locationId,
            location_name: location.name,
            enable_realtime: false,
            number_of_phases: 1
          },
          store: {
            device_type: device.type,
            created: device.created,
            modified: device.modified
          }
        }));

      } catch (error) {
        this.error('Failed to get devices:', error);
        throw new Error(`Failed to retrieve devices: ${error.message}`);
      }
    });

    // Clean up on pair session disconnect
    session.setHandler('disconnect', async () => {
      this.log('Pairing session ended');
      
      const sd = this.pairingSessions.get(sessionId);
      if (sd && sd.cloudAPI) {
        sd.cloudAPI.disconnect();
      }
      
      // Clean up session data
      this.pairingSessions.delete(sessionId);
      this.log(`Cleaned up pairing session: ${sessionId}`);
    });
  }

  /**
   * onRepair is called when a user wants to repair a device
   */
  async onRepair(session, device) {
    this.log('Repair session started for device:', device.getName());

    let cloudAPI = null;

    // Step 1: Get new cloud credentials
    session.setHandler('cloud_login', async (data) => {
      try {
        const { email, password } = data;

        if (!email || !password) {
          throw new Error('Email and password are required');
        }

        // Create cloud API instance
        cloudAPI = new HomeWizardCloudAPI({
          email: email,
          password: password
        });

        // Authenticate
        await cloudAPI.authenticate();
        this.log('Successfully authenticated during repair');

        // Update device settings
        await device.setSettings({
          cloud_email: email,
          cloud_password: password
        });

        return { success: true };

      } catch (error) {
        this.error('Cloud login failed during repair:', error);
        throw new Error(`Authentication failed: ${error.message}`);
      }
    });

    // Clean up on repair session disconnect
    session.setHandler('disconnect', async () => {
      this.log('Repair session ended');
      
      if (cloudAPI) {
        cloudAPI.disconnect();
        cloudAPI = null;
      }
    });
  }

}

module.exports = CloudP1Driver;