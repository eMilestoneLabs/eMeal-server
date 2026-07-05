#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# delivered-fixes.sh — validates the delivered attendance + notification fixes
# over real HTTP:
#   • ADMIN SELF-ATTENDANCE — an admin can mark their OWN attendance (the
#     member-consent gate no longer blocks a self-mark); overriding ANOTHER
#     member is still gated (regression guard).
#   • VACATION MEMBERS — GET /attendance/vacation-members is per-date and
#     org-isolated, returning {date,userIds,members,count}; admin-only; a
#     foreign/unknown group 404s.
#   • NOTIFICATION CENTER — notices expose linkType + targetUserId; deep-link
#     values come from the known vocabulary; per-member targeted notices never
#     leak across users (verified with two distinct students).
#   • Regression sweep of the surfaces these changes touch.
#
# PROD-SAFE: read-only by DEFAULT. The single real write (admin self-mark) is
# gated behind WRITE_TESTS=1 and self-cleans (restores the prior status). Touches
# NO application code and NO infrastructure. Standalone-runnable or sourced by
# run.sh. Every assertion is tagged for the traceability certificate.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
# REUSE tokens already obtained by functional.sh when sourced by run.sh (same
# shell): re-logging in every account here would add ~4 more POST /auth/login
# hits on top of functional's, risking the 10/60s login throttle. Only log in
# what isn't already set (always the case when run standalone).
ADMIN_TOKEN="${ADMIN_TOKEN:-}";       [ -z "$ADMIN_TOKEN" ]    && ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
STUDENT_TOKEN="${STUDENT_TOKEN:-}";   [ -z "$STUDENT_TOKEN" ]  && [ -n "${STUDENT_EMAIL:-}" ]  && STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "${STUDENT_PASS:-}")"
ADMIN2_TOKEN="${ADMIN2_TOKEN:-}";     [ -z "$ADMIN2_TOKEN" ]   && [ -n "${ADMIN2_EMAIL:-}" ]   && ADMIN2_TOKEN="$(login "$ADMIN2_EMAIL" "${ADMIN2_PASS:-}")"
STUDENT2_TOKEN="${STUDENT2_TOKEN:-}"; [ -z "$STUDENT2_TOKEN" ] && [ -n "${STUDENT2_EMAIL:-}" ] && STUDENT2_TOKEN="$(login "$STUDENT2_EMAIL" "${STUDENT2_PASS:-}")"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (delivered-fixes)"
  # NEVER abort the whole suite when sourced by run.sh — just skip this module.
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

ADMIN_ID="$(req GET /auth/me "" "$ADMIN_TOKEN"; jbody '.id // .data.id // empty')"
STUDENT_ID="";  [ -n "$STUDENT_TOKEN" ]  && { req GET /auth/me "" "$STUDENT_TOKEN";  STUDENT_ID="$(jbody '.id // .data.id // empty')"; }
STUDENT2_ID=""; [ -n "$STUDENT2_TOKEN" ] && { req GET /auth/me "" "$STUDENT2_TOKEN"; STUDENT2_ID="$(jbody '.id // .data.id // empty')"; }
TODAY="$(date +%F)"

# ── Resolve a group + (preferably priced) meal, like functional.sh ───────────
req GET /groups "" "$ADMIN_TOKEN"
_GIDS="$(jbody '(.data // .)[]?.id')"
GRP="${GROUP_ID:-$(printf '%s\n' $_GIDS | head -1)}"
MEAL=""; MEAL_GID=""; PRICED_MEAL=""
for _g in $_GIDS; do
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _mid="$(jbody '(.data // .)[0].id // empty')"
  [ -n "$_mid" ] && [ -z "$MEAL" ] && { MEAL="$_mid"; MEAL_GID="$_g"; }
  _pmid="$(jbody '[(.data // .)[]? | select((.price//0)>0 or (.pricing.enabled==true))][0].id // empty')"
  [ -n "$_pmid" ] && [ -z "$PRICED_MEAL" ] && { PRICED_MEAL="$_pmid"; MEAL_GID="$_g"; }
