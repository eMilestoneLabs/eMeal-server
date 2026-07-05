#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# performance.sh — ULTRA-SPEED metrics + memory-leak SOAK signal.
#   • Per-endpoint latency: p50/p95/p99/min/max over $PERF_SAMPLES, SLO gates.
#   • Concurrency / throughput: $PERF_CONC parallel clients → req/s + error rate.
#   • Soak/memory: PM2 RSS before → $SOAK_REQUESTS sustained load → settle →
#     RSS after; reports delta & growth %. This is a LEAK SIGNAL (a monotonic,
#     non-recovering climb is suspicious), NOT a formal leak proof.
# Read-only endpoints only. Tagged FR-TIME / FR-CONC / FR-MEMX.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"

: "${ADMIN_EMAIL:?}"; : "${ADMIN_PASS:?}"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
req GET /groups "" "$ADMIN_TOKEN"; GROUP_ID="${GROUP_ID:-$(jbody '(.data // .)[0].id // empty')}"

sec "PERF-A — LATENCY PERCENTILES (backend compute, localhost) FR-TIME / NFR-perf"
echo "  (samples=$PERF_SAMPLES each; SLO gate on p95)" >&2
perf "health"           "/health"                                                   ""            "NFR-PERF-001" 100 >/dev/null
perf "dashboard/admin"  "/dashboard/admin"                                          "$ADMIN_TOKEN" "FR-OVR-001,NFR-PERF-010" 300 >/dev/null
perf "attendance/today" "/attendance/today"                                         "$ADMIN_TOKEN" "FR-ATT-001,NFR-PERF-011" 200 >/dev/null
perf "meals/today"      "/meals/today?groupId=$GROUP_ID"                            "$ADMIN_TOKEN" "FR-MEAL-020,NFR-PERF-012" 250 >/dev/null
perf "billing-summary"  "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "$ADMIN_TOKEN" "FR-BILL-001,NFR-PERF-013" 250 >/dev/null
perf "groups"           "/groups"                                                   "$ADMIN_TOKEN" "FR-GRP-001,NFR-PERF-014" 200 >/dev/null

sec "PERF-B — CONCURRENCY / THROUGHPUT (${PERF_CONC} parallel clients) FR-CONC-001"
TOTAL=$((PERF_CONC*10))
ERRF="$RESULTS_DIR/.thr_err"; : > "$ERRF"
START=$(date +%s.%N)
seq 1 "$TOTAL" | xargs -P"$PERF_CONC" -I{} sh -c \
  'c=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer '"$ADMIN_TOKEN"'" "'"$BASE"'/dashboard/admin"); [ "$c" = "200" ] || echo "$c" >> "'"$ERRF"'"'
END=$(date +%s.%N)
ELAPSED=$(awk "BEGIN{print $END-$START}")
RPS=$(awk "BEGIN{printf \"%.1f\", $TOTAL/($ELAPSED>0?$ELAPSED:1)}")
ERRS=$(wc -l < "$ERRF" | tr -d ' ')
echo "  $TOTAL reqs @P$PERF_CONC in ${ELAPSED}s → ${RPS} req/s, errors=$ERRS" >&2
[ "$ERRS" = "0" ] && ok "Concurrency stable (0 errors @ P$PERF_CONC)" "${RPS} req/s" "FR-CONC-001" \
  || no "Concurrency errors" "$ERRS non-200 of $TOTAL" "FR-CONC-001"

sec "PERF-C — MEMORY SOAK / LEAK SIGNAL ($SOAK_REQUESTS reqs) FR-MEMX-001"
if command -v pm2 >/dev/null; then
  rss(){ pm2 jlist 2>/dev/null | jq '[.[]|select(.name=="emeal-server")|.monit.memory]|add // 0'; }
  restarts(){ pm2 jlist 2>/dev/null | jq '[.[]|select(.name=="emeal-server")|.pm2_env.unstable_restarts]|add // 0'; }
  # Warm-up: right after a PM2 reload the workers are still allocating (JIT,
  # pool/route caches), so a cold baseline reads that ramp as a fake "leak".
  # Prime to steady state, let GC settle, THEN take the baseline.
  echo "  warm-up: 300 requests before baseline..." >&2
  seq 1 300 | xargs -P"$PERF_CONC" -I{} sh -c \
    'curl -s -o /dev/null -H "Authorization: Bearer '"$ADMIN_TOKEN"'" "'"$BASE"'/dashboard/admin"'
  sleep 5
  MEM0=$(rss); R0=$(restarts)
  ENDPOINTS=( "/dashboard/admin" "/attendance/today" "/meals/today?groupId=$GROUP_ID" "/groups" "/notices" )
  echo "  soaking with $SOAK_REQUESTS requests across ${#ENDPOINTS[@]} endpoints..." >&2
  seq 1 "$SOAK_REQUESTS" | xargs -P"$PERF_CONC" -I{} sh -c \
    'eps="'"${ENDPOINTS[*]}"'"; set -- $eps; n=$(( ($$ + {}) % '"${#ENDPOINTS[@]}"' + 1 )); eval p=\${$n};
     curl -s -o /dev/null -H "Authorization: Bearer '"$ADMIN_TOKEN"'" "'"$BASE"'$p"'
  # Two-point settle: a real leak keeps CLIMBING after load stops; a healthy
  # cluster expands its V8 heap under burst then plateaus/recedes as GC runs.
  # So we measure twice (12s + 12s) and judge the TREND, not just the peak.
  sleep 12; MEM1=$(rss)
  sleep 12; MEM2=$(rss); R1=$(restarts)
  DELTA=$(( (MEM2-MEM0)/1048576 ))
  PCT=$(awk "BEGIN{printf \"%.1f\", ($MEM0>0)?(($MEM2-$MEM0)*100.0/$MEM0):0}")
  # Trend after peak: >0 means still climbing (leak-like), <=0 means settling.
  TREND=$(awk "BEGIN{printf \"%.1f\", ($MEM1>0)?(($MEM2-$MEM1)*100.0/$MEM1):0}")
  echo "  RSS before=$((MEM0/1048576))MB settle1=$((MEM1/1048576))MB settle2=$((MEM2/1048576))MB Δ=${DELTA}MB (${PCT}%) post-peak-trend=${TREND}% restarts:${R0}→${R1}" >&2
  # A leak = still climbing after settle AND well above a cluster-burst
  # tolerance (4 workers each grow their heap independently). Plateauing or
  # receding RSS is healthy regardless of the absolute burst peak.
  STILL_CLIMBING=$(awk "BEGIN{print ($TREND>2.0)?1:0}")
  OVER=$(awk "BEGIN{print ($PCT>30.0)?1:0}")
  if [ "$R1" -gt "$R0" ]; then no "Memory soak — worker restarted under load" "restarts ${R0}→${R1}" "FR-MEMX-001"
  elif [ "$STILL_CLIMBING" = "1" ] && [ "$OVER" = "1" ]; then no "Memory soak — RSS still climbing ${TREND}% after settle at ${PCT}% (investigate)" "Δ${DELTA}MB" "FR-MEMX-001"
  else ok "Memory soak stable (Δ${DELTA}MB, ${PCT}% peak, trend ${TREND}%, no restarts)" "leak-signal clean" "FR-MEMX-001,FR-MEMX-010"; fi
else skip "Memory soak" "pm2 not on PATH" "FR-MEMX-001"; fi

[ "${SRS_SOURCED:-0}" = "1" ] || summary "PERFORMANCE"
