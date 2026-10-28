#!/usr/bin/env bash
# Apply the Pi cache keep-alive pieces to this machine's Pi install.
# Idempotent. Run again after updating Pi packages:
#   bash pi/install.sh
# Running Pi sessions keep their old code until they restart.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
AGENT=${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}
BRIDGE=$AGENT/npm/node_modules/pi-claude-bridge
PATCH=$HERE/claude-bridge-keepalive.patch
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$AGENT/backups" "$AGENT/extensions"

# 1. Codex keep-alive: a plain extension file, auto-discovered by Pi.
DEST=$AGENT/extensions/codex-cache-keepalive.ts
if [ -f "$DEST" ] && cmp -s "$HERE/codex-cache-keepalive.ts" "$DEST"; then
  echo "[ok] codex-cache-keepalive.ts already current"
else
  [ -f "$DEST" ] && cp "$DEST" "$AGENT/backups/codex-cache-keepalive.ts.bak-$STAMP"
  cp "$HERE/codex-cache-keepalive.ts" "$DEST"
  echo "[ok] installed $DEST"
fi

# 2. claude-bridge keep-alive: a patch on the installed pi-claude-bridge package.
#    The unpatched source is kept as a pristine copy, so a newer patch revision
#    can be applied over an older one.
REV=$(grep -o 'KEEPALIVE_PATCH_REV = [0-9]*' "$PATCH" | head -1)
SRC=$BRIDGE/src/index.ts
if [ ! -f "$SRC" ]; then
  echo "[skip] pi-claude-bridge not installed at $BRIDGE"
elif grep -q "$REV" "$SRC"; then
  echo "[ok] pi-claude-bridge already patched ($REV)"
else
  VERSION=$(cd "$BRIDGE" && node -p "require('./package.json').version")
  PRISTINE=$AGENT/backups/pi-claude-bridge-$VERSION-index.ts.orig
  if grep -q "Cache keep-alive (local patch" "$SRC"; then
    # An older patch revision: start again from the pristine source.
    if [ ! -f "$PRISTINE" ]; then
      echo "[FAIL] older keep-alive patch found but no pristine copy at $PRISTINE"
      exit 1
    fi
    cp "$SRC" "$AGENT/backups/pi-claude-bridge-index.ts.bak-$STAMP"
    cp "$PRISTINE" "$SRC"
    echo "[ok] restored pristine pi-claude-bridge $VERSION source to upgrade the patch"
  else
    [ -f "$PRISTINE" ] || cp "$SRC" "$PRISTINE"
  fi
  [ "$VERSION" = "0.9.3" ] || echo "[warn] patch was made for pi-claude-bridge 0.9.3, found $VERSION; trying it"
  if (cd "$BRIDGE" && patch -p1 --dry-run -s < "$PATCH" >/dev/null); then
    (cd "$BRIDGE" && patch -p1 -s --no-backup-if-mismatch < "$PATCH")
    echo "[ok] patched pi-claude-bridge $VERSION ($REV; pristine copy in $AGENT/backups)"
  else
    echo "[FAIL] patch does not apply to pi-claude-bridge $VERSION; re-make it against this version"
    exit 1
  fi
fi

echo "Restart Pi sessions to load. Pings are logged to $AGENT/cache-keepalive.log"
