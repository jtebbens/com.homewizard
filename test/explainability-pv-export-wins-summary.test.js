'use strict';

// Explainability: when the DP decides NOT to store PV because export pays more, the battery
// does nothing and the surplus leaves the house. The summary used to open with
// "Advies: bewaren" while the same sentence said the surplus goes to the grid — two
// contradicting claims in one line (reported 2026-09-09, hwMode standby, price €0.260 vs
// store ceiling €0.241). The advice word must match the action: doing nothing, not keeping.

const assert = require('assert');
const ExplainabilityEngine = require('../lib/explainability-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

const eng = new ExplainabilityEngine({ log: () => {} });

function summary({ pvExportWins, hwMode = 'standby', soc = 75 }) {
  const inputs = {
    dpDecision: {
      finalAction: 'preserve',
      exception: null,
      breakEven: 0.308,
      maxFuturePrice: 0.432,
      pvExportWins,
    },
    effectivePrice: 0.260,
    battery: { stateOfCharge: soc },
    settings: { min_soc: 0, max_soc: 100, tariff_model: 'saldering', export_price_ratio: 1.0 },
    tariff: { currentPrice: 0.260 },
  };
  return eng._generateDpSummary({ hwMode }, inputs);
}

// ── The reported case: export wins → nothing is kept, surplus is exported ────
test('pvExportWins → advice says "niets doen", never "bewaren"', () => {
  const s = summary({ pvExportWins: true });
  assert.ok(/Advies: niets doen/.test(s), `expected "Advies: niets doen", got: ${s}`);
  assert.ok(!/bewaren/.test(s), `advice must not claim keeping while exporting, got: ${s}`);
});

// ── The reason itself must still name export and the price ───────────────────
test('pvExportWins → reason still names PV-export and the export price', () => {
  const s = summary({ pvExportWins: true });
  assert.ok(/PV-export/.test(s), `expected PV-export in reason, got: ${s}`);
  assert.ok(/€0\.260/.test(s), `expected export price in reason, got: ${s}`);
});

// ── Low-SoC grid top-up override keeps its own wording (guards the branch above it) ──
test('pvExportWins + hwMode to_full → charge wording, not the export line', () => {
  const s = summary({ pvExportWins: true, hwMode: 'to_full', soc: 5 });
  assert.ok(/Advies: opladen/.test(s), `expected charge advice, got: ${s}`);
});

// ── Without the flag the generic preserve wording is correct: charge IS kept ──
test('pvExportWins false → generic "bewaren" wording is untouched', () => {
  const s = summary({ pvExportWins: false });
  assert.ok(/Advies: bewaren/.test(s), `expected generic preserve wording, got: ${s}`);
  assert.ok(!/PV-export/.test(s), `export reason must not fire without the flag, got: ${s}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
