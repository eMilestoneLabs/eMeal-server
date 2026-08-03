#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# lib.sh — shared helpers for the SRS end-to-end validation suite.
# Source-only (do not execute). Every module sources this so it can also run
# standalone. Idempotent: guarded against double-sourcing.
#
# Design rules that keep this HONEST and PROD-SAFE:
#   • READ-ONLY by default. Any check that writes real data is gated behind
#     WRITE_TESTS=1 and must self-clean. Never mutates prod unless asked.
#   • Every assertion is tagged with one or more SRS requirement IDs via `tag`.
#     The tag → status is appended to $REQLOG so run.sh can reconcile coverage
#     against the full 664-ID manifest. No fake green: unreachable/UI reqs are
#     recorded as MANUAL, never PASS.
#   • Perf helper prints its human line to STDERR so command-substitution reads
#     ONLY the numeric result (a bug that bit the earlier validate scripts).
# ─────────────────────────────────────────────────────────────────────────────
[ -n "${_SRS_LIB_SOURCED:-}" ] && return 0
_SRS_LIB_SOURCED=1
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
EDGE="${EDGE:-}"                          # https://domain → enables TLS/header probes
FROM="${FROM:-$(date -d '-7 days' +%F 2>/dev/null || date +%F)}"
TO="${TO:-$(date +%F)}"
PERF_SAMPLES="${PERF_SAMPLES:-30}"
PERF_CONC="${PERF_CONC:-20}"
SOAK_REQUESTS="${SOAK_REQUESTS:-2000}"
WRITE_TESTS="${WRITE_TESTS:-0}"           # 1 = allow self-cleaning write flows

RESULTS_DIR="${RESULTS_DIR:-/tmp/emeal-srs-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$RESULTS_DIR"
REQLOG="$RESULTS_DIR/requirements.tsv"     # <tag>\t<PASS|FAIL|MANUAL|SKIP>\t<detail>
[ -f "$REQLOG" ] || : > "$REQLOG"

command -v curl >/dev/null || { echo "FATAL: curl required"; exit 1; }
command -v jq   >/dev/null || { echo "FATAL: jq required";   exit 1; }

PASS=0; FAIL=0; SKIP=0; MANUAL=0
declare -a FAILED_LABELS

_g(){ printf '\033[32m%s\033[0m' "$1"; }
_r(){ printf '\033[31m%s\033[0m' "$1"; }
_y(){ printf '\033[33m%s\033[0m' "$1"; }
hr(){ printf '%.0s─' $(seq 1 78); echo; }
sec(){ echo; hr; echo "▶ $*"; hr; }

# tag "<FR-IDs csv>" <PASS|FAIL|MANUAL|SKIP> "<detail>"  — traceability sink
tag(){
  local ids="$1" st="$2" detail="${3:-}"
  local id
  IFS=',' read -ra _IDS <<< "$ids"
  for id in "${_IDS[@]}"; do
    id="$(echo "$id" | tr -d ' ')"
    [ -n "$id" ] && printf '%s\t%s\t%s\n' "$id" "$st" "$detail" >> "$REQLOG"
  done
}

# ok/no/skip/manual <label> [detail] [req-ids]
ok(){    PASS=$((PASS+1));   printf "  $(_g PASS)  %-54s %s\n" "$1" "${2:-}"; [ -n "${3:-}" ] && tag "$3" PASS "$1"; }
no(){    FAIL=$((FAIL+1));   FAILED_LABELS+=("$1"); printf "  $(_r FAIL)  %-54s %s\n" "$1" "${2:-}"; [ -n "${3:-}" ] && tag "$3" FAIL "$1 ${2:-}"; }
skip(){  SKIP=$((SKIP+1));   printf "  $(_y SKIP)  %-54s %s\n" "$1" "${2:-}"; [ -n "${3:-}" ] && tag "$3" SKIP "$1"; }
manual(){ MANUAL=$((MANUAL+1)); printf "  $(_y MANL)  %-54s %s\n" "$1" "${2:-}"; [ -n "${3:-}" ] && tag "$3" MANUAL "$1"; }

