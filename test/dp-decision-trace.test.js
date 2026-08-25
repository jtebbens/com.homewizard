'use strict';

// [DP-TRACE] persists WHY the DP chose what it chose, once per policy run. mode-history already
// records the outcome (mode, SoC, price) but none of the reasons, so a past day could only ever
// show THAT the plan underperformed, never WHY — the 2026-07-23 window was unrecoverable for
// exactly this reason, and open questions kept degrading into "wait until the state recurs".
//
// Contract covered here:
//   - compute() leaves both constraint arrays on the engine, at horizon length
//   - the probe pass (no currentSoc) does not clobber the arrays of the plan that shipped
//   - the record carries one entry per slot in every per-slot field, and stays small enough
//     to write ~96x/day for 23 days
//   - missing engine state yields null, never a half record
//   - append is one line per run in the day's file, and lines round-trip as JSON
//   - rotation drops trace files past MODE_HISTORY_DAYS and leaves mode-history alone
//   - an unwritable dir degrades to an error line, never a throw into the policy run

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const Module = require('module');

const OptimizationEngine = require('../lib/optimization-engine');

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device');
Module.prototype.require = origRequire;

const build  = BatteryPolicyDevice.prototype._buildDecisionTrace;
const append = BatteryPolicyDevice.prototype._appendDecisionTrace;
assert.strictEqual(typeof build, 'function', '_buildDecisionTrace must exist on the prototype');
assert.strictEqual(typeof append, 'function', '_appendDecisionTrace must exist on the prototype');

const DAYS = BatteryPolicyDevice.MODE_HISTORY_DAYS;
assert.ok(Number.isInteger(DAYS) && DAYS > 0, 'MODE_HISTORY_DAYS must be a positive integer');

