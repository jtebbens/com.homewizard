const https = require('https');
const WebSocket = require('ws');

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


class WebSocketManager {
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

    this.ws = null;
    this.wsActive = false;
    this.reconnectAttempts = 0;
    this.lastMeasurementAt = Date.now();
  }


  async start() {

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is already connecting — skipping start');
      return;
    }

    this.reconnectAttempts = this.reconnectAttempts || 0;
    
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
    
      const settingsUrl = this.getSetting('url');
      if (!this.url && settingsUrl) {
        this.url = settingsUrl;
      }
    
      if (!this.token || !this.url) {
        this.error('❌ Missing token or URL — cannot start WebSocket');
        return;
      }
    
      const agent = new (require('https')).Agent({ rejectUnauthorized: false });
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
    
      try {
        //this.ws = new (require('ws'))(wsUrl, { agent });
        this.ws = new WebSocket(wsUrl, { agent });
      } catch (err) {
        this.error('❌ Failed to create WebSocket:', err);
        this.wsActive = false;
        return;
      }
    
      this.ws.on('open', () => {
        this.wsActive = true;
        this.lastMeasurementAt = Date.now();
        this.reconnectAttempts = 0;
        this._startHeartbeatMonitor();
        this.log('🔌 WebSocket opened — waiting to authorize...');
    
        if (this.ws._socket) {
          this.ws._socket.setKeepAlive(true, 30000);
        }
    
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
            this.log('⚠️ WebSocket not open yet — delaying subscription');
            const waitForOpen = setInterval(() => {
              if (this.ws && this.ws.readyState === this.ws.OPEN) {
                clearInterval(waitForOpen);
                this._subscribeTopics();
              }
            }, 100);
          }

        } else if (data.type === 'measurement') {
          this._handleMeasurement(data.data);
        } else if (data.type === 'system') {
          this._handleSystem(data.data);
        } else if (data.type === 'batteries') {
          this._handleBatteries(data.data);
        }
      });

    
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

    _subscribeTopics() {
      ['system', 'measurement', 'batteries'].forEach(topic => {
        this.ws.send(JSON.stringify({ type: 'subscribe', data: topic }));
      });
      this.wsActive = true;
      this.setAvailable().catch(this.error);
    }


    _startHeartbeatMonitor() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        const now = Date.now();

        // Skip if WebSocket is connecting or recently opened
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
          this.log(`⏸️ Heartbeat skipped — WebSocket state: ${this.ws.readyState}`);
          return;
        }

        if (now - this.lastMeasurementAt > 60000) {
          this.log('💤 No measurement in 60s — reconnecting WebSocket');
          this.restartWebSocket();
        }
      }, 30000);
    }

    isConnected() {
      return this.ws && this.ws.readyState === WebSocket.OPEN;
    }




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
