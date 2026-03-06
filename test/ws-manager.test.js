/**
 * Standalone test for WebSocketManager (includes/v2/Ws.js)
 *
 * Run:  node test/ws-manager.test.js
 *
 * Creates a local mock WS server that mimics the HomeWizard device
 * protocol (authorize → subscribe → stream messages) and verifies
 * the manager handles each phase correctly.
 *
 * No test framework needed. Exits 0 on success, 1 on failure.
 */

'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Helpers ───────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Mock device server ────────────────────────────────

function createMockServer() {
  const server = http.createServer((req, res) => {
    // Preflight: GET /api/system
    if (req.url === '/api/system') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        product_name: 'HWE-BAT',
        product_type: 'HWE-BAT',
        serial: 'test-serial-001',
        firmware_version: '6.02',
        api_version: 'v2',
        cloud_enabled: true,
        wifi_ssid: 'TestNetwork',
        wifi_strength: -42,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });
  const state = {
    authorized: false,
    subscriptions: new Set(),
    measurementInterval: null,
    clients: [],
  };

  wss.on('connection', (ws) => {
    state.clients.push(ws);

    ws.on('message', (msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch { return; }

      if (data.type === 'authorization') {
        state.authorized = true;
        ws.send(JSON.stringify({ type: 'authorized' }));
      }
      else if (data.type === 'subscribe') {
        state.subscriptions.add(data.data);

        // Once subscribed to measurement, start streaming
        if (data.data === 'measurement' && !state.measurementInterval) {
          let tick = 0;
          state.measurementInterval = setInterval(() => {
            tick++;
            if (ws.readyState !== WebSocket.OPEN) return;

            // Measurement every 1s (simulates energy_v2)
            ws.send(JSON.stringify({
              type: 'measurement',
              data: {
                power_w: 100 + tick,
                energy_import_kwh: 1234.5 + tick * 0.001,
                energy_export_kwh: 567.8,
              }
            }));

            // System every 3s
            if (tick % 3 === 0) {
              ws.send(JSON.stringify({
                type: 'system',
                data: { wifi_strength: -40 - (tick % 10) }
              }));
            }

            // Batteries every 2s
            if (tick % 2 === 0) {
              ws.send(JSON.stringify({
                type: 'batteries',
                data: {
                  mode: 'zero',
                  permissions: ['charge_allowed', 'discharge_allowed'],
                  state_of_charge_pct: 45 + tick * 0.1,
                  power_w: 200,
                }
              }));
            }
          }, 1000);
        }
      }
      else if (data.type === 'batteries' && data.data?.mode) {
        // Battery mode change command
        ws.send(JSON.stringify({
          type: 'batteries',
          data: { mode: data.data.mode, permissions: data.data.permissions || [] }
        }));
      }
    });

    ws.on('close', () => {
      if (state.measurementInterval) {
        clearInterval(state.measurementInterval);
        state.measurementInterval = null;
      }
      state.authorized = false;
      state.subscriptions.clear();
    });
  });

  return { server, wss, state };
}

// ─── Test suite ────────────────────────────────────────

