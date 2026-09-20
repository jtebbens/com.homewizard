'use strict';

/**
 * The satellite leg may only feed the DP for the hour that is running.
 *
 * Why this exists: a MSG-CPP image carries a quarter-hour issue stamp but reaches the app ~45 min
 * later (verified 2026-09-20 on six dp-input dumps: issue 08:45 seen 09:30, 09:45 seen 10:30,
 * 10:45 seen 11:30). SAT_MAX_AGE_MS rejects it past 60 min, so it is usable for one run and stale
 * for the next. With pv_sat_full_override on, that flipped every slot up to 4 h ahead between the
 * satellite value (weight 1.00) and Open-Meteo, and the plan flipped with it: on 2026-09-20 the
 * blended PV went 9.1 kWh -> 5.6 kWh between two runs 15 min apart, which is the difference
 * between preserving and planning a grid charge.
 *
 * The measurement that decides the cap (2026-09-09, n=2579, 18-08..09-09, from the [SAT blend]
 * lines against realized roof production) says the satellite only earns its weight on lead 0:
 *
 *   lead 0h: n=1347  OM 306 W  sat 276 W   <- satellite wins
 *   lead 1h: n= 664  OM 298 W  sat 354 W
 *   lead 2h: n= 488  OM 296 W  sat 404 W
 *   lead 3h: n=  80  OM 215 W  sat 341 W
 *
 * So the leg is capped at the running hour. Freshness (`_satSlotIsFresh`) is unchanged and still
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

// 1. The regression itself: whatever the image age does, no slot an hour or more ahead may take
//    its PV from the satellite. That is the input the DP plans its charge slots on, and it is the
//    swing that made the plan ping-pong. Before the cap this held 3 slots at RUN_FRESH.
check('no slot >=1h ahead carries satellite, at either run time', () => {
  for (const [label, nowMs] of [['fresh', RUN_FRESH], ['stale', RUN_STALE]]) {
    const ahead = satSlotsForDp(SLOTS, nowMs, undefined).filter(ts => leadHours(ts, nowMs) >= 1);
    assert.deepStrictEqual(ahead, [], `${label} run leaked ${ahead.length} slot(s) ahead: ${ahead}`);
  }
});

// 2. Lead 0 survives — the cap must not silence the satellite where it is measured to be better.
check('running hour still carries satellite while the image is fresh', () => {
  assert.deepStrictEqual(
    satSlotsForDp(SLOTS, RUN_FRESH, undefined),
    ['2026-09-20T10:00:00.000Z'],
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
  assert.strictEqual(inWin('2026-09-20T10:00:00.000Z', 0), true, 'lead 0 must be in');
  assert.strictEqual(inWin('2026-09-20T11:00:00.000Z', 0), false, 'lead 1 must be out');
  assert.strictEqual(inWin('2026-09-20T12:00:00.000Z', 0), false, 'lead 2 must be out');
  assert.strictEqual(inWin('2026-09-20T09:00:00.000Z', 0), false, 'past hour must be out');
  // Same call one millisecond before the hour rolls: the answer may not change.
  const justBefore = Date.parse('2026-09-20T10:59:59.999Z');
  assert.strictEqual(
    BatteryPolicyDevice._satSlotInLeadWindow(at('2026-09-20T11:00:00.000Z'), justBefore, 0),
    false,
    'lead 1 must stay out right up to the hour boundary',
  );
});

// 5. Default is the cap. Reading the constant through the default argument pins that the shipped
//    behaviour is lead 0, not whatever a caller happens to pass.
check('default lead window is the running hour only', () => {
  const s = { timestamp: '2026-09-20T11:00:00.000Z', satPanelW: 100, satIssueMs: ISSUE_MS };
  assert.strictEqual(BatteryPolicyDevice._satSlotInLeadWindow(s, RUN_FRESH), false);
  assert.strictEqual(
    BatteryPolicyDevice._satSlotInLeadWindow(
      { ...s, timestamp: '2026-09-20T10:00:00.000Z' }, RUN_FRESH,
    ),
    true,
  );
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

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
