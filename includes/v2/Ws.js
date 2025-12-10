const https = require('https');
const WebSocket = require('ws');
const fetch = require('node-fetch');
//const fetch = require('../../includes/utils/fetchQueue');

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
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return await res.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
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
 *
 * Constructor expects callbacks and helpers from the device instance, keeping
 * the manager decoupled from Homey specifics:
 *  - url: base http(s) url of the device
 *  - token: bearer token for authorization
 *  - log, error: logging functions (e.g., device.log / device.error)
 *  - setAvailable: function to mark device available (returns promise)
 *  - getSetting: function to read device settings (if needed)
 *  - handleMeasurement, handleSystem, handleBatteries: callbacks to process incoming data
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
    
    // WebSocket instance and state flags
    this.ws = null;
    this.wsActive = false;
    this.reconnectAttempts = 0;
    this.lastMeasurementAt = Date.now();

    // Internal reconnect / restart guards

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
    let pendingMeasurement = null;
    // If an existing socket is in CONNECTING state, skip starting again

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
    // Allow URL to be obtained from settings if not provided initially

    const settingsUrl = this.getSetting('url');
    if (!this.url && settingsUrl) this.url = settingsUrl;
    if (!this.token || !this.url) {
      this.error('❌ Missing token or URL — cannot start WebSocket');
      return;
    }

    const agent = SHARED_AGENT;
    const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';

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
      this.lastMeasurementAt = Date.now();
      this.reconnectAttempts = 0; // reset backoff after successful connect
      this._startHeartbeatMonitor();
      this.log('🔌 WebSocket opened — waiting to authorize...');

      if (this.ws._socket) this.ws._socket.setKeepAlive(true, 30000);

      this.pongReceived = true;
      this.ws.on('pong', () => {
        this.pongReceived = true;
        this.lastMeasurementAt = Date.now();
      });

      this._safeSetInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (!this.pongReceived) {
          this.log('⚠️ No pong received — restarting WebSocket');
          this.restartWebSocket();
          return;
        }
        this.pongReceived = false;
        try { this.ws.ping(); } catch (e) { this.error('ping failed', e); }
      }, 30000);

      // ⬇️ Add this block for 2s measurement flush
      const updateInterval = this.getSetting('update_interval') || 2000;
      this._safeSetInterval(() => {
        if (pendingMeasurement) {
          this.lastMeasurementAt = Date.now();
          this._handleMeasurement?.(pendingMeasurement);
          pendingMeasurement = null;
        }
      }, updateInterval);
      // ⬆️

      const maxRetries = 30;
      let retries = 0;
      const tryAuthorize = () => {
        if (!this.ws) return;
        if (this.ws.readyState === this.ws.OPEN) {
          this.log('🔐 Sending WebSocket authorization');
          this._safeSend({ type: 'authorization', data: this.token });
        } else if (retries < maxRetries) {
          retries++;
          this._safeSetTimeout(tryAuthorize, 100);
        } else {
          this.error('❌ WebSocket failed to open after timeout — giving up');
          this.ws.terminate();
          this.wsActive = false;
        }
      };
      tryAuthorize();
    });


    this.ws.on('message', (msg) => {
      
      // ✅ RAW message log (exact bytes from device)
      //this.log(`📡 WS RAW: ${msg.toString()}`);

      let data;
      try { data = JSON.parse(msg.toString()); }
      catch (err) { this.error('❌ Failed to parse WebSocket message:', err); return; }

      if (data.type === 'authorized') this._subscribeTopics();
      else if (data.type === 'measurement') {
        pendingMeasurement = data.data;   // keep latest only
      } else if (data.type === 'system') this._handleSystem?.(data.data);
      else if (data.type === 'batteries') this._handleBatteries?.(data.data);
    });


    this.ws.on('error', (err) => {
      this.error(`❌ WebSocket error: ${err.code || ''} ${err.message || err}`);
      this.wsActive = false;
      this._scheduleReconnect();
    });

    this.ws.on('close', () => {
      this.log('🔌 WebSocket closed — retrying');
      this.wsActive = false;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.reconnecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log('⏸️ reconnect suppressed — socket is OPEN or CONNECTING');
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts++;
    const base = 5000 * this.reconnectAttempts;
    const delay = Math.min(base, 180000); // cap at 3 minutes
    const jitter = delay * (0.9 + Math.random() * 0.2);
    this.log(`🔁 WS reconnect scheduled in ${Math.round(jitter/1000)}s`);
    this._safeSetTimeout(() => {
      this.reconnecting = false;
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
    ['system', 'measurement', 'batteries'].forEach(topic => {
      this._safeSend({ type: 'subscribe', data: topic });
    });
    this.wsActive = true;
    this.setAvailable().catch(this.error);
  }

  _startHeartbeatMonitor() {
    this._safeSetInterval(() => {
      const now = Date.now();
      if (this.ws?.readyState === WebSocket.OPEN) {
        this._safeSend({ type: 'batteries' });
      }
      // Increase threshold from 60s → 180s
      if (now - this.lastMeasurementAt > 180000) {
        this.log('💤 No measurement in 3min — reconnecting WebSocket');
        this.restartWebSocket();
      }
    }, 30000); // still check every 30s
  }


  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  restartWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.log('⏸️ Socket is OPEN or still CONNECTING — skipping restart');
      return;
    }

    const now = Date.now();
    if (now - this._restartCooldown < 3000) {
      this.log('⏸️ Skipping restart — cooldown active');
      return;
    }

    this._restartCooldown = now;
    this._clearTimers();
    this._resetWebSocket();
    this.start();
  }

  _resetWebSocket() {
    if (!this.ws) return;
    const state = this.ws.readyState;
    if (state === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is still connecting — skipping termination');
      return;
    }
    try {
      if (state === WebSocket.OPEN) {
        this.log(`🔄 Terminating active WebSocket (state: ${state})`);
        this.ws.terminate();
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

    // Map Homey mode → API mode + permissions
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
      this.log(`✅ Battery mode command sent`);

      // ✅ Ensure Homey sees the mode change immediately
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
