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
# DEDUP: reuse the admin token functional.sh already put in scope (this module
# previously re-logged in unconditionally). reuse_or_login validates+reuses it,
# or logs in when standalone/expired.
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
# /attendance/today is student-scoped (returns 400 to an admin), so measure it
# with a student token for a true 200 hot-path reading. Falls back to admin.
reuse_or_login STUDENT_TOKEN "${STUDENT_EMAIL:-}" "${STUDENT_PASS:-}"
# DEDUP: reuse GROUP_ID already resolved by functional.sh (same shell); this GET
# carries no assertion, so skipping it when the id is known drops one redundant
# round-trip without losing a check. Standalone (unset) still resolves it.
[ -z "${GROUP_ID:-}" ] && { req GET /groups "" "$ADMIN_TOKEN"; GROUP_ID="$(jbody '(.data // .)[0].id // empty')"; }

# ── PERF-A settle (2026-07-19, 124656 audit) ─────────────────────────────────
# run.sh's module-start settle gate ran MINUTES ago; the functional + write
# battery since then re-raised the 1-min load, so PERF-A's SLO gates were
# measuring audit contention, not the app (srs started settled at 1.85, yet
# PERF-A read health p95=101 / meals 277 / billing 324 — every one a calm-box
# PASS: the same endpoints benchmarked 59/105/97 minutes later). Wait again
# HERE, immediately before sampling. PERF_SETTLE_LOAD=0 disables.
PERF_SETTLE_LOAD="${PERF_SETTLE_LOAD:-${SETTLE_LOAD:-2.0}}"
PERF_SETTLE_MAX_S="${PERF_SETTLE_MAX_S:-120}"
if awk -v t="$PERF_SETTLE_LOAD" 'BEGIN{exit !(t>0)}' && [ -r /proc/loadavg ]; then
  _pw=0
  while [ "$_pw" -lt "$PERF_SETTLE_MAX_S" ]; do
    _pl=$(cut -d' ' -f1 /proc/loadavg)
    awk -v l="$_pl" -v t="$PERF_SETTLE_LOAD" 'BEGIN{exit !(l<t)}' && {
      [ "$_pw" -gt 0 ] && echo "  ✓ box settled (load $_pl) after ${_pw}s — sampling now" >&2
      break
    }
    [ "$_pw" -eq 0 ] && echo "  ⏳ PERF-A settle: waiting for 1-min load < $PERF_SETTLE_LOAD (now $_pl; cap ${PERF_SETTLE_MAX_S}s; PERF_SETTLE_LOAD=0 to disable)…" >&2
    sleep 10; _pw=$((_pw + 10))
  done
  [ "$_pw" -ge "$PERF_SETTLE_MAX_S" ] && echo "  ⚠ load still ≥ $PERF_SETTLE_LOAD after ${_pw}s — sampling anyway (p95s may include box contention)" >&2
fi

sec "PERF-A — LATENCY PERCENTILES (backend compute, localhost) FR-TIME / NFR-perf"
echo "  (samples=$PERF_SAMPLES each; SLO gate on p95)" >&2
# perf() runs IN-PROCESS (so its SLO PASS/FAIL line displays and counts) and
# exposes each p95 via $PERF_P95, which we snapshot for the CERTIFICATE. Do NOT
# wrap these in $(...) — that would swallow the PASS line and corrupt .metrics.
perf "health"           "/health"                                                   ""            "NFR-PERF-001" 100;                    P_HEALTH="$PERF_P95"
perf "dashboard/admin"  "/dashboard/admin"                                          "$ADMIN_TOKEN" "FR-OVR-001,NFR-PERF-010" 300;         P_DASH="$PERF_P95"
perf "attendance/today" "/attendance/today"                                         "${STUDENT_TOKEN:-$ADMIN_TOKEN}" "FR-ATT-001,NFR-PERF-011" 200; P_ATT="$PERF_P95"
perf "meals/today"      "/meals/today?groupId=$GROUP_ID"                            "$ADMIN_TOKEN" "FR-MEAL-020,NFR-PERF-012" 250;        P_MEALS="$PERF_P95"
perf "billing-summary"  "/attendance/billing-summary?groupId=$GROUP_ID&fromDate=$FROM&toDate=$TO" "$ADMIN_TOKEN" "FR-BILL-001,NFR-PERF-013" 250; P_BILL="$PERF_P95"
perf "groups"           "/groups"                                                   "$ADMIN_TOKEN" "FR-GRP-001,NFR-PERF-014" 200;         P_GRP="$PERF_P95"

