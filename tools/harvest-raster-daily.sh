#!/bin/bash
# Harvest one day of the MSG satellite raster around the house, for the gap-detector track
# (spoor 5, project_pv_forecast_open_leads_0902.md).
#
# The replay itself must run on the LXC: it imports /opt/msgcpp/fetcher_ssi and needs eccodes.
# The LXC cannot reach the Homey (different subnet, ping returns 000), so the matching PV
# ground truth is collected separately by archive-pv-5min.sh on this box.
#
# One row per 15-min issue, 05-19 UTC: c1 (house cell), c3 (center 3x3 mean, what the DP eats),
# sstd (spread within those 9), p90/gmax/gstd over the full 11x11.
#
# Runs after sunset so the whole daylight window of the day just ended is covered.
#
# Install:
#   crontab -l 2>/dev/null | { cat; echo "40 21 * * * /root/github/com.homewizard/tools/harvest-raster-daily.sh >> /root/logs/harvest-raster.log 2>&1"; } | crontab -

set -euo pipefail

DAY="${1:-$(date -u +%Y%m%d)}"
LXC="jeroen@10.0.0.6"
OUTDIR="/root/logs/sat-raster"
OUT="$OUTDIR/$DAY.csv"

mkdir -p "$OUTDIR"

# fetcher_ssi reads KNMI_OPENDATA_KEY / LAT / LON from the environment, and those live in
# root-only /etc/msgcpp.env — the same cron-env trap that silently killed the mirror scripts for
# 17 days in 2026-07. ~/.msgcpp-replay.env holds a jeroen-readable copy of just those three keys.
ssh -o ConnectTimeout=15 "$LXC" \
  "set -a; . ~/.msgcpp-replay.env; set +a; python3 ~/sat_raster_replay.py $DAY" >/dev/null
scp -q "$LXC:/tmp/sat_raster_replay_$DAY.csv" "$OUT"
ssh -o ConnectTimeout=15 "$LXC" "rm -f /tmp/sat_raster_replay_$DAY.csv"

rows=$(( $(wc -l < "$OUT") - 1 ))
# 05-19 UTC at 15-min issues is 56 slots; accept a few dropped scans, refuse a broken day.
if [ "$rows" -lt 40 ]; then
  echo "$(date -Is) $DAY only $rows rows — keeping file but flagging" >&2
fi
echo "$(date -Is) $DAY harvested $rows rows -> $OUT"
