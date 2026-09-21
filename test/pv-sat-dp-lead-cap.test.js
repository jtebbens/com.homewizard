'use strict';

/**
 * The satellite leg may only feed the DP for the running hour and the one after it.
 *
 * Why this exists: a MSG-CPP image carries a quarter-hour issue stamp but reaches the app ~45 min
 * later (verified 2026-09-20 on six dp-input dumps: issue 08:45 seen 09:30, 09:45 seen 10:30,
 * 10:45 seen 11:30). SAT_MAX_AGE_MS rejects it past 60 min, so it is usable for one run and stale
 * for the next. With pv_sat_full_override on, that flipped every slot up to 4 h ahead between the
 * satellite value (weight 1.00) and Open-Meteo, and the plan flipped with it: on 2026-09-20 the
 * blended PV went 9.1 kWh -> 5.6 kWh between two runs 15 min apart, which is the difference
 * between preserving and planning a grid charge.
 *
 * The measurement that decides the cap was re-run 2026-09-21 over a wider window: 806 hourly
 * buckets, 2026-08-06..2026-09-20, [SAT blend] rows against realized roof production. Percentages
 * are the MAE as a share of the mean production in those same hours - both legs are coarse, which
 * the earlier absolute-only table hid:
 *
 *   lead 0h: n=240  OM 303 W (28%)  sat 226 W (21%)   <- satellite wins
 *   lead 1h: n=239  OM 296 W (29%)  sat 315 W (30%)   <- level
 *   lead 2h: n=218  OM 286 W (30%)  sat 338 W (35%)
 *   lead 3h: n=108  OM 275 W (32%)  sat 367 W (42%)
 *
 * Lead 1 is a tie on MAE, and the two legs lean opposite ways (OM -110 W, sat +61 W), so a 50/50
 * mix scored 262 W there against OM's 296 W. Second reason for including lead 1: the elevation
 * gate drops the satellite below SAT_MIN_ELEV_DEG, so on an autumn morning lead 0 is gated out and
 * a cap of 0 leaves the DP with no satellite at all while a fresh image holds usable hours
 * (live 2026-09-21 06:30-06:59Z). Window is 2026-08..09 only; no autumn or winter data yet.
 *
 * So the leg is capped at one hour ahead. Freshness (`_satSlotIsFresh`) is unchanged and still
 * gates on image age; the lead window is the second, independent gate mirrored here as
 * `satSlotsForDp`, matching the two conditions in device.js's blend loop.
 */

const assert = require('assert');
const Module = require('module');

// Stub 'homey' + heavy device-deps so battery-policy/device.js loads outside Homey.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};
const BatteryPolicyDevice = require('../drivers/battery-policy/device.js');
Module.prototype.require = origRequire;

const HOUR = 3600_000;

// Frozen from the two real dumps 15 min apart, tools/_dpdumps/dp-input-20260920T103010.831Z.json
// and dp-input-20260920T104500.439Z.json (harvested, gitignored — hence copied in). Same image
// (issue 09:45Z) on all four slots; pvPowerW is the Open-Meteo leg before the blend.
const ISSUE_MS = Date.parse('2026-09-20T09:45:00.000Z');
const RUN_FRESH = Date.parse('2026-09-20T10:30:10.831Z'); // image 45 min old -> usable
const RUN_STALE = Date.parse('2026-09-20T10:45:00.439Z'); // image 60.007 min old -> rejected

const SLOTS = [
  { timestamp: '2026-09-20T10:00:00.000Z', pvPowerW: 1909, satPanelW: 2399, satIssueMs: ISSUE_MS },
  { timestamp: '2026-09-20T11:00:00.000Z', pvPowerW: 1879, satPanelW: 2278, satIssueMs: ISSUE_MS },
  { timestamp: '2026-09-20T12:00:00.000Z', pvPowerW: 1365, satPanelW: 1853, satIssueMs: ISSUE_MS },
  { timestamp: '2026-09-20T13:00:00.000Z', pvPowerW: 1280, satPanelW: 1565, satIssueMs: ISSUE_MS },
  { timestamp: '2026-09-20T14:00:00.000Z', pvPowerW: 772, satPanelW: null, satIssueMs: null },
  { timestamp: '2026-09-20T15:00:00.000Z', pvPowerW: 436, satPanelW: null, satIssueMs: null },
];

