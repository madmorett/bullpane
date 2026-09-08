#!/usr/bin/env bash
# Runs the stress phases end to end. Requires: fixture loaded (load.ts), server up
# on $BASE, $STRESS_OUT/cookie.txt (COOKIE=...) and $STRESS_OUT/cid.txt (CID=...).
set -euo pipefail
export STRESS_OUT=${STRESS_OUT:-/tmp/bullpane-stress}
export BASE=${BASE:-http://localhost:3100}
export $(cat "$STRESS_OUT/cookie.txt") $(cat "$STRESS_OUT/cid.txt")
PHASE_SECS=${PHASE_SECS:-60}
cd "$(dirname "$0")/../.."   # apps/simulator
rm -f "$STRESS_OUT/probe.jsonl" "$STRESS_OUT/redis.jsonl" "$STRESS_OUT/server.jsonl"; echo "[]" > "$STRESS_OUT/phases.json"

pnpm exec tsx src/stress/probe.ts > "$STRESS_OUT/probe.log" 2>&1 & PROBE=$!
pnpm exec tsx src/stress/redis-monitor.ts > "$STRESS_OUT/redis-monitor.log" 2>&1 & MON=$!
SERVER_PID=$(lsof -ti:${BASE##*:} -sTCP:LISTEN | head -1)
( while true; do echo "{\"t\":$(date +%s000),\"rssMB\":$(ps -o rss= -p "$SERVER_PID" | awk '{print int($1/1024)}'),\"cpu\":$(ps -o %cpu= -p "$SERVER_PID" | tr -d ' ')}" >> "$STRESS_OUT/server.jsonl"; sleep 2; done ) & SRV=$!
trap 'kill $PROBE $MON $SRV 2>/dev/null || true' EXIT
sleep 15   # let the probe reach steady state

phase() { # name, duration, command...
  local name=$1 secs=$2; shift 2
  local start=$(date +%s000)
  echo "=== phase: $name ($secs s) ==="
  if [ $# -gt 0 ]; then DURATION=$secs "$@" > "$STRESS_OUT/load-$name.json" 2>&1 || true; else sleep "$secs"; fi
  local end=$(date +%s000)
  python3 - "$STRESS_OUT/phases.json" "$name" "$start" "$end" <<'PY'
import json,sys; f,n,s,e=sys.argv[1:]; p=json.load(open(f)); p.append({"name":n,"start":int(s),"end":int(e)}); json.dump(p,open(f,"w"))
PY
}

phase "baseline (server idle)" "$PHASE_SECS"
phase "1 user on overview"     "$PHASE_SECS" env MODE=idle pnpm exec tsx src/stress/dashboard-load.ts
phase "5 realistic users"      "$PHASE_SECS" env MODE=realistic pnpm exec tsx src/stress/dashboard-load.ts
phase "hostile x20"            "$PHASE_SECS" env MODE=hostile CLIENTS=20 pnpm exec tsx src/stress/dashboard-load.ts
phase "hostile x50"            "$PHASE_SECS" env MODE=hostile CLIENTS=50 pnpm exec tsx src/stress/dashboard-load.ts
phase "recovery (idle)"        30

pnpm exec tsx src/stress/report.ts | tee "$STRESS_OUT/report.txt"
echo "--- server process (RSS MB / %CPU) min..max:"; python3 - "$STRESS_OUT/server.jsonl" <<'PY'
import json,sys; rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]; print("rss", min(r["rssMB"] for r in rows), "..", max(r["rssMB"] for r in rows), "MB · cpu max", max(float(r["cpu"]) for r in rows), "%")
PY
