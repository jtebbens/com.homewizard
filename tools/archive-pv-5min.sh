#!/bin/bash
# Archive the PV production meter at 5-minute resolution before Homey Insights downsamples it.
#
# Same retention trap as the SoC archive (see archive-soc-5min.sh): Insights keeps `last24Hours`
# at 5-min steps, `last7Days` collapses to hourly and `last31Days` to 6-hourly. The fine series
# is gone for good after a day.
#
# Needed because the only usable magnitude source for realized PV is this cumulative meter
# differentiated to 15-min energy — the momentary `pvW` tile is a lottery under broken cloud
# (project_cloud_forecast_overcast_miss.md, bevinding 2, 2026-08-17).
#
# Stores the RAW cumulative kWh; differentiating is left to the analysis so no information is
# discarded here.
#
# Runs twice a day so a single missed run cannot punch a hole in the series; rows are
# de-duplicated on timestamp, so the overlap is harmless.
#
# Install:
#   crontab -l 2>/dev/null | { cat; echo "23 5,17 * * * /root/github/com.homewizard/tools/archive-pv-5min.sh"; } | crontab -

set -euo pipefail

DEVICE="homey:device:dfa15233-9ace-4005-a07d-909f41658cbb"
OUT="/root/logs/pv-produced-5min.csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# cron gives a bare PATH; node lives under nvm. Same resolution as archive-soc-5min.sh.
export HOME="${HOME:-/root}"
if ! command -v node >/dev/null 2>&1; then
  for n in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$n" ] && PATH="$n:$PATH"
  done
  export PATH
fi
command -v node >/dev/null 2>&1 || { echo "node not found in PATH" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
[ -f "$OUT" ] || echo "ts,kwh_cum" > "$OUT"

node "$(dirname "$0")/homey-local.js" \
  insights "$DEVICE:meter_power.produced.t1" last24Hours \
| python3 -c '
import json, sys
d = json.load(sys.stdin)
for v in d.get("values", []):
    if v.get("v") is not None:
        print("%s,%s" % (v["t"], v["v"]))
' > "$TMP"

# Refuse to touch the archive on a short/empty pull rather than appending a truncated day.
rows=$(wc -l < "$TMP")
if [ "$rows" -lt 100 ]; then
  echo "only $rows rows returned (expected ~288) — not archiving" >&2
  exit 1
fi

# Merge, de-duplicate on timestamp, keep chronological order.
{ tail -n +2 "$OUT"; cat "$TMP"; } | sort -u -t, -k1,1 > "$TMP.merged"
{ echo "ts,kwh_cum"; cat "$TMP.merged"; } > "$OUT"
rm -f "$TMP.merged"

echo "$(date -Is) archived $rows rows, total $(( $(wc -l < "$OUT") - 1 ))"