// Mirrors the gate in device.js's blend loop: a slot carries satellite into the DP only when the
// image is fresh AND the slot sits inside the lead window.
function satSlotsForDp(slots, nowMs, maxLeadH) {
  return slots
    .filter(s => BatteryPolicyDevice._satSlotIsFresh(s, nowMs)
      && BatteryPolicyDevice._satSlotInLeadWindow(s, nowMs, maxLeadH))
    .map(s => s.timestamp);
}

const leadHours = (ts, nowMs) => Math.round(
  (Date.parse(ts) - Math.floor(nowMs / HOUR) * HOUR) / HOUR,
);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('pv-sat-dp-lead-cap');

// 1. The regression itself: whatever the image age does, no slot two hours or more ahead may take
//    its PV from the satellite. That is the input the DP plans its charge slots on, and it is the
//    swing that made the plan ping-pong. Before any cap this held 3 slots ahead at RUN_FRESH; the
//    cap now holds back the two that scored worse than Open-Meteo and keeps the one that tied.
check('no slot >=2h ahead carries satellite, at either run time', () => {
  for (const [label, nowMs] of [['fresh', RUN_FRESH], ['stale', RUN_STALE]]) {
    const ahead = satSlotsForDp(SLOTS, nowMs, undefined).filter(ts => leadHours(ts, nowMs) >= 2);
    assert.deepStrictEqual(ahead, [], `${label} run leaked ${ahead.length} slot(s) ahead: ${ahead}`);
  }
});

// 2. Lead 0 and lead 1 survive — the cap must not silence the satellite where it measures at least
//    as good as Open-Meteo, and lead 1 is the hour that remains when the elevation gate takes 0.
check('running hour and the next carry satellite while the image is fresh', () => {
  assert.deepStrictEqual(
    satSlotsForDp(SLOTS, RUN_FRESH, undefined),
    ['2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z'],
  );
});

// 3. Freshness keeps its own say: a stale image drops out entirely, cap or no cap.
check('stale image yields no satellite slots at all', () => {
  assert.deepStrictEqual(satSlotsForDp(SLOTS, RUN_STALE, undefined), []);
  assert.deepStrictEqual(satSlotsForDp(SLOTS, RUN_STALE, 3), []);
});

// 4. Window arithmetic, anchored on the hour rather than on a millisecond difference: at 10:30 the
//    10:00 slot is lead 0, the 11:00 slot is lead 1. A `slotMs < nowMs + 1h` formula would let the
//    11:00 slot in for all but the first millisecond of the hour.
check('lead window is hour-indexed, not a rolling millisecond difference', () => {
  const at = ts => ({ timestamp: ts, satPanelW: 100, satIssueMs: ISSUE_MS });
  const inWin = (ts, lead) => BatteryPolicyDevice._satSlotInLeadWindow(at(ts), RUN_FRESH, lead);
  assert.strictEqual(inWin('2026-09-20T10:00:00.000Z', 0), true, 'lead 0 must be in at cap 0');
  assert.strictEqual(inWin('2026-09-20T11:00:00.000Z', 0), false, 'lead 1 must be out at cap 0');
  assert.strictEqual(inWin('2026-09-20T11:00:00.000Z', 1), true, 'lead 1 must be in at cap 1');
  assert.strictEqual(inWin('2026-09-20T12:00:00.000Z', 1), false, 'lead 2 must be out at cap 1');
  assert.strictEqual(inWin('2026-09-20T09:00:00.000Z', 1), false, 'past hour must be out');
  // Same call one millisecond before the hour rolls: the answer may not change.
  const justBefore = Date.parse('2026-09-20T10:59:59.999Z');
  assert.strictEqual(
    BatteryPolicyDevice._satSlotInLeadWindow(at('2026-09-20T12:00:00.000Z'), justBefore, 1),
    false,
    'lead 2 must stay out right up to the hour boundary',
  );
});

