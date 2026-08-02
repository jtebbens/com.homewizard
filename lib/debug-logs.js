'use strict';

// The shared fetch-debug log, on /userdata instead of in homey.settings.
//
// Six drivers (energy, energy_socket, watermeter, SDM230, SDM230-p1mode, SDM630) each kept their own
// copy of a read-append-cap-write against homey.settings' `debug_logs`. Every settings.set() ships the
// WHOLE settings object over IPC, so at 500 entries this one diagnostic key was 46.5 kB of a 364.5 kB
// blob, paid on every unrelated write. Same move the provider caches (lib/userdata-store.js),
// mode-history (f7011bf) and the DP input dumps (d8bcdd7) already made.
//
// Diagnostics are expendable: every path here degrades to "no logs" rather than throwing into a
// driver's poll loop.

const { readJson, writeJson, removeJson } = require('./userdata-store');

const FILE = 'debug_logs';
const MAX_DEBUG_LOGS = 500;

/** The stored lines, oldest first. Always an array — a missing or corrupt file reads as empty. */
function readDebugLogs() {
  const logs = readJson(FILE);
  return Array.isArray(logs) ? logs : [];
}

/** Appends a batch, keeping the newest MAX_DEBUG_LOGS. Returns true when the write landed. */
function appendDebugLogs(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const logs = readDebugLogs();
  logs.push(...entries);
  if (logs.length > MAX_DEBUG_LOGS) logs.splice(0, logs.length - MAX_DEBUG_LOGS);
  return writeJson(FILE, logs);
}

/** Drops every stored line. Clearing an already-empty log is a no-op. */
function clearDebugLogs() {
  removeJson(FILE);
}

module.exports = { readDebugLogs, appendDebugLogs, clearDebugLogs, MAX_DEBUG_LOGS };