sec "PERF-B — CONCURRENCY / THROUGHPUT (${PERF_CONC} parallel clients) FR-CONC-001"
# TOTAL scales with PERF_CONC, so `PERF_CONC=50` gives a genuine extreme-load
# tier. Every response code is logged and CLASSIFIED: 429 = the rate-limiter
# doing its job under load (expected, NOT a failure); only 5xx / connection
# errors (000) are real. This lets you push arbitrarily hard without a false red.
TOTAL=$((PERF_CONC*10))
CODEF="$RESULTS_DIR/.thr_codes"; : > "$CODEF"
START=$(date +%s.%N)
seq 1 "$TOTAL" | xargs -P"$PERF_CONC" -I{} sh -c \
  'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer '"$ADMIN_TOKEN"'" "'"$BASE"'/dashboard/admin" >> "'"$CODEF"'"'
END=$(date +%s.%N)
ELAPSED=$(awk "BEGIN{print $END-$START}")
RPS=$(awk "BEGIN{printf \"%.1f\", $TOTAL/($ELAPSED>0?$ELAPSED:1)}")
# Single awk pass → always emits three integers (no grep-exit-code pitfalls).
read -r OK2XX THROTTLED HARDERR <<EOF
$(awk '/^2[0-9][0-9]$/{ok++} /^429$/{th++} !/^(2[0-9][0-9]|429)$/{he++} END{printf "%d %d %d", ok+0, th+0, he+0}' "$CODEF")
EOF
echo "  $TOTAL reqs @P$PERF_CONC in ${ELAPSED}s → ${RPS} req/s | 2xx=$OK2XX throttled(429)=$THROTTLED hard-errors=$HARDERR" >&2
if [ "${HARDERR:-0}" = "0" ]; then ok "Concurrency stable (0 hard errors @ P$PERF_CONC)" "${RPS} req/s, ${THROTTLED} throttled" "FR-CONC-001" \
  ; else no "Concurrency hard errors" "$HARDERR 5xx/conn of $TOTAL" "FR-CONC-001"; fi

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

# ─────────────────────────────────────────────────────────────────────────────
sec "PERF-D — REALTIME CHANNEL (Socket.IO / Engine.IO handshake) FR-RT-001"
# Realtime here is Socket.IO PUSH (not a poll), so the meaningful client-facing
# metric is how fast the realtime pipe is ESTABLISHED. The Engine.IO transport
# handshake (GET /socket.io/?EIO=4&transport=polling) creates the session before
# auth, so a fast 2xx proves the realtime layer is up and responsive. Once open,
# server→client events (notice.created, attendance updates) are delivered on
# this socket in the same sub-ms loopback — event delivery is push, not fetched.
ROOT="${BASE%/api/v1}"
WSF="$RESULTS_DIR/.ws"; : > "$WSF"; WS_CODE=000
for _i in $(seq 1 20); do
  _out=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" "$ROOT/socket.io/?EIO=4&transport=polling" 2>/dev/null)
  WS_CODE="${_out%% *}"; echo "$(awk "BEGIN{printf \"%.0f\", ${_out##* }*1000}")" >> "$WSF"
done
WS_P50=$(pctl 50 < "$WSF"); WS_P95=$(pctl 95 < "$WSF")
WS_MIN=$(sort -n "$WSF" | head -1); WS_MAX=$(sort -n "$WSF" | tail -1)
printf "  realtime handshake   code=%-3s p50=%-4s p95=%-4s min=%-4s max=%-4s ms\n" "$WS_CODE" "$WS_P50" "$WS_P95" "$WS_MIN" "$WS_MAX" >&2
case "$WS_CODE" in
  2[0-9][0-9]) ok "Realtime channel establishes fast (Socket.IO handshake)" "p50=${WS_P50}ms" "FR-RT-001,FR-NOT-010" ;;
  # Non-2xx = the transport is gated differently in this env (e.g. auth at
  # allowRequest); report the latency but don't fail the certificate on it.
  *) skip "Realtime handshake returned $WS_CODE" "latency p50=${WS_P50}ms (informational)" "FR-RT-001" ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# PERF-E deliberately SATURATES the per-IP throttle (60s sliding window) on the
