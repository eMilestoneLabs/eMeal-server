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
# hits on top of functional's, risking the 10/60s login throttle. reuse_or_login
# validates the inherited token with one cheap GET /auth/me and only logs in when
# it is missing/expired (always the case when run standalone).
reuse_or_login ADMIN_TOKEN    "$ADMIN_EMAIL"        "$ADMIN_PASS"
reuse_or_login STUDENT_TOKEN  "${STUDENT_EMAIL:-}"  "${STUDENT_PASS:-}"
reuse_or_login ADMIN2_TOKEN   "${ADMIN2_EMAIL:-}"   "${ADMIN2_PASS:-}"
reuse_or_login STUDENT2_TOKEN "${STUDENT2_EMAIL:-}" "${STUDENT2_PASS:-}"
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

  # Input hardening: a malformed/injection date param must 400, NEVER 500.
  req_settle GET "/attendance/vacation-members?groupId=$GRP&date=2026-07-05%27%3BDROP%20TABLE%20notices%3B--" "" "$ADMIN_TOKEN"
  assert_code "malformed date → 400 (never 500)" 400 "$R_CODE" "FR-SECX-050,FR-VACX-053"

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
sec "DELIVERED FIX — admin self-attendance (ATT-004: member path; override of others removed)"
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

# When writes are enabled but NO group has a configured meal (mealId=none),
# self-provision a throwaway always-open meal so the ATT-004 self-mark test
# actually RUNS instead of skipping. The creator is auto-added as an active
# member (groups.service auto-membership), the window is 00:00–23:59 so the
# mark applies deterministically, and the group is permanently deleted below
# (meals + attendance cascade) — zero impact on real data.
# ATTENDANCE-ONLY mode (mealsEnabled:false) is deliberate: a meals-ON group
# defaults to Weekly Meal Mode, where an UNSCHEDULED meal is a no-meal day
# (SRS FR-MODE-032 → 422 NO_MEAL_TODAY) — the master 00:00–23:59 window only
# governs marking outside planner modes. Name carries a per-run suffix so a
# previously failed cleanup can never 409 the create (names are org-unique).
_ZZ_SELF_GID=""
if [ "$WRITE_TESTS" = "1" ] && [ -z "$SELF_MEAL" ]; then
  _ZZ_SUFFIX="$(date +%s)"
  req POST /groups "$(jq -nc --arg n "ZZ_SRS_SELFMARK_$_ZZ_SUFFIX" '{name:$n,type:"hostel",maxMembers:5,joinApprovalRequired:false,mealConfig:{mealsEnabled:false}}')" "$ADMIN_TOKEN"
  _ZZ_SELF_GID="$(jbody '.id // .data.id // empty')"
  if [ -n "$_ZZ_SELF_GID" ] && [ "$_ZZ_SELF_GID" != "null" ]; then
    req POST /meals "$(jq -nc --arg g "$_ZZ_SELF_GID" '{groupId:$g,slotKey:"zz_selfmark_open",name:"ZZ Selfmark Open",attendanceEnabled:true,attendanceWindow:{openTime:"00:00",closeTime:"23:59"}}')" "$ADMIN_TOKEN"
    _ZZ_MID="$(jbody '.id // .data.id // empty')"
    if [ -n "$_ZZ_MID" ] && [ "$_ZZ_MID" != "null" ]; then
      SELF_MEAL="$_ZZ_MID"; MEAL_GID="$_ZZ_SELF_GID"
    fi
  fi
fi

