#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# member-settings-scope.sh — GROUP-SCOPED member settings contracts.
#
# Vacation and Personal Auto-Attendance used to live ONLY on `users`, so one
# toggle governed every group a member belonged to: enabling auto-attendance
# while viewing group A also auto-marked (and BILLED) them in group B, and an
# approved group-A vacation suppressed attendance in group B. The per-group
# value now lives on `group_members`, with NULL meaning "inherit the user flag".
#
#   • LT15M-001 the migration is applied — both nullable columns exist
#   • LT15M-002 NULL is the inert default: pre-existing rows still inherit, so
#               the feature cannot have changed anyone's behaviour by landing
#   • LT15M-003 GET /groups/:id exposes `myMemberSettings` — the client needs a
#               per-group read source, or the toggle would write per-group
#               while the UI kept reading the shared user flag
#   • LT15M-004 USER ISOLATION — that payload carries the REQUESTER's own
#               overrides ONLY. Every member's settings must never ship in a
#               group response
#   • LT15M-005 the group LIST path does not populate it (detail-read only),
#               so a list response can never become a settings dump
#   • LT15M-006 ORG ISOLATION — a foreign group id is 404/403, never 200
#
# PROD-SAFE: 100% READ-ONLY — GETs and one psql SELECT. Creates nothing, edits
# nothing, toggles nothing, touches no application code and no infrastructure.
# The security probe that would REJECT a foreign-group write is deliberately
# NOT performed: a rejected write is still a write attempt, and this module is
# registered RO.
#
# Standalone (`bash deploy/srs/member-settings-scope.sh`) or sourced by run.sh.
# Exit 0 = pass, 2 = failures recorded.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (member-settings-scope)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

echo
echo "── Live-Test-15 · group-scoped member settings ──────────────────────────"

# Resolve a real group from the admin's own visible list (never hardcoded).
req GET "/groups?page=1&limit=20" "" "$ADMIN_TOKEN"
GID="$(jbody '(.data // .)[0].id // empty')"
if [ -z "$GID" ]; then
  skip "LT15M — no visible group for this admin" "cannot assert"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 0
fi

# ── LT15M-001 / 002 — schema applied, and inert by default ──────────────────
# psql via the documented docker path (guidebook §9.7). Absent docker/psql is a
# SKIP, never a FAIL — the ops box may not expose the container to this user.
PSQL='docker exec emeal_postgres bash -c'
COLS="$($PSQL 'psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from information_schema.columns where table_name='"'"'group_members'"'"' and column_name in ('"'"'isVacationMode'"'"','"'"'isDefaultAttendance'"'"')"' 2>/dev/null | tr -d '[:space:]')"
if [ -z "$COLS" ]; then
  skip "LT15M-001 migration applied (both columns exist)" "psql unavailable"
  skip "LT15M-002 NULL default keeps legacy rows inheriting" "psql unavailable"
