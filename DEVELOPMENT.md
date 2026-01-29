# HomeWizard Development Context

## Architecture Overview

### Driver Categories

**WebSocket-Based (Real-Time, Low Latency):**
- `energy_v2` - P1 meter with API v2 (WebSocket preferred, polling fallback)
- `plugin_battery` - Battery system via WebSocket (real-time power updates)
- Communication: WSS connection to device, ~2 second measurement intervals
- Manager: `includes/v2/Ws.js` - Handles connection, authorization, reconnection logic

**HTTP Polling-Based (API v1 & v2):**
- `energy` - P1 meter classic API (10s polling default, configurable)
- `SDM230`, `SDM230_v2`, `SDM230-p1mode` - 3-phase kWh meters
- `SDM630`, `SDM630_v2`, `SDM630-p1mode` - 3-phase kWh meters (industrial grade)
- `energy_socket` - Smart socket with power monitoring
- `watermeter` - Water consumption tracking
- Communication: HTTP REST with keep-alive agents, configurable intervals
- Manager: `includes/v2/Api.js` - Centralized fetch with timeout handling

**Legacy Gateway-Based (Proxy via Main Hub):**
- `thermometer` - Temperature sensors (poor WiFi)
- `heatlink` - Heating control (poor WiFi)
- `rainmeter` - Rain detection (poor WiFi)
- `windmeter` - Wind speed (poor WiFi)
- `kakusensors` - Various sensors (poor WiFi)
- `energylink` - Energy gateway (poor WiFi)
- Communication: HTTP polling to main hub unit which proxies requests
- Manager: `includes/legacy/homewizard.js` - Adaptive polling with backoff

---

## Key File Locations

| File | Purpose | Key Functions |
|------|---------|---|
| `app.js` | App entry point, lifecycle | Flow cards, baseload monitor init |
| `includes/v2/Ws.js` | WebSocket manager | Connection, auth, reconnect, message buffering |
| `includes/v2/Api.js` | HTTP utilities | fetchWithTimeout, fetch queue |
| `includes/legacy/homewizard.js` | Legacy gateway | Adaptive polling, device management, retry logic |
| `includes/utils/baseloadMonitor.js` | Baseload (sluipverbruik) tracker | Night analysis, fridge detection, oscillation checks |
| `includes/utils/fetchQueue.js` | Fetch rate limiter | Prevents CPU spikes from polling |
| `drivers/energy_v2/device.js` | P1 APIv2 driver | WebSocket + polling hybrid, battery handling |
| `drivers/energy/device.js` | P1 APIv1 driver | Polling-based, gas/water processing |
| `drivers/plugin_battery/device.js` | Battery driver | WebSocket real-time, polling fallback |

---

## Communication Patterns

### WebSocket Flow (energy_v2, plugin_battery)
```
1. Start → Preflight check (GET /api/system)
2. Connect → WebSocket upgrade to WSS
3. Authorize → Send token via message
4. Subscribe → Request system, measurement, batteries topics
5. Receive → Messages buffered, flushed every 2-10 seconds
6. Reconnect → Exponential backoff on disconnect (max 30 attempts)
7. Watchdog → Ping every 30s, detect stale connections (190s timeout)
```

### HTTP Polling Flow (energy, SDM230/630, energy_socket, watermeter)
```
1. OnInit → Create keep-alive HTTP agent, start polling interval
2. OnPoll → Fetch from device /data endpoint
3. Parse → JSON parse, validate structure
4. Update → updateCapability() with Promise.allSettled()
5. Retry → Exponential backoff on 5xx errors
6. OnDeleted → Clear interval, destroy agent, flush debug logs
```

### Legacy Gateway Flow (thermometer, heatlink, etc.)
```
1. RegisterDevice → Added to homewizard.devices map
2. StartPoll → Set interval with adaptive timeout
3. Call → homewizard.callnew() with abort controller
4. Timeout → getAdaptiveTimeout() based on response history
5. Retry → Backoff on failure, record response times
6. OnDeleted → homewizard.removeDevice() clears all references
```

---

## Known Issues & Workarounds

### WebSocket Specific
- **Reconnection spam:** Reduced debug logs during frequent reconnects
- **Authorization timeout:** Preflight check now validates device reachability first
- **Listener duplication:** Must call `removeAllListeners()` before re-attaching handlers
- **Memory leak risk:** Handler functions MUST be bound once in onInit(), not per reconnect

