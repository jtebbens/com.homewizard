#!/usr/bin/env node
/**
 * Read data straight off the Homey's local API instead of through `homey api`.
 *
 * The CLI resolves the active Homey through Athom's cloud on every invocation, so a cloud
 * rate-limit ("Too many requests", ~2h) blocks every dump and snapshot even though the Homey
 * itself is reachable on the LAN. These routes are LAN-only and keep working through that.
 *
 * Auth is a Personal Access Token (my.homey.app -> API keys), read from a file so it never
 * lands in a shell history or a log. Never print the token.
 *
 * Library:  const { getAppSetting, getInsightsEntries } = require('./homey-local');
 * CLI:      node tools/homey-local.js setting <name> [appId]
 *           node tools/homey-local.js insights <logId> [resolution]
 */
const fs = require('fs');

const ADDRESS = process.env.HOMEY_ADDRESS || 'http://192.168.1.12';
const TOKEN_FILE = process.env.HOMEY_TOKEN_FILE || '/root/.homey-local-token';
const APP_ID = 'com.homewizard';

let cachedToken = null;
function token() {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch (err) {
    throw new Error(`no token at ${TOKEN_FILE} (${err.code}) — see tools/homey-local.js header`);
  }
  if (!cachedToken) throw new Error(`${TOKEN_FILE} is empty`);
  return cachedToken;
}

async function get(path, asText = false) {
  const res = await fetch(`${ADDRESS}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path.split('?')[0]}`);
  return asText ? res.text() : res.json();
}

/** One app settings key. Returns null when the key does not exist. */
async function getAppSetting(name, appId = APP_ID) {
  return get(`/api/manager/apps/app/${encodeURIComponent(appId)}/setting/${encodeURIComponent(name)}`);
}

/**
 * One file from the app's /userdata directory. The mode history moved there when the settings
 * blob was split up (settings key policy_mode_history_YYYY-MM-DD no longer exists), and the
 * settings page reads it over this same path. A missing file yields null, like a missing key.
 */
async function getUserdata(name, appId = APP_ID) {
  // .jsonl (dp-trace-*) is one JSON object per line, so res.json() rejects the whole file at the
  // first newline ("Unexpected non-whitespace character after JSON"). Fetch it as text and parse
  // per line; a truncated last line — the file is appended to while we read — is dropped rather
  // than failing the read. Returns an array of records, so callers treat it like any other file.
  const jsonl = name.endsWith('.jsonl');
  try {
    const body = await get(`/app/${encodeURIComponent(appId)}/userdata/${encodeURIComponent(name)}`, jsonl);
    if (!jsonl) return body;
    const out = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (err) { /* partial trailing line: skip */ }
    }
    return out;
  } catch (err) {
    if (/HTTP 40[34]/.test(err.message)) return null;
    throw err;
  }
}

/** Insights log entries. `logId` is the full id; the uri is its first three segments. */
async function getInsightsEntries(logId, resolution = 'last24Hours') {
  const uri = logId.split(':', 3).join(':');
  const qs = `resolution=${encodeURIComponent(resolution)}`;
  return get(`/api/manager/insights/log/${encodeURIComponent(uri)}/${encodeURIComponent(logId)}/entry?${qs}`);
}

module.exports = { getAppSetting, getUserdata, getInsightsEntries, ADDRESS };

if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  const run = {
    setting: () => getAppSetting(a, b || APP_ID),
    userdata: () => getUserdata(a, b || APP_ID),
    insights: () => getInsightsEntries(a, b || 'last24Hours'),
  }[cmd];
  if (!run || !a) {
    console.error('usage: homey-local.js setting <name> [appId] | userdata <file> [appId] '
      + '| insights <logId> [resolution]');
    process.exit(2);
  }
  run()
    .then((out) => process.stdout.write(`${JSON.stringify(out)}\n`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
