#!/bin/bash
# Arm the app-setting `dp_input_dump` for N runs (it counts itself down to 0, so it can never stay
# on). Absolute PATH because cron runs no login shell and the homey CLI lives under nvm.
export PATH=/root/.nvm/versions/node/v22.21.1/bin:/usr/bin:/bin
N=${1:-12}
homey api apps set-app-setting --id com.homewizard --name dp_input_dump --value "$N" >/dev/null 2>&1
back=$(homey api apps get-app-setting --id com.homewizard --name dp_input_dump --json 2>/dev/null)
echo "$(date -Is) arm: requested $N, readback $back"
