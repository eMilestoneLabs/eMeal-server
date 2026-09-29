#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# livetest16-batch.sh — Issues_Live_Test_16 API contracts (READ-ONLY).
#
#   • LT16-01 every group payload carries `dataAvailableFrom` (null or
#             YYYY-MM-DD) — the retention floor the date pickers use (ISSUE-14)
#   • LT16-02 guest settings never exceed the hard ceiling of 5 guests/meal
#             and only the two surviving pricing modes are published (ISSUE-4)
#   • LT16-03 a member can read their OWN itemised adjustments
#             (GET /billing/adjustments/mine) and every row is theirs (ISSUE-16)
#   • LT16-04 the admin adjustments list stays admin-only for a member (403)
#
# PROD-SAFE: 100% READ-ONLY — GETs only. Creates nothing, edits nothing,
# touches no application code, config or infrastructure. Accounts come from
# accounts.sh (never hardcoded here).
#
# Standalone (`bash deploy/srs/livetest16-batch.sh`) or via run.sh.
# Exit 0 = pass, 2 = failures recorded.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (livetest16-batch)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

echo
echo "── Issues_Live_Test_16 · API contracts ──────────────────────────────────"

# ── LT16-01 / 02 — group payload contracts ──────────────────────────────────
req GET "/groups?page=1&limit=50" "" "$ADMIN_TOKEN"
if [ "$R_CODE" != "200" ]; then
  no "LT16-01 groups list reachable" "HTTP $R_CODE"
else
  COUNT="$(jbody '[(.data // .)[]?] | length')"
  if [ "${COUNT:-0}" = "0" ]; then
    skip "LT16-01 dataAvailableFrom on group payloads" "no visible group"
    skip "LT16-02 guest ceiling / pricing modes" "no visible group"
  else
    BAD_FLOOR="$(jbody '[(.data // .)[]? | select((has("dataAvailableFrom") | not) or ((.dataAvailableFrom != null) and ((.dataAvailableFrom | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) | not)))] | length')"
    if [ "$BAD_FLOOR" = "0" ]; then
      ok "LT16-01 dataAvailableFrom on every group payload" "$COUNT group(s)"
    else
      no "LT16-01 dataAvailableFrom on every group payload" "$BAD_FLOOR group(s) missing/malformed"
    fi
    BAD_GUEST="$(jbody '[(.data // .)[]? | .mealConfig.guestConfig? // empty | select((.maxGuestsPerMemberPerMeal // 0) > 5 or ((.guestPricingMode // "sameAsMember") | IN("sameAsMember","flatSurcharge") | not))] | length')"
    if [ "${BAD_GUEST:-0}" = "0" ]; then
      ok "LT16-02 guest ceiling <= 5 and 2 pricing modes only"
    else
      no "LT16-02 guest ceiling <= 5 and 2 pricing modes only" "$BAD_GUEST group(s) violate"
    fi
  fi
fi

# ── LT16-03 / 04 — member self-scoped adjustments ───────────────────────────
if [ -z "${STUDENT_EMAIL:-}" ] || [ -z "${STUDENT_PASS:-}" ]; then
  skip "LT16-03 member reads own adjustments" "no student account configured"
  skip "LT16-04 admin adjustments list is admin-only" "no student account configured"
else
  reuse_or_login STUDENT_TOKEN "$STUDENT_EMAIL" "$STUDENT_PASS"
  req GET "/auth/me" "" "$STUDENT_TOKEN"
  SID="$(jbody '.id // .user.id // empty')"
  SGID="$(jbody '(.groupId // .user.groupId // ((.groupIds // .user.groupIds // [])[0])) // empty')"
  if [ -z "$STUDENT_TOKEN" ] || [ -z "$SID" ] || [ -z "$SGID" ]; then
    skip "LT16-03 member reads own adjustments" "student login/group unavailable"
    skip "LT16-04 admin adjustments list is admin-only" "student login/group unavailable"
  else
    req GET "/billing/adjustments/mine?groupId=$SGID&page=1&limit=100" "" "$STUDENT_TOKEN"
    if [ "$R_CODE" = "200" ]; then
      FOREIGN="$(jbody "[.data[]? | select(.userId != \"$SID\")] | length")"
      if [ "${FOREIGN:-0}" = "0" ]; then
        ok "LT16-03 member reads ONLY own adjustments" "$(jbody '.data | length') row(s)"
      else
        no "LT16-03 member reads ONLY own adjustments" "$FOREIGN foreign row(s) — USER ISOLATION BREACH"
      fi
    else
      no "LT16-03 member reads own adjustments" "HTTP $R_CODE (route missing?)"
    fi
    req GET "/billing/adjustments?groupId=$SGID&page=1&limit=1" "" "$STUDENT_TOKEN"
    assert_in "LT16-04 admin adjustments list is admin-only" "$R_CODE" "" 403 401
  fi
fi

summary 2>/dev/null || true
[ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null
[ "$FAIL" -gt 0 ] && exit 2 || exit 0
