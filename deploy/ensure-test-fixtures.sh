#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# ensure-test-fixtures.sh — TEST-FIXTURE DOCTOR for the master audit.
#
# WHY: the whole validation fleet (srs / e2e / mealcheck / production) drives
# the API through the STANDING TEST ACCOUNTS (deploy/srs/accounts.sh). Audit
# 8295988 proved that when those fixtures drift, validators mis-report:
#   • Both test accounts were email-UNVERIFIED (they were re-created after the
#     2026-07-12 ACC-005 cutoff, so the legacy backfill correctly skips them).
#     Every participation probe then hit the account gate (403
#     EMAIL_VERIFICATION_REQUIRED) before reaching the validation under test —
#     3 false FAILs ("unknown meal", "backdated vacation", "oversized input")
#     and 4 SKIPs (vacation→bell, Q21/Q17, COR-005).
#   • One race-proof UNIQUE index (meals_group_name_active_uniq) was still
#     missing even though NO duplicate rows block it any more (the dirty rows
#     were long-deleted throwaway groups) — a plain re-apply fixes it.
#
# WHAT (idempotent, scoped STRICTLY to the named test fixtures):
#   1. Stamp emailVerifiedAt for the standing TEST accounts only (never a
#      blanket update — each row is matched by its exact email and only when
#      still NULL). This is the same repair backfill-email-verified.sh performs
#      for legacy accounts, extended to the post-cutoff test fixtures.
#   2. Ensure the primary test student is an ACTIVE member of the admin's
#      first group (join via the real join-code API + admin approval — the
#      product flow, not a DB write).
#   3. Re-apply any race-proof UNIQUE index that is missing with ZERO blocking
#      duplicate rows (uni-index-doctor.sh --fix-safe). Data-destructive
#      dedupe remains a manual operation — this never deletes rows.
#
# ZERO PRODUCTION COUPLING: touches no application code, config, infra or
# schema (the index re-apply replays the already-committed guarded migration).
# Real member data is never modified — only the named test accounts.
#
# Usage (on the VPS):   bash deploy/ensure-test-fixtures.sh
# Via the master audit: bash deploy/run.sh --all --writes --yes  (module: fixtures)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_DIR/srs/accounts.sh" ] && . "$_DIR/srs/accounts.sh"

BASE="${BASE:-http://localhost:3000/api/v1}"
PG_CONTAINER="${PG_CONTAINER:-emeal_postgres}"

command -v jq   >/dev/null || { echo "FATAL: jq required";   exit 2; }
command -v curl >/dev/null || { echo "FATAL: curl required"; exit 2; }

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf "  \033[32mOK\033[0m    %-56s %s\n" "$1" "${2:-}"; }
no(){ FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m  %-56s %s\n" "$1" "${2:-}"; }
note(){ printf "  ·     %s\n" "$1"; }

req(){ # METHOD PATH [JSON] [TOKEN] → R_CODE R_BODY
  local m="$1" p="$2" body="${3:-}" tok="${4:-}"
  local hdr=(-H 'Content-Type: application/json')
  [ -n "$tok" ] && hdr+=(-H "Authorization: Bearer $tok")
  local tmp; tmp="$(mktemp)"
  local w
  if [ -n "$body" ]; then
    w=$(curl -s -o "$tmp" -w '%{http_code}' -X "$m" "${hdr[@]}" -d "$body" "$BASE$p")
  else
    w=$(curl -s -o "$tmp" -w '%{http_code}' -X "$m" "${hdr[@]}" "$BASE$p")
  fi
  R_CODE="$w"; R_BODY="$(cat "$tmp")"; rm -f "$tmp"
}
jb(){ printf '%s' "$R_BODY" | jq -r "$1" 2>/dev/null; }
login(){ req POST /auth/login "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')"; jb '.accessToken // empty'; }

echo "══ TEST-FIXTURE DOCTOR — $(date -u +%FT%TZ) ══"

# ── 1. Email-verification stamp for the STANDING TEST ACCOUNTS only ──────────
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONTAINER}\$"; then
  # Credentials resolve INSIDE the container from its own env (the proven
  # backfill-email-verified.sh pattern — host-side defaults broke once).
  pgexec(){ docker exec -i "$PG_CONTAINER" bash -c 'psql -v ON_ERROR_STOP=1 -tAU "$POSTGRES_USER" -d "$POSTGRES_DB"'; }
  _IN_LIST=""
  for _e in "${ADMIN_EMAIL:-}" "${STUDENT_EMAIL:-}" "${STUDENT2_EMAIL:-}" "${ADMIN2_EMAIL:-}"; do
    [ -n "$_e" ] || continue
    # test-account emails are plain ASCII addresses; strip any quote defensively
    _e="$(printf '%s' "$_e" | tr -d "'\"")"
    _IN_LIST="${_IN_LIST:+$_IN_LIST, }lower('$_e')"
  done
  if [ -n "$_IN_LIST" ]; then
    _PENDING="$(printf '%s' "SELECT count(*) FROM users WHERE lower(email) IN ($_IN_LIST) AND \"emailVerifiedAt\" IS NULL AND \"deletedAt\" IS NULL;" | pgexec)"
    if [ "${_PENDING:-x}" = "0" ]; then
      ok "test accounts already email-verified (ACC-005 open)" "0 to stamp"
    elif [[ "${_PENDING:-x}" =~ ^[0-9]+$ ]]; then
      _STAMPED="$(printf '%s' "UPDATE users SET \"emailVerifiedAt\" = now() WHERE lower(email) IN ($_IN_LIST) AND \"emailVerifiedAt\" IS NULL AND \"deletedAt\" IS NULL RETURNING lower(email);" | pgexec)"
      _NSTAMP="$(printf '%s\n' "$_STAMPED" | grep -c . || true)"
      if [ "${_NSTAMP:-0}" -ge 1 ]; then
        ok "stamped emailVerifiedAt on $_NSTAMP test account(s)" "$(printf '%s' "$_STAMPED" | tr '\n' ' ')"
      else
        no "verification stamp matched 0 rows (wanted $_PENDING)" "check container creds / emails"
      fi
    else
      no "could not query users table" "psql said: ${_PENDING:-empty}"
    fi
  else
    no "no test-account emails resolved" "source deploy/srs/accounts.sh"
  fi