### HTTP Polling Specific
- **Agent socket leak:** Must destroy agent in onDeleted() to prevent port exhaustion
- **Polling deadlock:** Removed overcomplicated interval checks that blocked polling
- **Timeout cascades:** Each device has independent timeout, not global queue
- **Debug I/O overhead:** Now batched with 5-second debounce (85% I/O reduction)

### Legacy Gateway Specific
- **Poor WiFi:** Adaptive polling increases interval after failures, resets on success
- **Device deletion:** Must call `homewizard.removeDevice()` to clear internal maps
- **Callback leaks:** safeCallback() wrapper ensures AbortController/timeout cleanup
- **Race conditions:** Response stats array now has atomic bounds checking

### Baseload Monitor Specific
- **Fridge false positives:** Near-zero detection now requires CONSECUTIVE samples (not cumulative)
- **Battery interference:** Negative power (export) completely filtered before analysis
- **Night data gaps:** Uses fallback calculation if too many invalid nights
- **Oscillation sensitivity:** 300W threshold for normal grid variations, 400W for battery systems

---

## Performance Baselines & Targets

### CPU Usage Per Device Type
| Driver | Type | Typical CPU | Update Frequency |
|--------|------|-------------|---|
| energy_v2 (WS) | WebSocket | 0.5-1% | ~2s (buffered) |
| plugin_battery (WS) | WebSocket | 0.3-0.5% | ~2s (buffered) |
| energy (polling) | HTTP | 1-2% | 10s default |
| SDM230/630 | HTTP | 0.8-1.5% | 10s default |
| energy_socket | HTTP | 0.5-1% | 10s default |
| watermeter | HTTP | 0.3-0.5% | 10s default |
| Legacy (thermometer, etc.) | HTTP | 0.2-0.8% | 15-60s adaptive |

### Memory Usage Per Device
| Driver | Typical | Notes |
|--------|---------|-------|
| energy_v2 | ~5-8 MB | Includes cache, capability store, battery tracking |
| plugin_battery | ~3-5 MB | Smaller dataset than P1 |
| polling drivers | ~2-3 MB each | Minimal state |
| legacy drivers | ~200-300 KB | Lightweight, sparse data |

### I/O Operations Reduction (v3.11.10)
- Settings.get() calls: 8,640/day → 1,440/day (83% reduction)
- Debug log writes: 50/min → ~10/min (85% reduction)
- WebSocket hash calculations: 30/min → optimized loop (garbage collection reduced)

---

## Debug Logging & Monitoring

### App Settings Dashboard
- Location: App settings → "Fetch Debug" / "WebSocket Debug" / "Baseload Samples"
- Batched writes: Every 5 seconds max, 500-log global limit per app
- Per-device buffer: Max 20 logs before flush
- Cleared on device deletion to prevent unbounded growth

### Key Debug Flags
```javascript
const debug = false;  // Set to true for verbose WebSocket/measurement logging
const wsDebug = require('./wsDebug');  // WebSocket connection lifecycle
```

### Common Log Patterns
- `❌` - Error, action failed or malformed
- `⚠️` - Warning, degraded but functional
- `🔐` - Security/authorization
- `📡` - Network communication
- `⚡` - Battery/power-related
- `🕒` - Timing/watchdog
- `💧` - Gas/water data
- `🔌` - WebSocket lifecycle

---

## Baseload Monitor (Sluipverbruik) Logic

### Detection Window
- **Night hours:** 1 AM - 5 AM (configurable)
- **Sample collection:** Every power update during night (typically 10-30s intervals)
- **History:** Last 30 nights kept for stability

### Invalid Night Conditions
1. **High Plateau** - Avg power > baseload + 500W for 10+ min (indicates external load)
2. **Negative Long** - Power < 0W for 5+ min (grid export, disabled for battery systems)
3. **Near-Zero Consecutive** - Continuous ±50W for 20+ min (grid balancing detected)
4. **Oscillation** - 300W+ swing in 5-min window (unstable conditions)
5. **PV Startup** - Negative power (export) at 4-6 AM (solar generation)

