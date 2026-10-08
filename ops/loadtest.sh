#!/usr/bin/env bash
#
# ops/loadtest.sh — the pre-go-live gate for datum on the shared VPS.
#
#   bash /opt/datum/ops/loadtest.sh [N]        (default N=10)
#
# 1. Baseline: free -m, then vmstat 5 for one minute.
# 2. N attestations through the real service path (Base read, proof, sponsor
#    DUST, submit), one after another, while sampling every 5 s:
#      - MemAvailable
#      - swap-in (vmstat si)
#      - restart counts of lictor, lictor-felix and partitio-relayer
# 3. ROLLBACK, immediately, if available memory drops under 500 MB, swap-in
#    stays active for three samples in a row, or any watched process restarts:
#    stop the datum units and nothing else on the box changes.
#
# Run it with the service started with RATE_PER_HOUR raised for the test
# (every request comes from 127.0.0.1, so the per-IP limit would stop at 3).
#
set -u
N=${1:-10}
API=http://127.0.0.1:3034
WATCH="lictor lictor-felix partitio-relayer"
LOG=/opt/datum/loadtest-$(date -u +%Y%m%dT%H%M%SZ).log
exec > >(tee -a "$LOG") 2>&1

restarts() { pm2 jlist 2>/dev/null | node -e '
  const a = JSON.parse(require("fs").readFileSync(0)); const w = process.argv[1].split(" ");
  console.log(w.map((n) => { const p = a.find((x) => x.name === n); return `${n}=${p ? p.pm2_env.restart_time + ":" + p.pm2_env.status : "missing"}`; }).join(" "));' "$WATCH"; }
avail() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
rollback() {
  echo "ROLLBACK: $1"
  pm2 stop datum-tunnel datum-api datum-prover >/dev/null 2>&1
  pm2 jlist | node -e 'for (const p of JSON.parse(require("fs").readFileSync(0))) if (p.name.startsWith("datum")) console.log(p.name, p.pm2_env.status)'
  exit 1
}

echo "== baseline $(date -u +%FT%TZ)"
free -m
vmstat 5 13
BASE=$(restarts)
echo "watched: $BASE"

echo "== load: $N attestations"
SAMPLER_FLAG=/tmp/datum-loadtest.$$
touch "$SAMPLER_FLAG"
(
  hot=0
  while [ -e "$SAMPLER_FLAG" ]; do
    a=$(avail); si=$(vmstat 1 2 | tail -1 | awk '{print $7}'); r=$(restarts)
    echo "sample $(date -u +%T) avail_MB=$a si=$si $r"
    [ "$a" -lt 500 ] && { echo "TRIP avail $a < 500"; kill -USR1 $$; break; }
    if [ "$si" -gt 0 ]; then hot=$((hot + 1)); else hot=0; fi
    [ "$hot" -ge 3 ] && { echo "TRIP swap-in active 3 samples"; kill -USR1 $$; break; }
    [ "$r" != "$BASE" ] && { echo "TRIP restart: $r vs $BASE"; kill -USR1 $$; break; }
    sleep 4
  done
) &
SAMPLER=$!
trap 'rm -f "$SAMPLER_FLAG"; rollback "a gate tripped"' USR1

books=(aero-overlevered aero-conservative)
for i in $(seq 1 "$N"); do
  b=${books[$(( (i - 1) % 2 ))]}
  t0=$(date +%s)
  id=$(curl -s -X POST "$API/api/attest" -H 'content-type: application/json' -d "{\"book\":\"$b\"}" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);console.log(j.id??("ERR "+j.error))}catch{console.log("ERR "+s)}})')
  case "$id" in ERR*) echo "job $i: $id"; continue ;; esac
  while :; do
    j=$(curl -s "$API/api/jobs/$id")
    st=$(echo "$j" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(j.status, j.result?.txHash ?? j.error ?? "", j.result?.block ?? "")})')
    case "$st" in landed*|failed*) break ;; esac
    sleep 3
  done
  echo "job $i ($b): $st  $(( $(date +%s) - t0 )) s"
done

rm -f "$SAMPLER_FLAG"
wait "$SAMPLER" 2>/dev/null
echo "== after $(date -u +%FT%TZ)"
free -m
echo "watched: $(restarts)  (baseline $BASE)"
P=$(pm2 pid datum-prover); A=$(pm2 pid datum-api)
for pid in $P $A; do CG=/sys/fs/cgroup$(cut -d: -f3 /proc/$pid/cgroup); echo "pid $pid $(cut -d: -f3 /proc/$pid/cgroup) peak_MB=$(( $(cat $CG/memory.peak) / 1048576 )) max=$(cat $CG/memory.max) swap.max=$(cat $CG/memory.swap.max) oom_score_adj=$(cat /proc/$pid/oom_score_adj)"; done
echo "log: $LOG"
