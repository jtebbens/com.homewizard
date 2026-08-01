#!/bin/bash
# Archive the battery SoC series at 5-minute resolution before Homey Insights downsamples it.
#
# Insights keeps `last24Hours` at 5-min steps WITH decimals (it averages within each bucket),
# but `last7Days` collapses to hourly and `last31Days` to 6-hourly. So the high-resolution
# history only exists for 24 hours and is then gone for good.
#
# That resolution is what the replay harness needs: policy_mode_history stores SoC as whole
# percent sampled once per policy run, and that reading does not refresh every slot —
# consecutive discharge slots alternate large/small steps whose mean is right while the
# individual values are not (see project_counterfactual_replay_harness.md).
#
# Runs twice a day so a single missed run cannot punch a hole in the series; rows are
# de-duplicated on timestamp, so the overlap is harmless.
#
# Install:
#   crontab -l 2>/dev/null | { cat; echo "17 5,17 * * * /root/github/com.homewizard/tools/archive-soc-5min.sh"; } | crontab -

set -euo pipefail

DEVICE="homey:device:08e18fb1-bc61-49d3-94b4-bcedb3ff7d6d"
OUT="/root/logs/battery-soc-5min.csv"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# cron gives a bare PATH; the homey CLI lives under nvm. Resolve it the same way the LXC
# mirror scripts had to after the 2026-07-13 cron-env outage (missing HOME/nvm PATH silently
# killed them for 17 days).
export HOME="${HOME:-/root}"
if ! command -v node >/dev/null 2>&1; then
  for n in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$n" ] && PATH="$n:$PATH"
  done
  export PATH
fi
command -v node >/dev/null 2>&1 || { echo "node not found in PATH" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
[ -f "$OUT" ] || echo "ts,soc" > "$OUT"

node "$(dirname "$0")/homey-local.js" \
  insights "$DEVICE:battery_group_average_soc" last24Hours \
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
{ echo "ts,soc"; cat "$TMP.merged"; } > "$OUT"
rm -f "$TMP.merged"

echo "$(date -Is) archived $rows rows, total $(( $(wc -l < "$OUT") - 1 ))"
