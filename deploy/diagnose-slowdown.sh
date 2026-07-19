#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# diagnose-slowdown.sh — answers "WHY is the box slow RIGHT NOW?" in ~30s.
#
#   bash deploy/diagnose-slowdown.sh
#
# Read-only: takes a CPU/steal sample, lists the top consumers, snapshots
# docker + PM2, and probes /health 20x. Ends with a plain-English VERDICT:
#   • STEAL       → a noisy neighbor VM on the shared host is eating your CPU.
#                   Nothing on this VPS can fix it; re-measure later or ask
#                   Contabo / upgrade to dedicated vCPU.
#   • LOCAL-CPU   → a process on THIS box is hogging CPU (top list shows who —
#                   usually a k6/audit run still winding down).
#   • HEALTHY     → box is calm; if an audit failed earlier it was transient —
#                   re-run it now.
#
# Golden band reference (idle box): /health p95 ≤ 15ms, steal ≤ 2%, load < 1.
# ─────────────────────────────────────────────────────────────────────────────
set -u

echo "══ eMeal slowdown diagnosis — $(date -Is) ══"
echo
echo "── 1. Load average (rule of thumb: keep < 4 on 4 vCPUs; < 1 = calm) ──"
uptime

echo
echo "── 2. CPU sample over 10s — watch 'st' (steal) and 'id' (idle) ──"
# vmstat: 3 samples, 5s apart; first data line is since-boot garbage.
# IMPORTANT: newer procps adds a 'gu' (guest) column after 'st', so columns
# must be located from the HEADER row, never counted from the end.
VM_ALL=$(vmstat 5 3)
VM_HDR=$(echo "$VM_ALL" | sed -n '2p')
VM_OUT=$(echo "$VM_ALL" | tail -2)
echo "$VM_HDR"
echo "$VM_OUT"
ID_COL=$(echo "$VM_HDR" | awk '{for(i=1;i<=NF;i++) if($i=="id") print i}')
ST_COL=$(echo "$VM_HDR" | awk '{for(i=1;i<=NF;i++) if($i=="st") print i}')
AVG_ID=$(echo "$VM_OUT" | awk -v c="${ID_COL:-15}" '{s+=$c; n++} END {printf "%d", (n?s/n:0)}')
AVG_ST=$(echo "$VM_OUT" | awk -v c="${ST_COL:-17}" '{s+=$c; n++} END {printf "%d", (n?s/n:0)}')
echo "   → avg steal=${AVG_ST}%  avg idle=${AVG_ID}%"

echo
echo "── 3. Top 8 CPU consumers on this box ──"
ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -9

echo
echo "── 4. Docker containers (CPU%) ──"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null | head -14

echo
echo "── 5. PM2 workers ──"
pm2 jlist 2>/dev/null | node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
    try { JSON.parse(d).forEach(p=>console.log(
      `   ${p.name}[${p.pm_id}] cpu=${p.monit.cpu}% mem=${Math.round(p.monit.memory/1048576)}MB restarts=${p.pm2_env.restart_time}`
    )); } catch(e) { console.log("   (pm2 list unavailable)"); }
  })' 2>/dev/null || pm2 ls

echo
echo "── 6. /health probe — 20 samples (app+DB+Redis round trip) ──"
TIMES=()
for i in $(seq 1 20); do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 5 http://localhost:3000/api/v1/health 2>/dev/null || echo 5)
  TIMES+=("$T")
done
STATS=$(printf '%s\n' "${TIMES[@]}" | sort -n | awk '
  {a[NR]=$1} END {
    printf "min=%.0fms  p50=%.0fms  p95=%.0fms  max=%.0fms",
      a[1]*1000, a[int(NR*0.5)]*1000, a[int(NR*0.95)]*1000, a[NR]*1000 }')
echo "   $STATS"
P95_MS=$(printf '%s\n' "${TIMES[@]}" | sort -n | awk '{a[NR]=$1} END {printf "%d", a[int(NR*0.95)]*1000}')

# Stall forensics (2026-07-19): /health now reports the worker's event-loop
# delay histogram since its last read. This is the arbiter for slow tails:
#   eventLoop.maxMs ≈ the request tail  → IN-PROCESS stall (investigate app);
#   eventLoop.maxMs small, tails high   → the HOST paused the worker (vCPU
#   contention / co-located containers — no app code can fix that).
EL=$(curl -s --max-time 5 http://localhost:3000/api/v1/health 2>/dev/null \
  | jq -r '.eventLoop // empty | "mean=\(.meanMs)ms p99=\(.p99Ms)ms max=\(.maxMs)ms"' 2>/dev/null)
[ -n "$EL" ] && \
  echo "   event-loop delay (1 worker, since last /health read): $EL"

echo
echo "── VERDICT ──"
if [ "$AVG_ST" -ge 10 ]; then
  echo "  🛑 STEAL: ${AVG_ST}% of your CPU is being taken by OTHER customers' VMs on"
  echo "     this physical host. Your app and code are fine — measurements taken now"
  echo "     are unreliable. Re-run audits when steal ≤ 2-3%, or contact Contabo /"
  echo "     consider a dedicated-vCPU plan if this is frequent."
elif [ "$AVG_ID" -le 20 ]; then
  echo "  ⚠️  LOCAL-CPU: this box's own processes are consuming the CPU (idle only"
  echo "     ${AVG_ID}%). Check section 3 — an audit/k6/npm/build likely still running"
  echo "     or winding down. Wait for load < 1, then re-measure."
elif [ "${P95_MS:-999}" -gt 40 ]; then
  echo "  ⚠️  APP-SIDE?: CPU looks calm (steal=${AVG_ST}%, idle=${AVG_ID}%) but /health"
  echo "     p95=${P95_MS}ms is above the ~15ms golden band. Check PM2 logs, Postgres"
  echo "     (docker stats), and recent deploys — this pattern DOES warrant app-level"
  echo "     investigation."
else
  echo "  ✅ HEALTHY: steal=${AVG_ST}%, idle=${AVG_ID}%, /health p95=${P95_MS}ms — the box"
  echo "     is calm. If an audit failed earlier it was transient contention;"
  echo "     re-run it now:  bash deploy/run.sh --load --yes"
fi
