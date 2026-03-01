/*
 * HomeWizard WebSocket Manager
 * Copyright (C) 2025 Jeroen Tebbens
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

'use strict';

const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const wsDebug = require('./wsDebug');
const debug = false;

const SHARED_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000,
  maxSockets: 4,
  maxFreeSockets: 2,
  rejectUnauthorized: false,
  timeout: 10000
});

// ✅ GLOBAL circuit breaker shared across ALL WebSocketManager instances
// Optimized for up to 5 devices (4 plugin_battery + 1 energy_v2)
const GLOBAL_CIRCUIT_BREAKER = {
  _consecutiveFailures: 0,
  _isOpen: false,
  _activeAttempts: 0,
  _resetTimeout: null,
  _maxConcurrentAttempts: 8,     // Allow some overlap across 5 devices
  _failureThreshold: 25,          // 5 devices × 5 attempts each
  _resetTimeoutMs: 300000,        // 5 minutes
  
  canAttempt() {
    return !this._isOpen && this._activeAttempts < this._maxConcurrentAttempts;
  },
  
  startAttempt() {
    this._activeAttempts++;
  },
  
  endAttempt() {
    this._activeAttempts = Math.max(0, this._activeAttempts - 1);
  },
  
  recordSuccess() {
    this._consecutiveFailures = 0;
    if (this._isOpen) {
      console.log('🔄 Global circuit breaker CLOSED: Connection restored');
      this._isOpen = false;
      if (this._resetTimeout) {
        clearTimeout(this._resetTimeout);
        this._resetTimeout = null;
      }
    }
  },
  
  recordFailure() {
    this._consecutiveFailures++;
    
    if (this._consecutiveFailures >= this._failureThreshold && !this._isOpen) {
      this._isOpen = true;
      console.error(`🚨 GLOBAL CIRCUIT BREAKER OPEN`);
      console.error(`   Total failures: ${this._consecutiveFailures} across all devices`);
      console.error(`   This indicates a network or device availability issue`);
      console.error(`   All reconnection attempts paused for 5 minutes`);
      
      if (this._resetTimeout) clearTimeout(this._resetTimeout);
      this._resetTimeout = setTimeout(() => {
        console.log('🔄 Global circuit breaker auto-reset after 5 minutes');
        console.log('   Resuming connection attempts...');
        this._isOpen = false;
        this._consecutiveFailures = 0;
        this._resetTimeout = null;
      }, this._resetTimeoutMs);
      
      return { opened: true };
    }
    
    return { opened: false };
  },
  
  getBackoffDelay() {
    // Exponential backoff: 5s, 10s, 15s, 20s, 25s, ..., max 3 minutes
    const base = 5000 * Math.min(this._consecutiveFailures, 10);
    const delay = Math.min(base, 180000);
    // Add 10-20% jitter to prevent thundering herd
    return delay * (0.9 + Math.random() * 0.2);
  },
  
  isOpen() {
    return this._isOpen;
  },
  
  getFailureCount() {
    return this._consecutiveFailures;
  },
  
  getStats() {
    return {
      failures: this._consecutiveFailures,
      isOpen: this._isOpen,
      activeAttempts: this._activeAttempts,
      threshold: this._failureThreshold,
      maxConcurrent: this._maxConcurrentAttempts
    };
  }
};

/**
 * Perform a fetch with a timeout using AbortController.
 */
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Fetch timeout'));
    }, timeout);

    fetch(url, options)
      .then(async res => {
        clearTimeout(timer);
        const text = await res.text();
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(text);
        }
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * WebSocketManager
 */
class WebSocketManager {
  constructor({ device, url, token, log, error, setAvailable, getSetting, handleMeasurement, handleSystem, handleBatteries }) {
    this.device = device;
    this.url = url;
    this.token = token;
    this.log = log;
    this.error = error;
    this.setAvailable = setAvailable;
    this.getSetting = getSetting;

    this._handleMeasurement = handleMeasurement;
    this._handleSystem = handleSystem;
    this._handleBatteries = handleBatteries;

    this.pendingMeasurement = null;
    this.pendingSystem = null;
    this.pendingBatteries = null;

    this.ws = null;
    this.wsActive = false;
    this.wsAuthorized = false;
    this.reconnectAttempts = 0;
    this.lastMeasurementAt = Date.now();

    this.reconnecting = false;
    this._restartCooldown = 0;

    this._timers = new Set();
    this.pongReceived = true;
    this._stopped = false;
    
    // Track socket handlers for cleanup
    this._socketHandlers = new Map();
    
    // Use GLOBAL circuit breaker
    this.circuitBreaker = GLOBAL_CIRCUIT_BREAKER;
    
    // ✅ Per-device failure tracking (soft limit)
    this._deviceFailures = 0;
    this._deviceFailureResetTimeout = null;
  }

  _safeSetTimeout(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      if (this._stopped) return;
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _safeSetInterval(fn, ms) {
    const id = setInterval(() => {
      if (this._stopped) return;
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _clearTimers() {
    for (const id of this._timers) {
      clearTimeout(id);
      clearInterval(id);
    }
    this._timers.clear();
  }

  /**
   * Perform TLS + HTTP upgrade manually
   */
  async _openUpgradedSocket(wsUrlString) {
    const url = new URL(wsUrlString);
    const host = url.hostname;
    const port = url.port || 443;
    const path = url.pathname + (url.search || '');

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const expectedAccept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
      
      const tlsOptions = {
        host,
        port,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
        timeout: 5000
      };
      
      if (!isIp) {
        tlsOptions.servername = host;
      }
      
      const socket = tls.connect(tlsOptions);

      let buffer = '';
      let upgraded = false;
      let timeoutId = null;

      const fail = (err) => {
        if (!upgraded) {
          if (timeoutId) clearTimeout(timeoutId);
          try { socket.destroy(); } catch {}
          reject(err);
        }
      };

      timeoutId = setTimeout(() => {
        fail(new Error('WebSocket upgrade timeout (10s)'));
      }, 10000);

      socket.on('error', err => fail(err));
      socket.on('timeout', () => fail(new Error('TLS timeout')));
      socket.on('close', () => {
        if (!upgraded) fail(new Error('Socket closed before upgrade'));
      });

      socket.once('connect', () => {
        const headers = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: keep-alive, Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Protocol: homewizard-api',
          `Authorization: Bearer ${this.token}`,
          '\r\n'
        ].join('\r\n');

        socket.write(headers);
      });

      socket.on('data', chunk => {
        if (upgraded) return;
        buffer += chunk.toString('utf8');

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const header = buffer.slice(0, headerEnd);
        const lines = header.split('\r\n');
        const status = lines.shift();
        const m = status.match(/^HTTP\/1\.[01] (\d{3})/);
        const code = m ? parseInt(m[1], 10) : 0;

        if (code !== 101) return fail(new Error(`WS upgrade failed: ${code}`));

        const headersObj = {};
        for (const line of lines) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          headersObj[line.slice(0, idx).trim().toLowerCase()] =
            line.slice(idx + 1).trim();
        }

        if (headersObj['sec-websocket-accept'] !== expectedAccept) {
          return fail(new Error('Invalid Sec-WebSocket-Accept'));
        }

        upgraded = true;
        if (timeoutId) clearTimeout(timeoutId);
        const leftover = buffer.slice(headerEnd + 4);

        socket.removeAllListeners('data');
        
        resolve({ socket, leftover });
      });
    });
  }

  /**
   * Start the WebSocket connection
   */
  async start() {
    if (this._stopped) {
      this.log('⚠️ WebSocket is stopped - use resume() to restart');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is already connecting — skipping start');
      return;
    }

    // ✅ Per-device soft limit: back off this device if it fails repeatedly
    if (this._deviceFailures >= 10) {
      this.log(`⚠️ This device has failed ${this._deviceFailures} times, waiting longer before retry`);
      const longDelay = 60000 + Math.random() * 60000; // 1-2 minutes
      this._safeSetTimeout(() => {
        this._deviceFailures = 0; // Reset after long wait
        this.start();
      }, longDelay);
      return;
    }

    // ✅ Check GLOBAL circuit breaker
    if (!this.circuitBreaker.canAttempt()) {
      if (this.circuitBreaker.isOpen()) {
        this.log(`⚠️ Global circuit breaker OPEN (${this.circuitBreaker.getFailureCount()} total failures)`);
      } else {
        this.log(`⚠️ Too many global connection attempts (${this.circuitBreaker._activeAttempts})`);
      }
      
      this._safeSetTimeout(() => this.start(), this.circuitBreaker.getBackoffDelay());
      return;
    }

    this.circuitBreaker.startAttempt();

    try {
      // Clean up existing connection
      if (this.ws) {
        await this._cleanupWebSocket();
      }

      const settingsUrl = this.getSetting('url');
      if (!this.url && settingsUrl) this.url = settingsUrl;
      if (!this.token || !this.url) {
        this.error('❌ Missing token or URL — cannot start WebSocket');
        return;
      }

      const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';

      // Preflight check
      try {
        const res = await fetchWithTimeout(`${this.url}/api/system`, {
          headers: { Authorization: `Bearer ${this.token}` },
          agent: SHARED_AGENT
        }, 3000);

        if (!res || typeof res.cloud_enabled === 'undefined') {
          this.error(`❌ Device unreachable at ${this.url} - invalid response`);
          throw new Error('Device unreachable');
        }
        
        // ✅ Success - reset on successful preflight
        this.reconnectAttempts = 0;
        
        // On success (after successful preflight):
        this._deviceFailures = 0;
        if (this._deviceFailureResetTimeout) {
          clearTimeout(this._deviceFailureResetTimeout);
          this._deviceFailureResetTimeout = null;
        }
        this.circuitBreaker.recordSuccess();
        
      } catch (err) {
        this.error(`❌ Preflight check failed: ${err.message}`);
        
        // On failure (in catch blocks):
        this._deviceFailures++;
        
        // Record failure in global circuit breaker
        const result = this.circuitBreaker.recordFailure();
        if (result.opened) {
          this.error(`🚨 Global circuit breaker OPENED - too many failures across all devices`);
        }
        
        // Schedule retry with exponential backoff
        this._safeSetTimeout(() => this.start(), this.circuitBreaker.getBackoffDelay());
        return;
      }
      // Perform custom HTTP upgrade
      let upgraded;
      try {
        upgraded = await this._openUpgradedSocket(wsUrl);
      } catch (err) {
        this.error('❌ WebSocket HTTP upgrade failed:', err.message || err);
        
        // On failure (in catch blocks):
        this._deviceFailures++;
        
        const result = this.circuitBreaker.recordFailure();
        if (result.opened) {
          this.error(`🚨 Global circuit breaker OPENED`);
        }
        
        this._safeSetTimeout(() => this.start(), this.circuitBreaker.getBackoffDelay());
        return;
      }

      const { socket: upgradedSocket, leftover } = upgraded;

      // Create WebSocket wrapper
      try {
        await this._createWebSocketWrapper(upgradedSocket, leftover);
        
        // ✅ Record success in GLOBAL circuit breaker
        this.circuitBreaker.recordSuccess();
        
      } catch (err) {
        this.error('❌ Failed to create WebSocket wrapper:', err);
        
        // On failure (in catch blocks):
        this._deviceFailures++;
        
        const result = this.circuitBreaker.recordFailure();
        if (result.opened) {
          this.error(`🚨 Global circuit breaker OPENED`);
        }
        
        try { upgradedSocket.destroy(); } catch {}
        this._safeSetTimeout(() => this.start(), this.circuitBreaker.getBackoffDelay());
        return;
      }
      
    } catch (err) {
      this.error('❌ Unexpected error in start():', err);
      
      // On failure (in catch blocks):
      this._deviceFailures++;
      
      const result = this.circuitBreaker.recordFailure();
      if (result.opened) {
        this.error(`🚨 Global circuit breaker OPENED`);
      }
      
      this._safeSetTimeout(() => this.start(), this.circuitBreaker.getBackoffDelay());
    } finally {
      // Always release attempt slot
      this.circuitBreaker.endAttempt();
    }
  }

  /**
   * Create WebSocket wrapper around upgraded socket
   */
  async _createWebSocketWrapper(upgradedSocket, leftover) {
    const { Receiver, Sender } = WebSocket;

    const receiver = new Receiver({
      maxPayload: 128 * 1024,
      skipUTF8Validation: true,
      allowSynchronousEvents: true,
      isServer: false,
      clientTracking: false
    });

    const sender = new Sender(upgradedSocket, { skipMasking: false });

    this.ws = {
      _socket: upgradedSocket,
      _receiver: receiver,
      _sender: sender,
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      _events: {},

      terminate: () => {
        try { upgradedSocket.destroy(); } catch {}
      },

      close: () => {
        try { upgradedSocket.end(); } catch {}
      },

      ping: () => {
        try {
          sender.ping(Buffer.alloc(0), { mask: true });
        } catch (err) {
          this.error('❌ ping() failed:', err);
        }
      },

      send: (data) => {
        try {
          sender.send(
            Buffer.from(data),
            { fin: true, opcode: 1, mask: true, rsv1: false },
            (err) => err && this.error('❌ Sender error:', err)
          );
        } catch (err) {
          this.error('❌ send() failed:', err);
        }
      },

      on: (event, handler) => {
        this.ws._events[event] = handler;
      },

      removeAllListeners: (event) => {
        if (event) {
          delete this.ws._events[event];
        } else {
          this.ws._events = {};
        }
      }
    };

    receiver.on('ping', (data) => {
      try {
        sender.pong(data, { mask: true });
      } catch (err) {
        this.error('❌ Failed to send pong:', err);
      }
      const handler = this.ws._events?.pong;
      if (handler) handler();
    });

    receiver.on('message', (data) => {
      const handler = this.ws._events?.message;
      if (handler) handler(data);
    });

    receiver.on('close', () => {
      const handler = this.ws._events?.close;
      if (handler) handler();
    });

    receiver.on('error', (err) => {
      this.error('❌ Receiver error:', err);
      try { this.ws.terminate(); } catch {}
      this._scheduleReconnect();
    });

    if (leftover && leftover.length) {
      try {
        receiver.write(Buffer.from(leftover, 'binary'));
      } catch (err) {
        this.error('❌ Failed to write leftover to receiver:', err);
      }
    }

    const dataHandler = (chunk) => {
      if (this._stopped) return;
      try {
        receiver.write(chunk);
      } catch (err) {
        this.error('❌ Receiver write failed:', err);
      }
    };

    this._socketHandlers.set('data', dataHandler);
    upgradedSocket.on('data', dataHandler);

    const errorHandler = (err) => {
      this.error('❌ Low-level socket error:', err.message);
      try { this.ws.terminate(); } catch {}
      this._scheduleReconnect();
    };

    this._socketHandlers.set('error', errorHandler);
    upgradedSocket.on('error', errorHandler);

    const endHandler = () => {
      try { receiver.end(); } catch {}
    };

    this._socketHandlers.set('end', endHandler);
    upgradedSocket.on('end', endHandler);

    const closeHandler = () => {
      try { receiver.end(); } catch {}
    };

    this._socketHandlers.set('close', closeHandler);
    upgradedSocket.on('close', closeHandler);

    this._safeSend = (obj) => {
      if (this._stopped) return false;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

      try {
        const data = Buffer.from(JSON.stringify(obj));
        sender.send(
          data,
          { fin: true, opcode: 1, mask: true },
          (err) => err && this.error('❌ Sender error:', err)
        );
        return true;
      } catch (err) {
        this.error('❌ safeSend failed:', err);
        return false;
      }
    };

    this._setupWebSocketHandlers();

    this._safeSetTimeout(() => {
      if (this._stopped) return;
      const handler = this.ws._events?.open;
      if (handler) handler();
    }, 10);
  }

  /**
   * Set up WebSocket event handlers
   */
  _setupWebSocketHandlers() {
    this.ws.on('open', () => {
      if (this._stopped) return;

      this.wsActive = true;
      this.wsAuthorized = false;
      this.reconnectAttempts = 0;

      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('open', devId, 'WebSocket opened');

      if (this.ws._socket) this.ws._socket.setKeepAlive(true, 30000);

      this.pongReceived = true;

      this._safeSetInterval(() => {
        if (this._stopped) return;
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const idleFor = now - this.lastMeasurementAt;

        if (!this.pongReceived && idleFor > 60000) {
          this.log(`🧨 No pong & idle ${idleFor}ms — force closing zombie WebSocket`);
          try { this.ws.terminate(); } catch (e) {}
          this.ws = null;
          this.wsActive = false;
          this.wsAuthorized = false;
          this._scheduleReconnect();
          return;
        }

        this.pongReceived = false;
        try { this.ws.ping(); } catch (e) { this.error('ping failed', e); }
      }, 30000);

      // Enforce minimum 2 second update interval
      const requestedInterval = this.getSetting('update_interval');
      const updateInterval = Math.max(requestedInterval || 2000, 2000);
      
      if (requestedInterval && requestedInterval < 2000) {
        this.log(`⚠️ Update interval ${requestedInterval}ms too aggressive, using 2000ms`);
      }

      this._safeSetInterval(() => {
        if (this._stopped) return;
        if (!this.pendingMeasurement) return;

        const data = this.pendingMeasurement;
        this.pendingMeasurement = null;
        this.lastMeasurementAt = Date.now();

        try {
          this._handleMeasurement?.(data);
        } catch (e) {
          this.error('❌ Error in measurement handler:', e);
        }
      }, updateInterval);

      this._safeSetInterval(() => {
        if (this._stopped) return;

        if (this.pendingSystem) {
          const sys = this.pendingSystem;
          this.pendingSystem = null;
          try {
            this._handleSystem?.(sys);
          } catch (e) {
            this.error('❌ Error in system handler:', e);
          }
        }

        if (this.pendingBatteries) {
          const bat = this.pendingBatteries;
          this.pendingBatteries = null;
          try {
            this._handleBatteries?.(bat);
          } catch (e) {
            this.error('❌ Error in batteries handler:', e);
          }
        }
      }, 10000);

      const maxRetries = 30;
      let retries = 0;

      const tryAuthorize = () => {
        if (this._stopped) return;
        if (!this.ws) return;

        if (this.ws.readyState === WebSocket.OPEN) {
          this.log('🔐 Sending WebSocket authorization');
          this._safeSend({ type: 'authorization', data: this.token });
        } else if (retries < maxRetries) {
          retries++;
          this._safeSetTimeout(tryAuthorize, 100);
        } else {
          this.error('❌ WebSocket failed to open after timeout — giving up');
          try { this.ws.terminate(); } catch (e) {}
          this.wsActive = false;
        }
      };

      tryAuthorize();
    });

    this.ws.on('pong', () => {
      if (this._stopped) return;
      this.pongReceived = true;
      this.lastMeasurementAt = Date.now();
    });

    this.ws.on('message', (msg) => {
      if (this._stopped) return;

      const devId = this.device?.getData?.().id || 'unknown-device';

      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (err) {
        this.error('❌ Failed to parse WebSocket message:', err);
        return;
      }

      if (debug) this.log(`[WS][${devId}] TYPE=${data.type}`);

      if (data.type === 'authorized') {
        wsDebug.log('authorized', devId, 'WebSocket authorized');
        this.wsAuthorized = true;
        this.lastMeasurementAt = Date.now();
        this._subscribeTopics();
        this._startHeartbeatMonitor();
      }
      else if (data.type === 'measurement') {
        this.pendingMeasurement = data.data || {};
      }
      else if (data.type === 'system') {
        this.pendingSystem = data.data || {};
      }
      else if (data.type === 'batteries') {
        if (debug) {
          const d = data.data || {};
          this.log(
            `[WS][${devId}] BATTERY GROUP: mode=${d.mode}, ` +
            `target=${d.target_power_w}, permissions=${JSON.stringify(d.permissions)}`
          );
        }
        this.pendingBatteries = data.data || {};
      }
    });

    this.ws.on('error', (err) => {
      if (this._stopped) return;

      this.error(`❌ WebSocket error: ${err.code || ''} ${err.message || err}`);
      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('error', devId, `${err.code || ''} ${err.message || err}`);
      this.wsActive = false;
      this.wsAuthorized = false;
      this._scheduleReconnect();
    });

    this.ws.on('close', () => {
      if (this._stopped) return;

      this.log('🔌 WebSocket closed — retrying');
      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('close', devId, 'WebSocket closed');
      this.wsActive = false;
      this.wsAuthorized = false;
      this._scheduleReconnect();
    });
  }

  /**
   * Clean up WebSocket and all associated resources
   */
  async _cleanupWebSocket() {
    if (!this.ws) return;

    try {
      this.ws.removeAllListeners();

      if (this.ws._socket) {
        for (const [event, handler] of this._socketHandlers.entries()) {
          this.ws._socket.removeListener(event, handler);
        }
        this._socketHandlers.clear();
      }

      if (this.ws._receiver) {
        try {
          this.ws._receiver.removeAllListeners();
          this.ws._receiver.end();
        } catch (err) {
          // Ignore cleanup errors
        }
      }

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.ws.readyState !== WebSocket.CLOSED) {
        this.ws.terminate();
      }
    } catch (err) {
      this.error('❌ Error during WebSocket cleanup:', err);
    }

    this.ws = null;
    this.wsActive = false;
  }

  _scheduleReconnect() {
    if (this._stopped) {
      this.log('⚠️ WebSocket stopped - skipping reconnect');
      return;
    }

    const devId = this.device?.getData?.().id || 'unknown-device';

    if (this.reconnecting) {
      wsDebug.log('reconnect_suppressed', devId, 'Already reconnecting');
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ reconnect suppressed — still CONNECTING');
      wsDebug.log('reconnect_suppressed', devId, `State=${this.ws.readyState}`);
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    const delay = this.circuitBreaker.getBackoffDelay();

    this.log(`🔁 WS reconnect scheduled in ${Math.round(delay / 1000)}s (global failures: ${this.circuitBreaker.getFailureCount()})`);
    wsDebug.log('reconnect_scheduled', devId, `${Math.round(delay / 1000)}s`);

    this._safeSetTimeout(() => {
      if (this._stopped) {
        this.log('⚠️ Reconnect cancelled - WebSocket was stopped');
        this.reconnecting = false;
        return;
      }
      
      this.reconnecting = false;
      wsDebug.log('reconnect_execute', devId, 'Restarting WebSocket');
      this.restartWebSocket();
    }, delay);
  }

  async stop() {
    if (this._stopped) {
      this.log('⚠️ WebSocket already stopped');
      return;
    }

    this.log('🛑 Stopping WebSocket manager...');
    this._stopped = true;

    this._clearTimers();
    this.reconnecting = false;

    await this._cleanupWebSocket();

    this.wsAuthorized = false;
    this.reconnectAttempts = 0;

    this.pendingMeasurement = null;
    this.pendingSystem = null;
    this.pendingBatteries = null;

    this.log('✅ WebSocket manager stopped');
  }

  async resume() {
    if (!this._stopped) {
      this.log('⚠️ WebSocket not stopped - already running');
      return;
    }

    this.log('▶️ Resuming WebSocket manager...');
    this._stopped = false;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    
    await this.start();
  }

  _subscribeTopics() {
    if (this._stopped) return;

    ['system', 'measurement', 'batteries'].forEach((topic) => {
      this._safeSend({ type: 'subscribe', data: topic });
    });
    this.wsActive = true;
    this.setAvailable().catch(this.error);
  }

  _startHeartbeatMonitor() {
    this._safeSetInterval(() => {
      if (this._stopped) return;

      const now = Date.now();

      if (!this.wsAuthorized) return;

      if (this.ws?.readyState === WebSocket.OPEN &&
          now - this.lastMeasurementAt > 60000) {
        this._safeSend({ type: 'batteries' });
      }

      if (now - this.lastMeasurementAt > 180000) {
        this.log('💤 No measurement in 3min — reconnecting WebSocket');
        this.restartWebSocket();
      }
    }, 30000);
  }

  isConnected() {
    return !this._stopped && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  restartWebSocket() {
    if (this._stopped) return;

    const devId = this.device?.getData?.().id || 'unknown-device';

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WS is CONNECTING — skipping restart');
      wsDebug.log('restart_suppressed', devId, `State=${this.ws.readyState}`);
      return;
    }

    const now = Date.now();

    if (now - this._restartCooldown < 1000) {
      this.log('⏸️ Skipping restart — cooldown active');
      wsDebug.log('restart_cooldown', devId, `${now - this._restartCooldown}ms since last restart`);
      return;
    }

    this._restartCooldown = now;
    wsDebug.log('restart_execute', devId, 'Restarting WebSocket');

    this._clearTimers();
    this._resetWebSocket();
    this.start();
  }

  async _resetWebSocket() {
    if (!this.ws) return;

    const state = this.ws.readyState;

    if (state === WebSocket.CONNECTING || state === WebSocket.CLOSING) {
      this.log(`⏸️ WS is ${state === WebSocket.CONNECTING ? 'CONNECTING' : 'CLOSING'} — skipping reset`);
      return;
    }

    if (this.reconnecting) {
      this.log('⏸️ WS reset suppressed — reconnect in progress');
      return;
    }

    await this._cleanupWebSocket();
  }

  setBatteryMode(mode) {
    if (!this.isConnected()) {
      const errMsg = `❌ Cannot set battery mode to "${mode}" — WebSocket not connected`;
      this.error(errMsg);
      throw new Error(errMsg);
    }

    let payloadData;

    switch (mode) {
      case 'standby':
        payloadData = { mode: 'standby', permissions: [] };
        break;
      case 'zero':
        payloadData = { mode: 'zero', permissions: ['charge_allowed', 'discharge_allowed'] };
        break;
      case 'zero_charge_only':
        payloadData = { mode: 'zero', permissions: ['charge_allowed'] };
        break;
      case 'zero_discharge_only':
        payloadData = { mode: 'zero', permissions: ['discharge_allowed'] };
        break;
      case 'to_full':
        payloadData = { mode: 'to_full' };
        break;
      default:
        this.error(`❌ Unknown battery mode: "${mode}"`);
        throw new Error(`Unknown battery mode: "${mode}"`);
    }

    const payload = {
      type: 'batteries',
      data: { ...payloadData }
    };

    this.log(`🔋 WS → setBatteryMode("${mode}")`);

    try {
      this._safeSend(payload);
      this.log('✅ Battery mode command sent');
      this.device._handleBatteries(payload.data);
    } catch (err) {
      this.error(`❌ Failed to send battery mode command: ${err.message}`);
      throw err;
    }
  }

  requestBatteryStatus() {
    if (!this.isConnected()) {
      this.log('⚠️ Cannot request battery status — WebSocket not connected');
      return;
    }
    this.log('🔋 Requesting battery status via WebSocket');
    this._safeSend({ type: 'batteries' });
  }

  setCloud(enabled) {
    if (!this.isConnected()) throw new Error('WebSocket not connected');
    this._safeSend({ type: 'system', data: { cloud_enabled: enabled } });
  }
}

module.exports = WebSocketManager;