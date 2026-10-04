#!/bin/sh
# Re-apply box3-ac-patch onto a BOX Local Engine install.
# Does not touch postgres, projects, play-worlds, or other data volumes.
#
# Usage:
#   ./apply.sh                  # default ENGINE_ROOT=/opt/box3-engine
#   ./apply.sh /opt/box3-engine

set -eu

ENGINE_ROOT="${1:-/opt/box3-engine}"
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ ! -f "$ENGINE_ROOT/compose.yml" ]; then
  echo "compose.yml not found under $ENGINE_ROOT" >&2
  exit 1
fi

mkdir -p "$ENGINE_ROOT/patches"
cp -f "$HERE/files/net-tick.js" "$ENGINE_ROOT/patches/net-tick.js"
cp -f "$HERE/files/net-server-controller.js" "$ENGINE_ROOT/patches/net-server-controller.js"
cp -f "$HERE/compose.ac.yml" "$ENGINE_ROOT/compose.ac.yml"

# Drop in-place volume lines from an older apply, so mounts live only in compose.ac.yml.
python3 - "$ENGINE_ROOT/compose.yml" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text().splitlines(True)
drop = ("patches/net-tick.js", "patches/net-server-controller.js")
kept = [ln for ln in lines if not any(s in ln for s in drop)]
if kept != lines:
    p.write_text("".join(kept))
    print("removed inline AC mounts from compose.yml")
else:
    print("compose.yml had no inline AC mounts")
PY

ENV_FILE="$ENGINE_ROOT/.env"
touch "$ENV_FILE"
if grep -q '^COMPOSE_FILE=' "$ENV_FILE"; then
  if grep -q 'compose.ac.yml' "$ENV_FILE"; then
    echo "COMPOSE_FILE already includes compose.ac.yml"
  else
    # append overlay to existing COMPOSE_FILE
    python3 - "$ENV_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = p.read_text().splitlines(True)
out = []
for ln in lines:
    if ln.startswith("COMPOSE_FILE=") and "compose.ac.yml" not in ln:
        val = ln.split("=", 1)[1].strip().strip('"').strip("'")
        ln = "COMPOSE_FILE=" + val + ":compose.ac.yml\n"
    out.append(ln)
p.write_text("".join(out))
print("updated COMPOSE_FILE")
PY
  fi
else
  printf '\nCOMPOSE_FILE=compose.yml:compose.ac.yml\n' >> "$ENV_FILE"
  echo "added COMPOSE_FILE=compose.yml:compose.ac.yml"
fi

echo "restarting creator + play (data volumes untouched)"
cd "$ENGINE_ROOT"
docker compose up -d creator play

echo "done. logs: $ENGINE_ROOT/apps/local-engine/data/loki-cheaters.jsonl"
echo "ban ips: $ENGINE_ROOT/apps/local-engine/data/loki-ban-ips.txt"
