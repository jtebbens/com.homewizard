'use strict';

// One /userdata sink for the rebuildable provider caches (merged prices, weather, Solcast).
//
// They lived in homey.settings, but every settings.set() serialises and ships the WHOLE settings
// object (SDK manager/settings.js _save -> emitApp('setSettings', …)), so three caches nothing in
// the UI reads cost 70.7 kB on every unrelated write — 14% of a 490 kB blob, on every Homey running
// this app. Same move mode-history (f7011bf) and the DP input dumps (d8bcdd7) already made; this is
// the shared helper those two predate.
//
// Everything here degrades to the caller's existing cache-miss path: readJson returns null, writeJson
// returns false. A cache is by definition refetchable, so a lost file costs one API call, never data.

const fs = require('fs');

// Per call, not captured at require time: the tests point this at a tmpdir and back.
function dir() {
  return process.env.HOMEY_USERDATA_DIR || '/userdata';
}

function file(name) {
  return `${dir()}/${name}.json`;
}

/** Parsed contents, or null when the file is missing, unreadable or corrupt. */
function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** True when the file landed. Serialises BEFORE opening, so a bad payload leaves no truncated file. */
function writeJson(name, value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (_) {
    return false;
  }
  try {
    fs.writeFileSync(file(name), json);
    return true;
  } catch (_) {
    return false;
  }
}

/** Best-effort delete; an absent file is not an error. */
function removeJson(name) {
  try {
    fs.unlinkSync(file(name));
  } catch (_) { /* already gone */ }
}

module.exports = { readJson, writeJson, removeJson, dir };