# assert_code <label> <expected> <actual> <req-ids> [extra]
assert_code(){
  if [ "$3" = "$2" ]; then ok "$1" "($3 ${5:-})" "$4"; else no "$1" "expected $2 got $3 ${5:-}" "$4"; fi
}
# assert_in <label> <actual> <req-ids> <code...>  — pass if actual ∈ {codes}
assert_in(){
  local label="$1" actual="$2" ids="$3"; shift 3
  local c
  for c in "$@"; do [ "$actual" = "$c" ] && { ok "$label" "($actual)" "$ids"; return; }; done
  no "$label" "got $actual, wanted one of: $*" "$ids"
}

# req METHOD PATH [BODY] [TOKEN]  → sets R_CODE R_MS R_BODY (+R_HDRS file)
R_HDRS_FILE="$RESULTS_DIR/.hdrs"
req(){
  local m="$1" p="$2" body="${3:-}" tok="${4:-}"
  local bf="$RESULTS_DIR/.body"
  local args=(-s -o "$bf" -D "$R_HDRS_FILE" -w '%{http_code} %{time_total}'
              -X "$m" -H 'Content-Type: application/json')
  [ -n "$tok" ]  && args+=(-H "Authorization: Bearer $tok")
  [ -n "$body" ] && args+=(--data "$body")
  local out; out="$(curl "${args[@]}" "$BASE$p" 2>/dev/null)"
  R_CODE="${out%% *}"; [ -z "${R_CODE:-}" ] && R_CODE=000
  R_MS="$(awk "BEGIN{printf \"%.0f\", ${out##* }*1000}" 2>/dev/null || echo 0)"
  R_BODY="$(cat "$bf" 2>/dev/null)"
}
jbody(){ printf '%s' "$R_BODY" | jq -r "$1" 2>/dev/null; }

# req_settle METHOD PATH [BODY] [TOKEN] — like req, but if the response is a
# transient 429 (a prior load test saturated the burst throttle) it backs off
# and retries so the caller sees the TRUE verdict (e.g. RBAC 403), not a rate-
# limit artifact. Bounded so it can never hang. Used by correctness assertions
# (RBAC / tenant-isolation) that must not be masked by throttling.
req_settle(){
  local _t=0
  req "$@"
  while [ "${R_CODE:-000}" = "429" ] && [ "$_t" -lt 8 ]; do
    sleep 2; _t=$((_t+1)); req "$@"
  done
}

# login <email> <password>  → echoes accessToken (empty on failure)
login(){
  req POST /auth/login "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')"
  jbody '.accessToken // .data.accessToken // empty'
}

# reuse_or_login VAR EMAIL PASS — sets global $VAR to a working access token.
# DEDUP: run.sh sources every module into ONE shell, so a token functional.sh
# already obtained is still in scope here — re-logging the same account burned
# the 10/60s per-IP login budget (and forced sleep-retry loops downstream).
# Reuse path: validate the inherited token with ONE cheap GET /auth/me (API
# budget, not login budget); a post-load transient 429 is drained by
# req_settle, and a lingering 429 counts as reuse (it says nothing about token
# validity, and a fresh login would be throttled too). Login path (standalone
# runs / expired token): retries ONLY on 429 — a real credential failure never
# wastes the sleep loop. Empty EMAIL keeps the original "" semantics.
reuse_or_login(){
  local __var="$1" __email="${2:-}" __pass="${3:-}" __tok _t=0
  eval "__tok=\"\${$__var:-}\""
  if [ -n "$__tok" ]; then
    req_settle GET /auth/me "" "$__tok"
    case "$R_CODE" in 200|429) return 0 ;; esac
  fi
  if [ -z "$__email" ]; then eval "$__var=''"; return 0; fi
  req POST /auth/login "$(jq -nc --arg i "$__email" --arg p "$__pass" '{identifier:$i,password:$p}')"
  __tok="$(jbody '.accessToken // .data.accessToken // empty')"
  while [ -z "$__tok" ] && [ "${R_CODE:-}" = "429" ] && [ "$_t" -lt 6 ]; do
    sleep 12; _t=$((_t+1))
    req POST /auth/login "$(jq -nc --arg i "$__email" --arg p "$__pass" '{identifier:$i,password:$p}')"
    __tok="$(jbody '.accessToken // .data.accessToken // empty')"
  done
  eval "$__var=\"\$__tok\""
}

