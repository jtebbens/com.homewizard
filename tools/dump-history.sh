#!/bin/bash
# Dump policy_mode_history to tools/_hist-chunks/*.json, one file per Amsterdam day.
#
# The app stores the history as one settings key per day (policy_mode_history_YYYY-MM-DD,
# ~35 kB full) instead of one 596 kB blob. A day chunk is well under the 64 KiB
# get-app-setting cap, so the old index paging is gone — each day is one request.
#
# Day keys are derived from the calendar, not enumerated: get-app-setting takes a name, and
# there is no list-keys call. Missing days (app down, key pruned) return null and are skipped.
#
# Falls back to the pre-chunk single key when no day chunk answers, so this keeps working
# against a Homey still running a build from before the split.
set -euo pipefail

APP=com.homewizard
DAYS=${1:-24}                       # retention is 23 days; one extra covers a boundary write
OUT=$(dirname "$0")/_hist-chunks
mkdir -p "$OUT"; rm -f "$OUT"/*.json

# Reads go over the Homey's local API (tools/homey-local.js), not `homey api`: the CLI
# authenticates through Athom's cloud on every call, so a cloud rate-limit blocks the whole
# dump while the Homey itself is perfectly reachable on the LAN.
#
# The transport occasionally answers with something that is not JSON (a stray notice, a dropped
# connection). Retry once and validate, so a transient hiccup cannot silently drop a whole day
# from the dump -- a missing day looks exactly like a pruned one downstream.
get() {
  local out
  for _ in 1 2; do
    out=$(node "$(dirname "$0")/homey-local.js" setting "$1" "$APP" 2>/dev/null | jq "${2:-.}" 2>/dev/null || true)
    if printf '%s' "$out" | jq -e . >/dev/null 2>&1; then printf '%s' "$out"; return 0; fi
    sleep 2
  done
  return 1
}

total=0
files=0
missing=0
for ((d = DAYS - 1; d >= 0; d--)); do
  day=$(TZ=Europe/Amsterdam date -d "-$d day" +%Y-%m-%d)
  if ! json=$(get "policy_mode_history_$day"); then
    printf 'WARN %s: no valid answer after retry — day MISSING from this dump\n' "$day" >&2
    missing=$((missing + 1))
    continue
  fi
  if [ "$json" = "null" ]; then continue; fi
  n=$(printf '%s' "$json" | jq '. | length')
  if [ "$n" -eq 0 ]; then continue; fi
  printf '%s' "$json" > "$OUT/$day.json"
  printf '%s: %s entries\n' "$day" "$n" >&2
  total=$((total + n)); files=$((files + 1))
done

if [ "$files" -eq 0 ]; then
  echo 'no day chunks found — falling back to the legacy single key' >&2
  N=$(get policy_mode_history '. | length')
  if [ -z "$N" ] || [ "$N" = "null" ]; then echo 'policy_mode_history is empty too' >&2; exit 1; fi
  STEP=140                          # ~48 kB at ~340 B/entry, safely under the 64 KiB cap
  i=0
  while [ "$i" -lt "$N" ]; do
    j=$((i + STEP)); if [ "$j" -gt "$N" ]; then j=$N; fi
    printf 'legacy chunk %s:%s\n' "$i" "$j" >&2
    get policy_mode_history ".[$i:$j]" > "$OUT/$(printf 'legacy-%05d' $i).json"
    i=$j
  done
  echo "legacy: $(ls "$OUT" | wc -l) file(s), $N entries"
  exit 0
fi

echo "$files day file(s), $total entries → $OUT"
if [ "$missing" -gt 0 ]; then echo "WARN: $missing day(s) missing — rerun before using this dump" >&2; exit 2; fi
