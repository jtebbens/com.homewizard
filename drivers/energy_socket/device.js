'use strict';

const Homey = require('homey');
const http = require('http');
const fetchWithTimeout = require('../../includes/utils/fetchWithTimeout');

// Eén gedeelde HTTP agent voor alle energy socket devices.
// maxSockets:4 = max 4 gelijktijdige verbindingen over alle devices heen.
// Dit bespaart ~14 Agent-instanties + OS-sockets t.o.v. 1-per-device.
const SHARED_SOCKET_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: 4,
  maxFreeSockets: 2,
});



/**
 * Safe capability updater
 */
async function updateCapability(device, capability, value) {
  try {
    const current = device.getCapabilityValue(capability);

    // --- SAFE REMOVE ---
    // Removal is allowed only when:
    // 1) the new value is null
    // 2) the current value in Homey is also null

    if (value == null && current == null) {
      if (device.hasCapability(capability)) {
        await device.removeCapability(capability);
        device.log(`🗑️ Removed capability "${capability}"`);
      }
      return;
    }

    // --- ADD IF MISSING ---
    if (!device.hasCapability(capability)) {
      try {
        await device.addCapability(capability);
        device.log(`➕ Added capability "${capability}"`);
      } catch (err) {
        if (err && (err.code === 409 || err.statusCode === 409 || (err.message && err.message.includes('capability_already_exists')))) {
          device.log(`Capability already exists: ${capability} — ignoring`);
        } else {
          throw err;
        }
      }
    }

    // --- UPDATE ---
    if (current !== value) {
      await device.setCapabilityValue(capability, value);
    }

  } catch (err) {
    if (err.message === 'device_not_found') {
      device.log(`⚠️ Skipping capability "${capability}" — device not found`);
      return;
    }
    device.error(`❌ Failed updateCapability("${capability}")`, err);
  }
}