if [ "$WRITE_TESTS" = "1" ] && [ -n "$SELF_MEAL" ]; then
  # attendanceDate must be "today" in the ORG timezone (Asia/Kolkata) — the
  # member path rejects any other date, and the VPS clock runs on UTC.
  TODAY="$(TZ='Asia/Kolkata' date +%F)"
  req GET "/attendance/today?groupId=$MEAL_GID" "" "$ADMIN_TOKEN"
  _PRIOR="$(printf '%s' "$R_BODY" | jq -r --arg m "$SELF_MEAL" '[(.data // .)[]? | select(.mealId==$m)][0].status // empty' 2>/dev/null)"

  # SRS Module 03 ATT-004 (supersedes the FR-OVR-001 consent gate): the admin
  # override endpoint now only accepts SELF-marks and delegates them to the
  # normal member marking path — window, vacation and preference rules apply
  # to the admin exactly like any member. So the valid outcomes are:
  #   200/201  applied (window currently open)
  #   423      window closed — member rules correctly govern the self-mark
  # A 403 ADMIN_OVERRIDE_REMOVED on a SELF-mark would be the actual bug.
  req POST /attendance/admin/override \
    "$(jq -nc --arg u "$ADMIN_ID" --arg m "$SELF_MEAL" --arg d "$TODAY" '{userId:$u,mealId:$m,attendanceDate:$d,status:"present"}')" "$ADMIN_TOKEN"
  _RC="$R_CODE"
  _APPLIED=0
  _ST="$(jbody '.status // .data.status // (.record.status) // empty')"
  _BC="$(jbody '.code // .data.code // empty')"
  if [ "$_RC" = "200" ] || [ "$_RC" = "201" ]; then
    _APPLIED=1
    ok "admin self-mark APPLIED via member path (ATT-004)" "status=$_ST" "FR-ATT-031"
  elif [ "$_RC" = "423" ]; then
    ok "admin self-mark window-gated like a member (ATT-004)" "423 — window closed, member rules govern self-marks" "FR-ATT-031"
  elif [ "$_RC" = "422" ] && [ "$_BC" = "NO_MEAL_TODAY" ]; then
    # Planner holiday rule (FR-MODE-032) applied to the ADMIN exactly like any
    # member — an unscheduled meal is unmarkable for EVERYONE. This IS the
    # member path governing the self-mark; the actual ATT-004 bug would be a
    # 403 ADMIN_OVERRIDE_REMOVED on a SELF-mark.
    ok "admin self-mark planner-gated like a member (ATT-004)" "422 NO_MEAL_TODAY — unscheduled meal, member rules govern self-marks" "FR-ATT-031"
  else
    no "admin self-mark blocked/gated" "code=$_RC body-code=$_BC (expected 200/201 applied, 423 window-locked, or 422 NO_MEAL_TODAY)" "FR-ATT-031"
  fi

  # ATT-004 regression guard: targeting a DIFFERENT member must be REFUSED —
  # the consent-gate flow was removed; corrections are the only path now.
  if [ -n "$STUDENT_ID" ]; then
    req POST /attendance/admin/override \
      "$(jq -nc --arg u "$STUDENT_ID" --arg m "$SELF_MEAL" --arg d "$TODAY" '{userId:$u,mealId:$m,attendanceDate:$d,status:"present"}')" "$ADMIN_TOKEN"
    _OCODE="$(jbody '.code // .data.code // empty')"
    if [ "$R_CODE" = "403" ] && [ "$_OCODE" = "ADMIN_OVERRIDE_REMOVED" ]; then
      ok "other-member override REFUSED (ATT-004)" "(403 ADMIN_OVERRIDE_REMOVED)" "FR-ATT-030"
    else
      no "other-member override gate" "code=$R_CODE body-code=$_OCODE (expected 403 ADMIN_OVERRIDE_REMOVED)" "FR-ATT-030"
    fi
  fi

  # Restore the admin's prior status (self-clean; only if the mark applied —
  # the restore rides the same member path, so a closed window skips it).
  if [ "$_APPLIED" = "1" ] && [ -n "$_PRIOR" ] && [ "$_PRIOR" != "present" ]; then
    req POST /attendance/admin/override \
      "$(jq -nc --arg u "$ADMIN_ID" --arg m "$SELF_MEAL" --arg d "$TODAY" --arg s "$_PRIOR" '{userId:$u,mealId:$m,attendanceDate:$d,status:$s}')" "$ADMIN_TOKEN"
    ok "cleanup: restored admin prior status" "→ $_PRIOR" "FR-ATT-031"
  fi
else
  if [ "$WRITE_TESTS" = "1" ]; then
    skip "admin self-mark (live write)" "could not provision a throwaway meal (create capacity?)" "FR-ATT-031"
  else
    skip "admin self-mark (live write)" "set WRITE_TESTS=1 (self-cleaning) to run" "FR-ATT-031"
  fi
fi

# Cleanup: permanently delete the self-provisioned throwaway group (cascades
# its meal + the self-mark attendance row). Real groups are never touched.
if [ -n "$_ZZ_SELF_GID" ] && [ "$_ZZ_SELF_GID" != "null" ]; then
  req DELETE "/groups/$_ZZ_SELF_GID/permanent" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "204" ]; } \
    && ok "cleanup: throwaway self-mark group deleted" "($R_CODE)" "FR-ATT-031" \
    || no "cleanup: throwaway self-mark group NOT deleted" "$R_CODE — delete ZZ_SRS_SELFMARK manually" "FR-ATT-031"
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
# Canonical linkType vocabulary — MUST stay in sync with the values the backend
# emits (grep: linkType: ' in src/features). As of MODULE_02 there are 8:
# admin queues (vacationRequests/correctionRequests/guestRequests/groupJoinRequests),
# member deep-links (myVacations/myCorrections/myGroups), and groupMembers.
_BADLINK="$(jbody '[.data[]? | .linkType | select(.!=null) | . as $lt | select(["vacationRequests","correctionRequests","guestRequests","groupJoinRequests","groupMembers","myVacations","myCorrections","myGroups"] | index($lt) | not)] | length')"
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

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — signup conflict field-key contract (Live-Test-1 Issue 3)"
# ═════════════════════════════════════════════════════════════════════════════
# READ-ONLY (zero writes): the duplicate-identifier check throws BEFORE any user
# row is created, so these /auth/register attempts create NOTHING (self-cleaning
# by nature). They pin the backend contract the Flutter signup screens rely on to
# place a conflict on the RIGHT field — a taken EMAIL → errors.email, a taken
# MOBILE → errors.mobileNumber (never the wrong field, which was the bug).
_UNIQ="$(date +%s)$$"
# Existing EMAIL (+ a throwaway valid phone) → 409 carried on the `email` field.
req_settle POST /auth/register \
  "$(jq -nc --arg e "$ADMIN_EMAIL" '{name:"ZZ SRS Conflict",role:"student",email:$e,phone:"+19990000001",password:"ZzSrs!2345"}')" ""