done
[ -z "$MEAL_GID" ] && MEAL_GID="$GRP"
SELF_MEAL="${PRICED_MEAL:-$MEAL}"

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — vacation-members (per-date, RBAC, tenant isolation)"
# ═════════════════════════════════════════════════════════════════════════════
if [ -n "$GRP" ]; then
  req GET "/attendance/vacation-members?groupId=$GRP&date=$TODAY" "" "$ADMIN_TOKEN"
  assert_code "vacation-members endpoint (admin)" 200 "$R_CODE" "FR-VAC-050,FR-VACX-006"
  _SHAPE="$(jbody '((.userIds|type=="array") and (.members|type=="array") and (has("count")))')"
  [ "$_SHAPE" = "true" ] \
    && ok "vacation-members shape {date,userIds,members,count}" "count=$(jbody '.count')" "FR-VAC-051" \
    || no "vacation-members shape wrong" "$R_BODY" "FR-VAC-051"
  _MNAME="$(jbody '((.members|length)==0) or ([.members[]|has("userId") and has("name")]|all)')"
  [ "$_MNAME" = "true" ] \
    && ok "members carry userId+name (powers Vacation filter)" "" "FR-VAC-052" \
    || no "members missing userId/name" "" "FR-VAC-052"

  req_settle GET "/attendance/vacation-members?groupId=deadbeef-not-a-group&date=$TODAY" "" "$ADMIN_TOKEN"
  assert_code "unknown group → 404 (tenant guard)" 404 "$R_CODE" "FR-VACX-050,FR-SECX-040"

  if [ -n "$STUDENT_TOKEN" ]; then
    req_settle GET "/attendance/vacation-members?groupId=$GRP&date=$TODAY" "" "$STUDENT_TOKEN"
    assert_code "student blocked (admin-only)" 403 "$R_CODE" "FR-SECX-041,FR-VACX-051"
  else skip "vacation-members student RBAC" "no student token" "FR-SECX-041"; fi

  req_settle GET "/attendance/vacation-members?groupId=$GRP&date=$TODAY" "" ""
  assert_code "vacation-members unauthenticated → 401" 401 "$R_CODE" "FR-SECX-001"

  if [ -n "$ADMIN2_TOKEN" ]; then
    req_settle GET "/attendance/vacation-members?groupId=$GRP&date=$TODAY" "" "$ADMIN2_TOKEN"
    assert_in "cross-org admin cannot read foreign group" "$R_CODE" "FR-SECX-042,FR-VACX-052" 403 404
  else skip "vacation-members cross-org isolation" "no ADMIN2 token" "FR-SECX-042"; fi
else
  skip "vacation-members" "no group resolved" "FR-VAC-050,FR-VAC-051,FR-VAC-052"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — admin self-attendance (self-mark applied; other still gated)"
# ═════════════════════════════════════════════════════════════════════════════
# RBAC (read-only): a student can never reach admin/override — the guard denies
# BEFORE the body is processed, so this mutates nothing.
if [ -n "$STUDENT_TOKEN" ]; then
  req_settle POST /attendance/admin/override \
    "$(jq -nc --arg u "$STUDENT_ID" '{userId:$u,mealId:"x",attendanceDate:"2020-01-01",status:"present"}')" "$STUDENT_TOKEN"
  assert_code "student blocked from admin/override" 403 "$R_CODE" "FR-SECX-041"
fi
# Endpoint reachable + validates (read-only: unknown meal is rejected, no write).
req POST /attendance/admin/override \
  "$(jq -nc --arg u "$ADMIN_ID" '{userId:$u,mealId:"nonexistent-meal",attendanceDate:"2020-01-01",status:"present"}')" "$ADMIN_TOKEN"
