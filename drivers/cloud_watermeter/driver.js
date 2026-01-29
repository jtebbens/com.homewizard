'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');

const API_BASE_URL = 'https://api.homewizardeasyonline.com/v1';
const HOMES_API_URL = 'https://homes.api.homewizard.com';
const GRAPHQL_URL = 'https://api.homewizard.energy/v1/graphql';
const TSDB_URL = 'https://tsdb-reader.homewizard.com';
const TOKEN_REFRESH_MARGIN = 60; // seconds before expiry to refresh

module.exports = class HomeWizardCloudWatermeterDriver extends Homey.Driver {

  async onInit() {
    this.log('HomeWizard Cloud Watermeter driver initialized');
  }

  /**
   * Authenticate with HomeWizard Cloud API
   * @param {string} username - HomeWizard account email
   * @param {string} password - HomeWizard account password
   * @returns {Promise<Object>} Token data with access_token and expires_in
   */
  async authenticate(username, password) {
    const url = `${API_BASE_URL}/auth/account/token`;
    
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    
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
        throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        access_token: data.access_token,
        expires_at: Date.now() + ((data.expires_in || 3600) - TOKEN_REFRESH_MARGIN) * 1000,
      };
    } catch (err) {
      this.error('Authentication error:', err.message);
      throw new Error(this.homey.__('errors.auth_failed'));
    }
  }

  /**
   * Get list of locations (homes) for the account
   * @param {string} token - Bearer token
   * @returns {Promise<Array>} List of locations
   */
  async getLocations(token) {
    const url = `${HOMES_API_URL}/locations`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'HomeWizardHomey/1.0',
        },
        timeout: 10000,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch locations: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      this.error('Error fetching locations:', err.message);
      return [];
    }
  }

  /**
   * Get devices for a specific home using GraphQL
   * @param {string} token - Bearer token
   * @param {number} homeId - Home ID
   * @returns {Promise<Object>} GraphQL response with devices
   */
  async getDevices(token, homeId) {
    const payload = {
      operationName: 'DeviceList',
      variables: {
        homeId: homeId,
      },
      query: `query DeviceList($homeId: Int!) {
        home(id: $homeId) {
          devices {
            identifier
            name
            wifiStrength
            ... on CloudDevice {
              type
              model
              hardwareVersion
              onlineState
            }
          }
        }
      }`,
    };

    return await this.callGraphQL(token, payload);
  }

  /**
   * Call GraphQL endpoint
   * @param {string} token - Bearer token
   * @param {Object} payload - GraphQL query payload
   * @returns {Promise<Object>} GraphQL response
   */
  async callGraphQL(token, payload) {
    try {
      const response = await fetch(GRAPHQL_URL, {
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
        throw new Error(`GraphQL request failed: ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      this.error('GraphQL error:', err.message);
      return null;
    }
  }

  /**
   * Get time-series database data for water measurements
   * @param {string} token - Bearer token
   * @param {string} deviceIdentifier - Device identifier
   * @param {Date} date - Date to fetch data for
   * @param {string} timezone - Timezone string (e.g., 'Europe/Amsterdam')
   * @returns {Promise<Object>} TSDB data
   */
  async getTSDBData(token, deviceIdentifier, date, timezone = 'Europe/Amsterdam') {
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '/');
    const url = `${TSDB_URL}/devices/date/${dateStr}`;

    const payload = {
      devices: [
        {
          identifier: deviceIdentifier,
          measurementType: 'water',
        },
      ],
      type: 'water',
      values: true,
      wattage: true,
      gb: '15m',
      tz: timezone,
      fill: 'linear',
      three_phases: false,
    };

    try {
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
        const text = await response.text();
        throw new Error(`TSDB request failed: ${response.status} - ${text}`);
      }

      return await response.json();
    } catch (err) {
      this.error('TSDB error:', err.message);
      return null;
    }
  }

  /**
   * Pairing flow - authenticate and discover devices
   */
  async onPair(session) {
    let username = '';
    let password = '';
    let tokenData = null;

    session.setHandler('login', async (data) => {
      username = data.username;
      password = data.password;

      try {
        // Authenticate
        tokenData = await this.authenticate(username, password);
        this.log('Authentication successful');
        return true;
      } catch (err) {
        this.error('Login failed:', err.message);
        throw new Error(this.homey.__('errors.invalid_credentials'));
      }
    });

    session.setHandler('list_devices', async () => {
      if (!tokenData) {
        throw new Error('Not authenticated');
      }

      const devices = await this.discoverDevices(tokenData, username, password);
      return devices;
    });
  }

  /**
   * Discover watermeter devices
   */
  async discoverDevices(tokenData, username, password) {
    try {
      this.log('Fetching locations...');
      const locations = await this.getLocations(tokenData.access_token);
      
      if (!locations || locations.length === 0) {
        throw new Error(this.homey.__('errors.no_locations'));
      }

      const devices = [];

      for (const location of locations) {
        this.log(`Fetching devices for location: ${location.id} (${location.name || 'unnamed'})`);
        const devicesData = await this.getDevices(tokenData.access_token, location.id);
        
        if (devicesData?.data?.home?.devices) {
          this.log(`Found ${devicesData.data.home.devices.length} total devices`);
          
          const watermeters = devicesData.data.home.devices.filter(
            device => device.type === 'watermeter' || device.model?.includes('WTR')
          );
          
          this.log(`Filtered to ${watermeters.length} watermeter(s)`);

          for (const device of watermeters) {
            devices.push({
              name: device.name || `Watermeter (${device.identifier})`,
              data: {
                id: device.identifier,
              },
              store: {
                username: username,
                password: password,
                token: tokenData.access_token,
                token_expires_at: tokenData.expires_at,
                identifier: device.identifier,
                homeId: location.id,
              },
            });
          }
        }
      }

      if (devices.length === 0) {
        throw new Error(this.homey.__('errors.no_watermeters'));
      }

      this.log(`Returning ${devices.length} watermeter(s) for pairing`);
      return devices;
    } catch (err) {
      this.error('Device discovery failed:', err.message);
      this.error('Stack trace:', err.stack);
      throw err;
    }
  }
};