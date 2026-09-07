#!/bin/bash
# Pull every [DP-INPUT-DUMP] file the app has written into tools/_dpdumps/, skipping what is
export PATH=/root/.nvm/versions/node/v22.21.1/bin:/usr/bin:/bin
# already there. The Homey keeps only the newest DP_DUMP_KEEP=12 (device.js:49), so this must run
# between armings or a batch is rotated away before it is ever read.
#
# Filenames come from the log pointer line; the payload comes off the LAN API (tools/homey-local.js),
# not `homey api` — the CLI resolves through Athom's cloud and a rate-limit there would block this.
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=${HOMEY_LOG:-/tmp/homey.log}
DEST=tools/_dpdumps
mkdir -p "$DEST"
got=0; miss=0; had=0
for f in $(grep -ho 'dp-input-[0-9]\{8\}T[0-9]\{6\}\.[0-9]\{3\}Z\.json' "$LOG" | sort -u); do
  if [ -s "$DEST/$f" ]; then had=$((had+1)); continue; fi
  if node tools/homey-local.js userdata "$f" > "$DEST/$f.tmp" 2>/dev/null && [ -s "$DEST/$f.tmp" ] \
     && head -c1 "$DEST/$f.tmp" | grep -q '{'; then
    mv "$DEST/$f.tmp" "$DEST/$f"; got=$((got+1))
  else
    rm -f "$DEST/$f.tmp"; miss=$((miss+1))   # rotated off the Homey already
  fi
done
echo "$(date -Is) harvest: +$got new, $had already local, $miss gone (rotated)"