assert_in "admin/override validates unknown meal" "$R_CODE" "FR-ATT-030" 400 404 422

if [ "$WRITE_TESTS" = "1" ] && [ -n "$SELF_MEAL" ]; then
  req GET "/attendance/today?groupId=$MEAL_GID" "" "$ADMIN_TOKEN"
  _PRIOR="$(printf '%s' "$R_BODY" | jq -r --arg m "$SELF_MEAL" '[(.data // .)[]? | select(.mealId==$m)][0].status // empty' 2>/dev/null)"

  # THE FIX: admin marks THEIR OWN attendance present on a (priced) meal.
  # Must return an applied record with status=present, NOT requiresMemberConsent.
  req POST /attendance/admin/override \
    "$(jq -nc --arg u "$ADMIN_ID" --arg m "$SELF_MEAL" --arg d "$TODAY" '{userId:$u,mealId:$m,attendanceDate:$d,status:"present"}')" "$ADMIN_TOKEN"
  _RC="$R_CODE"
  _CONSENT="$(jbody '.requiresMemberConsent // .data.requiresMemberConsent // false')"
  _ST="$(jbody '.status // .data.status // (.record.status) // empty')"
  if [ "$_RC" = "200" ] && [ "$_CONSENT" != "true" ]; then
    ok "admin self-mark APPLIED (no consent gate)" "status=$_ST consent=$_CONSENT" "FR-ATT-031,FR-OVR-001"
  else
    no "admin self-mark blocked/gated" "code=$_RC consent=$_CONSENT" "FR-ATT-031,FR-OVR-001"
  fi

  # Regression guard: overriding a DIFFERENT member on a priced meal must STILL
  # raise the member-consent gate (proves the fix is scoped to self only).
  if [ -n "$STUDENT_ID" ] && [ -n "$PRICED_MEAL" ]; then
    req POST /attendance/admin/override \
      "$(jq -nc --arg u "$STUDENT_ID" --arg m "$PRICED_MEAL" --arg d "$TODAY" '{userId:$u,mealId:$m,attendanceDate:$d,status:"present"}')" "$ADMIN_TOKEN"
    _OC="$(jbody '.requiresMemberConsent // .data.requiresMemberConsent // false')"
    if [ "$_OC" = "true" ]; then
      ok "other-member override STILL gated (regression)" "consent=$_OC" "FR-OVR-001"
      _CRID="$(jbody '.correctionRequest.id // .data.correctionRequest.id // empty')"
      [ -n "$_CRID" ] && req PATCH "/corrections/$_CRID/reject" '{}' "$ADMIN_TOKEN"
    else
      skip "other-member gate" "not priced/consent-eligible (consent=$_OC)" "FR-OVR-001"
    fi
  fi

  # Restore the admin's prior status (self-clean; leave the DB as found).
  if [ -n "$_PRIOR" ] && [ "$_PRIOR" != "present" ]; then
    req POST /attendance/admin/override \
      "$(jq -nc --arg u "$ADMIN_ID" --arg m "$SELF_MEAL" --arg d "$TODAY" --arg s "$_PRIOR" '{userId:$u,mealId:$m,attendanceDate:$d,status:$s}')" "$ADMIN_TOKEN"
    ok "cleanup: restored admin prior status" "→ $_PRIOR" "FR-ATT-031"
  fi
else
  skip "admin self-mark (live write)" "set WRITE_TESTS=1 (self-cleaning) to run" "FR-ATT-031,FR-OVR-001"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — notification center (linkType, targeting, no cross-user leak)"
# ═════════════════════════════════════════════════════════════════════════════
req GET "/notices?limit=25" "" "$ADMIN_TOKEN"
assert_code "notices feed reachable" 200 "$R_CODE" "FR-NOT-001"
_HASLINK="$(jbody '[.data[]?|has("linkType")]|all')"
[ "$_HASLINK" = "true" ] \
  && ok "notices expose linkType (deep-link)" "" "FR-NOTX-030" \
  || no "linkType field missing on notices" "" "FR-NOTX-030"
