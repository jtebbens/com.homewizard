# CPU Crash Diagnostics

## Overview
Comprehensive logging has been added to identify CPU crash causes. Logs will show exactly where the app is spending time and where crashes occur.

## How to View Logs

### Real-time logs:
```bash
homey app run
```

### Or tail the Homey log:
```bash
tail -f /tmp/homey.log
```

## Log Markers to Look For

### 🔍 WebSocket Operations
All WebSocket operations are logged with `[WS-CRASH-LOG]` prefix:

- `[WS-CRASH-LOG][ID][CONSTRUCTOR]` - WebSocket manager created
- `[WS-CRASH-LOG][ID][START]` - Connection starting
- `[WS-CRASH-LOG][ID][MSG_RECV]` - Message received
- `[WS-CRASH-LOG][ID][MSG_PARSED]` - Message parsed (shows type)
- `[WS-CRASH-LOG][ID][MEASURE_CHECK]` - Checking throttle timing
- `[WS-CRASH-LOG][ID][MEASURE_PROCESS]` - Processing measurement
- `[WS-CRASH-LOG][ID][MEASURE_DONE]` - Measurement processed
- `[WS-CRASH-LOG][ID][MEASURE_THROTTLED]` - Message throttled
- `[WS-CRASH-LOG][ID][MEASURE_ERROR]` - Error in measurement handler

### 💥 Global Error Handlers
- `💥 UNHANDLED PROMISE REJECTION:` - Promise rejected without .catch()
- `💥 UNCAUGHT EXCEPTION:` - Uncaught exception
- `⚠️ PROCESS WARNING:` - Node.js process warnings (memory, event listeners, etc.)

### ❌ Device Errors
- `❌ _handleMeasurement crashed` - Measurement handler crashed
- `❌ Capability update batch error` - Capability updates failed

## What to Look For

### CPU Issues
If you see rapid repeating patterns like:
```
[WS-CRASH-LOG][123][MEASURE_PROCESS] Calling handler
[WS-CRASH-LOG][124][MEASURE_PROCESS] Calling handler
[WS-CRASH-LOG][125][MEASURE_PROCESS] Calling handler
```
This indicates measurements are processing too frequently (throttling not working).

### Memory Leaks
```
⚠️ PROCESS WARNING: MaxListenersExceededWarning
```
Indicates event listeners are accumulating (likely from restart loops).

### Unhandled Errors
```
💥 UNHANDLED PROMISE REJECTION:
```
Shows errors that aren't being caught - these can cause silent crashes.

## Disabling Diagnostic Logs

To disable WebSocket crash logs (after debugging), edit `/includes/v2/Ws.js`:
```javascript
const CRASH_LOG_ENABLED = false; // Change to false
```

## Performance Impact

The crash logs add minimal overhead (~1-2% CPU) but provide critical diagnostics. They should be disabled in production once the issue is resolved.

## Next Steps After Crash

1. **Check the last operation** - The last `[WS-CRASH-LOG]` entry shows where it crashed
2. **Look for error patterns** - Repeating errors indicate the root cause
3. **Check timing** - Look at timestamps between operations to find bottlenecks
4. **Verify cleanup** - Ensure `onUninit()` is called before crashes

## Expected Behavior (Normal Operation)

You should see:
- Messages throttled to ~5 second intervals
- No rapid repetition of the same operation
- No unhandled promise rejections
- Clean `onUninit()` calls during restarts
