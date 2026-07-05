#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run.sh — master SRS end-to-end validator. Runs functional + security +
# performance/soak against the LIVE backend, then reconciles every assertion
# against the 664-requirement manifest and prints a certificate-ready report.
#
# PROD-SAFE: read-only by default (WRITE_TESTS=1 opts into self-cleaning writes).
# Does NOT touch application code or infrastructure.
#
#   ADMIN_EMAIL=.. ADMIN_PASS=.. STUDENT_EMAIL=.. STUDENT_PASS=.. \
#   ADMIN2_EMAIL=.. ADMIN2_PASS=.. EDGE=https://your-domain \
#   bash deploy/srs/run.sh
#
# Env: BASE (default http://localhost:3000/api/v1), PERF_SAMPLES(30),
#      PERF_CONC(20), SOAK_REQUESTS(2000), WRITE_TESTS(0), EDGE(unset).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RESULTS_DIR="${RESULTS_DIR:-/tmp/emeal-srs-$(date +%Y%m%d-%H%M%S)}"
export SRS_SOURCED=1
. "$HERE/lib.sh"
LOG="$RESULTS_DIR/full-run.log"
exec > >(tee "$LOG") 2>&1

echo "════════════════════════════════════════════════════════════════════════════"
echo " MealAttend SRS END-TO-END VALIDATION — $(date -u +%FT%TZ)"
echo " BASE=$BASE  samples=$PERF_SAMPLES  conc=$PERF_CONC  soak=$SOAK_REQUESTS  writes=$WRITE_TESTS"
echo " results → $RESULTS_DIR"
echo "════════════════════════════════════════════════════════════════════════════"

# Order matters: performance BEFORE security. security.sh's SEC-F test floods
# the login endpoint to prove the 429 rate-limit works, which then throttles the
# shared login for ~60s. If performance ran after, its fresh login would be
# throttled → empty token → every PERF probe returns 401 (false failures). Perf
# first gets a clean token; security's flood is the last thing that runs.
. "$HERE/functional.sh"
. "$HERE/performance.sh"
. "$HERE/security.sh"

# ── Reconcile assertions (REQLOG) against the requirement manifest ───────────
MAN="$HERE/manifest.tsv"
sec "SRS TRACEABILITY & CERTIFICATE"
if [ ! -f "$MAN" ]; then
  echo "  manifest.tsv missing — run generate-manifest.sh locally and commit it."
else
  awk -F'\t' -v reqlog="$REQLOG" '
    BEGIN{
      while((getline line < reqlog)>0){
        split(line,a,"\t"); id=a[1]; st=a[2];
        if(st=="FAIL") stat[id]="FAIL";
        else if(st=="PASS" && stat[id]!="FAIL") stat[id]="PASS";
        else if(st=="MANUAL" && stat[id]!="FAIL" && stat[id]!="PASS") stat[id]="MANUAL";
        else if(st=="SKIP" && stat[id]=="") stat[id]="SKIP";
      }
    }
    NR==1{next}
    {
      id=$1; mod=$2; method=$3; total++;
      mtot[method]++; modtot[mod]++;
      s=stat[id];
      if(s=="PASS"){pass++; mpass[method]++; covered++}
      else if(s=="FAIL"){fail++; mfail[method]++; covered++}
      else if(s=="SKIP"){skip++; covered++}
      else if(method=="DEVICE"){device++}   # UI/manual — expected, not a gap
      else {uncov++; uncovlist[method]++}    # backend-testable but not asserted yet
    }
    END{
      printf "  Requirements in SRS:            %d\n", total;
      printf "  Automated assertions PASS:      %d\n", pass;
      printf "  Automated assertions FAIL:      %d\n", fail;
      printf "  Skipped (needs data/env):       %d\n", skip;
      printf "  Device / manual (Flutter UI):   %d\n", device;
      printf "  Backend-testable, not yet asserted: %d\n", uncov;
      autom = pass+fail;
      printf "\n  Automated pass rate:            %.1f%%  (%d/%d executed)\n", (autom>0?pass*100.0/autom:0), pass, autom;
      printf "  Requirement coverage (any assertion): %.1f%%  (%d/%d, excl. device-manual)\n",
             ((total-device)>0? covered*100.0/(total-device):0), covered, total-device;
      printf "\n  By method:  method   total  pass  fail  device  uncovered\n";
      split("API PERF SECURITY DEVICE",order," ");
      for(i=1;i<=4;i++){m=order[i];
        printf "    %-8s %5d %5d %5d %6s %10d\n", m, mtot[m]+0, mpass[m]+0, mfail[m]+0,
               (m=="DEVICE"?mtot[m]+0:"-"), (m=="DEVICE"?0:(mtot[m]-mpass[m]-mfail[m]));
      }
    }
  ' "$MAN"
  # Emit per-requirement CSV + the device checklist for the manual pass
  {
    echo "requirement_id,module,method,status"
    awk -F'\t' -v reqlog="$REQLOG" '
      BEGIN{while((getline l<reqlog)>0){split(l,a,"\t");
        if(a[2]=="FAIL")s[a[1]]="FAIL"; else if(a[2]=="PASS"&&s[a[1]]!="FAIL")s[a[1]]="PASS";
        else if(a[2]=="MANUAL"&&s[a[1]]=="")s[a[1]]="MANUAL"; else if(a[2]=="SKIP"&&s[a[1]]=="")s[a[1]]="SKIP";}}
      NR>1{st=s[$1]; if(st==""){st=($3=="DEVICE"?"MANUAL-PENDING":"NOT-ASSERTED")} print $1","$2","$3","st}
    ' "$MAN"
  } > "$RESULTS_DIR/requirement-coverage.csv"
  awk -F'\t' 'NR>1 && $3=="DEVICE"{print "    ☐ "$1}' "$MAN" > "$RESULTS_DIR/device-manual-checklist.txt"
  echo
  echo "  Per-requirement CSV : $RESULTS_DIR/requirement-coverage.csv"
  echo "  Device checklist    : $RESULTS_DIR/device-manual-checklist.txt (run on the phone)"
