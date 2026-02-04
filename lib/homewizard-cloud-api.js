/*
 * HomeWizard Cloud API Client
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
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

'use strict';

const https = require('https');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

/**
 * HomeWizard Cloud API Client
 * Handles authentication and WebSocket connections to HomeWizard cloud services
 */
class HomeWizardCloudAPI extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.email = options.email;
    this.password = options.password;
    this.accessToken = null;
    this.tokenExpiry = null;
    this.accountInfo = null;
    
    // WebSocket connections
    this.mainWs = null;
    this.realtimeWs = null;
    
    // Device state cache
    this.deviceStates = new Map();
    
    // Track subscribed devices for reconnection
    this.subscribedDevices = new Set();
    
    // Configuration
    this.reconnectInterval = 10000;
    this.messageId = 0;

    this._fastModeStart = null;
    this._fastModeRecovery = false;
    this._lastFastModeRecovery = null;

    this._lastPatchReceived = null;
    this._lastPatchTs = null;

    this._watchdogInterval = null;

    this._forceResubscribeAfterRecovery = false;

    this._startWatchdog();

  }

  /**
   * Authenticate and get access token
   */
  async authenticate() {
    return new Promise((resolve, reject) => {
      const credentials = Buffer.from(`${this.email}:${this.password}`).toString('base64');
      
      const options = {
        hostname: 'api.homewizardeasyonline.com',
        path: '/v1/auth/account/token?include=account',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            
            if (res.statusCode === 200) {
              this.accessToken = response.access_token;
              this.tokenExpiry = Date.now() + (response.expires_in * 1000);
              this.accountInfo = response.account;
              
              this.emit('authenticated', this.accountInfo);
              resolve(response);
            } else {
              reject(new Error(`Authentication failed: ${res.statusCode} - ${data}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse authentication response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Authentication request failed: ${error.message}`));
      });

      req.end();
    });
  }

  /**
   * Check if access token is still valid
   */
  isTokenValid() {
    return this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry;
  }

  /**
   * Get user's homes/locations
   */
  async getLocations() {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'homes.api.homewizard.com',
        path: '/locations',
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const locations = JSON.parse(data);
            
            if (res.statusCode === 200) {
              resolve(locations);
            } else {
              reject(new Error(`Failed to get locations: ${res.statusCode} - ${data}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse locations response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Get locations request failed: ${error.message}`));
      });

      req.end();
    });
  }

  /**
   * Connect to main WebSocket for device updates (every 40 seconds)
   */
  async connectMainWebSocket() {
  if (!this.isTokenValid()) {
    await this.authenticate();
  }

  return new Promise((resolve, reject) => {
    this.mainWs = new WebSocket('wss://energy-app-ws.homewizard.com/ws/');

    let authenticated = false;

    this.mainWs.on('open', () => {
      this.log('Main WebSocket connected');

      const helloMessage = {
        type: 'hello',
        message_id: ++this.messageId,
        compatibility: 5,
        os: 'homey',
        source: 'com.homewizard',
        token: this.accessToken,
        version: 'com.homewizard/3.0.0'
      };

      this.mainWs.send(JSON.stringify(helloMessage));
    });

    this.mainWs.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        // STREAM DEBUG
        if (message.type === 'response' && message.details && message.details.includes('Stream ID')) {
          const streamId = message.details.split('Stream ID: ')[1];
          if (!this._lastStreamId) {
            this._lastStreamId = streamId;
            this.log(`[DEBUG] First stream ID: ${streamId}`);
          } else if (this._lastStreamId !== streamId) {
            this.log(`[DEBUG] New stream ID detected: ${streamId} (previous: ${this._lastStreamId})`);
            this._lastStreamId = streamId;
          }
        }

        // AUTH
        if (message.type === 'response' && !authenticated) {
          if (message.status === 200) {
            authenticated = true;
            this.log('WebSocket authenticated successfully');
            this.emit('mainws_connected');

            

            if (this.subscribedDevices.size > 0) {
              this.log(`Re-subscribing to ${this.subscribedDevices.size} device(s)...`);
              setTimeout(() => {
                for (const deviceId of this.subscribedDevices) {
                  this._sendSubscribeMessage(deviceId);
                }
              }, 1000);
            }

            resolve();
          } else {
            reject(new Error(`Authentication failed: ${message.status} - ${message.details}`));
          }
        }

        // FAST‑MODE DETECTOR
        if (message.type === 'json_patch') {
          const now = Date.now();
          this._lastPatchReceived = now;

          if (!this._lastPatchTs) this._lastPatchTs = now;
          const diff = now - this._lastPatchTs;
          this._lastPatchTs = now;

          const isFast = diff < 1500;

          if (isFast) {
            if (!this._fastModeStart) {
              this._fastModeStart = now;
              this.log('[FAST-MODE] Detected fast updates, monitoring...');
            }
          } else {
            this._fastModeStart = null;
          }

          if (this._fastModeStart && now - this._fastModeStart > 5000) {
            this.log('[FAST-MODE] Cloud stuck in fast-mode → forcing reconnect');

            this._fastModeStart = null;
            this._fastModeRecovery = true;
            this._forceResubscribeAfterRecovery = true;
            this._lastFastModeRecovery = Date.now();

            try {
              this.mainWs.close();
            } catch (e) {
              this.error('Error closing WS during fast-mode recovery:', e);
            }

            return;
          }
        }

        this._handleMainWebSocketMessage(message);

      } catch (error) {
        this.error('Failed to parse WebSocket message:', error);
      }
    });

    this.mainWs.on('error', (error) => {
      this.error('Main WebSocket error:', error);
      this.emit('mainws_error', error);
      if (!authenticated) {
        reject(error);
      }
    });

    this.mainWs.on('close', () => {
      this.log('Main WebSocket closed');
      this.emit('mainws_closed');

      authenticated = false;

      // FAST‑MODE LOCKOUT
      if (this._fastModeRecovery) {
        this.log('Main WebSocket closed due to fast-mode recovery');

        this._fastModeRecovery = false;

        const sinceRecovery = Date.now() - (this._lastFastModeRecovery || 0);
        const lockout = 2 * 60 * 1000;
        const wait = Math.max(0, lockout - sinceRecovery);

        this.log(`[FAST-MODE] Enforcing 2-minute lockout, waiting ${wait}ms before reconnect...`);

        setTimeout(() => {
          this.connectMainWebSocket().catch(err => {
            this.error('Reconnect after lockout failed:', err);
          });
        }, wait);

        return;
      }

      // NORMAL RECONNECT
      const jitter = Math.floor(Math.random() * 2000);
      const cooldown = this.reconnectInterval + 10000 + jitter;

      this.log(`Reconnecting main WebSocket after ${cooldown}ms cooldown...`);

      setTimeout(() => {
        this.connectMainWebSocket().catch((error) => {
          this.error('Failed to reconnect main WebSocket:', error);
        });
      }, cooldown);
    });

  });
}



  /**
   * Connect to realtime WebSocket for second-by-second updates
   */
  async connectRealtimeWebSocket(deviceId, threePhases = false) {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }

    return new Promise((resolve, reject) => {
      this.realtimeWs = new WebSocket('wss://tsdb-reader.homewizard.com/devices/date/now');

      this.realtimeWs.on('open', () => {
        this.log('Realtime WebSocket connected');
        
        // Send subscription message
        const subscribeMessage = {
          token: this.accessToken,
          type: 'main_connection',
          devices: [{
            identifier: deviceId,
            measurementType: 'main_connection'
          }],
          three_phases: threePhases
        };

        this.realtimeWs.send(JSON.stringify(subscribeMessage));
        this.emit('realtimews_connected');
        resolve();
      });

      this.realtimeWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleRealtimeWebSocketMessage(message, deviceId);
        } catch (error) {
          this.error('Failed to parse realtime WebSocket message:', error);
        }
      });

      this.realtimeWs.on('error', (error) => {
        this.error('Realtime WebSocket error:', error);
        this.emit('realtimews_error', error);
      });

      this.realtimeWs.on('close', () => {
        this.log('Realtime WebSocket closed, attempting to reconnect...');
        this.emit('realtimews_closed');
        
        setTimeout(() => {
          this.connectRealtimeWebSocket(deviceId, threePhases).catch((error) => {
            this.error('Failed to reconnect realtime WebSocket:', error);
          });
        }, this.reconnectInterval);
      });
    });
  }

  /**
   * Send subscribe message (internal helper)
   */
  _sendSubscribeMessage(deviceId) {
    if (!this.mainWs || this.mainWs.readyState !== WebSocket.OPEN) {
      this.error(`Cannot subscribe to ${deviceId}: WebSocket not open`);
      return;
    }

    const subscribeMessage = {
      type: 'subscribe_device',
      device: deviceId,
      message_id: ++this.messageId
    };

    this.mainWs.send(JSON.stringify(subscribeMessage));
    this.log(`Subscribed to device: ${deviceId}`);
  }

  /**
   * Subscribe to a device on the main WebSocket
   */
  subscribeToDevice(deviceId) {
    // Add to tracked devices for auto-resubscribe on reconnect
    this.subscribedDevices.add(deviceId);
    
    // Subscribe now if connected
    this._sendSubscribeMessage(deviceId);
  }

  /**
   * Unsubscribe from a device
   */
    unsubscribeFromDevice(deviceId) {
      this.subscribedDevices.delete(deviceId);
      this.deviceStates.delete(deviceId);

      if (!this.mainWs || this.mainWs.readyState !== WebSocket.OPEN) {
        this.log(`WS not open, local unsubscribe only for ${deviceId}`);
        return;
      }

      const msg = {
        type: 'unsubscribe_device',
        device: deviceId,
        message_id: ++this.messageId,
      };

      this.mainWs.send(JSON.stringify(msg));
      this.log(`Unsubscribe message sent for device: ${deviceId}`);
    }


  /**
   * Handle messages from main WebSocket
   */
  _handleMainWebSocketMessage(message) {
    switch (message.type) {
      case 'response':
        this.log(`Response received: ${message.status} - ${message.details}`);
        break;

      case 'error':
        this.error('WebSocket error message:', JSON.stringify(message));
        // Check if this is a critical error that should close connection
        if (message.code === 'unauthorized' || message.code === 'forbidden') {
          this.emit('mainws_error', new Error(`WebSocket error: ${message.message || 'Unauthorized'}`));
        }
        break;

      case 'p1dongle':
      case 'energysocket':
      case 'watermeter':
        // Full device state update
        this.deviceStates.set(message.device, message);
        this.emit('device_update', message);
        break;

      case 'json_patch':
        this._lastPatchReceived = Date.now();   // <-- NIEUW
        this._applyJsonPatch(message);
        break;


      default:
        this.log(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Apply JSON patch to device state
   */
  _applyJsonPatch(patchMessage) {
    const deviceId = patchMessage.device;
    let deviceState = this.deviceStates.get(deviceId);

    if (!deviceState) {
      // This is expected if we've unsubscribed from the device
      // Don't log as error to avoid spam
      return;
    }

    // Apply each patch operation
    for (const operation of patchMessage.patch) {
      if (operation.op === 'replace') {
        // Parse the path (e.g., "/state/active_power_w" -> ["state", "active_power_w"])
        const pathParts = operation.path.split('/').filter(p => p);
        
        // Navigate to the nested property and update it
        let target = deviceState;
        for (let i = 0; i < pathParts.length - 1; i++) {
          target = target[pathParts[i]];
        }
        target[pathParts[pathParts.length - 1]] = operation.value;
      }
    }

    this.deviceStates.set(deviceId, deviceState);
    this.emit('device_patch', { deviceId, patch: patchMessage.patch, state: deviceState });
  }

  /**
   * Handle messages from realtime WebSocket
   */
  _handleRealtimeWebSocketMessage(message, deviceId) {
    if (message.time && message.wattage !== undefined) {
      this.emit('realtime_power', {
        deviceId,
        timestamp: new Date(message.time),
        wattage: message.wattage,
        wattages: message.wattages
      });
    }
  }

  _startWatchdog() {
  if (this._watchdogInterval) return;

  this._watchdogInterval = setInterval(() => {
    const now = Date.now();

    // Skip tijdens fast-mode recovery
    if (this._fastModeRecovery) return;

    // Skip als WS niet open is
    if (!this.mainWs || this.mainWs.readyState !== WebSocket.OPEN) return;

    // Skip als we recent een patch kregen
    if (this._lastPatchReceived && now - this._lastPatchReceived < 60000) return;

    // Skip als we nog nooit een patch hebben gehad
    if (!this._lastPatchReceived) return;

    this.log('[WATCHDOG] No patches for 60s — forcing resubscribe');

    // Eerst resubscribe
    for (const deviceId of this.subscribedDevices) {
      this._sendSubscribeMessage(deviceId);
    }

    // Na 10s checken of het werkte
    setTimeout(() => {
      const now2 = Date.now();

      if (this._lastPatchReceived && now2 - this._lastPatchReceived < 60000) {
        this.log('[WATCHDOG] Resubscribe successful');
        return;
      }

      this.log('[WATCHDOG] Resubscribe failed — forcing reconnect');

      try {
        if (this.mainWs && this.mainWs.readyState === WebSocket.OPEN) {
          this.mainWs.close();
        }
      } catch (e) {
        this.error('[WATCHDOG] Error closing WS:', e);
      }

      this.connectMainWebSocket().catch(err => {
        this.error('[WATCHDOG] Reconnect failed:', err);
      });

    }, 10000);

  }, 30000);
}


  /**
   * Get current state of a device
   */
  getDeviceState(deviceId) {
    return this.deviceStates.get(deviceId);
  }

  /**
   * Disconnect all WebSocket connections
   */
  disconnect() {
    if (this.mainWs) {
      this.mainWs.close();
      this.mainWs = null;
    }

    if (this.realtimeWs) {
      this.realtimeWs.close();
      this.realtimeWs = null;
    }

    this.deviceStates.clear();
    this.subscribedDevices.clear();
    this.emit('disconnected');
  }

  // Logging helpers
  log(...args) {
    console.log('[HomeWizardCloudAPI]', ...args);
  }

  error(...args) {
    console.error('[HomeWizardCloudAPI]', ...args);
  }
}

module.exports = HomeWizardCloudAPI;