async function runTests() {
  const { server, wss, state } = createMockServer();

  // Start server on random port
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`\n🧪 Mock server on port ${port}\n`);

  // Patch fetchQueue → use plain node-fetch for tests
  // We need to bypass the fetchQueue since it has module-level state
  const originalRequire = require('../../includes/utils/fetchQueue');

  // Load WebSocketManager (fetchQueue will be loaded as a module)
  const WebSocketManager = require('../includes/v2/Ws');

  // ─── Collected data from callbacks ───
  const collected = {
    measurements: [],
    systems: [],
    batteries: [],
    available: false,
  };

  // ─── Create manager ───
  const mgr = new WebSocketManager({
    device: {
      getData: () => ({ id: 'test-device-001' }),
      _handleBatteries: (data) => {
        // Optimistic update from setBatteryMode
        collected.batteries.push({ ...data, optimistic: true });
      },
    },
    url: baseUrl,
    token: 'test-token-xyz',
    log: (...args) => console.log('    [LOG]', ...args),
    error: (...args) => console.error('    [ERR]', ...args),
    setAvailable: async () => { collected.available = true; },
    getSetting: (key) => {
      if (key === 'url') return baseUrl;
      if (key === 'update_interval') return 2000;
      return null;
    },
    handleMeasurement: (data) => collected.measurements.push(data),
    handleSystem: (data) => collected.systems.push(data),
    handleBatteries: (data) => collected.batteries.push(data),
  });

  // ═══════ TEST 1: getStats before start ═══════
  console.log('── Test 1: Initial state ──');
  const stats0 = mgr.getStats();
  assert(!stats0.connected, 'Not connected before start');
  assert(stats0.stopped === false, 'Not stopped initially');
  assert(stats0.counters.messagesReceived === 0, 'Zero messages initially');

  // ═══════ TEST 2: Connection + Auth + Subscribe ═══════
  console.log('\n── Test 2: Connect / Auth / Subscribe ──');
  mgr.setDebug(true);
  await mgr.start();
  await sleep(2000); // wait for open + authorize + subscribe + a few messages

  const stats1 = mgr.getStats();
  assert(stats1.connected, 'Connected after start');
  assert(stats1.wsActive, 'wsActive is true');
  assert(stats1.counters.messagesReceived > 0, `Received ${stats1.counters.messagesReceived} messages`);
  assert(state.authorized, 'Server saw authorization');
  assert(state.subscriptions.has('measurement'), 'Subscribed to measurement');
  assert(state.subscriptions.has('system'), 'Subscribed to system');
  assert(state.subscriptions.has('batteries'), 'Subscribed to batteries');
  assert(collected.available, 'setAvailable was called');

  // ═══════ TEST 3: Throttling ═══════
  console.log('\n── Test 3: Throttling ──');
  await sleep(6000); // let 6s of messages flow

  const stats2 = mgr.getStats();
  // ~6 measurement messages sent (1/s), but only ~3 should be processed (2s throttle)
  assert(stats2.counters.measurementsProcessed >= 2, `Measurements processed: ${stats2.counters.measurementsProcessed} (expected ~3)`);
  assert(stats2.counters.measurementsDropped >= 1, `Measurements dropped/deferred: ${stats2.counters.measurementsDropped}`);
  // System: ~2 sent (every 3s), only 1 should pass (10s throttle)
  assert(stats2.counters.systemProcessed >= 1, `System processed: ${stats2.counters.systemProcessed}`);
  // Batteries: ~3 sent (every 2s), limited by 5s throttle
  assert(stats2.counters.batteriesProcessed >= 1, `Batteries processed: ${stats2.counters.batteriesProcessed}`);

  console.log(`    Totals: msgs=${stats2.counters.messagesReceived}, meas=${stats2.counters.measurementsProcessed}/${stats2.counters.measurementsDropped}, sys=${stats2.counters.systemProcessed}/${stats2.counters.systemDropped}, bat=${stats2.counters.batteriesProcessed}/${stats2.counters.batteriesDeferred}`);

  // ═══════ TEST 4: setBatteryMode ═══════
  console.log('\n── Test 4: setBatteryMode ──');
  const prevBatLen = collected.batteries.length;
  mgr.setBatteryMode('standby');
  await sleep(500);
  assert(collected.batteries.length > prevBatLen, 'setBatteryMode triggered callback');
  const lastBat = collected.batteries[collected.batteries.length - 1];
  assert(lastBat.optimistic === true, 'Optimistic local update fired');
  assert(lastBat.mode === 'standby', `Mode is standby (got ${lastBat.mode})`);

  mgr.setBatteryMode('zero_charge_only');
  await sleep(500);
  const lastBat2 = collected.batteries[collected.batteries.length - 1];
  assert(lastBat2.mode === 'zero', `zero_charge_only maps to mode=zero`);

  // ═══════ TEST 5: setBatteryMode all modes ═══════
  console.log('\n── Test 5: All battery modes ──');
  const modes = ['standby', 'zero', 'zero_charge_only', 'zero_discharge_only', 'to_full'];
  for (const mode of modes) {
    try {
      mgr.setBatteryMode(mode);
      assert(true, `setBatteryMode("${mode}") — OK`);
    } catch (e) {
      assert(false, `setBatteryMode("${mode}") threw: ${e.message}`);
    }
  }

  try {
    mgr.setBatteryMode('invalid_mode');
    assert(false, 'Should have thrown for invalid mode');
  } catch (e) {
    assert(true, `setBatteryMode("invalid_mode") throws: ${e.message}`);
  }

  // ═══════ TEST 6: Stop / Resume ═══════
  console.log('\n── Test 6: Stop / Resume ──');
  mgr.stop();
  await sleep(500);
  const stats3 = mgr.getStats();
  assert(!stats3.connected, 'Disconnected after stop');
  assert(stats3.stopped, 'Stopped flag set');
  assert(stats3.timersActive === 0, 'All timers cleared');

  try {
    mgr.setBatteryMode('zero');
    assert(false, 'Should throw when stopped');
  } catch (e) {
    assert(true, 'setBatteryMode throws when stopped');
  }

  await mgr.resume();
  await sleep(2000);
  const stats4 = mgr.getStats();
  assert(stats4.connected, 'Reconnected after resume');
  assert(!stats4.stopped, 'Stopped flag cleared');

  // ═══════ TEST 7: getStats snapshot ═══════
  console.log('\n── Test 7: getStats completeness ──');
  const snap = mgr.getStats();
  assert('connected' in snap, 'Has connected');
  assert('throttle' in snap, 'Has throttle section');
  assert('counters' in snap, 'Has counters section');
  assert(typeof snap.idleMs === 'number', 'idleMs is number');
  assert(typeof snap.timersActive === 'number', 'timersActive is number');
  assert(snap.counters.lastConnectedAt !== null, 'lastConnectedAt tracked');

  // ═══════ TEST 8: Debug toggle ═══════
  console.log('\n── Test 8: Debug toggle ──');
  mgr.setDebug(false);
  assert(!mgr._debug, 'Debug turned off');
  mgr.setDebug(true);
  assert(mgr._debug, 'Debug turned on');

  // ═══════ Cleanup ═══════
  mgr.stop();
  wss.close();
  server.close();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('💥 Test crashed:', err);
  process.exit(1);
});