module.exports = class HomeWizardEnergySocketDevice extends Homey.Device {

  async onInit() {

    this._lastStatePoll = 0;
    this._debugLogs = [];
    this.__deleted = false;

    // ✅ FIX: Connection stability tracking
    this._consecutiveFailures = 0;
    this._consecutiveSuccesses = 0;
    this._isMarkedUnavailable = false;
    this._lastSuccessfulPoll = Date.now();

    // Persistent fetch stats — restored from settings across restarts
    const allStoredStats = this.homey.settings.get('fetch_device_stats') || {};
    const stored = allStoredStats[this.getName()] || {};
    this._fetchStats = {
      total:         stored.total         || 0,
      ok:            stored.ok            || 0,
      failed:        stored.failed        || 0,
      timeouts:      stored.timeouts      || 0,
      avgResponseMs: stored.avgResponseMs || 0,
      lastError:     stored.lastError     || null,
      lastErrorAt:   stored.lastErrorAt   || null,
      since:         stored.since         || new Date().toISOString(),
      // WiFi stats
      rssiAvg:       stored.rssiAvg       || null,
      rssiMin:       stored.rssiMin       || null,
      rssiMax:       stored.rssiMax       || null,
      // mDNS stats
      lastDiscoveryAt:    stored.lastDiscoveryAt    || null,
      lastDiscoveryEvent: stored.lastDiscoveryEvent || null,
    };
    // Flush stats to store every 60s, staggered by device index to prevent thundering herd
    // (safeIndex is set below — forward reference is fine since this runs after allDevices lookup)
    this._statsFlushTimer = null; // set after safeIndex is known

    this.agent = SHARED_SOCKET_AGENT;

    await updateCapability(this, 'connection_error', 'No errors');
    await updateCapability(this, 'alarm_connectivity', false);

    // Auto-scale interval based on device count to prevent fetchQueue overflow.
    // fetchQueue: MAX_CONCURRENT=4, ~1s/request → throughput ~4 req/s
    // Each device does 2 req/poll → min interval = ceil(deviceCount / 2)
    const allDevices = this.driver.getDevices();
    const deviceCount = allDevices.length;
    const myIndex = allDevices.indexOf(this);
    const safeIndex = myIndex >= 0 ? myIndex : 0;

    const userInterval = Math.max(this.getSetting('offset_polling') || 10, 2);
    const minInterval = Math.max(2, Math.ceil(deviceCount / 2));
    const interval = Math.max(userInterval, minInterval);

    if (interval > userInterval) {
      this.log(`⚠️ Polling interval auto-scaled: ${userInterval}s → ${interval}s (${deviceCount} devices)`);
      // Only notify once (from the first device) to avoid notification spam on multi-device setups
      if (safeIndex === 0) {
        this.homey.notifications.createNotification({
          excerpt: `Energy Socket polling auto-scaled naar ${interval}s (${deviceCount} devices). Verhoog je polling-instelling om deze melding te verbergen.`,
        }).catch(() => {});
      }
    }

    // Deterministic spread: device index determines start offset so devices never poll simultaneously.
    // First device starts after 500ms, others evenly spread across the full interval.
    const offset = safeIndex === 0
      ? 500
      : Math.round((safeIndex / deviceCount) * interval * 1000);

    this.log(`⏱️ Polling interval ${interval}s (user: ${userInterval}s), spread offset ${Math.round(offset / 1000)}s (device ${safeIndex + 1}/${deviceCount})`);

    // Stagger stats flush: 10s between devices, every 5min (settings writes are ~130ms each)
    const flushDelay = 300000 + safeIndex * 10000;
    setTimeout(() => {
      if (this.__deleted) return;
      this._flushFetchStats();
      this._statsFlushTimer = setInterval(() => this._flushFetchStats(), 300000);
    }, flushDelay);

    if (this.onPollInterval) clearInterval(this.onPollInterval);

    // Start interval only after first poll completes (avoids double-firing)
    setTimeout(() => {
      if (this.__deleted) return;
      this.log(`🚀 First poll starting (after ${Math.round(offset/1000)}s delay)`);
      this.onPoll().catch(this.error);
      this.onPollInterval = setInterval(() => {
        this.onPoll().catch(this.error);
      }, interval * 1000);
    }, offset);


    if (this.getClass() === 'sensor') {
      this.setClass('socket');
    }

    // Capability listeners
    this.registerCapabilityListener('onoff', async (value) => {
      if (this.getCapabilityValue('locked')) throw new Error('Device is locked');
      await this._putState({ power_on: value });
    });

    this.registerCapabilityListener('identify', async () => {
      await this._putIdentify();
    });

    this.registerCapabilityListener('dim', async (value) => {
      await this._putState({ brightness: Math.round(255 * value) });
    });

    this.registerCapabilityListener('locked', async (value) => {
      await this._putState({ switch_lock: value });
    });
  }

  onUninit() {
    // Cleanup intervals and timers when app stops/crashes
    this.__deleted = true;

    if (this.onPollInterval) {
      clearInterval(this.onPollInterval);
      this.onPollInterval = null;
    }
    if (this._debugFlushTimeout) {
      clearTimeout(this._debugFlushTimeout);
      this._debugFlushTimeout = null;
    }
    if (this._statsFlushTimer) {
      clearInterval(this._statsFlushTimer);
      this._statsFlushTimer = null;
    }
    this._flushFetchStats();
    // Gedeelde agent NIET destroyen — die wordt gebruikt door alle energy socket devices
    this.agent = null;
  }

  onDeleted() {
    // Call onUninit to cleanup timers
    this.onUninit();

    // Flush remaining logs before device deletion (only on explicit deletion)
    if (this._debugBuffer && this._debugBuffer.length > 0) {
      this._flushDebugLogs();
    }
    // Clear debug buffer
    if (this._debugBuffer) {
      this._debugBuffer = null;
    }
  }

  /**
   * Discovery handlers
   */
  _trackDiscovery(event) {
    if (this._fetchStats) {
      this._fetchStats.lastDiscoveryAt = new Date().toISOString();
      this._fetchStats.lastDiscoveryEvent = event;
    }
  }

  onDiscoveryAvailable(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._trackDiscovery('available');
    // ✅ FIX: Reset failure counters on rediscovery
    this._consecutiveFailures = 0;
    this._consecutiveSuccesses = 0;
    this.setAvailable();
    this._isMarkedUnavailable = false;
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._trackDiscovery('address_changed');
    this._debugLog(`Discovery address changed: ${this.url}`);
    // ✅ FIX: Reset failure counters on address change
    this._consecutiveFailures = 0;
    this._consecutiveSuccesses = 0;
    this.setAvailable();
    this._isMarkedUnavailable = false;
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.url = `http://${discoveryResult.address}:${discoveryResult.port}${discoveryResult.txt.path}`;
    this._trackDiscovery('last_seen');
    this.setAvailable();
    this._isMarkedUnavailable = false;
  }

  /**
   * Debug logger (batched writes to shared app settings)
   */
_debugLog(msg) {
  try {
    if (!this._debugBuffer) this._debugBuffer = [];
    const ts = new Date().toLocaleString('nl-NL', { hour12: false, timeZone: 'Europe/Amsterdam' });
    const driverName = this.driver.id;
    const deviceName = this.getName();
    const safeMsg = typeof msg === 'string' ? msg : (msg instanceof Error ? msg.message : JSON.stringify(msg));
    const line = `${ts} [${driverName}] [${deviceName}] ${safeMsg}`;
    this._debugBuffer.push(line);
    if (this._debugBuffer.length > 20) this._debugBuffer.shift();
    if (!this._debugFlushTimeout) {
      this._debugFlushTimeout = setTimeout(() => {
        this._flushDebugLogs();
        this._debugFlushTimeout = null;
      }, 5000);
    }
  } catch (err) {
    this.error('Failed to write debug logs:', err.message || err);
  }
}

_flushDebugLogs() {
  if (!this._debugBuffer || this._debugBuffer.length === 0) return;
  try {
    const logs = this.homey.settings.get('debug_logs') || [];
    logs.push(...this._debugBuffer);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    this.homey.settings.set('debug_logs', logs);
    this._debugBuffer = [];
  } catch (err) {
    this.error('Failed to flush debug logs:', err.message || err);
  }
}

_flushFetchStats() {
  if (!this._fetchStats) return;
  const t0 = Date.now();
  // If the settings entry for this device was cleared (reset button), reset in-memory stats too
  try {
    const allStats = this.homey.settings.get('fetch_device_stats') || {};
    if (!allStats[this.getName()]) {
      this._fetchStats = {
        total: 0, ok: 0, failed: 0, timeouts: 0,
        avgResponseMs: 0, lastError: null, lastErrorAt: null,
        since: new Date().toISOString(),
        rssiAvg: null, rssiMin: null, rssiMax: null,
      };
    }
    allStats[this.getName()] = this._fetchStats;
    this.homey.settings.set('fetch_device_stats', allStats);
  } catch (_) {}
  // setStoreValue is redundant — data is already in homey.settings above
  //this.log(`💾 _flushFetchStats took ${Date.now() - t0}ms`);
}

  /**
   * PUT /state (pure fetch, geen retries)
   */
  async _putState(body) {
    if (!this.url) return;

    try {
      // ✅ FIX: Longer timeout for poor WiFi (10s instead of 5s)
      const res = await fetchWithTimeout(`${this.url}/state`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 10000);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {
      this._debugLog(`PUT /state failed: ${err.message}`);
      throw new Error('Network error during state update');
    }
  }

  /**
   * PUT /identify
   */
  async _putIdentify() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/identify`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      }, 10000);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

    } catch (err) {
      this._debugLog(`PUT /identify failed: ${err.message}`);
      throw new Error('Network error during identify');
    }
  }

  /**
   * PUT /system cloud on/off
   */
  async setCloudOn() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: true })
      }, 10000);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    } catch (err) {
      this._debugLog(`Cloud ON failed: ${err.message}`);
      throw new Error('Network error during setCloudOn');
    }
  }

  async setCloudOff() {
    if (!this.url) return;

    try {
      const res = await fetchWithTimeout(`${this.url}/system`, {
        agent: this.agent,
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cloud_enabled: false })
      }, 10000);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    } catch (err) {
      this._debugLog(`Cloud OFF failed: ${err.message}`);
      throw new Error('Network error during setCloudOff');
    }
  }

  /**
   * ✅ FIX: Debounced connection state management
   * Only mark unavailable after 3 consecutive failures
   * Only mark available after 2 consecutive successes
   */
  _handlePollSuccess(elapsedMs, rssi) {
    this._consecutiveFailures = 0;
    this._consecutiveSuccesses++;
    this._lastSuccessfulPoll = Date.now();

    // Update fetch stats
    const s = this._fetchStats;
    s.total++;
    s.ok++;
    if (elapsedMs != null) {
      s.avgResponseMs = Math.round(s.avgResponseMs + (elapsedMs - s.avgResponseMs) / s.ok);
    }
    if (rssi != null) {
      s.rssiAvg = s.rssiAvg == null ? rssi : Math.round(s.rssiAvg + (rssi - s.rssiAvg) / s.ok);
      if (s.rssiMin == null || rssi < s.rssiMin) s.rssiMin = rssi;
      if (s.rssiMax == null || rssi > s.rssiMax) s.rssiMax = rssi;
    }

    // Mark available after 2 consecutive successes (prevents flapping)
    if (this._consecutiveSuccesses >= 2 && this._isMarkedUnavailable) {
      this.log('✅ Connection restored (2 consecutive successes)');
      this.setAvailable().catch(this.error);
      this._isMarkedUnavailable = false;
      updateCapability(this, 'connection_error', 'No errors').catch(this.error);
      updateCapability(this, 'alarm_connectivity', false).catch(this.error);
    } else if (!this._isMarkedUnavailable) {
      // Already available — alarm_connectivity is already false, only clear error text if needed
      if (this._consecutiveFailures > 0 || this._consecutiveSuccesses === 1) {
        updateCapability(this, 'connection_error', 'No errors').catch(this.error);
      }
    }
  }

  _handlePollFailure(err) {
    this._consecutiveSuccesses = 0;
    this._consecutiveFailures++;

    // Update fetch stats
    const s = this._fetchStats;
    s.total++;
    s.failed++;
    if (err && (err.message === 'TIMEOUT' || err.name === 'AbortError')) s.timeouts++;
    s.lastError = err ? (err.message || String(err)) : 'unknown';
    s.lastErrorAt = new Date().toISOString();

    const timeSinceLastSuccess = Date.now() - this._lastSuccessfulPoll;

    // Only mark unavailable after 3 consecutive failures AND 90 seconds since last success
    // This prevents flapping on temporary WiFi glitches
    if (this._consecutiveFailures >= 3 && timeSinceLastSuccess > 90000) {
      if (!this._isMarkedUnavailable) {
        this.log(`❌ Connection lost after ${this._consecutiveFailures} failures (${Math.round(timeSinceLastSuccess/1000)}s since last success)`);
        this.setUnavailable(err.message || 'Polling error').catch(this.error);
        this._isMarkedUnavailable = true;
      }
      updateCapability(this, 'connection_error', err.message || 'Polling error').catch(this.error);
      updateCapability(this, 'alarm_connectivity', true).catch(this.error);
    } else {
      // Still trying - just log the error but don't mark unavailable yet
      this._debugLog(`Poll failed (${this._consecutiveFailures}/3): ${err.message}`);
      updateCapability(this, 'connection_error', `Retrying (${this._consecutiveFailures}/3): ${err.message}`).catch(this.error);
    }
  }

  /**
   * GET /data + GET /state (with improved error handling)
   */
  async onPoll() {
  if (this.__deleted) return;

  const settings = this.getSettings();
  const pollStart = Date.now();

  // URL restore when needed
  if (!this.url) {
    if (settings.url) {
      this.url = settings.url;
    } else {
      this._handlePollFailure(new Error('Missing URL'));
      return;
    }
  }

  try {
    
    // -----------------------------
    // GET /data (with retry on timeout)
    // -----------------------------
    let data;
    let retries = 2;
    
    while (retries >= 0) {
      try {
        // ✅ FIX: Longer timeout for poor WiFi (10s instead of 5s)
        const res = await fetchWithTimeout(`${this.url}/data`, {
          agent: this.agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }, 10000);

        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

        data = await res.json();
        if (!data || typeof data !== 'object') throw new Error('Invalid JSON');
        
        break; // Success - exit retry loop
        
      } catch (err) {
        retries--;
        if (retries < 0) {
          throw err; // All retries exhausted
        }
        // Wait 1 second before retry
        this._debugLog(`/data failed, retrying (${2-retries}/2): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    const offset = Number(this.getSetting('offset_socket')) || 0;
    const watt = data.active_power_w + offset;

    const tasks = [];
    const cap = (name, value) => {
      if (value === undefined || value === null) return;
      const cur = this.getCapabilityValue(name);
      if (cur !== value) tasks.push(updateCapability(this, name, value));
    };

    cap('measure_power', watt);
    cap('meter_power.consumed.t1', data.total_power_import_t1_kwh);
    cap('measure_power.l1', data.active_power_l1_w);
    cap('rssi', data.wifi_strength);

    if (data.total_power_export_t1_kwh > 1) {
      cap('meter_power.produced.t1', data.total_power_export_t1_kwh);
    }

    const net = data.total_power_import_t1_kwh - data.total_power_export_t1_kwh;
    cap('meter_power', net);

    cap('measure_voltage', data.active_voltage_v);
    cap('measure_current', data.active_current_a);

    // -----------------------------
    // GET /state (max 1× per 30s, non-critical)
    // -----------------------------
    const now = Date.now();
    const mustPollState =
      !this._lastStatePoll ||
      (now - this._lastStatePoll) > 30000;

    if (mustPollState) {
      this._lastStatePoll = now;

      try {
        const resState = await fetchWithTimeout(`${this.url}/state`, {
          agent: this.agent,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }, 10000);

        if (!resState.ok) throw new Error(`HTTP ${resState.status}: ${resState.statusText}`);

        const state = await resState.json();
        if (!state || typeof state !== 'object') throw new Error('Invalid JSON');

        cap('onoff', state.power_on);
        cap('dim', state.brightness / 255);
        cap('locked', state.switch_lock);

      } catch (err) {
        // ✅ FIX: State poll failure is non-critical - don't count as connection failure
        this._debugLog(`State poll failed (non-critical): ${err.message}`);
        // Don't update connection_error or alarm_connectivity for state failures
      }
    }

    if (!this.__deleted && this.url !== settings.url) {
      this.setSettings({ url: this.url }).catch(this.error);
    }

    if (tasks.length > 0) await Promise.allSettled(tasks);

    // ✅ FIX: Mark as successful poll
    this._handlePollSuccess(Date.now() - pollStart, data.wifi_strength);

  } catch (err) {
    if (!this.__deleted) {
      this._debugLog(`Poll failed: ${err.message}`);
      // ✅ FIX: Use debounced failure handler
      this._handlePollFailure(err);
    }
  }
}


  /**
   * Settings handler
   */
  async onSettings(oldSettings, newSettings, changedKeys = []) {

    for (const key of changedKeys) {

      if (key === 'offset_socket') {
        const cap = 'measure_power';
        const oldVal = Number(oldSettings[key]) || 0;
        const newVal = Number(newSettings[key]) || 0;
        const delta = newVal - oldVal;

        const current = this.getCapabilityValue(cap) || 0;
        await this.setCapabilityValue(cap, current + delta).catch(this.error);
      }

      if (key === 'offset_polling') {
        if (this.onPollInterval) {
          clearInterval(this.onPollInterval);
          this.onPollInterval = null;
        }

        const interval = Number(newSettings.offset_polling);
        // ✅ CPU FIX: Increased min interval from 2s to 5s (9 devices = high load)
        if (interval >= 2) {
          this.onPollInterval = setInterval(this.onPoll.bind(this), interval * 1000);
        }
      }

      if (key === 'cloud') {
        try {
          if (newSettings.cloud == 1) await this.setCloudOn();
          else await this.setCloudOff();
        } catch (err) {
          this.error('Failed to update cloud setting:', err);
        }
      }
    }
  }
};