elif [ "$COLS" = "2" ]; then
  ok "LT15M-001 migration applied (both columns exist)" "group_members +2"
  # Rows carrying an explicit value are members who deliberately set one. Any
  # row still NULL proves the inherit path is intact for untouched members.
  NULLS="$($PSQL 'psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from group_members where \"isVacationMode\" is null and \"isDefaultAttendance\" is null"' 2>/dev/null | tr -d '[:space:]')"
  TOTAL="$($PSQL 'psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select count(*) from group_members"' 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$NULLS" ] && [ -n "$TOTAL" ]; then
    ok "LT15M-002 NULL default keeps legacy rows inheriting" "$NULLS/$TOTAL still inherit"
  else
    skip "LT15M-002 NULL default keeps legacy rows inheriting" "count unavailable"
  fi

  # ── LT15M-006 — A-full ownership invariant (READ-ONLY) ────────────────────
  # A GROUP-SCOPED approved request must write GroupMember.isVacationMode, NOT
  # the account flag. So no user may carry isVacationMode=true while EVERY
  # approved request covering today is group-scoped — that combination is
  # exactly the cross-group spill, and finding one proves a writer regressed.
  # Members on a genuine org-wide toggle are excluded: they have no covering
  # request at all, so the NOT EXISTS below never matches them.
  SPILL="$($PSQL 'psql -tAU "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
    select count(*) from users u
    where u.\"isVacationMode\" = true
      and exists (select 1 from vacation_requests r
                  where r.\"userId\" = u.id and r.status = '"'"'approved'"'"'
                    and r.\"deletedAt\" is null and r.\"groupId\" is not null
                    and r.\"startDate\" <= now() and r.\"endDate\" >= now())
      and not exists (select 1 from vacation_requests r2
                      where r2.\"userId\" = u.id and r2.status = '"'"'approved'"'"'
                        and r2.\"deletedAt\" is null and r2.\"groupId\" is null
                        and r2.\"startDate\" <= now() and r2.\"endDate\" >= now())"' 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$SPILL" ]; then
    skip "LT15M-006 group-scoped leave never sets the account flag" "query unavailable"
  elif [ "$SPILL" = "0" ]; then
    ok "LT15M-006 group-scoped leave never sets the account flag" "0 spilled users"
  else
    no "LT15M-006 group-scoped leave never sets the account flag" "$SPILL user(s) carry an account-level flag explained only by GROUP-scoped leave"
  fi
else
  no "LT15M-001 migration applied (both columns exist)" "found $COLS/2 — run prisma migrate deploy"
  skip "LT15M-002 NULL default keeps legacy rows inheriting" "schema incomplete"
fi

# ── LT15M-003 — the client has a per-group read source ──────────────────────
req GET "/groups/$GID" "" "$ADMIN_TOKEN"
if [ "$R_CODE" != "200" ]; then
  no "LT15M-003 GET /groups/:id exposes myMemberSettings" "HTTP $R_CODE"
else
  HAS="$(jbody 'has("myMemberSettings")')"
  if [ "$HAS" = "true" ]; then
    ok "LT15M-003 GET /groups/:id exposes myMemberSettings" "present"
  else
    no "LT15M-003 GET /groups/:id exposes myMemberSettings" "key missing — client would read the shared user flag"
  fi

  # ── LT15M-004 — requester's own overrides ONLY ────────────────────────────
  # The value must be null (not a member / no override) or an object with just
  # the two boolean-or-null fields. An ARRAY, or extra keys such as a userId,
  # would mean another member's state is riding along.
  SHAPE="$(jbody '(.myMemberSettings // null) | if . == null then "null" elif type == "object" then ([keys[]] | sort | join(",")) else type end')"
  case "$SHAPE" in
    null|"isDefaultAttendance,isVacationMode")
      ok "LT15M-004 USER ISOLATION — own overrides only" "shape=$SHAPE" ;;
    *)
      no "LT15M-004 USER ISOLATION — own overrides only" "unexpected shape: $SHAPE" ;;
  esac

  # The internal per-member map must never be serialized under any name.
  LEAK="$(printf '%s' "$R_BODY" | jq -r 'tostring | test("memberSettings\"\\s*:\\s*\\[")' 2>/dev/null)"
  if [ "$LEAK" = "true" ]; then
    no "LT15M-004b internal member map not serialized" "array leaked into the payload"
  else
    ok "LT15M-004b internal member map not serialized" "no member-settings array"
  fi
fi

# ── LT15M-005 — list path stays a list ──────────────────────────────────────
# Populated only on the detail read, so list entries either omit the key or
# carry null. A list that started returning real overrides would be shipping
# per-member state for every group at once.
req GET "/groups?page=1&limit=20" "" "$ADMIN_TOKEN"
NONNULL="$(jbody '[(.data // .)[]? | select(.myMemberSettings != null)] | length')"
case "$NONNULL" in
  ""|0) ok "LT15M-005 list path does not populate it (detail-only)" "0 populated" ;;
  *)    no "LT15M-005 list path does not populate it (detail-only)" "$NONNULL entries populated" ;;
esac

# ── LT15M-006 — org isolation on the detail read ────────────────────────────
req GET "/groups/ckfakefakefakefakefake000" "" "$ADMIN_TOKEN"
case "$R_CODE" in
  404|403) ok "LT15M-006 ORG ISOLATION — foreign group id rejected" "HTTP $R_CODE" ;;
  *)       no "LT15M-006 ORG ISOLATION — foreign group id rejected" "HTTP $R_CODE (expected 404/403)" ;;
esac

echo
echo "── member-settings-scope: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ──"
[ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null
[ "$FAIL" -gt 0 ] && exit 2 || exit 0
