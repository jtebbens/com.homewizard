'use strict';
/**
 * Diagnose-battery step 4: pull policy_last_run_debug and tag every field by source
 * type (live / measured / forecast / DP-predicted / learning-derived / config), so a
 * debugging session states the source kind instead of re-deriving it from lib/policy-engine.js
 * and device.js each time (CLAUDE.md "Data Source Discipline").
 *
 * Field→category map is hand-verified against lib/policy-engine.js:613-635 (dynamic-tariff
 * debug object) and drivers/battery-policy/device.js:1967-2025 (fields device.js appends
 * after the policy run). Re-check this map after touching either block.
 *
 * The 300-entry PV sample buffer used to ride along in this key and had to be dropped here with
 * --jq to stay under the 64KiB get-app-setting truncation
 * (reference_homey_app_settings_via_cli.md). It now lives in its own key,
 * `policy_pv_predictions_recent` — pull that separately when you need it.
 *
 * Usage: node tools/diag-snapshot.js
 */

const { getAppSetting } = require('./homey-local');

const CATEGORY = {
  ts: 'meta', appVersion: 'meta',

  soc: 'live', currentLoad: 'live', pvEstimate: 'live', price: 'live',
  delayCharge: 'live', lowSocGridTopUp: 'live',

  houseConsumption: 'measured',

  priceMin12h: 'forecast', priceMax12h: 'forecast',
  pvKwhTomorrow: 'forecast', pvTermKwh: 'forecast',

  policyMode: 'dp-predicted', hwMode: 'dp-predicted', optimizer: 'dp-predicted',
  dynamicMaxChargePrice: 'dp-predicted', pvTermFactor: 'dp-predicted',
  dischargeNext12h: 'dp-predicted', exception: 'dp-predicted', scores: 'dp-predicted',

  avgCost: 'learning-derived', breakEven: 'learning-derived',
  pvAccuracySat: 'learning-derived', pvAccuracyOm: 'learning-derived',
  pvAccuracySc: 'learning-derived', pvAccuracyScore: 'learning-derived',
  pvAccuracySamples: 'learning-derived', satYieldFactors: 'learning-derived',
  consumptionAccuracy: 'learning-derived', refillConfidence: 'learning-derived',
  reserveFloorPct: 'learning-derived', minDischargePriceRange: 'learning-derived',
  consumptionMarginRange: 'learning-derived',

  battCapKwh: 'config',
};

const ORDER = ['meta', 'live', 'measured', 'forecast', 'dp-predicted', 'learning-derived', 'config', 'unmapped'];

async function main() {
  let debug;
  try {
    debug = await getAppSetting('policy_last_run_debug');
  } catch (err) {
    console.error('local API call failed — is the Homey reachable and the token still valid?');
    console.error(err.message);
    process.exit(1);
  }

  const grouped = {};
  for (const cat of ORDER) grouped[cat] = [];

  for (const [key, value] of Object.entries(debug)) {
    const cat = CATEGORY[key] || 'unmapped';
    grouped[cat].push([key, value]);
  }

  const runTs = debug.ts
    ? new Date(debug.ts).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'medium' })
    : '(no ts)';
  console.log(`policy_last_run_debug — run at ${runTs} (Amsterdam)`);

  for (const cat of ORDER) {
    const rows = grouped[cat];
    if (!rows.length) continue;
    console.log(`\n[${cat.toUpperCase()}]`);
    for (const [key, value] of rows) {
      if (key === 'ts') continue;
      const printable = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
      console.log(`  ${key} = ${printable}`);
    }
  }

  if (grouped.unmapped.length) {
    console.log('\n⚠ Unmapped fields found — policy-engine.js/device.js debug object changed. Update CATEGORY map in tools/diag-snapshot.js.');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
