'use strict';

// [DP-INPUT-DUMP] captures the exact compute() arguments so a DP anomaly can be replayed against
// the REAL inputs — the 2026-07-10 minDischargePrice scalar-vs-array bug was invisible in every
// derived log line and only fell out of replaying the true arguments (param SHAPE, not just value,
// flips the decision). The sink used to be this.log(): one ~150 kB line into /tmp/homey.log, which
// is tmpfs, rolls away as the log grows, and dies on restart — so the capture regularly outlived
// its usefulness before anyone read it. It writes one JSON file per run to /userdata now, which is
// plain-HTTP readable from the dev box (no cloud, no `homey api` rate limit).
//
// Contract covered here:
//   - one file per dump, named from the dump's own timestamp, lexically sortable = chronological
//   - the payload round-trips: per-slot arrays stay arrays and keep their length and values
//   - rotation keeps the newest DP_DUMP_KEEP files and prunes the rest
//   - rotation counts only dp-input-* files; other /userdata files (mode-history) are untouched
//   - an unwritable dir degrades to a log line, never a throw (the dump must not break a policy run)

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const write = BatteryPolicyDevice.prototype._writeDpInputDump;
assert.strictEqual(typeof write, 'function', '_writeDpInputDump must exist on the prototype');

const KEEP = BatteryPolicyDevice.DP_DUMP_KEEP;
assert.ok(Number.isInteger(KEEP) && KEEP > 0, 'DP_DUMP_KEEP must be a positive integer');

function ctx(dir) {
  const logs = [];
  return { _dpDumpDir: dir, log: (m) => logs.push(m), error: (m) => logs.push(m), logs };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dpdump-'));
}

function dumps(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('dp-input-')).sort();
}

let passed = 0;
function ok(name) { passed++; console.log(`  ok ${name}`); }

// --- one file per dump, named from its own timestamp, payload round-trips ------------------------
{
  const dir = tmpdir();
  const self = ctx(dir);
  const payload = {
    at: '2026-08-01T21:45:12.345Z',
    soc: 37, capacityKwh: 5.4, minDischargePrice: [0.11, 0.12, 0.13],
    prices: [{ price: 0.21, timestamp: '2026-08-01T22:00:00.000Z' }],
    consumptionWPerSlot: [400, 410, 395],
  };
  const file = write.call(self, payload);

  assert.ok(file, 'write returns the file path');
  const names = dumps(dir);
  assert.strictEqual(names.length, 1, 'exactly one file written');
  assert.strictEqual(names[0], 'dp-input-20260801T214512.345Z.json', `unexpected name ${names[0]}`);

  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(back, payload, 'payload round-trips byte-for-byte');
  assert.ok(Array.isArray(back.minDischargePrice), 'a per-slot array stays an array');
  assert.strictEqual(back.consumptionWPerSlot.length, 3, 'array length preserved');
  ok('one file per dump, timestamped name, payload round-trips');
}

// --- names sort chronologically -----------------------------------------------------------------
{
  const dir = tmpdir();
  const self = ctx(dir);
  const stamps = [
    '2026-08-01T22:05:00.000Z',
    '2026-08-01T21:45:12.345Z',
    '2026-08-02T00:00:00.000Z',
  ];
  for (const at of stamps) write.call(self, { at, soc: 1 });

  const names = dumps(dir);
  const ats = names.map((n) => JSON.parse(fs.readFileSync(`${dir}/${n}`, 'utf8')).at);
  assert.deepStrictEqual(ats, [...stamps].sort(), 'lexical filename order == chronological order');
  ok('filenames sort chronologically');
}

// --- rotation keeps the newest KEEP ---------------------------------------------------------------
{
  const dir = tmpdir();
  const self = ctx(dir);
  const total = KEEP + 5;
  const ats = [];
  for (let i = 0; i < total; i++) {
    const at = new Date(Date.UTC(2026, 7, 1, 12, i, 0)).toISOString();
    ats.push(at);
    write.call(self, { at, soc: i });
  }

  const names = dumps(dir);
  assert.strictEqual(names.length, KEEP, `rotation keeps ${KEEP}, found ${names.length}`);
  const kept = names.map((n) => JSON.parse(fs.readFileSync(`${dir}/${n}`, 'utf8')).soc);
  const expected = [];
  for (let i = total - KEEP; i < total; i++) expected.push(i);
  assert.deepStrictEqual(kept, expected, 'the NEWEST dumps survive, the oldest are pruned');
  ok(`rotation keeps newest ${KEEP}`);
}

// --- rotation leaves foreign files alone ----------------------------------------------------------
{
  const dir = tmpdir();
  const self = ctx(dir);
  fs.writeFileSync(`${dir}/mode-history-2026-08-01.json`, '[]');
  fs.writeFileSync(`${dir}/baseload-state.json`, '{}');
  for (let i = 0; i < KEEP + 3; i++) {
    write.call(self, { at: new Date(Date.UTC(2026, 7, 1, 12, i, 0)).toISOString(), soc: i });
  }

  assert.ok(fs.existsSync(`${dir}/mode-history-2026-08-01.json`), 'mode-history survives rotation');
  assert.ok(fs.existsSync(`${dir}/baseload-state.json`), 'baseload state survives rotation');
  assert.strictEqual(dumps(dir).length, KEEP, 'rotation still trims its own files');
  ok('rotation ignores non-dump files');
}

// --- an unwritable dir degrades to a log line ------------------------------------------------------
{
  const self = ctx('/proc/definitely-not-writable');
  let result;
  assert.doesNotThrow(() => { result = write.call(self, { at: '2026-08-01T21:45:12.345Z', soc: 1 }); },
    'a failed dump must never throw into the policy run');
  assert.strictEqual(result, null, 'a failed dump returns null');
  assert.ok(self.logs.some((m) => /DP-INPUT-DUMP/.test(m)), 'the failure is logged');
  ok('unwritable dir degrades to a log line');
}

// --- a non-serialisable payload degrades the same way ----------------------------------------------
{
  const dir = tmpdir();
  const self = ctx(dir);
  const circular = { at: '2026-08-01T21:45:12.345Z' };
  circular.self = circular;
  let result;
  assert.doesNotThrow(() => { result = write.call(self, circular); }, 'circular payload must not throw');
  assert.strictEqual(result, null, 'a failed dump returns null');
  assert.strictEqual(dumps(dir).length, 0, 'no partial file left behind');
  ok('non-serialisable payload degrades to a log line');
}

console.log(`\n${passed} passed`);