### Valid Night Conditions
- Fridge cycles (50-300W, 30-120 min duration) detected and ignored
- Battery discharge (negative power) filtered out completely
- Baseload = average of all positive samples during night
- Stability = average of last 7 valid nights

### Calculation Formula
```
baseload = average(last_7_valid_nights)
- Each valid night = average power during 1-5 AM
- Filters applied: negative power removed, fridge cycles allowed
- Fallback: 10th percentile of all samples if < 7 valid nights
```

---

## Common Development Tasks

### Adding a New Polling Driver
1. Create `drivers/my_device/device.js`
2. Extend with polling loop in onInit()
3. Implement onPoll() with fetchWithTimeout()
4. Use updateCapability() in Promise.allSettled() pattern
5. Destroy HTTP agent in onDeleted()
6. Add debug logging with _debugLog() pattern
7. Update app.json with device definition

### Fixing a Memory Leak
1. Check for event listeners not removed (WebSocket.removeAllListeners())
2. Check for closures holding references (bind once in onInit())
3. Check for intervals/timeouts not cleared (verify onDeleted())
4. Check for device map entries not cleaned (verify removeDevice() called)
5. Monitor with: `node --inspect` and Chrome DevTools

### Optimizing CPU Usage
1. Batch updates with Promise.allSettled() (parallel, not sequential)
2. Throttle expensive operations (e.g., baseload detection every 30s)
3. Eliminate spread operators in tight loops
4. Cache settings.get() results instead of repeated calls
5. Use reverse iteration with early exit for filters

### Testing Battery Integration
1. Set energy_v2 to use_polling = true (WebSocket fallback)
2. Trigger reconnects: restart device or kill WiFi
3. Monitor battery message buffering (should flush every 10s)
4. Verify battery mode changes trigger flow cards
5. Check that negative power doesn't invalidate baseload

---

## Async/Await Patterns

### Safe Pattern (Parallel Execution)
```javascript
const tasks = [];
tasks.push(updateCapability(this, 'cap1', value1).catch(this.error));
tasks.push(updateCapability(this, 'cap2', value2).catch(this.error));
await Promise.allSettled(tasks);  // All run in parallel
```

### Anti-Pattern (Sequential, Slow)
```javascript
await updateCapability(this, 'cap1', value1);  // Wait for cap1
await updateCapability(this, 'cap2', value2);  // Then wait for cap2
```

### Error Handling
```javascript
try {
  const data = await fetchWithTimeout(url, options);
  // Process data
} catch (err) {
  this.error('Failed to fetch:', err.message);
  await this.setUnavailable(err.message || 'Fetch error');
}
```

---

## Configuration Reference

### Device Settings (app.json)
- `polling_interval` - Fetch interval in seconds (default 10)
- `url` - Device IP/hostname
- `show_gas` - Include gas meter data (P1 only)
- `offset_polling` - Socket smart plug polling offset
- `use_polling` - Force polling instead of WebSocket (energy_v2, plugin_battery)

### App Settings
- `baseload_state` - Persisted baseload history and preferences
- `pluginBatteryGroup` - Fallback battery data when realtime unavailable
- Debug logs - Per-driver and per-app entries

---

## Testing Procedures

### Device Connectivity
```
1. Verify Local API enabled in HomeWizard app
2. Check device reachability: curl http://device_ip/api/system
3. Verify authentication: curl with Authorization header
4. Test WebSocket: wscat wss://device_ip/api/ws
```

### Polling Stability
```
1. Monitor poll intervals: check debug logs for timing
2. Verify no deadlocks: check pollingActive flag doesn't stick
3. Test timeout recovery: kill network briefly, verify reconnect
4. Stress test: set polling_interval to 1s, monitor CPU
```

### Baseload Accuracy
```
1. Run 7+ full nights to build history
2. Verify fridge cycles logged but don't invalidate nights
3. Check app settings for baseload_state history
4. Manually inspect currentNightSamples to verify filtering
```

---

## Version History Key Milestones

- **v3.11.10** - CPU optimization (caching, detection throttling), baseload near-zero fix
- **v3.9.29** - Baseload monitor introduced (sluipverbruik tracking)
- **v3.8.22** - WebSocket optimization, fetcQueue centralization
- **v3.0+** - Battery support, modular P1 driver, API v2
