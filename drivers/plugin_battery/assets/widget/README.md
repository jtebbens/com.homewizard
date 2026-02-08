# Plugin Battery State of Charge Widget

## Overview

A beautiful, responsive widget that displays the Plugin Battery's state of charge (SoC) as a percentage. The widget provides real-time visual feedback with a color-coded battery icon that changes based on the charge level.

## Features

- **Real-time Percentage Display**: Shows current battery charge level as a large, easy-to-read percentage
- **Visual Battery Icon**: Animated battery icon with dynamic fill based on charge level
- **Color Coding**: 
  - Green (50-100%): Healthy charge
  - Orange (20-50%): Medium charge
  - Red (0-20%): Low battery warning
- **Connection Status**: Displays whether the device is connected
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Smooth Animations**: Transitions smoothly when battery level changes

## Widget Details

### HTML File
- **Location**: `drivers/plugin_battery/assets/widget/soc_widget.html`
- **Capability Used**: `measure_battery` (state of charge percentage)
- **Update Frequency**: Real-time as battery level changes

### Configuration

The widget is configured in `driver.compose.json` with:
- **ID**: `battery_soc_widget`
- **Template**: Generic widget template
- **Supported Capability**: `measure_battery` (0-100%)

### Trigger Tokens

The widget provides the following trigger token:
- **state_of_charge**: Returns the current battery charge percentage (0-100)

## Display Elements

1. **Title**: "Battery State of Charge"
2. **Battery Icon**: Visual representation with:
   - Battery body showing fill level
   - Terminal at the top
   - Color-coded fill (green → orange → red)
3. **Percentage Value**: Large, bold display of current charge level
4. **Status Indicator**: Shows connection status with indicator light
5. **Label**: "Charge Level" text

## Integration with Homey

The widget automatically:
- Updates whenever the `measure_battery` capability value changes
- Reflects real-time battery state from your Plugin Battery device
- Displays connection status based on device availability

## Usage

1. Add this widget to your Homey dashboard
2. Select your Plugin Battery device
3. The widget will display the current state of charge percentage
4. Watch the battery icon fill/empty as the charge level changes

## Styling Notes

- **Font**: System fonts (SF Pro Display, Segoe UI, Roboto)
- **Color Scheme**: 
  - Background gradient: Purple (#667eea to #764ba2)
  - Widget background: Clean white
  - Text: Dark gray (#333) for readability
- **Border Radius**: 24px for modern, rounded corners
- **Shadow**: Soft shadow for depth

## Responsive Breakpoints

- **Desktop**: Full 300px width widget
- **Tablet**: Scales appropriately
- **Mobile** (<480px): Compact layout with adjusted font sizes

## Future Enhancements (Optional)

Potential improvements for future versions:
- Time-to-full estimate display
- Time-to-empty estimate display
- Charging/discharging rate indicator
- Historical trend graph
- Temperature display
- Multi-language support (EN, NL already configured)

## Localization

The widget supports multiple languages configured in `driver.compose.json`:
- **English (en)**
- **Dutch (nl)**

All labels and descriptions are localized.
