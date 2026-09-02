'use strict';

const assert = require('assert');
const WeatherForecaster = require('../lib/weather-forecaster');
const LearningEngine = require('../lib/learning-engine');

// _dewpointC: Magnus-Tetens dewpoint, and the depression (ta - dewpoint) it feeds.
// recordKnmiHourlyDewDepression: storage, mirrors recordKnmiHourlySunshine's contract.

{
  // Saturated air (rh=100%): dewpoint equals air temperature exactly.
  const td = WeatherForecaster._dewpointC(20, 100);
  assert.ok(Math.abs(td - 20) < 0.05, `expected ~20, got ${td}`);
  console.log('✓ rh=100% → dewpoint equals air temp (depression = 0)');
}

{
  // Known reference pair (NWS Magnus-Tetens table): 20°C / 50% RH → dewpoint ≈ 9.3°C.
  const td = WeatherForecaster._dewpointC(20, 50);
  assert.ok(Math.abs(td - 9.3) < 0.3, `expected ~9.3, got ${td}`);
  console.log('✓ 20°C/50%rh → dewpoint ≈ 9.3°C (known reference value)');
}

{
  // Drier air → wider depression (dewpoint drops further below air temp).
  const tdWet = WeatherForecaster._dewpointC(15, 90);
  const tdDry = WeatherForecaster._dewpointC(15, 30);
  assert.ok((15 - tdDry) > (15 - tdWet), 'drier air must give a wider depression');
  console.log('✓ depression widens as rh drops');
}

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlyDewDepression(4.2, '2026-09-02', 14);
  assert.strictEqual(engine.data.knmi_hourly_dew_depression['2026-09-02'][14], 4.2);
  console.log('✓ stores a value at the given date/hour');
}

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlyDewDepression(NaN, '2026-09-02', 14);
  assert.strictEqual(engine.data.knmi_hourly_dew_depression, undefined);
  console.log('✓ ignores non-finite input, no crash, no entry created');
}

{
  const engine = new LearningEngine({ log: () => {} }, {});
  engine.data = {};
  engine.recordKnmiHourlyDewDepression(1, '2026-08-30', 8);   // > 2 days before 2026-09-02
  engine.recordKnmiHourlyDewDepression(2, '2026-09-01', 9);
  engine.recordKnmiHourlyDewDepression(3, '2026-09-02', 10);
  assert.strictEqual(engine.data.knmi_hourly_dew_depression['2026-08-30'], undefined);
  assert.strictEqual(engine.data.knmi_hourly_dew_depression['2026-09-01'][9], 2);
  assert.strictEqual(engine.data.knmi_hourly_dew_depression['2026-09-02'][10], 3);
  console.log('✓ prunes dates older than 2 days on write');
}

console.log('\n6 passed, 0 failed');
