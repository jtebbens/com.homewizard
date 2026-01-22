'use strict';

const https = require('https');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const wsDebug = require('./wsDebug');
// const fetch = require('../../includes/utils/fetchQueue');
const debug = false;

const SHARED_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000,
  maxSockets: 4,
  maxFreeSockets: 2,
  rejectUnauthorized: false,
  timeout: 10000
});

/**
 * Perform a fetch with a timeout using AbortController.
 *
 * @param {string} url - The URL to fetch.
 * @param {object} [options={}] - Fetch options (headers, agent, etc.).
 * @param {number} [timeout=5000] - Timeout in milliseconds.
 * @returns {Promise<any>} - Parsed JSON response.
 * @throws Will throw if the request times out or fetch fails.
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
 *
 * Manages a resilient WebSocket connection to a HomeWizard device.
 * Responsibilities:
 *  - Open and authorize the WebSocket connection
 *  - Subscribe to topics: system, measurement, batteries
 *  - Reconnect with backoff on errors/close
 *  - Monitor heartbeat (last incoming measurement) to detect stalls
 *  - Expose start/stop/restart and helper checks
 */
class WebSocketManager {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} opts.token
   * @param {function} opts.log
   * @param {function} opts.error
   * @param {function} opts.setAvailable
   * @param {function} opts.getSetting
   * @param {function} opts.handleMeasurement
   * @param {function} opts.handleSystem
   * @param {function} opts.handleBatteries
   */
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

    this._eventsThisSecond = 0;
    this._lastSecond = Math.floor(Date.now() / 1000);

    this.ws = null;
    this.wsActive = false;
    this.wsAuthorized = false;
    this.reconnectAttempts = 0;
    this.lastMeasurementAt = Date.now();

    this.reconnecting = false;
    this._restartCooldown = 0;

    this._timers = new Set();
    this.pongReceived = true;
  }

  _safeSetTimeout(fn, ms) {
    const id = setTimeout(() => {
      this._timers.delete(id);
      fn();
    }, ms);
    this._timers.add(id);
    return id;
  }

  _safeSetInterval(fn, ms) {
    const id = setInterval(fn, ms);
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
   * Start or restart the WebSocket connection.
   * Performs a small preflight check to ensure the device is reachable
   * and expects the system response structure before opening the WS.
   */
  async start() {
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is already connecting — skipping start');
      return;
    }

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.terminate();
        else this.ws.close();
      } catch (err) {
        this.error('❌ Failed to clean up WebSocket:', err);
      }
      this.ws = null;
      this.wsActive = false;
    }

    const settingsUrl = this.getSetting('url');
    if (!this.url && settingsUrl) this.url = settingsUrl;
    if (!this.token || !this.url) {
      this.error('❌ Missing token or URL — cannot start WebSocket');
      return;
    }

    const agent = SHARED_AGENT;
    const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';

    // Preflight met harde timeout
    try {
      const res = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent
      }, 3000);

      if (!res || typeof res.cloud_enabled === 'undefined') {
        this.error(`❌ Device unreachable at ${this.url} — skipping WebSocket`);
        return;
      }
    } catch (err) {
      this.error(`❌ Preflight check failed: ${err.message}`);
      return;
    }

    // Create WebSocket instance
    try {
      this.ws = new WebSocket(wsUrl, {
        agent,
        perMessageDeflate: false,
        maxPayload: 512 * 1024,
        handshakeTimeout: 5000
      });
    } catch (err) {
      this.error('❌ Failed to create WebSocket:', err);
      this.wsActive = false;
      return;
    }

    // Remove any previously registered event listeners to prevent duplicates on reconnect
    this.ws.removeAllListeners('open');
    this.ws.removeAllListeners('message');
    this.ws.removeAllListeners('error');
    this.ws.removeAllListeners('close');
    this.ws.removeAllListeners('pong');

    this._safeSend = (obj) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      try {
        const buffered = this.ws._socket?.bufferSize || this.ws.bufferedAmount || 0;
        const MAX_BUFFERED = 512 * 1024;
        if (buffered > MAX_BUFFERED) {
          this.log(`⚠️ Skipping send - buffered ${buffered} > ${MAX_BUFFERED}`);
          return false;
        }
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        this.error('❌ safeSend failed:', err);
        return false;
      }
    };

    // WS open handler: authorize and setup heartbeat monitor
    this.ws.on('open', () => {
      this.wsActive = true;
      this.wsAuthorized = false;
      this.reconnectAttempts = 0;

      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('open', devId, 'WebSocket opened');

      if (this.ws._socket) this.ws._socket.setKeepAlive(true, 30000);

      this.pongReceived = true;
      this.ws.on('pong', () => {
        this.pongReceived = true;
        this.lastMeasurementAt = Date.now();
      });

      // Heartbeat + zombie‑detectie — minder agressief
      this._safeSetInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const idleFor = now - this.lastMeasurementAt;

        if (!this.pongReceived && idleFor > 60000) {
          this.log(`🧨 No pong & idle ${idleFor}ms — force closing zombie WebSocket`);

          try { this.ws.terminate(); } catch (e) {}
          try { this.ws.close(); } catch (e) {}

          this.ws = null;
          this.wsActive = false;
          this.wsAuthorized = false;

          this._scheduleReconnect();
          return;
        }

        this.pongReceived = false;
        try { this.ws.ping(); } catch (e) { this.error('ping failed', e); }
      }, 30000);

      // Measurement flush (2s)
      const updateInterval = this.getSetting('update_interval') || 2000;
      this._safeSetInterval(() => {
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

      // Buffered system + batteries flush (10s)
      this._safeSetInterval(() => {
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

    this.ws.on('message', (msg) => {
      const devId = this.device?.getData?.().id || 'unknown-device';
      this._eventsThisSecond++;

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
        const d = data.data || {};
        if (debug) this.log(`[WS][${devId}] MEAS: ${JSON.stringify(d)}`);
        this.pendingMeasurement = d;
      }

      else if (data.type === 'system') {
        this.pendingSystem = data.data || {};
      }

      else if (data.type === 'batteries') {
        const d = data.data || {};
        if (debug) {
          this.log(
            `[WS][${devId}] BATTERY GROUP: mode=${d.mode}, ` +
            `target=${d.target_power_w}, permissions=${JSON.stringify(d.permissions)}`
          );
        }
        this.pendingBatteries = d;
      }

      else {
        if (debug) this.log(`[WS][${devId}] UNKNOWN TYPE: ${data.type}`);
      }
    });

    // Error handler
    this.ws.on('error', (err) => {
      this.error(`❌ WebSocket error: ${err.code || ''} ${err.message || err}`);
      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('error', devId, `${err.code || ''} ${err.message || err}`);
      this.wsActive = false;
      this.wsAuthorized = false;
      this._scheduleReconnect();
    });

    this.ws.on('close', () => {
      this.log('🔌 WebSocket closed — retrying');
      const devId = this.device?.getData?.().id || 'unknown-device';
      wsDebug.log('close', devId, 'WebSocket closed');
      this.wsActive = false;
      this.wsAuthorized = false;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
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

    const base = 5000 * this.reconnectAttempts;
    const delay = Math.min(base, 180000);
    const jitter = delay * (0.9 + Math.random() * 0.2);

    this.log(`🔁 WS reconnect scheduled in ${Math.round(jitter / 1000)}s`);
    wsDebug.log('reconnect_scheduled', devId, `${Math.round(jitter / 1000)}s`);

    this._safeSetTimeout(() => {
      this.reconnecting = false;
      wsDebug.log('reconnect_execute', devId, 'Restarting WebSocket');
      this.restartWebSocket();
    }, jitter);
  }

  stop() {
    this._clearTimers();
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
        else this.ws.terminate();
      } catch (err) {
        this.error('❌ Error closing WebSocket:', err);
      }
      this.ws = null;
      this.wsActive = false;
    }
  }

  _subscribeTopics() {
    ['system', 'measurement', 'batteries'].forEach((topic) => {
      this._safeSend({ type: 'subscribe', data: topic });
    });
    this.wsActive = true;
    this.setAvailable().catch(this.error);
  }

  _startHeartbeatMonitor() {
    this._safeSetInterval(() => {
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
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  restartWebSocket() {
    const devId = this.device?.getData?.().id || 'unknown-device';

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WS is CONNECTING — skipping restart');
      wsDebug.log('restart_suppressed', devId, `State=${this.ws.readyState}`);
      return;
    }

    const now = Date.now();

    // Iets mildere cooldown, maar nog steeds bescherming
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

  _resetWebSocket() {
    if (!this.ws) return;

    const state = this.ws.readyState;

    if (state === WebSocket.CONNECTING) {
      this.log('⏸️ WS is CONNECTING — skipping reset');
      return;
    }

    if (state === WebSocket.CLOSING) {
      this.log('⏸️ WS is CLOSING — skipping reset');
      return;
    }

    if (this.reconnecting) {
      this.log('⏸️ WS reset suppressed — reconnect in progress');
      return;
    }

    try {
      if (state === WebSocket.OPEN) {
        this.log(`🔄 Terminating active WebSocket (state: ${state})`);
        this.ws.terminate();
      } else if (state === WebSocket.CLOSED) {
        this.log('🔄 WS already CLOSED — skipping close');
      } else {
        this.log(`🔄 Closing inactive WebSocket (state: ${state})`);
        this.ws.close();
      }
    } catch (err) {
      this.error('❌ Failed to reset WebSocket:', err);
    }

    this.ws = null;
    this.wsActive = false;
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
      data: {
        ...payloadData
      }
    };

    this.log(`🔋 WS → setBatteryMode("${mode}")`);
    this.log(`   Payload: ${JSON.stringify(payload)}`);

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
