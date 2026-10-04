'use strict';

/**
 * Regression: a DP 'preserve' slot where the DP does NOT store the PV surplus must not be
 * turned into a force-store by the policy layer.
 *
 * Live 2026-09-29 08:00Z (10:00 CEST), v3.19.7:
 *   DynamicChargePrice: maxFuturePrice=€0.428, rte=0.732, cycleCost=€0.075, dynamic=€0.238
 *   PV OVERSCHOT: DP koos preserve ⇒ opslaan
 *   [MAPPING] policyMode=preserve, soc=5, PV=true (... netSurplus≈841W), price=0.359
 *   Recommendation: hwMode 'zero_charge_only'  → battery charged ~794W from PV
 * Export earns €0.359/kWh (saldering), storing is worth €0.428 × 0.732 − 0.075 = €0.238/kWh.
 *
 * The DP's forward pass only books free PV on a preserve slot at pvGainCoverage (flags off:
 * the strong band, plus its store-vs-export test) — here pvCoverage 0.31 is below it, so
 * socProjected stays flat: the plan exports this surplus. policy-engine's "DP koos preserve"
 * branch (b74ab6c2 / d232d40b) read every preserve as "store", which is only what the DP
 * decided on slots where it actually credits the PV.
 *
 * Arrays: policy_optimizer_schedule of the live 07:30Z run, from the 08:00Z slot on
 * (248 × 15 min). Must FAIL before the fix and PASS after.
 */

const assert = require('assert');
const OptimizationEngine = require('../lib/optimization-engine');
const PolicyEngine = require('../lib/policy-engine');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const Q = 900_000;
const base = new Date('2026-09-29T08:00:00Z').getTime();

