'use strict';

const assert = require('assert');
const LearningEngine = require('../lib/learning-engine');

// recordKnmiHourlySunshine stores per-hour KNMI sunshine minutes (0-10), mirroring
// recordKnmiHourlyCloud's shape, and prunes dates older than 2 days.

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlySunshine(10, '2026-09-02', 12);
  assert.strictEqual(engine.data.knmi_hourly_sunshine['2026-09-02'][12], 10);
  console.log('✓ stores a value at the given date/hour');
}

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlySunshine('not-a-number', '2026-09-02', 12);
  engine.recordKnmiHourlySunshine(NaN, '2026-09-02', 13);
  assert.strictEqual(engine.data.knmi_hourly_sunshine, undefined);
  console.log('✓ ignores non-finite input, no crash, no entry created');
}

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlySunshine(0, '2026-08-30', 8);   // > 2 days before 2026-09-02
  engine.recordKnmiHourlySunshine(5, '2026-09-01', 9);
  engine.recordKnmiHourlySunshine(10, '2026-09-02', 10); // triggers prune relative to this write
  assert.strictEqual(engine.data.knmi_hourly_sunshine['2026-08-30'], undefined);
  assert.strictEqual(engine.data.knmi_hourly_sunshine['2026-09-01'][9], 5);
  assert.strictEqual(engine.data.knmi_hourly_sunshine['2026-09-02'][10], 10);
  console.log('✓ prunes dates older than 2 days on write');
}

console.log('\n3 passed, 0 failed');
