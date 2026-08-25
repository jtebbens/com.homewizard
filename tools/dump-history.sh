#!/bin/bash
# Dump policy_mode_history to tools/_hist-chunks/*.json, one file per Amsterdam day.
#
# The app writes one file per day to /userdata (mode-history-YYYY-MM-DD.json, ~45 kB full).
# That is where the store landed when the settings blob was cut down for RSS; before that it
# was one settings key per day, and before that a single 596 kB blob. All three are tried, in
# that order, so this keeps working against an older build.
#
# Days are derived from the calendar, not enumerated: neither the userdata route nor
# get-app-setting lists names. Missing days (app down, chunk pruned) answer null and are skipped.
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
    out=$(node "$(dirname "$0")/homey-local.js" "${3:-setting}" "$1" "$APP" 2>/dev/null | jq "${2:-.}" 2>/dev/null || true)
    # Valid JSON is enough; `jq -e` is deliberately not used, as it exits non-zero on `null`
    # and would turn an absent day (pruned, or app down that day) into a transport failure.
    if [ -n "$out" ] && printf '%s' "$out" | jq . >/dev/null 2>&1; then printf '%s' "$out"; return 0; fi
    sleep 2
  done
  return 1
}

# A day comes from the userdata file when the running build has one, else from the settings key
# the older build wrote. Both are asked for before a day is called missing: a build change must
# not look like a pruned day.
get_day() {
  local json
  if json=$(get "mode-history-$1.json" '.' userdata) && [ "$json" != "null" ]; then
    printf '%s' "$json"; return 0
  fi
  get "policy_mode_history_$1"
}

total=0
files=0
missing=0
for ((d = DAYS - 1; d >= 0; d--)); do
  day=$(TZ=Europe/Amsterdam date -d "-$d day" +%Y-%m-%d)
  if ! json=$(get_day "$day"); then
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