const priceVals = [
  0.359, 0.3436, 0.3346, 0.314, 0.3056, 0.2988, 0.2777, 0.2643, 0.2598, 0.2481, 0.2465, 0.229,
  0.2363, 0.2255, 0.2165, 0.2103, 0.2103, 0.2265, 0.2374, 0.244, 0.2394, 0.2621, 0.2745, 0.2868,
  0.2691, 0.3044, 0.3246, 0.3699, 0.3452, 0.368, 0.3769, 0.3927, 0.3857, 0.4032, 0.4129, 0.4277,
  0.4253, 0.4085, 0.3905, 0.373, 0.3663, 0.3574, 0.3504, 0.3431, 0.3535, 0.3413, 0.3359, 0.3351,
  0.3397, 0.3309, 0.3332, 0.3136, 0.2999, 0.2964, 0.2866, 0.2794, 0.3052, 0.3084, 0.3001, 0.2977,
  0.2971, 0.2932, 0.2919, 0.2902, 0.2982, 0.3, 0.2981, 0.2967, 0.2962, 0.2944, 0.2908, 0.2955,
  0.2963, 0.2987, 0.3049, 0.3082, 0.3028, 0.3014, 0.3103, 0.3117, 0.3161, 0.3269, 0.3276, 0.3443,
  0.3511, 0.3517, 0.3519, 0.3494, 0.3618, 0.3568, 0.346, 0.323, 0.3303, 0.3157, 0.3046, 0.29,
  0.2964, 0.2871, 0.2786, 0.2736, 0.2665, 0.2628, 0.2719, 0.2622, 0.2573, 0.2517, 0.2441, 0.2345,
  0.2337, 0.2354, 0.2259, 0.2273, 0.2281, 0.2336, 0.2288, 0.2501, 0.2654, 0.2749, 0.285, 0.297,
  0.3077, 0.3154, 0.3199, 0.3515, 0.3465, 0.3594, 0.3677, 0.387, 0.3834, 0.4047, 0.4252, 0.4345,
  0.4351, 0.4312, 0.4195, 0.4089, 0.4071, 0.396, 0.3939, 0.3962, 0.3894, 0.3797, 0.3791, 0.3761,
  0.3768, 0.3676, 0.3639, 0.3541, 0.3486, 0.3413, 0.3406, 0.3374, 0.3401, 0.3417, 0.3322, 0.3323,
  0.3269, 0.3302, 0.3243, 0.3212, 0.3236, 0.3209, 0.3186, 0.3185, 0.3185, 0.3211, 0.3223, 0.3211,
  0.3181, 0.3206, 0.3225, 0.3233, 0.3553, 0.3586, 0.3667, 0.371, 0.378, 0.3902, 0.3983, 0.4035,
  0.4084, 0.4228, 0.4221, 0.4195, 0.4281, 0.4285, 0.4243, 0.4216, 0.4282, 0.4022, 0.376, 0.3678,
  0.3736, 0.3705, 0.3703, 0.3657, 0.3703, 0.3257, 0.3176, 0.3078, 0.2939, 0.2831, 0.277, 0.2692,
  0.2622, 0.2642, 0.2629, 0.2738, 0.2781, 0.2756, 0.2855, 0.2696, 0.2787, 0.2966, 0.3105, 0.324,
  0.3363, 0.3424, 0.3615, 0.3822, 0.4004, 0.4138, 0.4082, 0.4393, 0.4307, 0.4403, 0.4551, 0.4789,
  0.4738, 0.4724, 0.4697, 0.4698, 0.4678, 0.4663, 0.4511, 0.4388, 0.4579, 0.4332, 0.427, 0.4179,
  0.4216, 0.4054, 0.3966, 0.3943, 0.3945, 0.3877, 0.3877, 0.3743,
];
const pvVals = [
  819, 904, 989, 1074, 1159, 1176, 1192, 1209, 1225, 1234, 1243, 1251,
  1260, 1228, 1196, 1164, 1132, 1060, 988, 915, 843, 732, 621, 509,
  398, 354, 311, 267, 223, 196, 169, 141, 114, 86, 57, 29,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 5,
  6, 61, 116, 171, 226, 389, 553, 716, 879, 1004, 1130, 1255,
  1380, 1408, 1436, 1464, 1492, 1482, 1473, 1463, 1453, 1369, 1285, 1201,
  1117, 1016, 915, 813, 712, 654, 595, 537, 478, 420, 363, 305,
  247, 223, 198, 174, 149, 126, 102, 79, 55, 41, 28, 14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const consVals = [
  573, 596, 660, 649, 705, 585, 524, 448, 451, 1188, 794, 736,
  677, 549, 477, 481, 725, 500, 471, 892, 546, 532, 619, 507,
  477, 469, 656, 461, 501, 1042, 1083, 568, 500, 950, 534, 515,
  459, 491, 477, 461, 461, 473, 475, 481, 512, 552, 697, 667,
  615, 608, 576, 542, 544, 578, 581, 527, 563, 604, 456, 326,
  336, 355, 388, 258, 311, 300, 278, 302, 334, 359, 333, 348,
  350, 325, 330, 305, 284, 281, 301, 306, 306, 301, 404, 389,
  405, 404, 404, 464, 285, 419, 341, 330, 432, 674, 495, 1072,
  1487, 862, 826, 977, 688, 765, 1604, 1735, 647, 706, 1051, 1409,
  870, 709, 796, 724, 494, 992, 992, 990, 1002, 776, 679, 782,
  869, 1162, 1154, 1152, 1118, 1495, 721, 879, 764, 679, 565, 458,
  487, 394, 417, 419, 467, 419, 448, 500, 484, 449, 548, 624,
  597, 571, 584, 592, 593, 608, 597, 555, 452, 363, 414, 276,
  279, 325, 295, 276, 297, 386, 325, 325, 368, 327, 323, 296,
  300, 283, 299, 319, 292, 282, 373, 342, 340, 360, 365, 346,
  325, 379, 338, 346, 352, 363, 322, 314, 669, 829, 594, 697,
  784, 602, 485, 691, 759, 624, 740, 665, 889, 506, 607, 1123,
  1681, 807, 792, 605, 514, 719, 1299, 594, 664, 520, 535, 516,
  613, 674, 709, 712, 604, 504, 770, 575, 403, 391, 511, 476,
  431, 461, 569, 562, 516, 556, 669, 458, 431, 463, 574, 547,
  625, 661, 595, 593, 660, 620, 590, 571,
];

const prices = priceVals.map((p, t) => ({ timestamp: new Date(base + t * Q).toISOString(), price: p }));
const pv     = pvVals.map((w, t)   => ({ timestamp: new Date(base + t * Q).toISOString(), pvPowerW: w }));

// Live values from the 08:00Z log lines (rte, cycle cost, dynamic max charge price, SoC).
const SETTINGS = {
  battery_efficiency: 0.732,
  min_soc: 0,
  max_soc: 100,
  cycle_cost_per_kwh: 0.075,
  export_price_ratio: 1.0,
  dp_flatten_pv_shift: true,
  tariff_model: 'saldering',
};
const SOC = 5;
const MAX_CHARGE_PRICE = 0.238;

const eng = new OptimizationEngine(SETTINGS);
eng.compute(prices, SOC, 2.688, 800, 800, pv, null, consVals.slice(),
  0.117, 1.15, 3.2, 3.2, 1.0, 0.92, false, MAX_CHARGE_PRICE);
const slots = eng._schedule.slots;

const RealDate = Date;
function atLiveRun(fn) {
  const fixed = new RealDate('2026-09-29T08:00:00.600Z');
  global.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed.getTime()]));
      if (!args.length) return new RealDate(fixed.getTime());
    }

    static now() { return fixed.getTime(); }
  };
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