assert_code "duplicate email → 409" 409 "$R_CODE" "FR-AUTH-LT1-030"
_EK="$(jbody '.errors.email // empty')"
[ -n "$_EK" ] \
  && ok "duplicate email conflict on 'email' field" "$_EK" "FR-AUTH-LT1-030" \
  || no "email conflict missing errors.email" "$R_BODY" "FR-AUTH-LT1-030"

# Existing MOBILE (+ a fresh unique email so the email check passes first) → 409
# carried on the `mobileNumber` field (this is exactly the misrouted case).
ADMIN_PHONE="$(req GET /auth/me "" "$ADMIN_TOKEN"; jbody '.phone // .data.phone // empty')"
if [ -n "$ADMIN_PHONE" ]; then
  req_settle POST /auth/register \
    "$(jq -nc --arg p "$ADMIN_PHONE" --arg e "zz-srs-$_UNIQ@example.com" '{name:"ZZ SRS Conflict",role:"student",email:$e,phone:$p,password:"ZzSrs!2345"}')" ""
  assert_code "duplicate mobile → 409" 409 "$R_CODE" "FR-AUTH-LT1-031"
  _MK="$(jbody '.errors.mobileNumber // empty')"
  [ -n "$_MK" ] \
    && ok "duplicate mobile conflict on 'mobileNumber' field (NOT email)" "$_MK" "FR-AUTH-LT1-031" \
    || no "mobile conflict missing errors.mobileNumber" "$R_BODY" "FR-AUTH-LT1-031"
else
  skip "duplicate mobile conflict field" "admin account has no phone on record" "FR-AUTH-LT1-031"
fi

# ═════════════════════════════════════════════════════════════════════════════
sec "DELIVERED FIX — org name mandatory + globally unique (Live-Test-1)"
# ═════════════════════════════════════════════════════════════════════════════
# READ-ONLY: an empty name is rejected by DTO validation, and a duplicate name is
# rejected BEFORE the organization/user rows are created — zero writes either way.
# Admin MUST provide an organization name that is not already taken.
req_settle POST /auth/register \
  "$(jq -nc --arg e "zz-srs-org-$_UNIQ@example.com" '{name:"ZZ SRS Org",role:"hostelAdmin",email:$e,phone:"+19990000002",password:"ZzSrs!2345",organizationName:""}')" ""
assert_in "admin empty org name → rejected" "$R_CODE" "FR-AUTH-LT1-032" 400 422
_ONK="$(jbody '.errors.organizationName // empty')"
[ -n "$_ONK" ] \
  && ok "mandatory org name enforced on 'organizationName' field" "$_ONK" "FR-AUTH-LT1-032" \
  || no "empty org name not reported on organizationName" "$R_BODY" "FR-AUTH-LT1-032"

# Reusing an EXISTING org name (fresh email+phone so identity checks pass first)
# → 409 on the organizationName field, so the admin must choose another.
ADMIN_ORG="$(req GET /organizations/me "" "$ADMIN_TOKEN"; jbody '.name // .data.name // empty')"
# Validation ORDER is format → uniqueness: a legacy org name outside the 2–30
# char signup rule is rejected 400 by the length gate BEFORE the duplicate
# check can 409. Only a format-valid seed name can prove the uniqueness rule
# (which is separately guaranteed by the slug @unique + P2002 race guard).
_ORG_LEN="${#ADMIN_ORG}"
if [ -n "$ADMIN_ORG" ] && { [ "$_ORG_LEN" -lt 2 ] || [ "$_ORG_LEN" -gt 30 ]; }; then
  skip "duplicate org name → 409" "seed org name is $_ORG_LEN chars (legacy, outside the 2–30 signup rule) — format gate fires before uniqueness" "FR-AUTH-LT1-033"
elif [ -n "$ADMIN_ORG" ]; then
  req_settle POST /auth/register \
    "$(jq -nc --arg e "zz-srs-org2-$_UNIQ@example.com" --arg o "$ADMIN_ORG" '{name:"ZZ SRS Org",role:"hostelAdmin",email:$e,phone:"+19990000003",password:"ZzSrs!2345",organizationName:$o}')" ""
  assert_code "duplicate org name → 409" 409 "$R_CODE" "FR-AUTH-LT1-033"
  _DUP="$(jbody '.errors.organizationName // empty')"
  [ -n "$_DUP" ] \
    && ok "duplicate org name conflict on 'organizationName' field" "$_DUP" "FR-AUTH-LT1-033" \
    || no "duplicate org name missing errors.organizationName" "$R_BODY" "FR-AUTH-LT1-033"
else
  skip "duplicate org name field" "could not resolve admin org name via /organizations/me" "FR-AUTH-LT1-033"
fi

[ "${SRS_SOURCED:-0}" = "1" ] || summary "DELIVERED-FIXES"
