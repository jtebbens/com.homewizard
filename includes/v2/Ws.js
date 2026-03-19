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
const WebSocket = require('ws');
const fetch = require('../../includes/utils/fetchQueue');

const SHARED_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 11000,
  maxSockets: 4,
  maxFreeSockets: 2,
  rejectUnauthorized: false,
  timeout: 10000
});

/**
 * Perform a fetch with timeout. Passes the timeout to fetchQueue which
 * handles abort internally via its own AbortController.
 *
 * @param {string} url
 * @param {object} [options={}]
 * @param {number} [timeout=5000]
 * @returns {Promise<any>} Parsed JSON response
 */
async function fetchWithTimeout(url, options = {}, timeout = 5000) {
  const res = await fetch(url, { ...options, timeout });
  return await res.json();
}

/**
 * WebSocketManager
 *
 * Manages a resilient WebSocket connection to a HomeWizard device.
 * Responsibilities:
 *  - Open and authorize the WebSocket connection
 *  - Subscribe to topics: system, measurement, batteries
 *  - Reconnect with exponential backoff on errors/close
 *  - Monitor heartbeat to detect stalls and zombies
 *  - Throttle incoming data to prevent CPU overload
 *  - Expose start/stop/restart and helper checks
 *
 * Constructor expects callbacks and helpers from the device instance:
 *  - device: device reference (for optimistic setBatteryMode update)
 *  - url: base http(s) url of the device
 *  - token: bearer token for authorization
 *  - log, error: logging functions
 *  - setAvailable: mark device available
 *  - getSetting: read device settings
 *  - handleMeasurement, handleSystem, handleBatteries: data callbacks
 */
class WebSocketManager {
  constructor({ device, url, token, log, error, setAvailable, getSetting, handleMeasurement, handleSystem, handleBatteries, onJournalEvent, measurementThrottleMs }) {
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
    this._onJournalEvent = onJournalEvent || null;
    this._deviceId = device?.getData?.()?.id || 'unknown';

    // WebSocket instance and state
    this.ws = null;
    this.wsActive = false;
    this.reconnectAttempts = 0;
    this.lastMeasurementAt = Date.now();

    // Reconnect / restart guards
    this.reconnecting = false;
    this._restartCooldown = 0;
    this._stopped = false;

    this._timers = new Set();
    this.pongReceived = true;

    // Throttle: measurements arrive every ~1s, process at most every 2s
    // ✅ CPU FIX: configurable via constructor (plugin_battery uses 5s, energy_v2 uses 2s)
    this._lastMeasurementProcessedAt = 0;
    this._measurementThrottleMs = (typeof measurementThrottleMs === 'number' && measurementThrottleMs > 0)
      ? measurementThrottleMs
      : 2000;
    this._pendingMeasurement = null;
    this._pendingMeasurementTimer = null;

    // Throttle: system (wifi rssi etc.) — handler does capability writes
    this._lastSystemProcessedAt = 0;
    this._systemThrottleMs = 30000; // ✅ CPU FIX: raised from 10s to 30s — WiFi RSSI doesn't need 10s updates

    // Throttle: batteries — handler does capability writes + flow triggers
    // ✅ CPU FIX: raised from 5s to 30s — HomeWizard firmware pushes batteries
    // topic on EVERY measurement (1/s). Battery mode changes are rare; 30s is plenty.
    this._lastBatteriesProcessedAt = 0;
    this._batteriesThrottleMs = 30000;
    this._pendingBatteries = null;
    this._pendingBatteriesTimer = null;

    // Debug: verbose per-message logging (toggle via device setting 'ws_debug')
    this._debug = false;

    // Uptime & timing
    this._startedAt = Date.now();
    this._lastHandlerDurationMs = { measurement: 0, system: 0, batteries: 0 };
    this._maxHandlerDurationMs = { measurement: 0, system: 0, batteries: 0 };

    // Reconnect rate detection (ring buffer of last 20 reconnect timestamps)
    this._reconnectTimestamps = [];

    // Stats counters for getStats()
    this._stats = {
      messagesReceived: 0,
      measurementsProcessed: 0,
      measurementsDropped: 0,
      systemProcessed: 0,
      systemDropped: 0,
      batteriesProcessed: 0,
      batteriesDeferred: 0,
      reconnects: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      handlerErrors: 0,
    };
  }

