const https = require('https');
const WebSocket = require('ws');

let fetch;
try {
  fetch = global.fetch || require('node-fetch');
} catch (e) {
  console.error('Fetch is not available. Please install node-fetch.');
}

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
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
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
  constructor({ url, token, log, error, setAvailable, getSetting, handleMeasurement, handleSystem, handleBatteries }) {
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
    this.heartbeatTimer = null;
  }


  /**
   * Start or restart the WebSocket connection.
   * Performs a small preflight check to ensure the device is reachable
   * and expects the system response structure before opening the WS.
   */
  async start() {

    // If an existing socket is in CONNECTING state, skip starting again
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is already connecting — skipping start');
      return;
    }

    this.reconnectAttempts = this.reconnectAttempts || 0;
    
    // Clean up existing websocket if present
    if (this.ws) {
      try {
        switch (this.ws.readyState) {
          case this.ws.OPEN:
            this.ws.terminate();
            break;
          case this.ws.CONNECTING:
            this.log('⚠️ WebSocket still connecting — skipping termination');
            return;
          case this.ws.CLOSING:
          case this.ws.CLOSED:
            this.ws.close();
            break;
        }
      } catch (err) {
        this.error('❌ Failed to clean up WebSocket:', err);
      }

      this.ws = null;
      this.wsActive = false;
    }

    // Allow URL to be obtained from settings if not provided initially
    const settingsUrl = this.getSetting('url');
    if (!this.url && settingsUrl) {
      this.url = settingsUrl;
    }

    if (!this.token || !this.url) {
      this.error('❌ Missing token or URL — cannot start WebSocket');
      return;
    }

    // For legacy devices we may skip TLS verification; agent is used for fetch and ws
    const agent = new (require('https')).Agent({ rejectUnauthorized: false });
    const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';

    // Preflight: ensure device responds to /api/system and has expected fields
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
      this.ws = new WebSocket(wsUrl, { agent });
    } catch (err) {
      this.error('❌ Failed to create WebSocket:', err);
      this.wsActive = false;
      return;
    }

    // WS open handler: authorize and setup heartbeat monitor
    this.ws.on('open', () => {
      this.wsActive = true;
      this.lastMeasurementAt = Date.now();
      this.reconnectAttempts = 0;
      this._startHeartbeatMonitor();
      this.log('🔌 WebSocket opened — waiting to authorize...');

      // Ensure socket keep-alive is enabled
      if (this.ws._socket) {
        this.ws._socket.setKeepAlive(true, 30000);
      }

      // Authorize: retry a short number of times while waiting for OPEN state
      const maxRetries = 30;
      let retries = 0;
      let retryTimer;

      const tryAuthorize = () => {
        if (!this.ws) return;

        if (this.ws.readyState === this.ws.OPEN) {
          this.log('🔐 Sending WebSocket authorization');
          this.ws.send(JSON.stringify({ type: 'authorization', data: this.token }));
          clearTimeout(retryTimer);
        } else if (retries < maxRetries) {
          retries++;
          retryTimer = setTimeout(tryAuthorize, 100);
        } else {
          this.error('❌ WebSocket failed to open after timeout — giving up');
          this.ws.terminate();
          this.wsActive = false;
        }
      };

      tryAuthorize();
    });

    // WS message handler: parse and dispatch to appropriate handlers
    this.ws.on('message', (msg) => {
      let data;
      try {
        data = JSON.parse(msg.toString());
      } catch (err) {
        this.error('❌ Failed to parse WebSocket message:', err);
        return;
      }

      if (data.type === 'authorized') {
        if (this.ws.readyState === this.ws.OPEN) {
          this._subscribeTopics();
        } else {
          // If not open yet, poll until open and subscribe
          this.log('⚠️ WebSocket not open yet — delaying subscription');
          const waitForOpen = setInterval(() => {
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
              clearInterval(waitForOpen);
              this._subscribeTopics();
            }
          }, 100);
        }

      } else if (data.type === 'measurement') {
        // Update lastMeasurementAt and hand over payload to device handler
        this.lastMeasurementAt = Date.now();
        this._handleMeasurement(data.data);
      } else if (data.type === 'system') {
        this._handleSystem(data.data);
      } else if (data.type === 'batteries') {
        this._handleBatteries(data.data);
      }
    });

    // Reconnect logic with exponential-ish backoff, capped to 30s
    const reconnect = () => {
      if (this.reconnecting) return;
      this.reconnecting = true;

      this.reconnectAttempts++;
      const delay = Math.min(30000, 5000 * this.reconnectAttempts);

      setTimeout(() => {
        this.reconnecting = false;
        this.restartWebSocket();
      }, delay);
    };

    // Error and close handlers trigger reconnect attempts
    this.ws.on('error', (err) => {
      this.error(`❌ WebSocket error: ${err.code || ''} ${err.message || err}`);
      this.wsActive = false;
      reconnect();
    });

    this.ws.on('close', () => {
      this.log('🔌 WebSocket closed — retrying');
      this.wsActive = false;
      reconnect();
    });
  }

  /**
   * Stop the WebSocket manager: clear timers and terminate the socket.
   * Safe to call multiple times.
   */
  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (err) {
        this.error('❌ Error during WebSocket termination:', err);
      }
      this.ws = null;
      this.wsActive = false;
    }
  }

  /**
   * Subscribe to the desired topics on the WS after authorization.
   * Marks the device as available once subscriptions are sent.
   * @private
   */
  _subscribeTopics() {
    ['system', 'measurement', 'batteries'].forEach(topic => {
      this.ws.send(JSON.stringify({ type: 'subscribe', data: topic }));
    });
    this.wsActive = true;
    this.setAvailable().catch(this.error);
  }


  /**
   * Start a heartbeat monitor that checks if measurements arrive frequently.
   * If no measurement arrives within threshold, restart the connection.
   * @private
   */
  _startHeartbeatMonitor() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      // If connecting/open, skip restart checks; lastMeasurementAt will be updated on messages
      if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
        //this.log(`⏸️ Heartbeat skipped — WebSocket state: ${this.ws.readyState}`);
        return;
      }

      // If no measurement for more than 60s, attempt restart
      if (now - this.lastMeasurementAt > 60000) {
        this.log('💤 No measurement in 60s — reconnecting WebSocket');
        this.restartWebSocket();
      }
    }, 30000);
  }

  /**
   * Returns true if the WebSocket is currently open.
   * @returns {boolean}
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }




  /**
   * Restart the WebSocket connection while preventing rapid repeated restarts.
   */
  restartWebSocket() {
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ Already connecting — skipping restart');
      return;
    }

    this._restartCooldown = this._restartCooldown || 0;
    const now = Date.now();
    if (now - this._restartCooldown < 3000) {
      this.log('⏸️ Skipping restart — cooldown active');
      return;
    }

    this._restartCooldown = now;
    this._resetWebSocket();
    this.start();
  }


  /**
   * Reset/close/terminate the underlying WebSocket instance safely.
   * Leaves manager in a clean state ready for start().
   * @private
   */
  _resetWebSocket() {
    if (!this.ws) return;

    const state = this.ws.readyState;

    if (state === WebSocket.CONNECTING) {
      this.log(`⏸️ WebSocket is still connecting — skipping termination`);
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

}

module.exports = WebSocketManager;