// 5. Default is the cap. Reading the constant through the default argument pins that the shipped
//    behaviour is lead 0-1, not whatever a caller happens to pass.
check('default lead window is the running hour plus one', () => {
  const s = { timestamp: '2026-09-20T12:00:00.000Z', satPanelW: 100, satIssueMs: ISSUE_MS };
  assert.strictEqual(BatteryPolicyDevice._satSlotInLeadWindow(s, RUN_FRESH), false);
  for (const ts of ['2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z']) {
    assert.strictEqual(
      BatteryPolicyDevice._satSlotInLeadWindow({ ...s, timestamp: ts }, RUN_FRESH),
      true,
      `${ts} must be inside the default window`,
    );
  }
});

// 6. The kill switch path: lead 3 restores exactly the pre-cap set, so reverting is one setting.
check('maxLeadH=3 restores the old four-slot set', () => {
  assert.deepStrictEqual(satSlotsForDp(SLOTS, RUN_FRESH, 3), [
    '2026-09-20T10:00:00.000Z',
    '2026-09-20T11:00:00.000Z',
    '2026-09-20T12:00:00.000Z',
    '2026-09-20T13:00:00.000Z',
  ]);
});

// 7. Junk in, false out — same contract as _satSlotIsFresh, which is fed the same slots.
check('rejects junk without throwing', () => {
  assert.strictEqual(BatteryPolicyDevice._satSlotInLeadWindow(null, RUN_FRESH), false);
  assert.strictEqual(BatteryPolicyDevice._satSlotInLeadWindow(undefined, RUN_FRESH), false);
  assert.strictEqual(BatteryPolicyDevice._satSlotInLeadWindow({}, RUN_FRESH), false);
  assert.strictEqual(
    BatteryPolicyDevice._satSlotInLeadWindow({ timestamp: 'not-a-date' }, RUN_FRESH), false,
  );
  assert.strictEqual(
    BatteryPolicyDevice._satSlotInLeadWindow({ timestamp: '2026-09-20T10:00:00.000Z' }, NaN), false,
  );
});

// 8. Spatial spread gate. Measured 2026-09-21 (n=1606 hourly buckets, 06-08..21-09): ahead of the
// running hour the satellite goes from best to worst as the cloud field breaks up (lead 1h, top
// spread quintile: sat MAE 525 W vs Open-Meteo 385 W), while at lead 0 it wins in every quintile.
// The taper encodes exactly that split, so these checks pin the split itself, not the constants.
const SSTD_RUN = Date.parse('2026-09-20T10:30:00.000Z'); // running hour = 10:00Z
const withSstd = (ts, sstd) => ({ timestamp: ts, satSstd: sstd });

check('a broken sky never touches the running hour', () => {
  for (const sstd of [0, 26, 41, 120]) {
    assert.strictEqual(
      BatteryPolicyDevice._satSstdTrust(withSstd('2026-09-20T10:00:00.000Z', sstd), SSTD_RUN), 1,
      `lead 0 must keep full trust at sstd=${sstd}`,
    );
  }
});

check('ahead of the running hour, trust tapers from uniform to broken sky', () => {
  const t = sstd => BatteryPolicyDevice._satSstdTrust(withSstd('2026-09-20T11:00:00.000Z', sstd), SSTD_RUN);
  assert.strictEqual(t(0), 1, 'uniform sky keeps the leg at full strength');
  assert.strictEqual(t(26), 1, 'taper must not start below the measured crossover');
  assert.strictEqual(t(41), 0, 'past the crossover the leg steps aside entirely');
  assert.strictEqual(t(120), 0, 'and stays aside beyond it');
  const mid = t(33.5);
  assert.ok(mid > 0 && mid < 1, `between the two the trust interpolates, got ${mid}`);
  assert.ok(t(30) > t(38), 'trust must fall as the spread grows');
});

check('a missing spread reading is not treated as a broken sky', () => {
  for (const sstd of [null, undefined, NaN, -1, 'x']) {
    assert.strictEqual(
      BatteryPolicyDevice._satSstdTrust({ timestamp: '2026-09-20T11:00:00.000Z', satSstd: sstd }, SSTD_RUN), 1,
      `sstd=${String(sstd)} must fall back to full trust`,
    );
  }
  assert.strictEqual(BatteryPolicyDevice._satSstdTrust(null, SSTD_RUN), 1);
  assert.strictEqual(
    BatteryPolicyDevice._satSstdTrust(withSstd('2026-09-20T11:00:00.000Z', 99), NaN), 1,
  );
});

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