else
  no "postgres container '$PG_CONTAINER' not reachable" "run this on the VPS"
fi

# ── 2. Primary test student must be an ACTIVE member of the admin's group ────
ADMIN_TOKEN="$(login "${ADMIN_EMAIL:-}" "${ADMIN_PASS:-}")"
STUDENT_TOKEN="$(login "${STUDENT_EMAIL:-}" "${STUDENT_PASS:-}")"
if [ -z "$ADMIN_TOKEN" ] || [ -z "$STUDENT_TOKEN" ]; then
  no "admin/student login for membership check" "admin=$([ -n "$ADMIN_TOKEN" ] && echo ok || echo FAIL) student=$([ -n "$STUDENT_TOKEN" ] && echo ok || echo FAIL) (throttle? creds?)"
else
  req GET /groups "" "$STUDENT_TOKEN"
  _SGID="$(jb '(.data // .)[0].id // empty')"
  if [ -n "$_SGID" ]; then
    ok "test student already belongs to a group" "$_SGID"
  else
    req GET /groups "" "$ADMIN_TOKEN"
    _AGID="$(jb '(.data // .)[0].id // empty')"
    if [ -z "$_AGID" ]; then
      no "admin has no groups — cannot join the student anywhere" ""
    else
      req GET "/groups/$_AGID/qr-token" "" "$ADMIN_TOKEN"
      _CODE="$(jb '.joinCode // .data.joinCode // empty')"
      if [ -z "$_CODE" ]; then
        no "could not resolve join code for group $_AGID" "($R_CODE)"
      else
        req POST /groups/join "$(jq -nc --arg c "$_CODE" '{joinCode:$c}')" "$STUDENT_TOKEN"
        _JST="$(jb '.joinStatus // .data.joinStatus // empty')"
        if [ "$_JST" = "pending" ]; then
          req GET /auth/me "" "$STUDENT_TOKEN"; _SUID="$(jb '.id // .data.id // empty')"
          req PATCH "/groups/$_AGID/join-requests/$_SUID/approve" '{}' "$ADMIN_TOKEN"
          note "join was approval-gated — admin approved ($R_CODE)"
        fi
        req GET /groups "" "$STUDENT_TOKEN"
        _SGID="$(jb '(.data // .)[0].id // empty')"
        [ -n "$_SGID" ] \
          && ok "test student joined group via join-code flow" "$_SGID" \
          || no "student still has no group after join attempt" "join=$_JST"
      fi
    fi
  fi
fi

# ── 3. Safe re-apply of missing race-proof UNIQUE indexes (no row deletes) ───
if [ -x "$_DIR/uni-index-doctor.sh" ] || [ -f "$_DIR/uni-index-doctor.sh" ]; then
  if bash "$_DIR/uni-index-doctor.sh" --fix-safe; then
    ok "race-proof UNIQUE indexes present (5/5)" ""
  else
    no "UNIQUE index re-apply left gaps" "dirty duplicate rows need a manual merge — see output above"
  fi
else
  no "uni-index-doctor.sh not found next to this script" ""
fi

echo
echo "  FIXTURES: OK=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && { echo "  ✅ test fixtures ready — validators can reach real validation paths"; exit 0; }
echo "  ❌ fixture repair incomplete — validator SKIPs/FAILs may persist"
exit 2
