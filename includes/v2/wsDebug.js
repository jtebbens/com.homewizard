'use strict';

/**
 * wsDebug — Crash-resilient WebSocket diagnostics
 *
 * Writes critical events + periodic stats snapshots to Homey persistent
 * settings so they survive app kills (CPU/memory limit, SIGKILL).
 *
 * Settings keys:
 *   ws_journal   – ring buffer of last 50 critical events
 *   ws_snapshots – last stats snapshot per device (keyed by deviceId)
 *
 * The old 'debug_ws' key is still written for backward compatibility
 * with existing settings page code.
 */

let HomeyRef = null;

// Throttle settings writes: at most once per 5 seconds per key
const _lastWrite = {};
const MIN_WRITE_INTERVAL_MS = 5000;

function _ts() {
  return new Date().toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour12: false,
  });
}

module.exports = {

  init(homeyInstance) {
    HomeyRef = homeyInstance;
  },

  /**
   * Log a critical event to the persistent journal.
   * Only call for events that matter: connect, disconnect, error,
   * reconnect, mode_change, preflight_fail — NOT every message.
   */
  log(type, deviceId, message) {
    if (!HomeyRef) return;

    try {
      const entry = { ts: _ts(), type, deviceId, message };

      const stored = HomeyRef.settings.get('ws_journal');
      const journal = Array.isArray(stored) ? stored : [];
      journal.push(entry);

      // Keep last 50 entries
      const trimmed = journal.slice(-50);

      // Throttle: don't write more than once per 5s
      const now = Date.now();
      if (!_lastWrite.journal || now - _lastWrite.journal >= MIN_WRITE_INTERVAL_MS) {
        _lastWrite.journal = now;
        HomeyRef.settings.set('ws_journal', trimmed);
        // Backward compat: also write to old key
        HomeyRef.settings.set('debug_ws', trimmed);
      }
    } catch (err) {
      console.error('wsDebug.log failed:', err.message);
    }
  },

  /**
   * Persist a stats snapshot for a device.
   * Called periodically (every ~5 min) from Ws.js.
   * Survives app crash — the last snapshot before the kill is readable
   * from the settings page.
   */
  snapshot(deviceId, stats) {
    if (!HomeyRef || !deviceId) return;

    try {
      const now = Date.now();
      // Throttle snapshots to once per 30s per device
      const key = `snap_${deviceId}`;
      if (_lastWrite[key] && now - _lastWrite[key] < 30000) return;
      _lastWrite[key] = now;

      const stored = HomeyRef.settings.get('ws_snapshots') || {};
      stored[deviceId] = {
        ts: _ts(),
        timestamp: now,
        ...stats,
      };
      HomeyRef.settings.set('ws_snapshots', stored);
    } catch (err) {
      console.error('wsDebug.snapshot failed:', err.message);
    }
  },

  /**
   * Read the full journal (for settings page or programmatic access).
   */
  getJournal() {
    if (!HomeyRef) return [];
    try {
      return HomeyRef.settings.get('ws_journal') || [];
    } catch { return []; }
  },

  /**
   * Read all device snapshots.
   */
  getSnapshots() {
    if (!HomeyRef) return {};
    try {
      return HomeyRef.settings.get('ws_snapshots') || {};
    } catch { return {}; }
  },

  /**
   * Clear journal + snapshots (e.g. from settings page button).
   */
  clear() {
    if (!HomeyRef) return;
    try {
      HomeyRef.settings.set('ws_journal', []);
      HomeyRef.settings.set('ws_snapshots', {});
      HomeyRef.settings.set('debug_ws', []);
    } catch (err) {
      console.error('wsDebug.clear failed:', err.message);
    }
  },
};
