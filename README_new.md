# HomeWizard for Homey

Control and monitor your HomeWizard Energy devices directly from your Homey smart home hub.

## 🚀 Quick Start

1. **Enable Local API** - Open the official HomeWizard Energy app and enable "Local API" for your devices
2. **Add Homewizard Unit** - First add your main Homewizard unit in Homey
3. **Add Devices** - Then add related/connected components from Homewizard to your Homey

⚠️ **IMPORTANT**: You must enable "Local API" for your device in the official HomeWizard Energy app before adding devices to Homey.

## ✨ Features

### Smart Energy Management
- **P1 Meter Support** - Monitor energy consumption in real-time (API v1 & v2)
- **Smart Sockets** - Control and monitor individual devices
- **Battery Management** - Track and control home battery systems
- **Solar Integration** - Monitor solar production and consumption

### Advanced Features
- **Battery Policy Driver** - Automated battery management based on dynamic tariffs or peak shaving
- **Power Quality Monitoring** - Trigger cards for voltage sags, swells, and power failures
- **Baseload Detection** - Identify standby power consumption (sluipverbruik)
- **Learning Engine** - AI-powered pattern recognition for optimized battery charging
- **Cloud API Support** - Connect P1 meters and water meters via HomeWizard cloud

### Supported Devices
- P1 Energy Meters (API v1 & v2, including cloud-connected)
- Energy Sockets
- Plugin Battery
- SDM230 & SDM630 kWh Meters (3-phase, industrial grade)
- Water Meters (local & cloud)
- Legacy Devices (thermometer, heatlink, rainmeter, windmeter, sensors)

## 📊 Battery Policy Manager

NEW in v3.13.14: Intelligent battery management system that:
- Responds to dynamic electricity tariffs
- Implements peak shaving strategies
- Learns consumption patterns over time
- Adjusts PV production estimates based on historical accuracy
- Provides confidence scoring for policy decisions

**Note**: Cloud-based features depend on internet connectivity and HomeWizard Energy platform availability. During maintenance or outages, you may experience errors or incorrect data.

## 📝 Latest Updates (v3.13.49)

### New Features
* Battery Policy driver with ML-based charging optimization
* Trigger cards for energy grid errors, voltage swells, and voltage sags
* Learning engine for consumption patterns and PV accuracy tracking
* Plugin Battery state of charge icon for dashboard

