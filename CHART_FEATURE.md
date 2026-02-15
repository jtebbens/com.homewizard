# Battery Planning Chart Feature

## Overview

The Battery Policy Manager can display a visual 24-hour planning chart showing:
- **Price bars**: Color-coded energy prices (green = cheap, red = expensive)
- **Mode icons**: Battery mode forecast for each hour (⚡=charge, ☀️=PV-only, 🔋=discharge, ⏸️=standby, ⏹️=zero)
- **PV curve**: Solar production forecast (orange line)
- **SoC projection**: Battery state of charge trajectory (green dashed line)
- **Current hour highlight**: White border around current time
- **Full legend**: Explains colors and symbols

## Status

**Implementation**: Complete (v3.13.17+)  
**Default**: **DISABLED** (requires optional native dependency)  
**Chart updates**: Every 15 minutes automatically when enabled

## How to Enable

The chart feature requires the `canvas` library, which needs system dependencies to compile.

### 1. Install System Dependencies

**Ubuntu/Debian:**
```bash
apt-get install -y pkg-config libcairo2-dev libpixman-1-dev libjpeg-dev libgif-dev librsvg2-dev
```

**macOS:**
```bash
brew install pkg-config cairo pixman jpeg giflib librsvg
```

**Alpine Linux:**
```bash
apk add --no-cache build-base cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev
```

### 2. Install Canvas Package

```bash
cd /path/to/com.homewizard
npm install
```

### 3. Enable Camera Capability

Edit `drivers/battery-policy/driver.compose.json` and add `"camera"` to capabilities:

```json
{
  "capabilities": [
    ...
    "weather_override",
    "camera"
  ]
}
```

### 4. Run the App

```bash
homey app run --remote
```

## Display

Once enabled:
- **Device card**: Small preview of chart
- **Click for full screen**: Tap preview to see full 800x600 chart
- **Dashboard compatible**: Works in Homey dashboards
- **Auto-refresh**: Updates every 15 minutes with policy check

## Technical Details

**Files involved:**
- `lib/battery-chart-generator.js` - Chart rendering engine (262 lines)
- `drivers/battery-policy/device.js` - Integration and data preparation
- `locales/en.json` & `nl.json` - Camera title translations

**Graceful degradation:**
- If canvas is not installed, chart generation is silently disabled
- Log message: "Chart generation disabled - canvas package not installed"
- All other battery policy features continue working normally

**Chart data:**
- **Prices**: From tariff manager cache (dynamic pricing API)
- **Modes**: Currently simplified (shows current mode), can be enhanced with actual planning
- **PV forecast**: Bell curve 8am-5pm based on sun4h weather data
- **SoC projection**: Linear model (-2%/h discharge, +5%/h PV charge)

## Future Enhancements

- **Smart mode forecasting**: Use tariff data to predict actual mode changes per hour
- **Weather-based PV**: Use Open-Meteo hourly sunshine_duration instead of bell curve
- **Advanced SoC model**: Calculate actual charge/discharge rates based on household load  
- **Historical overlay**: Show yesterday's actual vs today's forecast
- **Export function**: Save chart as image file for sharing

## Why Optional?

The `canvas` library requires:
- **Native compilation**: Uses Cairo/Pixman C libraries
- **Build tools**: gcc, make, python
- **System dependencies**: Multiple image libraries
- **Platform-specific**: Different install on each OS

Making it optional ensures:
- ✅ App installs quickly without build errors
- ✅ Works on resource-constrained systems
- ✅ No breaking changes for existing users
- ✅ Advanced users can enable visual features

## Support

If you encounter canvas installation issues:
1. Ensure all system dependencies are installed
2. Check Node.js version is compatible (v16-v22)
3. Try `npm rebuild canvas` after system package install
4. See canvas documentation: https://github.com/Automattic/node-canvas

For development machine without chart:
- Battery policy works 100% normally
- Chart code gracefully skips execution
- No errors or warnings in production