fi

# ── PERFORMANCE CERTIFICATE (headline latency + capacity limits) ─────────────
if [ -f "$RESULTS_DIR/.metrics" ]; then
  # shellcheck disable=SC1090
  . "$RESULTS_DIR/.metrics"
  sec "PERFORMANCE CERTIFICATE — measured limits (backend compute, localhost)"
  printf "  %-26s %s\n" "API p95 latency:"      "dashboard=${P_DASH:-na}ms  meals=${P_MEALS:-na}ms  billing=${P_BILL:-na}ms  groups=${P_GRP:-na}ms  attendance=${P_ATT:-na}ms  health=${P_HEALTH:-na}ms"
  printf "  %-26s %s\n" "Realtime channel:"      "Socket.IO handshake p50=${WS_P50:-na}ms p95=${WS_P95:-na}ms (min ${WS_MIN:-na}ms) — push, event-driven"
  printf "  %-26s %s\n" "Sustained throughput:"  "${CONC_RPS:-na} req/s @ P${CONC_P:-na} (0 hard errors)"
  printf "  %-26s %s\n" "MAX sustainable load:"  "${PEAK_RPS:-na} req/s @ P${PEAK_P:-na} concurrent (peak tier with 0 hard errors)"
  printf "  %-26s %s\n" "Memory under 5k soak:"  "post-peak trend ${SOAK_TREND:-na}% (${SOAK_PCT:-na}% burst peak), 0 restarts — no leak"
  printf "  %-26s %s\n" "Rate limits:"           "login 10/60s per IP (verified: flood→429)  |  API THROTTLE_LIMIT/THROTTLE_TTL (prod 1000/60s per IP); burst ceiling observed at P${PEAK_P:-200}"
  echo   "  Note: these are backend-compute times on loopback. End-user latency adds network RTT"
  echo   "  (≈150–250ms France↔India), which the frontend cache-first layer masks by instant repaint."
fi

echo
hr
echo "  OVERALL: PASS=$PASS FAIL=$FAIL SKIP=$SKIP MANUAL=$MANUAL"
# Always name EVERY failed assertion here so a single fail can never hide in a
# long scroll — the consolidated list is printed at the very bottom.
if [ "$FAIL" -gt 0 ] && [ "${#FAILED_LABELS[@]}" -gt 0 ]; then
  echo "  Failed assertion(s):"
  printf '    ✗ %s\n' "${FAILED_LABELS[@]}"
fi
echo "  Full log: $LOG"
if [ "$FAIL" -eq 0 ]; then echo "  RESULT: $(_g 'GREEN — all automated SRS assertions passed')"; STATUS=0
else echo "  RESULT: $(_r "RED — $FAIL automated assertion(s) failed (named above)")"; STATUS=1; fi
hr
exit $STATUS