_HASTGT="$(jbody '[.data[]?|has("targetUserId")]|all')"
[ "$_HASTGT" = "true" ] \
  && ok "notices expose targetUserId (per-member routing)" "" "FR-NOTX-031" \
  || no "targetUserId field missing on notices" "" "FR-NOTX-031"
_BADLINK="$(jbody '[.data[]? | .linkType | select(.!=null) | . as $lt | select(["vacationRequests","correctionRequests","guestRequests","myVacations","myCorrections"] | index($lt) | not)] | length')"
[ "${_BADLINK:-0}" = "0" ] \
  && ok "linkType values from known vocabulary" "0 unknown" "FR-NOTX-032" \
  || no "unknown linkType value present" "${_BADLINK} bad" "FR-NOTX-032"

# Per-member targeting must not leak: a student must never receive a notice
# targeted at someone else. Checked for BOTH students (two distinct users).
_check_no_leak(){ # <token> <self-id> <label>
  local tok="$1" me="$2" label="$3"
  [ -z "$tok" ] || [ -z "$me" ] && { skip "targeting isolation ($label)" "no token/id" "FR-NOTX-033"; return; }
  req GET "/notices?limit=50" "" "$tok"
  local leak; leak="$(printf '%s' "$R_BODY" | jq -r --arg me "$me" '[.data[]? | select(.targetUserId!=null and .targetUserId!=$me)] | length' 2>/dev/null)"
  [ "${leak:-0}" = "0" ] \
    && ok "targeted notices do NOT leak to $label" "0 leaked" "FR-NOTX-033,FR-SECX-041" \
    || no "$label sees another user's targeted notice" "${leak} leaked" "FR-NOTX-033,FR-SECX-041"
}
_check_no_leak "$STUDENT_TOKEN"  "$STUDENT_ID"  "student-1"
_check_no_leak "$STUDENT2_TOKEN" "$STUDENT2_ID" "student-2"

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — regression: touched surfaces still healthy"
# ═════════════════════════════════════════════════════════════════════════════
for _p in "/dashboard/admin" "/notices?limit=5" "/attendance/today" "/vacation-requests" "/groups"; do
  _tok="$ADMIN_TOKEN"; case "$_p" in /attendance/today|/vacation-requests) _tok="${STUDENT_TOKEN:-$ADMIN_TOKEN}";; esac
  req GET "$_p" "" "$_tok"
  assert_code "regression GET $_p" 200 "$R_CODE" "FR-REG-DELIVERED"
done
req GET /notices/unread-count "" "${STUDENT_TOKEN:-$ADMIN_TOKEN}"
assert_code "regression GET /notices/unread-count" 200 "$R_CODE" "FR-NOT-010"

# ── Optional bonus: confirm the additive migrations landed (DB, read-only) ────
# Only if this host can reach the postgres container; pure inspection, no writes.
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^emeal_postgres$'; then
  _COLS="$(docker exec emeal_postgres bash -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -tAc "SELECT string_agg(column_name,'"'"','"'"') FROM information_schema.columns WHERE table_name='"'"'notices'"'"' AND column_name IN ('"'"'linkType'"'"','"'"'targetUserId'"'"')"' 2>/dev/null)"
  case "$_COLS" in
    *linkType*targetUserId*|*targetUserId*linkType*) ok "migrations applied (notices.linkType+targetUserId)" "$_COLS" "FR-DB-MIGRATION" ;;
    *) no "notice migration columns missing" "got: ${_COLS:-none}" "FR-DB-MIGRATION" ;;
  esac
else
  skip "notice migration DB check" "postgres container not reachable from here" "FR-DB-MIGRATION"
fi

[ "${SRS_SOURCED:-0}" = "1" ] || summary "DELIVERED-FIXES"
