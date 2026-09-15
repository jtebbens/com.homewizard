'use strict';

// Two settings writers that kept the blob busy for nothing (Docker CDP probe 2026-09-15, 0.96 h):
//   - debug_legacy_fetch: the legacy driver re-set the same error list every 20 s — 165 of 270
//     settings writes/hour, byte-identical three polls in a row.
//   - policy_weakpv_shadow: the weak-PV shadow ring (96 rows, 20.2 kB) sat inside the settings
//     object, so every unrelated settings.set() shipped it too (SDK manager/settings.js _save ->
//     emitApp('setSettings', <whole object>)). Blob-size effect on RSS: project_app_rss_step_0722.
//
// Contract covered here:
//   - an unchanged legacy error list is not re-set; a changed one is
//   - the shadow ring never reaches settings, round-trips through /userdata and stays capped at 96
//   - app.js carries the existing ring over to /userdata before dropping the settings key

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-blobwriters-'));
process.env.HOMEY_USERDATA_DIR = tmpDir;
const userdataStore = require('../lib/userdata-store');

const legacyDevices = {};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id.endsWith('includes/legacy/homewizard.js')) return { self: { devices: legacyDevices } };
  return origRequire.apply(this, arguments);
};
const HomeWizardDevice = require('../drivers/homewizard/device');
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const SHADOW_KEY = 'policy_weakpv_shadow';
const SHADOW_FILE = 'weakpv-shadow';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function fakeSettings() {
  const store = {};
  const writes = [];
  return {
    store,
    writes,
    get: k => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; writes.push(k); },
    unset: k => { delete store[k]; },
    getKeys: () => Object.keys(store),
  };
}

console.log('\nLegacy fetch debug — no re-set of an unchanged list\n');

function legacyCtx(settings) {
  return Object.assign(Object.create(HomeWizardDevice.prototype), { homey: { settings }, log() {} });
}

// The 20 s throttle is cadence, not part of the dedupe contract: clear it between polls.
function poll(ctx) {
  ctx._lastLegacySyncAt = 0;
  ctx.syncLegacyDebugToSettings();
}

const errEntry = (t, ms) => ({ t, name: 'HomeWizard', type: 'timeout', ms });

test('an unchanged error list is set once across three polls', () => {
  const entries = [errEntry('2026-09-15T01:08:26Z', 7003)];
  legacyDevices.a = { fetchLegacyDebug: { get: () => entries } };
  const settings = fakeSettings();
  const ctx = legacyCtx(settings);
  poll(ctx); poll(ctx); poll(ctx);
  assert.strictEqual(settings.writes.filter(k => k === 'debug_legacy_fetch').length, 1);
});

test('a new error does produce a fresh set', () => {
  const entries = [errEntry('2026-09-15T01:08:26Z', 7003)];
  legacyDevices.a = { fetchLegacyDebug: { get: () => entries } };
  const settings = fakeSettings();
  const ctx = legacyCtx(settings);
  poll(ctx);
  entries.push(errEntry('2026-09-15T01:30:00Z', 7010));
  poll(ctx);
  assert.strictEqual(settings.writes.filter(k => k === 'debug_legacy_fetch').length, 2);
  assert.strictEqual(settings.store.debug_legacy_fetch.length, 2);
});

console.log('\nWeak-PV shadow ring — out of the settings blob, onto /userdata\n');

function policyCtx(settings) {
  return Object.assign(Object.create(BatteryPolicyDevice.prototype), {
    _liveState: {},
    homey: { settings, setTimeout: fn => { fn(); return 1; } },
    log() {},
    error() {},
  });
}

test('appended rows land on /userdata and never in settings', () => {
  userdataStore.removeJson(SHADOW_FILE);
  const settings = fakeSettings();
  const ctx = policyCtx(settings);
  ctx._appendWeakPvShadowRow({ de: 0.01 });
  ctx._appendWeakPvShadowRow({ de: 0.02 });
  ctx._flushSettingsQueue?.();
  assert.ok(!(SHADOW_KEY in settings.store), 'shadow ring reached the settings object');
  assert.ok(!settings.writes.includes(SHADOW_KEY), 'shadow ring went through settings.set');
  assert.deepStrictEqual(userdataStore.readJson(SHADOW_FILE), { rows: [{ de: 0.01 }, { de: 0.02 }] });
});

test('the ring survives a restart (fresh instance continues the file) and stays capped at 96', () => {
  userdataStore.removeJson(SHADOW_FILE);
  const first = policyCtx(fakeSettings());
  for (let i = 0; i < 90; i++) first._appendWeakPvShadowRow({ i });
  const second = policyCtx(fakeSettings());
  for (let i = 90; i < 100; i++) second._appendWeakPvShadowRow({ i });
  const rows = userdataStore.readJson(SHADOW_FILE).rows;
  assert.strictEqual(rows.length, 96);
  assert.strictEqual(rows[0].i, 4);
  assert.strictEqual(rows[95].i, 99);
});

test('device.js no longer routes the ring through _setLive or settings', () => {
  const src = fs.readFileSync(path.join(__dirname, '../drivers/battery-policy/device.js'), 'utf8');
  assert.ok(!src.includes(`_setLive('${SHADOW_KEY}'`), 'still _setLive(policy_weakpv_shadow)');
  assert.ok(!src.includes(`settings.get('${SHADOW_KEY}')`), 'still reads the ring from settings');
});

test('app.js carries an existing ring over to /userdata, then drops the settings key', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  assert.ok(appSrc.includes(`'${SHADOW_KEY}'`), `app.js never mentions ${SHADOW_KEY}`);
  assert.ok(appSrc.includes(`'${SHADOW_FILE}'`), `app.js never writes ${SHADOW_FILE}.json`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