function ctx(dir) {
  const logs = [];
  return {
    _modeStateDir: dir,
    _dpTraceFile: BatteryPolicyDevice.prototype._dpTraceFile,
    log: (m) => logs.push(m),
    error: (m) => logs.push(m),
    logs,
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dptrace-'));
}

let passed = 0;
function ok(name) { passed++; console.log(`  ok ${name}`); }

// --- a real run: build the engine state the trace reads ------------------------------------------
// Overnight cheap, strong PV midday, expensive evening: enough structure that the DP actually picks
// different actions, so the action string is not a single repeated char.
const base = new Date('2026-06-01T00:00:00+02:00').getTime();
const H = 3_600_000;
const prices = [], pv = [], cons = [];
for (let t = 0; t < 24; t++) {
  let p = 0.15;
  if (t <= 6) p = 0.10;
  if (t >= 18 && t <= 22) p = 0.45;
  prices.push({ timestamp: new Date(base + t * H).toISOString(), price: p });
  pv.push({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: (t >= 9 && t <= 15) ? 3000 : 0 });
  cons.push(600);
}
const SETTINGS = { battery_efficiency: 0.90, min_soc: 10, max_soc: 100, cycle_cost_per_kwh: 0, export_price_ratio: 1.0 };

function runEngine(refillConfidence = 0.5) {
  const engine = new OptimizationEngine(SETTINGS);
  engine.compute(prices, 50, 5.4, 2200, 800, pv, 0.90, cons, 0.05, 1.0, 3.0, 3.0, 1.0, refillConfidence, false, 0.30);
  return engine;
}

// --- compute() exposes both constraint arrays at horizon length ----------------------------------
{
  const engine = runEngine();
  const arr = engine._lastDpArrays;
  assert.ok(arr, 'compute() stashes _lastDpArrays');
  assert.strictEqual(arr.reserveFloorG.length, prices.length, 'reserveFloorG spans the horizon');
  assert.strictEqual(arr.effectiveDischargePowerW.length, prices.length, 'effectiveDischargePowerW spans the horizon');
  ok('compute() exposes both constraint arrays at horizon length');
}

// --- the probe pass must not clobber the shipped plan's arrays -----------------------------------
// computeExpectedProfit() runs the backward DP without a real currentSoc. If the stash lived in
// _runBackwardDP, that pass would overwrite the arrays belonging to the plan that actually shipped
// and every trace after a "what if" call would describe the wrong run.
{
  const engine = runEngine();
  const before = Array.from(engine._lastDpArrays.reserveFloorG);
  engine.computeExpectedProfit(prices, 50, 9.0, 2200, 800, pv, 0.90, cons);
  const after = Array.from(engine._lastDpArrays.reserveFloorG);
  assert.deepStrictEqual(after, before, 'a probe pass leaves the shipped run\'s arrays untouched');
  ok('probe pass does not clobber the shipped arrays');
}

// --- the record: one entry per slot, all fields aligned ------------------------------------------
{
  const engine = runEngine();
  const n = engine._schedule.slots.length;
  const rec = build.call(ctx('/tmp'), {
    engine, now: Date.parse('2026-06-01T12:00:00Z'), soc: 50,
    refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });

  assert.ok(rec, 'a completed run yields a record');
  assert.strictEqual(rec.n, n, 'n names the horizon length');
  assert.strictEqual(rec.act.length, n, 'one action char per slot');
  assert.strictEqual(rec.socP.length, n, 'one projected SoC per slot');
  assert.strictEqual(rec.floor.length, n, 'one floor value per slot');
  assert.strictEqual(rec.dischW.length, n, 'one discharge cap per slot');
  assert.ok(!/\?/.test(rec.act), `every action maps to a char, got ${rec.act}`);
  assert.ok(new Set(rec.act.split('')).size > 1, `the plan must vary, got ${rec.act}`);

  // The four values the DP compared at t=0 are the point of the record: without them the chosen
  // action is unexplained. chosenAction must agree with the plan's first slot.
  assert.ok(typeof rec.v0.pre === 'number', 'vPreserve captured');
  // v0.act is the BACKWARD pass's pick at t=0, deliberately not slots[0].action: the post-DP passes
  // (reorder/island/topup/trickle) may relabel that slot, and the whole point of storing both is
  // being able to see afterwards that they diverged.
  assert.strictEqual(rec.v0.act, engine._flattenDebug.chosenAction, 'v0.act is the DP\'s own t=0 pick');
  assert.ok(['preserve', 'charge', 'discharge', 'standby'].includes(rec.v0.act), `unexpected v0.act ${rec.v0.act}`);
  assert.strictEqual(rec.conf, 0.5, 'refillConfidence captured');
  assert.strictEqual(rec.pvTom, 3.0, 'pvKwhTomorrow captured');
  assert.strictEqual(rec.maxChP, 0.30, 'maxChargePrice captured');
  assert.strictEqual(rec.floorPct0, +(engine._lastDpArrays.reserveFloorG[0] / 10).toFixed(1),
    'floorPct0 is the t=0 floor in percent');
  ok('record carries one entry per slot in every per-slot field');
}

// --- the src stamp: every action is attributable to the layer that wrote it ----------------------
// Without this the trace puts the backward DP's t=0 values next to an action that a post-DP pass
// may have rewritten, and the difference reads as the DP changing its mind. Measured live on
// 2026-08-15: 7 of 10 runs "diverged" with no way to say which pass did it.
{
  const engine = runEngine();
  const n = engine._schedule.slots.length;
  const rec = build.call(ctx('/tmp'), {
    engine, now: Date.parse('2026-06-01T12:00:00Z'), soc: 50,
    refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });

  const known = new Set(Object.values(OptimizationEngine.ACTION_SRC));
  assert.strictEqual(rec.src.length, n, 'one src char per slot');
  assert.ok(!/\?/.test(rec.src), `every slot names its writer, got ${rec.src}`);
  for (const c of rec.src) assert.ok(known.has(c), `unknown src char ${c} in ${rec.src}`);

  // The invariant the stamp exists to enforce: slot 0 may only carry the DP's own label when the
  // executed action still IS the DP's t=0 pick. Any disagreement must name a different writer.
  const { ACTION_SRC } = OptimizationEngine;
  const act0 = { P: 'preserve', C: 'charge', D: 'discharge', S: 'standby', T: 'trickle' }[rec.act[0]];
  if (rec.src[0] === ACTION_SRC.DP) {
    assert.strictEqual(act0, rec.v0.act, `src says the DP owns slot 0 but ${act0} !== ${rec.v0.act}`);
  } else {
    assert.notStrictEqual(act0, rec.v0.act, `slot 0 is stamped ${rec.src[0]} yet matches the DP's pick`);
  }
  ok('src stamps every slot with the layer that wrote its action');
}

// --- a post-DP rewrite is credited to the pass, not to the DP ------------------------------------
// The feasibility sweep relabels a discharge slot sitting at the reserve floor. Whatever it
// touches must stop being 'D', or the attribution is decorative.
{
  const engine = runEngine();
  const { ACTION_SRC } = OptimizationEngine;
  const known2 = new Set(Object.values(ACTION_SRC));
  const slots = engine._schedule.slots;
  const floor = engine._lastDpArrays.reserveFloorG;
  for (let t = 0; t < slots.length; t++) {
    if (slots[t].action === 'discharge') {
      assert.ok(slots[t].socProjected > floor[t] / 10,
        `slot ${t} discharges at the floor and should have been relabelled`);
    }
    if (slots[t].actionSrc !== ACTION_SRC.DP) {
      assert.ok(known2.has(slots[t].actionSrc), `slot ${t} carries an unknown writer ${slots[t].actionSrc}`);
    }
  }
  ok('no discharge slot survives at the reserve floor unattributed');
}

// --- the charge-repay shadow counter survives the run ---------------------------------------------
// _chargeRepayDebug decides whether dp_charge_repay_gate is worth switching on, but it lives on the
// engine and every run overwrites it: policy_last_run_debug keeps exactly one sample. Carrying it in
// the trace is what turns it into a series that can be counted over days.
{
  const engine = runEngine();
  const rec = build.call(ctx('/tmp'), {
    engine, now: Date.parse('2026-06-01T12:00:00Z'), soc: 50,
    refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });
  const dbg = engine._chargeRepayDebug;
  assert.ok(dbg, 'compute() stashes _chargeRepayDebug');
  assert.ok(rec.repay, 'the trace record carries the repay counter');
  assert.strictEqual(rec.repay.flag, dbg.flag, 'flag mirrors the engine');
  assert.strictEqual(rec.repay.n, dbg.wouldFire, 'wouldFire mirrors the engine');
  assert.strictEqual(rec.repay.kwh, +dbg.kwh.toFixed(3), 'kwh mirrors the engine');
  assert.strictEqual(rec.repay.short, +dbg.worstShortfall.toFixed(4), 'worstShortfall mirrors the engine');
  assert.strictEqual(rec.repay.at, dbg.worstAt, 'worstAt mirrors the engine');
  ok('the trace carries the charge-repay shadow counter');
}

// --- a probe pass must not clobber the shipped run's repay counter --------------------------------
// Same trap as _lastDpArrays above: computeExpectedProfit() re-runs the DP, and if the counter were
// written on that path every trace after a "what if" call would describe the wrong run.
{
  const engine = runEngine();
  const before = { ...engine._chargeRepayDebug };
  engine.computeExpectedProfit(prices, 50, 9.0, 2200, 800, pv, 0.90, cons);
  assert.deepStrictEqual({ ...engine._chargeRepayDebug }, before,
    'a probe pass leaves the shipped run\'s repay counter untouched');
  ok('probe pass does not clobber the repay counter');
}

// --- size: a 68-slot horizon must stay writable ~96x/day for 23 days ------------------------------
{
  const engine = new OptimizationEngine(SETTINGS);
  const p68 = [], pv68 = [], c68 = [];
  for (let t = 0; t < 68; t++) {
    p68.push({ timestamp: new Date(base + t * H).toISOString(), price: 0.12 + (t % 7) * 0.03 });
    pv68.push({ timestamp: new Date(base + t * H).toISOString(), pvPowerW: (t % 24 >= 9 && t % 24 <= 15) ? 3000 : 0 });
    c68.push(600);
  }
  engine.compute(p68, 50, 5.4, 2200, 800, pv68, 0.90, c68, 0.05, 1.0, 3.0, 3.0, 1.0, 0.5, false, 0.30);
  const rec = build.call(ctx('/tmp'), {
    engine, now: Date.now(), soc: 50, refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });
  const bytes = JSON.stringify(rec).length;
  assert.ok(bytes < 3000, `a 68-slot record must stay under 3 kB, got ${bytes} B`);
  ok(`68-slot record is ${bytes} B (< 3 kB)`);
}

// --- missing engine state yields null, never a half record ---------------------------------------
{
  const self = ctx('/tmp');
  const args = { now: Date.now(), soc: 50, refillConfidence: 1, pvKwhTomorrow: 0, maxChargePrice: 0.3 };
  assert.strictEqual(build.call(self, { ...args, engine: null }), null, 'no engine → null');
  assert.strictEqual(build.call(self, { ...args, engine: {} }), null, 'no schedule → null');

  const engine = runEngine();
  const noDebug = { _schedule: engine._schedule, _flattenDebug: null, _lastDpArrays: engine._lastDpArrays };
  assert.strictEqual(build.call(self, { ...args, engine: noDebug }), null, 'no _flattenDebug → null');

  const noArrays = { _schedule: engine._schedule, _flattenDebug: engine._flattenDebug, _lastDpArrays: null };
  assert.strictEqual(build.call(self, { ...args, engine: noArrays }), null, 'no arrays → null');
  ok('missing engine state yields null, not a half record');
}

// --- append: one line per run, round-trips as JSON ------------------------------------------------
{
  const dir  = tmpdir();
  const self = ctx(dir);
  const engine = runEngine();
  const mk = (iso) => build.call(self, {
    engine, now: Date.parse(iso), soc: 50, refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });

  const file = append.call(self, mk('2026-06-01T10:00:00Z'));
  append.call(self, mk('2026-06-01T10:15:00Z'));
  append.call(self, mk('2026-06-01T10:30:00Z'));

  assert.ok(/dp-trace-2026-06-01\.jsonl$/.test(file), `unexpected file name ${file}`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 3, 'one line per run, appended not overwritten');
  const back = lines.map((l) => JSON.parse(l));
  assert.deepStrictEqual(back.map((r) => r.ts), [
    '2026-06-01T10:00:00.000Z', '2026-06-01T10:15:00.000Z', '2026-06-01T10:30:00.000Z',
  ], 'lines round-trip in write order');
  assert.strictEqual(back[0].act.length, back[0].n, 'per-slot fields survive the round-trip');

  // Only the first write of the day names the file; the other ~95 stay quiet.
  assert.strictEqual(self.logs.filter((m) => /DP-TRACE/.test(m)).length, 1, 'exactly one log line per day');
  assert.strictEqual(append.call(self, null), null, 'a null record is a no-op');
  ok('append writes one line per run and logs once per day');
}

// --- rotation: past MODE_HISTORY_DAYS goes, mode-history stays -------------------------------------
{
  const dir  = tmpdir();
  const self = ctx(dir);
  const engine = runEngine();

  // Day 0 is what we are about to write; keep MODE_HISTORY_DAYS-1 days back, drop older.
  const day = (offset) => new Date(Date.UTC(2026, 5, 1) - offset * 86400000).toISOString().slice(0, 10);
  const fresh = day(DAYS - 1);
  const stale = day(DAYS);
  fs.writeFileSync(`${dir}/dp-trace-${fresh}.jsonl`, '{}\n');
  fs.writeFileSync(`${dir}/dp-trace-${stale}.jsonl`, '{}\n');
  fs.writeFileSync(`${dir}/mode-history-${stale}.json`, '[]');
  fs.writeFileSync(`${dir}/baseload-state.json`, '{}');

  append.call(self, build.call(self, {
    engine, now: Date.parse('2026-06-01T10:00:00Z'), soc: 50,
    refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  }));

  assert.ok(fs.existsSync(`${dir}/dp-trace-${fresh}.jsonl`), `a ${DAYS - 1}-day-old trace survives`);
  assert.ok(!fs.existsSync(`${dir}/dp-trace-${stale}.jsonl`), `a ${DAYS}-day-old trace is pruned`);
  assert.ok(fs.existsSync(`${dir}/mode-history-${stale}.json`), 'mode-history is not ours to prune');
  assert.ok(fs.existsSync(`${dir}/baseload-state.json`), 'baseload state survives rotation');
  ok(`rotation keeps ${DAYS} days and ignores foreign files`);
}

// --- an unwritable dir degrades to an error line ---------------------------------------------------
{
  const self = ctx('/proc/definitely-not-writable');
  const engine = runEngine();
  const rec = build.call(self, {
    engine, now: Date.now(), soc: 50, refillConfidence: 0.5, pvKwhTomorrow: 3.0, maxChargePrice: 0.30,
  });
  let result;
  assert.doesNotThrow(() => { result = append.call(self, rec); },
    'a failed trace write must never throw into the policy run');
  assert.strictEqual(result, null, 'a failed append returns null');
  assert.ok(self.logs.some((m) => /DP-TRACE/.test(m)), 'the failure is logged');
  ok('unwritable dir degrades to an error line');
}

console.log(`\n${passed} passed`);