  /**
   * Write a critical event to the persistent journal.
   * Called at key lifecycle points so events survive app kills.
   */
  _journal(type, message) {
    try { this._onJournalEvent?.(type, this._deviceId, message); }
    catch (e) { /* never let journal break the WS flow */ }
  }

  /**
   * Throttled journal: only write one event per type per 10 minutes.
   * Reduces noise for expected repeated events like preflight_fail.
   */
  _journalThrottled(type, message) {
    if (!this._journalThrottleMap) this._journalThrottleMap = {};
    const now = Date.now();
    const last = this._journalThrottleMap[type] || 0;
    if (now - last > 600000) {
      this._journal(type, message);
      this._journalThrottleMap[type] = now;
    }
  }

  /**
   * Persist current stats snapshot for post-crash diagnostics.
   * Called periodically from the 30s health-check timer.
   */
  _persistSnapshot() {
    try { this._onJournalEvent?.('snapshot', this._deviceId, this.getStats()); }
    catch (e) { /* ignore */ }
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
   * Start or restart the WebSocket connection.
   * Runs a preflight check to verify device reachability before connecting.
   */
  async start() {
    if (this._stopped) {
      this.log('⚠️ WebSocket is stopped — use resume() to restart');
      return;
    }

    // Skip if already connecting
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      this.log('⏸️ WebSocket is already connecting — skipping start');
      return;
    }

    // Clean up existing socket
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

    // Allow URL from settings if not provided at construction
    const settingsUrl = this.getSetting('url');
    if (!this.url && settingsUrl) this.url = settingsUrl;
    if (!this.token || !this.url) {
      this.error('❌ Missing token or URL — cannot start WebSocket');
      return;
    }

    // Preflight: verify device is reachable
    try {
      const res = await fetchWithTimeout(`${this.url}/api/system`, {
        headers: { Authorization: `Bearer ${this.token}` },
        agent: SHARED_AGENT
      }, 3000);
      if (!res || typeof res.cloud_enabled === 'undefined') {
        this.error(`❌ Device unreachable at ${this.url} — skipping WebSocket`);
        this._journalThrottled('preflight_fail', `Device unreachable at ${this.url}`);
        this._scheduleReconnect();
        return;
      }
    } catch (err) {
      this.error(`❌ Preflight check failed: ${err.message}`);
      this._journalThrottled('preflight_fail', err.message);
      this._scheduleReconnect();
      return;
    }

    const wsUrl = this.url.replace(/^http(s)?:\/\//, 'wss://') + '/api/ws';

    // Create standard WebSocket
    try {
      this.ws = new WebSocket(wsUrl, {
        agent: SHARED_AGENT,
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
        if (buffered > 512 * 1024) {
          this.log(`⚠️ Skipping send — buffered ${buffered}`);
          return false;
        }
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        this.error('❌ safeSend failed:', err);
        return false;
      }
    };

    // ──────────────────────── open ────────────────────────
    this.ws.on('open', () => {
      if (this._stopped) return;
      this.wsActive = true;
      this.lastMeasurementAt = Date.now();
      this.reconnectAttempts = 0;
      this._stats.lastConnectedAt = new Date().toISOString();
      this.log('🔌 WebSocket opened — authorizing...');
      this._journal('open', 'WebSocket opened');

      if (this.ws._socket) this.ws._socket.setKeepAlive(true, 30000);

      this.pongReceived = true;

      // Single 30s health-check: ping/pong + heartbeat + zombie detection
      this._safeSetInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const idle = now - this.lastMeasurementAt;

        // Periodically persist stats snapshot (every ~5 min = every 10th tick of 30s)
        if (!this._healthTick) this._healthTick = 0;
        this._healthTick++;
        if (this._healthTick % 10 === 0) this._persistSnapshot();

        // No pong reply AND no data for 60s → zombie
        if (!this.pongReceived && idle > 60000) {
          this.log('🧨 No pong & idle — force closing zombie WebSocket');
          this._journal('zombie', `No pong & idle ${Math.round(idle / 1000)}s — terminating`);
          try { this.ws.terminate(); } catch (e) {}
          this.ws = null;
          this.wsActive = false;
          this._scheduleReconnect();
          return;
        }

        // Request battery status if idle > 60s
        if (idle > 60000) {
          this._safeSend({ type: 'batteries' });
        }

        // No data for 3 minutes → force-close zombie (device may still respond to pings but stopped streaming)
        if (idle > 180000) {
          this.log(`💤 No measurement in 3min (${Math.round(idle / 1000)}s) — force closing zombie WebSocket`);
          this._journal('zombie', `Idle ${Math.round(idle / 1000)}s, no measurements — force restart`);
          try { this.ws.terminate(); } catch (e) {}
          this.ws = null;
          this.wsActive = false;
          this._scheduleReconnect();
          return;
        }

        this.pongReceived = false;
        try { this.ws.ping(); } catch (e) { this.error('ping failed', e); }
      }, 30000);

      // Authorize via message
      const maxRetries = 30;
      let retries = 0;
      const tryAuthorize = () => {
        if (this._stopped || !this.ws) return;
        if (this.ws.readyState === WebSocket.OPEN) {
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

    // ──────────────────────── pong ────────────────────────
    this.ws.on('pong', () => {
      this.pongReceived = true;
      // Do NOT update lastMeasurementAt here — only actual measurement data should reset the idle timer.
      // Updating on pong would mask a zombie: device alive at TCP level but stopped streaming data.
    });

    // ──────────────────────── message ────────────────────────
    this.ws.on('message', (msg) => {
      if (this._stopped) return;

      let data;
      try { data = JSON.parse(msg.toString()); }
      catch (err) { this.error('❌ Failed to parse WS message:', err); return; }

      this._stats.messagesReceived++;
      if (this._debug) this.log(`[WS-DBG] type=${data.type}`);

      if (data.type === 'authorized') {
        this.log('✅ WebSocket authorized');
        this._journal('authorized', 'WebSocket authorized — subscribing');
        this.lastMeasurementAt = Date.now();
        this._subscribeTopics();
      }
      else if (data.type === 'measurement') {
        this._onMeasurement(data.data || {});
      }
      else if (data.type === 'system') {
        this._onSystem(data.data || {});
      }
      else if (data.type === 'batteries') {
        this._onBatteries(data.data || {});
      }
    });

    // ──────────────────────── error ────────────────────────
    this.ws.on('error', (err) => {
      if (this._stopped) return;
      this.error(`❌ WebSocket error: ${err.code || ''} ${err.message || err}`);
      this._journal('error', `${err.code || ''} ${err.message || err}`);
      this.wsActive = false;
      this._stats.lastDisconnectedAt = new Date().toISOString();
      this._scheduleReconnect();
    });

    // ──────────────────────── close ────────────────────────
    this.ws.on('close', () => {
      if (this._stopped) return;
      this.log('🔌 WebSocket closed — retrying');
      this._journal('close', 'WebSocket closed');
      this.wsActive = false;
      this._stats.lastDisconnectedAt = new Date().toISOString();
      this._scheduleReconnect();
    });
  }

  // ──────────── Throttled message handlers ────────────

  /**
   * Measurement: process immediately if throttle window passed,
   * otherwise store latest and schedule a deferred flush.
   */
  _onMeasurement(payload) {
    const now = Date.now();
    if (now - this._lastMeasurementProcessedAt >= this._measurementThrottleMs) {
      this._lastMeasurementProcessedAt = now;
      this.lastMeasurementAt = now;
      this._stats.measurementsProcessed++;
      const t0 = Date.now();
      try { this._handleMeasurement?.(payload); }
      catch (e) { this.error('❌ Measurement handler error:', e); this._stats.handlerErrors++; }
      this._trackHandlerTime('measurement', Date.now() - t0);
    } else {
      this._stats.measurementsDropped++;
      this._pendingMeasurement = payload;
      if (!this._pendingMeasurementTimer) {
        const remaining = this._measurementThrottleMs - (now - this._lastMeasurementProcessedAt);
        this._pendingMeasurementTimer = this._safeSetTimeout(() => {
          this._pendingMeasurementTimer = null;
          if (this._stopped || !this._pendingMeasurement) return;
          const pending = this._pendingMeasurement;
          this._pendingMeasurement = null;
          this._lastMeasurementProcessedAt = Date.now();
          this.lastMeasurementAt = Date.now();
          const t0 = Date.now();
          try { this._handleMeasurement?.(pending); }
          catch (e) { this.error('❌ Deferred measurement error:', e); this._stats.handlerErrors++; }
          this._trackHandlerTime('measurement', Date.now() - t0);
        }, remaining);
      }
    }
  }

  /**
   * System: process if throttle window passed, drop intermediate.
   * Only carries wifi rssi — not critical to flush.
   */
  _onSystem(payload) {
    const now = Date.now();
    if (now - this._lastSystemProcessedAt >= this._systemThrottleMs) {
      this._lastSystemProcessedAt = now;
      this._stats.systemProcessed++;
      if (this._debug) this.log(`[WS-DBG] system processed`);
      const t0 = Date.now();
      try { this._handleSystem?.(payload); }
      catch (e) { this.error('❌ System handler error:', e); this._stats.handlerErrors++; }
      this._trackHandlerTime('system', Date.now() - t0);
    } else {
      this._stats.systemDropped++;
    }
  }

  /**
   * Batteries: process if throttle window passed, otherwise store
   * latest and schedule a deferred flush so mode changes are not lost.
   */
  _onBatteries(payload) {
    const now = Date.now();
    this._pendingBatteries = payload;
    if (now - this._lastBatteriesProcessedAt >= this._batteriesThrottleMs) {
      this._lastBatteriesProcessedAt = now;
      const bat = this._pendingBatteries;
      this._pendingBatteries = null;
      if (this._pendingBatteriesTimer) {
        clearTimeout(this._pendingBatteriesTimer);
        this._pendingBatteriesTimer = null;
      }
      this._stats.batteriesProcessed++;
      if (this._debug) this.log(`[WS-DBG] batteries processed: mode=${bat?.mode}`);
      const t0b = Date.now();
      try { this._handleBatteries?.(bat); }
      catch (e) { this.error('❌ Batteries handler error:', e); this._stats.handlerErrors++; }
      this._trackHandlerTime('batteries', Date.now() - t0b);
    } else if (!this._pendingBatteriesTimer) {
      this._stats.batteriesDeferred++;
      const remaining = this._batteriesThrottleMs - (now - this._lastBatteriesProcessedAt);
      this._pendingBatteriesTimer = this._safeSetTimeout(() => {
        this._pendingBatteriesTimer = null;
        if (this._stopped || !this._pendingBatteries) return;
        const bat = this._pendingBatteries;
        this._pendingBatteries = null;
        this._lastBatteriesProcessedAt = Date.now();
        const t0d = Date.now();
        try { this._handleBatteries?.(bat); }
        catch (e) { this.error('❌ Deferred batteries error:', e); this._stats.handlerErrors++; }
        this._trackHandlerTime('batteries', Date.now() - t0d);
      }, remaining);
    }
  }

  // ──────────── Reconnect / lifecycle ────────────

  _scheduleReconnect() {
    if (this._stopped || this.reconnecting) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log('⏸️ Reconnect suppressed — socket OPEN or CONNECTING');
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempts++;
    this._stats.reconnects++;
    this._reconnectTimestamps.push(Date.now());
    if (this._reconnectTimestamps.length > 20) this._reconnectTimestamps.shift();
    const base = 5000 * this.reconnectAttempts;
    const delay = Math.min(base, 180000); // cap at 3 minutes
    const jitter = delay * (0.9 + Math.random() * 0.2);
    this.log(`🔁 WS reconnect in ${Math.round(jitter / 1000)}s`);
    this._journal('reconnect', `Attempt #${this.reconnectAttempts} in ${Math.round(jitter / 1000)}s`);
    this._persistSnapshot(); // snapshot before potential crash
    this._safeSetTimeout(() => {
      this.reconnecting = false;
      if (this._stopped) return;
      this.restartWebSocket();
    }, jitter);
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    this.reconnecting = false;
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
    this._pendingMeasurement = null;
    this._pendingBatteries = null;
    this._pendingMeasurementTimer = null;
    this._pendingBatteriesTimer = null;
  }

  async resume() {
    if (!this._stopped) return;
    this._stopped = false;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    await this.start();
  }

  _subscribeTopics() {
    ['system', 'measurement', 'batteries'].forEach(topic => {
      this._safeSend({ type: 'subscribe', data: topic });
    });
    this.wsActive = true;
    this.setAvailable().catch(this.error);
  }

  _startHeartbeatMonitor() {
    // Merged into single 30s health-check in start() — kept for API compat
  }

  isConnected() {
    return !this._stopped && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Return a snapshot of internal state for diagnostics.
   * Call from device code: this.wsManager.getStats()
   */
  getStats() {
    const now = Date.now();
    return {
      connected: this.isConnected(),
      wsActive: this.wsActive,
      stopped: this._stopped,
      reconnecting: this.reconnecting,
      reconnectAttempts: this.reconnectAttempts,
      idleMs: now - this.lastMeasurementAt,
      timersActive: this._timers.size,
      throttle: {
        measurement: {
          lastProcessedAgo: now - this._lastMeasurementProcessedAt,
          pending: !!this._pendingMeasurement,
          timerActive: !!this._pendingMeasurementTimer,
        },
        system: {
          lastProcessedAgo: now - this._lastSystemProcessedAt,
        },
        batteries: {
          lastProcessedAgo: now - this._lastBatteriesProcessedAt,
          pending: !!this._pendingBatteries,
          timerActive: !!this._pendingBatteriesTimer,
        },
      },
      counters: { ...this._stats },
      uptimeMs: now - this._startedAt,
      handlerTiming: {
        last: { ...this._lastHandlerDurationMs },
        max: { ...this._maxHandlerDurationMs },
      },
      reconnectRate: this._getReconnectRate(),
    };
  }

  /**
   * Track how long a handler callback took.
   * If a handler exceeds 250ms that's a CPU warning sign.
   */
  _trackHandlerTime(name, ms) {
    this._lastHandlerDurationMs[name] = ms;
    if (ms > this._maxHandlerDurationMs[name]) {
      this._maxHandlerDurationMs[name] = ms;
    }
    // Log slow handlers (> 250ms) — these are CPU hogs
    // Throttle: only journal once per handler per 5 min to reduce noise
    if (ms > 250) {
      this.log(`⚠️ Slow ${name} handler: ${ms}ms`);
      if (!this._slowHandlerThrottle) this._slowHandlerThrottle = {};
      const now = Date.now();
      const lastLogged = this._slowHandlerThrottle[name] || 0;
      if (now - lastLogged > 300000) {
        this._journal('slow_handler', `${name} took ${ms}ms`);
        this._slowHandlerThrottle[name] = now;
      }
    }
  }

  /**
   * Calculate reconnect rate from recent timestamps.
   * Returns { count, windowMs, perMinute } or null if no reconnects.
   */
  _getReconnectRate() {
    if (this._reconnectTimestamps.length < 2) return null;
    const first = this._reconnectTimestamps[0];
    const last = this._reconnectTimestamps[this._reconnectTimestamps.length - 1];
    const windowMs = last - first;
    if (windowMs <= 0) return null;
    const count = this._reconnectTimestamps.length;
    return {
      count,
      windowMs,
      perMinute: Math.round((count / (windowMs / 60000)) * 10) / 10,
    };
  }

  /**
   * Generate a plain-text diagnostic report that users can copy-paste
   * and share. Designed for post-crash analysis.
   */
  getDiagnosticReport() {
    const stats = this.getStats();
    const now = new Date();
    const uptime = Math.round(stats.uptimeMs / 1000);
    const uptimeStr = uptime > 3600
      ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
      : `${Math.floor(uptime / 60)}m ${uptime % 60}s`;

    const lines = [];
    lines.push(`═══ WebSocket Diagnostic Report ═══`);
    lines.push(`Generated: ${now.toISOString()}`);
    lines.push(`Device: ${this._deviceId}`);
    lines.push(`URL: ${this.url || 'none'}`);
    lines.push(`Uptime: ${uptimeStr}`);
    lines.push(``);
    lines.push(`── Connection ──`);
    lines.push(`Connected: ${stats.connected}`);
    lines.push(`WS Active: ${stats.wsActive}`);
    lines.push(`Stopped: ${stats.stopped}`);
    lines.push(`Reconnecting: ${stats.reconnecting}`);
    lines.push(`Reconnect attempts: ${stats.reconnectAttempts}`);
    lines.push(`Idle: ${Math.round(stats.idleMs / 1000)}s`);
    lines.push(`Active timers: ${stats.timersActive}`);
    lines.push(``);
    lines.push(`── Counters ──`);
    const c = stats.counters;
    lines.push(`Messages received: ${c.messagesReceived}`);
    lines.push(`Measurements: ${c.measurementsProcessed} processed, ${c.measurementsDropped} throttled`);
    lines.push(`System: ${c.systemProcessed} processed, ${c.systemDropped} throttled`);
    lines.push(`Batteries: ${c.batteriesProcessed} processed, ${c.batteriesDeferred} deferred`);
    lines.push(`Reconnects: ${c.reconnects}`);
    lines.push(`Handler errors: ${c.handlerErrors}`);
    lines.push(`Last connected: ${c.lastConnectedAt || 'never'}`);
    lines.push(`Last disconnected: ${c.lastDisconnectedAt || 'never'}`);
    lines.push(``);
    lines.push(`── Handler Timing (ms) ──`);
    lines.push(`Last: meas=${stats.handlerTiming.last.measurement} sys=${stats.handlerTiming.last.system} bat=${stats.handlerTiming.last.batteries}`);
    lines.push(`Max:  meas=${stats.handlerTiming.max.measurement} sys=${stats.handlerTiming.max.system} bat=${stats.handlerTiming.max.batteries}`);

    // Anomaly detection
    const anomalies = [];
    if (stats.handlerTiming.max.measurement > 100) anomalies.push(`🔴 Measurement handler slow (max ${stats.handlerTiming.max.measurement}ms)`);
    if (stats.handlerTiming.max.system > 100) anomalies.push(`🔴 System handler slow (max ${stats.handlerTiming.max.system}ms)`);
    if (stats.handlerTiming.max.batteries > 100) anomalies.push(`🔴 Batteries handler slow (max ${stats.handlerTiming.max.batteries}ms)`);
    if (c.handlerErrors > 0) anomalies.push(`🟡 ${c.handlerErrors} handler errors occurred`);

    const rate = stats.reconnectRate;
    if (rate && rate.perMinute > 2) anomalies.push(`🔴 Rapid reconnects: ${rate.perMinute}/min (${rate.count} in ${Math.round(rate.windowMs / 1000)}s)`);
    else if (rate && rate.perMinute > 0.5) anomalies.push(`🟡 Elevated reconnects: ${rate.perMinute}/min`);

    if (c.reconnects > 10 && uptime < 600) anomalies.push(`🔴 ${c.reconnects} reconnects in ${uptimeStr} — reconnect storm`);
    if (stats.idleMs > 180000 && stats.connected) anomalies.push(`🟡 Connected but idle for ${Math.round(stats.idleMs / 1000)}s — stale connection?`);

    const msgRate = uptime > 0 ? (c.messagesReceived / uptime) : 0;
    if (msgRate > 5) anomalies.push(`🟡 High message rate: ${msgRate.toFixed(1)}/s`);

    if (anomalies.length > 0) {
      lines.push(``);
      lines.push(`── ⚠ Anomalies Detected ──`);
      anomalies.forEach(a => lines.push(a));
    } else {
      lines.push(``);
      lines.push(`── ✅ No anomalies detected ──`);
    }

    lines.push(``);
    lines.push(`── Throttle ──`);
    lines.push(`Measurement: last ${Math.round(stats.throttle.measurement.lastProcessedAgo / 1000)}s ago, pending=${stats.throttle.measurement.pending}`);
    lines.push(`System: last ${Math.round(stats.throttle.system.lastProcessedAgo / 1000)}s ago`);
    lines.push(`Batteries: last ${Math.round(stats.throttle.batteries.lastProcessedAgo / 1000)}s ago, pending=${stats.throttle.batteries.pending}`);

    return lines.join('\n');
  }

  /**
   * Enable or disable verbose debug logging at runtime.
   */
  setDebug(enabled) {
    this._debug = !!enabled;
    this.log(`🔧 WS debug ${this._debug ? 'ON' : 'OFF'}`);
  }

  restartWebSocket() {
    if (this._stopped) return;
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.log('⏸️ Socket is OPEN or CONNECTING — skipping restart');
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
        this.log('🔄 Terminating active WebSocket');
        this.ws.terminate();
      } else {
        this.log('🔄 Closing inactive WebSocket');
        this.ws.close();
      }
    } catch (err) {
      this.error('❌ Failed to reset WebSocket:', err);
    }
    this.ws = null;
    this.wsActive = false;
  }

  // ──────────── Battery control ────────────

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

    const payload = { type: 'batteries', data: { ...payloadData } };
    this.log(`🔋 WS → setBatteryMode("${mode}")`);
    this._journal('mode_change', `setBatteryMode("${mode}")`);

    try {
      this._safeSend(payload);
      this.log('✅ Battery mode command sent');
      // ✅ CPU FIX: Optimistic update via setImmediate to avoid blocking the send path.
      // Previously called _handleBatteries synchronously which triggered capability
      // writes + setSettings() in the same tick as the WS send.
      setImmediate(() => {
        if (!this._stopped) {
          this.device?._handleBatteries?.(payload.data);
        }
      });
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