function runtime() {
  const pe = new PolicyEngine({ log() {} }, {
    ...SETTINGS,
    tariff_type: 'dynamic',
    max_charge_price: 0.12,
    min_discharge_price: 0.117,
    respect_minmax: false,
    min_profit_margin: 0.01,
    policy_mode: 'balanced',
  });
  const inputs = {
    policyMode: 'balanced',
    battery: { stateOfCharge: SOC, maxChargePowerW: 800, totalCapacityKwh: 2.688 },
    tariff: { currentPrice: priceVals[0], allPrices: prices, slotHours: 0.25 },
    dynamicMaxChargePrice: MAX_CHARGE_PRICE,
    evCharging: false,
    _chargeUrgent: false,
    // "PV detected via batteryPower (794.08W) + export (217W)", pvEst=1414W
    p1: { resolved_gridPower: -217, battery_power: 794, pv_power_estimated: 1414, avg_consumption_w: 400 },
    batteryCost: { avgCost: 0.1, energyKwh: 0.1 },
    batteryEfficiency: 0.732,
    optimizer: { getSlotMeta: () => slots[0], _schedule: eng._schedule },
  };
  return atLiveRun(() => {
    inputs.weather = { todaySunset: new Date(RealDate.parse('2026-09-29T17:20:00Z')) };
    pe._computePvFlags(inputs);
    return { flags: inputs, mode: pe._mapPolicyToHwMode('preserve', inputs) };
  });
}

console.log('dp-preserve-weak-pv-export');

test('precondition: DP picks preserve at 08:00Z and books no PV into the battery', () => {
  const s = slots[0];
  assert.strictEqual(s.action, 'preserve', `slot 0 is '${s.action}'`);
  assert.strictEqual(slots[1].socProjected, s.socProjected,
    `socProjected ${s.socProjected} → ${slots[1].socProjected}: DP stored PV, scenario no longer applies`);
  assert.ok(s.pvStoreValue < s.price, `store €${s.pvStoreValue} not below export €${s.price}`);
});

test('runtime does not force-store a surplus the DP exports (store €0.238 < export €0.359)', () => {
  const { flags, mode } = runtime();
  assert.strictEqual(flags._pvStoreWins, false, `_pvStoreWins=${flags._pvStoreWins}`);
  assert.notStrictEqual(mode, 'zero_charge_only', `runtime stores PV the DP plan exports; got '${mode}'`);
});

test('chart mapper mirrors the export on the same slot (no pv_trickle on a flat SoC)', () => {
  const s = slots[0];
  const pe = new PolicyEngine({ log() {} }, { ...SETTINGS, tariff_type: 'dynamic' });
  const { hwMode, reason } = pe._mapActionToHwModeForPlanning(s.action, {
    price: s.price, soc: s.socProjected, pvW: pvVals[0], consumptionW: consVals[0],
    tariffType: 'dynamic', userPolicyMode: 'balanced',
    maxChargePrice: MAX_CHARGE_PRICE, minDischargePrice: 0.117, minSoc: 0, maxSoc: 100,
    futurePrices: [], pvStoreValue: s.pvStoreValue, exportPrice: s.exportPrice ?? null,
    pvStoredByDp: s.pvStoredByDp === true,
  });
  assert.strictEqual(hwMode, 'standby', `chart maps '${hwMode}' (${reason})`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
