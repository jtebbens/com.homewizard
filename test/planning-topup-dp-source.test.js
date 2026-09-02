'use strict';

// Regression: the planning mapper must read the DP's own top-up decision, not re-derive it.
//
// The top-up decision existed three times: the DP's `topupForced` flag (optimization-engine.js,
// which is what advances socProjected), the runtime mapper's `lowSocGridTopUp`, and the planning
// mapper's second copy of that same derivation. Both mapper copies added a gate the DP does not
// have (`pvHeadroomGateOpen` on pvKwhTomorrow + refillConfidence). When that gate opened, the
// planning mapper dropped through to the `preserve:export_wins` branch and returned standby —
// while the DP's socProjected kept the grid-charge path.
//
// Live 2026-09-02: 13:45 and 14:00 carried hwMode 'standby' (battery idle), pvCoverage 0 (no PV
// to store) and socProjected +7.4pp per slot (= 800 W grid charge). The chart promised SoC
// 18 → 33% that the mapped mode cannot deliver; the evening discharge then starts from 18%.
//
// Contract now: on a slot the DP flagged topupForced, the planning mapper charges. And no slot
// may ever carry a non-charging hwMode together with a rising DP SoC — buildPlanningSchedule
// re-simulates and flags those instead of passing the DP curve through.

const assert = require('assert');
const PolicyEngine = require('../lib/policy-engine');

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

const homey = { log() {} };
const SETTINGS = {
  tariff_type: 'dynamic',
  tariff_model: 'saldering',
  battery_efficiency: 0.7315858112370611,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  max_charge_price: 0.12,
  min_discharge_price: 0.22,
  respect_minmax: false,
  policy_mode: 'balanced',
};

const makeEngine = () => new PolicyEngine(homey, { ...SETTINGS });

const CAP_KWH  = 2.69;
const CHARGE_W = 800;
// Dynamic ceiling, as device.js passes it live — above the flat €0.12 setting.
const MAX_CHARGE_PRICE = 0.26;
// pvKwhTomorrow ≥ capacity × 0.9 and refillConfidence ≥ 0.8 → pvHeadroomGateOpen() is true,
// which is exactly what switched the mapper's own top-up derivation off live.
const PV_KWH_TOMORROW  = 10;
const REFILL_CONF      = 1.0;

// 13:30 Amsterdam (CEST) — the live slots, price at the day trough.
const START = new Date('2026-09-02T11:30:00.000Z');
const QUARTER = 15 * 60_000;

// socProjected is the value at the START of the slot, so a slot charges when the NEXT
// slot's value is higher. Slots 1 and 2 are the two the DP tops up.
const makeSlots = ({ topupOn }) => {
  const soc = [18, 18, 25.2, 32.6, 32.6];
  return soc.map((s, i) => ({
    timestamp: new Date(START.getTime() + i * QUARTER).toISOString(),
    action: 'preserve',
    price: 0.252,
    socProjected: s,
    consumptionW: 550,
    pvCoverage: 0,
    // Store value below the export value → the `preserve:export_wins` branch fires,
    // which is the branch that returned standby live.
    pvStoreValue: 0.244,
    exportPrice: null,
    topupForced: topupOn.includes(i),
  }));
};

const build = (engine, slots) => engine.buildPlanningSchedule(
  slots,
  null,             // pvForecast → pvW 0 on every slot, no PV to store
  0.118,            // minDischargePrice
  CHARGE_W,
  MAX_CHARGE_PRICE,
  CAP_KWH,
  PV_KWH_TOMORROW,
  REFILL_CONF,
);

const CHARGING_MODES = ['to_full', 'zero_charge_only', 'pv_trickle'];

// The invariant the live bug violated, checked over a whole schedule.
function assertNoIdleModeWithRisingSoc(result) {
  for (let i = 0; i < result.length - 1; i++) {
    const rise = result[i + 1].socProjected - result[i].socProjected;
    if (rise > 0.05 && !CHARGING_MODES.includes(result[i].hwMode)) {
      assert.fail(`slot ${i} (${result[i].timestamp}) maps to '${result[i].hwMode}' `
        + `but SoC rises ${rise.toFixed(1)}pp — mode cannot deliver that charge `
        + `(reason: ${result[i].reason})`);
    }
  }
}

console.log('\nPlanning mapper — DP owns the top-up decision\n');

test('DP topupForced → planning charges, even with the PV-headroom gate open', () => {
  const engine = makeEngine();
  const result = build(engine, makeSlots({ topupOn: [1, 2] }));

  assert.strictEqual(result[1].hwMode, 'to_full',
    `slot 1 should follow the DP top-up, got '${result[1].hwMode}' (${result[1].reason})`);
  assert.strictEqual(result[2].hwMode, 'to_full',
    `slot 2 should follow the DP top-up, got '${result[2].hwMode}' (${result[2].reason})`);
  assertNoIdleModeWithRisingSoc(result);
});

test('no DP top-up → mapper idles AND the SoC line stops rising with it', () => {
  const engine = makeEngine();
  // Same DP curve, but the DP did not flag a top-up. The mapper is then free to idle —
  // it may not keep publishing the DP's charge path underneath a standby mode.
  const result = build(engine, makeSlots({ topupOn: [] }));

  assert.ok(!CHARGING_MODES.includes(result[1].hwMode),
    `slot 1 should idle without a DP top-up, got '${result[1].hwMode}'`);
  assert.strictEqual(result[1].socOverride, true,
    'idling over a DP charge must be flagged as an override so [PLANTILE] counts it');
  // The published curve must not carry the DP's charge under the idled mode. (The re-seed
  // back onto the DP curve on the next agreeing slot is existing, deliberate behaviour —
  // buildPlanningSchedule measures that gap as maxGapPp.)
  assert.strictEqual(result[2].socProjected, result[1].socProjected,
    `SoC must stay flat across an idled slot, got ${result[1].socProjected} → ${result[2].socProjected}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
