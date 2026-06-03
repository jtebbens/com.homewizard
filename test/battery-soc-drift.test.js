'use strict';

// Regression test: BMS-calibratie drift moet kunnen vuren.
// Bug: de drift-loop draait elke 5 min en ververste previousSoC/
// previousTimestamp bij ELKE run. Daardoor was deltaTimeMin altijd ~5 min
// en haalde checkSoCDrift nooit de `deltaTimeMin >= 20` drempel → drift
// (SoC stuck op 0% terwijl firmware @75W calibreert) kon nooit triggeren.
// Fix: anker pas verversen als SoC verandert, zodat delta groeit zolang stuck.

const assert = require('assert');
const Module = require('module');

// Stub 'homey' + zware device-deps zodat device.js buiten Homey laadt.
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'homey') return { Device: class {}, App: class {} };
  if (id === 'node-fetch') return () => {};
  if (id.endsWith('/Ws') || id.endsWith('/wsDebug') || id.endsWith('/Api')) return {};
  return origRequire.apply(this, arguments);
};

const { checkSoCDrift } = require('../drivers/plugin_battery/device.js');

// checkSoCDrift gebruikt intern Date.now() als "now"; previousTimestamp moet
// dus relatief aan de wandklok. We modelleren 5-min polls via offsets.
// Mirror van caller-stap 8: SoC stuck 0%, @75W calibratie.
// updateAnchorAlways=true reproduceert het buggy gedrag (anker elke poll resetten).
function simulatePolls({ updateAnchorAlways, powerAtPoll = () => 75 }) {
  const STUCK_SOC = 0;
  const POLL_MS = 5 * 60 * 1000;
  let prevSoC = 0;
  let anchorSetAtPoll = 0;     // poll-index waarop anker laatst gezet is
  let fired = false;

  // 12 polls = 60 min stuck (45min @75W + 15min @800W, echte calibratie).
  for (let i = 1; i <= 12; i++) {
    const elapsedMs = (i - anchorSetAtPoll) * POLL_MS;
    const res = checkSoCDrift({
      previousSoC: prevSoC,
      previousTimestamp: Date.now() - elapsedMs,
      currentSoC: STUCK_SOC,
      currentPowerW: powerAtPoll(i),
      batteryCapacityWh: 2470,
    });
    if (res.drift) fired = true;

    if (updateAnchorAlways || STUCK_SOC !== prevSoC) {
      prevSoC = STUCK_SOC;
      anchorSetAtPoll = i;     // anker = deze poll → volgende delta = 5min
    }
  }
  return fired;
}

// Echte 2-fase calibratie: poll 1-9 @75W (45min), poll 10-12 @800W (15min).
const TWO_PHASE = (i) => (i <= 9 ? 75 : 800);

function testBuggyNeverFires() {
  const fired = simulatePolls({ updateAnchorAlways: true });
  assert.strictEqual(fired, false,
    'buggy anker (elke poll verversen) houdt delta op ~5min → drift vuurt nooit');
  console.log('✓ bug gereproduceerd: anker-per-poll → drift vuurt nooit');
}

function testFixedFires() {
  const fired = simulatePolls({ updateAnchorAlways: false });
  assert.strictEqual(fired, true,
    'fixed anker (alleen bij SoC-verandering) laat delta groeien → drift vuurt na 20min');
  console.log('✓ fix: anker-bij-verandering → drift vuurt na 20min stuck @75W');
}

function testTwoPhaseFires() {
  // Buggy anker mag ook bij 2-fase nooit vuren; fixed moet wel.
  assert.strictEqual(
    simulatePolls({ updateAnchorAlways: true, powerAtPoll: TWO_PHASE }), false,
    '2-fase met anker-per-poll → drift vuurt nooit');
  assert.strictEqual(
    simulatePolls({ updateAnchorAlways: false, powerAtPoll: TWO_PHASE }), true,
    '2-fase (45min@75W → 15min@800W) stuck 0% → drift vuurt');
  console.log('✓ fix: echte 2-fase calibratie (75W→800W) → drift vuurt, SoC stuck 0%');
}

// Contract-borging checkSoCDrift zelf.
function testDriftContract() {
  const base = { previousSoC: 0, currentSoC: 0, currentPowerW: 75, batteryCapacityWh: 2470 };
  assert.strictEqual(
    checkSoCDrift({ ...base, previousTimestamp: Date.now() - 19 * 60000 }).drift,
    false, '<20min mag niet vuren');
  assert.strictEqual(
    checkSoCDrift({ ...base, previousTimestamp: Date.now() - 20 * 60000 }).drift,
    true, '>=20min @75W stuck 0% moet vuren');
  assert.strictEqual(
    checkSoCDrift({ ...base, currentPowerW: 30, previousTimestamp: Date.now() - 25 * 60000 }).drift,
    false, 'power <50W (idle) mag niet vuren');
  console.log('✓ checkSoCDrift contract: 20min-drempel + powerband');
}

testBuggyNeverFires();
testFixedFires();
testTwoPhaseFires();
testDriftContract();
console.log('All battery-soc-drift tests passed');