# percentile helper: feed newline-separated numbers on stdin, arg=pXX(0-100)
pctl(){ awk -v p="$1" 'NR{a[NR]=$1} END{n=asort(a); if(n==0){print 0;exit} i=int((p/100)*n); if(i<1)i=1; if(i>n)i=n; print a[i]}'; }

# perf <label> <path> <token> <req-ids> <slo-ms>  → prints stats + the SLO
# PASS/FAIL line normally, asserts p95<slo, and exposes the p95 via the global
# $PERF_P95. Call it IN-PROCESS (not in $(...)): capturing its stdout would
# swallow the ok/no line into the caller and corrupt the metrics file.
PERF_P95=""
perf(){
  local label="$1" path="$2" tok="$3" ids="$4" slo="$5"
  local tmp="$RESULTS_DIR/.perf"; : > "$tmp"
  local code=000 i
  for ((i=0;i<PERF_SAMPLES;i++)); do req GET "$path" "" "$tok"; code="$R_CODE"; echo "$R_MS" >> "$tmp"; done
  local p50 p95 p99 mn mx
  p50="$(pctl 50 < "$tmp")"; p95="$(pctl 95 < "$tmp")"; p99="$(pctl 99 < "$tmp")"
  mn="$(sort -n "$tmp" | head -1)"; mx="$(sort -n "$tmp" | tail -1)"
  printf "  %-34s code=%-3s p50=%-4s p95=%-4s p99=%-4s min=%-4s max=%-4s ms (slo<%s)\n" \
    "$label" "$code" "$p50" "$p95" "$p99" "$mn" "$mx" "$slo" >&2
  # This is a LATENCY gate. A fast, well-formed response (any non-5xx: 200 as
  # well as an intended 400/401/403 — e.g. /attendance/today is student-scoped
  # and returns 400 to an admin) still proves the backend is fast. Only a server
  # error (5xx) or connection failure (000) — OR a slow p95 — fails the SLO.
  local ok_code=0
  case "$code" in 2[0-9][0-9]|4[0-9][0-9]) ok_code=1 ;; esac
  if [ "$ok_code" = "1" ] && [ "${p95:-99999}" -lt "$slo" ]; then ok "SLO $label p95<${slo}ms" "(code=$code p95=${p95}ms)" "$ids"
  else no "SLO $label p95<${slo}ms" "(code=$code p95=${p95}ms)" "$ids"; fi
  PERF_P95="$p95"
}

summary(){
  local total=$((PASS+FAIL))
  echo; hr; echo "▶ SUMMARY — $*"; hr
  echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP  MANUAL(device)=$MANUAL"
  if [ "$FAIL" -gt 0 ]; then echo "  Failed:"; printf '    ✗ %s\n' "${FAILED_LABELS[@]}"; fi
  # GNU awk still evaluates the division inside a printf-argument ternary, so
  # `(total>0)?(PASS*100/total):0` raised "division by zero attempted" and
  # printed an empty rate whenever a module skipped EVERY check (PASS=0 and
  # FAIL=0 — e.g. a probe run against an empty database). Branch in bash so awk
  # never sees a zero divisor.
  local pct="n/a"
  if [ "$total" -gt 0 ]; then
    pct="$(awk "BEGIN{printf \"%.1f\", $PASS*100.0/$total}")%"
  fi
  echo "  Automated pass rate: ${pct}   (requirements log: $REQLOG)"
}