### Improvements
* Homewizard Legacy Device updates (CSS, flow and language) - thanks smarthomesvan
* P1 meters can now connect via HomeWizard cloud API (thanks to Sven Serlier's research)
* Watermeter cloud support (4x daily updates via hwenergy)
* P1 (apiv2) tariff trigger improvements

### Bug Fixes
* Fixed capability_already_exists error (cloud_p1)

### Technical
* WebSocket internals refactored; debug and runtime statistics are now surfaced in the settings page for improved diagnostics

---

## 📖 Full Changelog

<details>
<summary>Click to expand complete version history</summary>

### v3.12.9
* Plugin battery charge mode selectable from UI
* Energy (apiv2) guard for add/remove "battery_group_charge_mode"

### v3.12.7
* P1 tuning TIMEOUT & Unreachable
* Removed pollingActive (unwanted side effect)

### v3.12.4
* Baseload ignores return power (battery compensation)
* Plugin Battery LED brightness adjustment
* Battery Group SoC improvements
* Polling deadlock fixes for multiple drivers
* WebSocket & caching optimizations
* Baseload detection runs every 30s (reduced CPU load)

### v3.11.9
* P1 energy and energy_v2 modular architecture
* Heatlink target_temperature safety checks
* P1 processing order optimized
* Battery Group State of Charge improvements

### v3.10.13
* Plugin battery mode names updated
* SDM630 per-phase kWh tracking
* Gas usage reset improvements
* Device name in debug messages

### v3.10.7
* Watermeter daily usage added
* Homewizard Legacy fetch improvements
* Adaptive polling & timeout tuning
* Debug information capture in app settings

### v3.9.29
* WebSocket manager optimization
* Baseload detection improvements
* App settings page with comprehensive logging
* Homewizard Legacy custom polling & UI improvements

### v3.9.20
* **NEW**: Plugin Battery zero_charge_only & zero_discharge_only modes
* **NEW**: Baseload (sluipverbruik) detection (experimental)
* Phase overload notifications with customizable thresholds
* Optional gas checkbox for P1 meters
* Belgium 15min power datapoint support
* APIv2 pairing improvements
* Code refactoring for multiple drivers

### v3.8.22
* Energy_v2 instant primary value updates
* WebSocket fine-tuning
* Watchdog for firmware changes
* Centralized fetch queue

### v3.8.16
* WebSocket-based battery mode settings
* WebSocket heartbeat for battery mode tracking
* HTTP agent tuning for ETIMEOUT/ECONNRESET

### v3.8.11
* Energy dongle code rollback
* Enhanced mDNS logging for older Homey devices

### v3.7.9
* WebSocket error handling improvements
* WiFi connection stability fixes
* Net frequency capability improvements

### v3.7.1
* **NEW**: Battery SoC Drift trigger card
* **NEW**: Battery error trigger card
* **NEW**: Net frequency out of range trigger
* Real-time WebSocket data for P1 apiv2 & Plugin Battery
* WebSocket reconnect for WiFi issues
* Optional polling fallback

### v3.6.77
* Custom polling interval for Homewizard Legacy (default 20s)
* Energy sockets: 3 retry attempts
* Fallback URL for P1 mode SDM230/SDM630

### v3.6.75
* Thermometer full refactoring
* Keep-alive fine-tuning
* Verbose mDNS discovery logging

### v3.6.73
* Homewizard Legacy crash protection
* Plugin battery kWh estimation improvements
* CloudOn/Off error handling

### v3.6.71
* Enhanced diagnostic logging
* Plugin battery charge estimate
* Polling & capability initialization improvements

### v3.6.67
* Interval enforcement across devices
* Authorization handler bugfixes

### v3.6.66
* Fallback URL settings for older Homey Pro devices
* HTTP keep-alive for Legacy devices
* Increased authorization/pairing timeouts

### v3.6.63
* **NEW**: SDM230 P1 mode
* P1apiv2 daily usage kWh tracking
* 3-phase detection for Norway
* HTTP keep-alive agent
* WiFi quality capability

### v3.6.58
* Energy flags for sockets (Home Batteries tracking)
* Slider capability fixes
* API call spreading optimization

### v3.6.50
* **NEW**: Phase monitoring with customizable thresholds
* Actual gas meter measurement
* Plugin battery trigger cards (state, time to full/empty)
* P1apiv1 code refactoring

### v3.6.40
* Cloud connection settings for multiple devices
* Watermeter offset bugfix

### v3.6.38
* Custom polling intervals (Watermeter, SDM230, SDM630)
* **NEW**: Plugin battery action cards (requires P1 firmware 6.0201+)
* WiFi metrics (dBm) for P1apiv2 & Plugin Battery
* Daily usage tracking (P1apiv1)
* Battery mode change trigger

### v3.6.6
* Polling interval adjustments (1s → 10s for stability)

### v3.6.2
* Major code rework (credits: DCSBL)
* Homey Energy dashboard integration
* Energylink meter_gas capability

### v3.5.5
* P1 APIv2 pairing improvements (DCSBL)
* Aligned pairing process (P1 & Plugin Battery)

### v3.5.2
* **NEW**: SDM630 clone for P1-like kWh meter usage

### v3.5.1
* Conversion to homey-compose (DCSBL)
* Socket identification with LED blink (DCSBL)

</details>

---

## 💝 Support This Project

If you find this app useful, consider supporting development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donateCC_LG.gif)](https://www.paypal.com/paypalme2/jtebbens)

---

## 📄 License

This app is licensed under the GNU General Public License v3.0

## 👥 Credits

- **Jeroen Tebbens** - Main developer
- **DCSBL** - Major code contributions (homey-compose, pairing improvements)
- **Sven Serlier (smarthomesvan)** - Cloud API research, Legacy device improvements
- **Community contributors** - Bug reports and feature requests

## 🔗 Links

- [GitHub Repository](https://github.com/jtebbens/com.homewizard)
- [Homey App Store](https://homey.app/a/com.homewizard/)
- [HomeWizard Official Site](https://www.homewizard.com/)