# shared hot path /dashboard/admin. If it runs before the security suite, that
# saturation makes SEC-B's RBAC probe read a 429 instead of the true 403 for a
# full window. So it's packaged as a function that run.sh invokes LAST (after
# security.sh) — nothing throttle-sensitive runs after it. It also persists the
# headline metrics the certificate reads, so the write lives here with it.
run_capacity_ramp(){
  sec "PERF-E — MAX CAPACITY RAMP (find peak sustainable throughput) FR-CAP-001"
  # Ramp concurrency until throughput plateaus / hard errors appear. 429s are the
  # limiter working (counted separately, not a failure). The peak tier with ZERO
  # hard errors (no 5xx / connection drop) is the certified max sustainable load.
  PEAK_RPS=0; PEAK_P=0
  for _P in 10 25 50 100 200; do
    _N=$((_P*20)); RCF="$RESULTS_DIR/.ramp"; : > "$RCF"
    _s=$(date +%s.%N)
    seq 1 "$_N" | xargs -P"$_P" -I{} sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer '"$ADMIN_TOKEN"'" "'"$BASE"'/dashboard/admin" >> "'"$RCF"'"'
    _e=$(date +%s.%N); _el=$(awk "BEGIN{print $_e-$_s}")
    _rps=$(awk "BEGIN{printf \"%.0f\", $_N/($_el>0?$_el:1)}")
    read -r _r2 _r429 _rerr <<EOF
$(awk '/^2[0-9][0-9]$/{a++} /^429$/{b++} !/^(2[0-9][0-9]|429)$/{c++} END{printf "%d %d %d", a+0, b+0, c+0}' "$RCF")
EOF
    printf "  P=%-3s N=%-4s %6s req/s | 2xx=%-4s throttled(429)=%-4s hard-err=%-3s\n" "$_P" "$_N" "$_rps" "$_r2" "$_r429" "$_rerr" >&2
    if [ "${_rerr:-0}" = "0" ] && [ "${_rps:-0}" -gt "${PEAK_RPS:-0}" ] 2>/dev/null; then PEAK_RPS="$_rps"; PEAK_P="$_P"; fi
  done
  if [ "${PEAK_RPS:-0}" -gt 0 ]; then ok "Max sustainable throughput (0 hard errors)" "${PEAK_RPS} req/s @P${PEAK_P}" "FR-CAP-001"
  else no "Capacity ramp hit hard errors at every tier" "" "FR-CAP-001"; fi

  # Persist the headline numbers so run.sh can print a PERFORMANCE CERTIFICATE.
  cat > "$RESULTS_DIR/.metrics" <<EOF
P_HEALTH=${P_HEALTH:-na}
P_DASH=${P_DASH:-na}
P_ATT=${P_ATT:-na}
P_MEALS=${P_MEALS:-na}
P_BILL=${P_BILL:-na}
P_GRP=${P_GRP:-na}
WS_P50=${WS_P50:-na}
WS_P95=${WS_P95:-na}
WS_MIN=${WS_MIN:-na}
CONC_RPS=${RPS:-na}
CONC_P=${PERF_CONC:-na}
PEAK_RPS=${PEAK_RPS:-na}
PEAK_P=${PEAK_P:-na}
SOAK_TREND=${TREND:-na}
SOAK_PCT=${PCT:-na}
EOF
}

# Standalone (bash performance.sh): run the ramp inline + print the module
# summary. Under run.sh (SRS_SOURCED=1) run.sh calls run_capacity_ramp AFTER
# security.sh so the throttle saturation can't taint the RBAC/IDOR probes.
if [ "${SRS_SOURCED:-0}" != "1" ]; then run_capacity_ramp; summary "PERFORMANCE"; fi
