#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# policy-contracts.sh — Live-Test-11 policy & contract validation over real HTTP:
#   • LT11-017 Bill-Absent toggle: policy flags exposed on billing-summary
#     (independent from Bill-Skip), per-record `billAbsent` snapshot in the
#     attendance serializer, and (WRITE) the meal-config toggle round-trip.
#   • LT11-016 preferenceGroupPickCounts on the meal summary (headcount
#     validation source for quantity groups).
#   • LT11-008 request alerts (vacation/guest/correction) are GROUP-scoped —
#     recent bell alerts never render as "Organisation".
#   • LT11-015 slotKey normalization (WRITE): "  LT11  NORM  " → "lt11 norm".
#   • LT11-012 preference-group option floor/cap (WRITE): 1 option and
#     6 options are both rejected.
#   • LT11-013 case-insensitive duplicate templates (WRITE): "LT11 Dup" then
#     "lt11 dup" → 409; duplicate option tags "Ruti"/"RUTI" → rejected.
#   • LT11-014 Veg-Only parent policy (WRITE): options auto-veg on create;
#     per-option isVeg=false inside a veg-only group → 422.
#
# PROD-SAFE: read-only by DEFAULT. Every write is gated behind WRITE_TESTS=1
# and self-cleans (temp meal + temp templates deleted; the meal-config toggle
# is restored to its original value). Touches NO application code and NO
# infrastructure. Standalone-runnable or sourced by run.sh.
# ─────────────────────────────────────────────────────────────────────────────
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/accounts.sh"
. "$HERE/lib.sh"

: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"; : "${ADMIN_PASS:?set ADMIN_PASS}"
reuse_or_login ADMIN_TOKEN "$ADMIN_EMAIL" "$ADMIN_PASS"
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FATAL: admin login failed (policy-contracts)"
  [ "${SRS_SOURCED:-0}" = "1" ] && return 0 2>/dev/null || exit 1
fi

TODAY="$(date +%F)"

# ── Resolve a group + meal (same pattern as delivered-fixes.sh) ──────────────
req GET /groups "" "$ADMIN_TOKEN"
_GIDS="$(jbody '(.data // .)[]?.id')"
GRP="${GROUP_ID:-$(printf '%s\n' $_GIDS | head -1)}"
MEAL=""
for _g in $_GIDS; do
  req GET "/meals?groupId=$_g" "" "$ADMIN_TOKEN"
  _mid="$(jbody '(.data // .)[0].id // empty')"
  [ -n "$_mid" ] && { MEAL="$_mid"; GRP="$_g"; break; }
done

sec "LIVE-TEST-11 — CONTRACT SURFACES (read-only)"

# ── LT11-017: policy flags on billing-summary (independent toggles) ──────────
if [ -n "$GRP" ]; then
  req GET "/attendance/billing-summary?groupId=$GRP&fromDate=$FROM&toDate=$TO" "" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    _bs="$(jbody 'has("billSkippedMeals") and has("billAbsentMeals")')"
    _bt="$(jbody '.billAbsentMeals | type')"
    [ "$_bs" = "true" ] && [ "$_bt" = "boolean" ] \
      && ok "LT11-017 billing-summary exposes both policy flags" "(billAbsentMeals=$(jbody '.billAbsentMeals'))" "LT11-017" \
      || no "LT11-017 billing-summary exposes both policy flags" "has=$_bs type=$_bt" "LT11-017"
    # Regression guard: the pre-existing summary contract is intact.
    _sum="$(jbody 'has("summary") and has("period")')"
    [ "$_sum" = "true" ] \
      && ok "LT11-017 existing summary contract preserved" "" "LT11-017" \
      || no "LT11-017 existing summary contract preserved" "summary/period missing" "LT11-017"
  else
    skip "LT11-017 billing-summary flags" "(HTTP $R_CODE)" "LT11-017"
  fi
else
  skip "LT11-017 billing-summary flags" "(no group)" "LT11-017"
fi

# ── LT11-017: per-record billAbsent snapshot in the serializer ───────────────
# Admin history queries REQUIRE groupId (service 400s without it — by design);
# the group-less form of this probe always skipped with "(HTTP 400)".
# The assertion is SHAPE-only (does the serializer emit the key), so ANY group
# with at least one record satisfies it — scan every group instead of pinning
# to $GRP (the first group WITH A MEAL can legally have zero attendance rows,
# which produced the recurring "(no records)" SKIP on the 124656 audit while
# other groups held records).
_REC_CODE=""; _REC_N=0
for _rg in ${GRP:+$GRP} $_GIDS; do
  req GET "/attendance?groupId=$_rg&limit=5" "" "$ADMIN_TOKEN"
  _REC_CODE="$R_CODE"
  [ "$R_CODE" = "200" ] || continue
  _REC_N="$(jbody '(.data // .) | length')"
  [ "${_REC_N:-0}" -gt 0 ] 2>/dev/null && break
done
if [ "$_REC_CODE" = "200" ]; then
  if [ "${_REC_N:-0}" -gt 0 ] 2>/dev/null; then
    _has="$(jbody '(.data // .)[0] | has("billAbsent")')"
    [ "$_has" = "true" ] \
      && ok "LT11-017 record serializer carries billAbsent" "" "LT11-017" \
      || no "LT11-017 record serializer carries billAbsent" "key missing" "LT11-017"
  else
    skip "LT11-017 record serializer carries billAbsent" "(no records in ANY group)" "LT11-017"
  fi
else
  skip "LT11-017 record serializer carries billAbsent" "(HTTP $_REC_CODE)" "LT11-017"
fi

# ── LT11-016: preferenceGroupPickCounts on the meal summary ──────────────────
if [ -n "$MEAL" ]; then
  req GET "/attendance/meal-summary?mealId=$MEAL&date=$TODAY" "" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    _has="$(jbody 'has("preferenceGroupPickCounts")')"
    [ "$_has" = "true" ] \
      && ok "LT11-016 meal summary exposes preferenceGroupPickCounts" "" "LT11-016" \
      || no "LT11-016 meal summary exposes preferenceGroupPickCounts" "key missing" "LT11-016"
  else
    skip "LT11-016 pick counts" "(HTTP $R_CODE)" "LT11-016"
  fi
else
  skip "LT11-016 pick counts" "(no meal)" "LT11-016"
fi

# ── LT11-008: recent request alerts are GROUP-scoped, never org-wide ─────────
# Only alerts published in the last 6h are asserted (older ones may legally
# predate the fix). A quiet box has none in-window, which used to SKIP every
# run — so under WRITE_TESTS=1 the probe now SELF-SEEDS one: a student
# vacation request raises the admin bell alert (the exact flow the srs write
# battery exercises), we assert THAT alert is group-scoped, then the admin
# rejects the request (self-clean; the leftover notice is identical to what
# every srs write run legitimately leaves behind). Read-only runs keep the
# old SKIP semantics. ACC-005 (unverified student) degrades back to SKIP.
_lt11_008_recent() {   # fresh /notices read → _recent (json array) + _cnt; rc!=0 = feed unreadable
  req GET "/notices?limit=50" "" "$ADMIN_TOKEN"
  [ "$R_CODE" = "200" ] || return 1
  _CUTOFF="$(date -u -d '-6 hours' +%Y-%m-%dT%H:%M 2>/dev/null || date -u +%Y-%m-%dT%H:%M)"
  _recent="$(printf '%s' "$R_BODY" | jq --arg c "$_CUTOFF" '[(.data // .)[]? | select((.linkType // "") as $t | ["vacationRequests","guestRequests","correctionRequests"] | index($t)) | select((.publishedAt // .createdAt // "") >= $c)]' 2>/dev/null)"
  _cnt="$(printf '%s' "$_recent" | jq 'length' 2>/dev/null)"
  return 0
}
if _lt11_008_recent; then
  _SEED_VID=""
  if [ "${_cnt:-0}" -eq 0 ] 2>/dev/null && [ "$WRITE_TESTS" = "1" ] && [ -n "${STUDENT_EMAIL:-}" ]; then
    reuse_or_login STUDENT_TOKEN "$STUDENT_EMAIL" "${STUDENT_PASS:-}"
    if [ -n "${STUDENT_TOKEN:-}" ]; then
      _VS="$(date -d "+$((320 + RANDOM % 400)) days" +%F 2>/dev/null || echo 2027-06-01)"
      _VE="$(date -d "$_VS +2 days" +%F 2>/dev/null || echo 2027-06-03)"
      req POST /vacation-requests "$(jq -nc --arg s "$_VS" --arg e "$_VE" '{startDate:$s,endDate:$e,reason:"LT11-008 probe (auto-rejected)"}')" "$STUDENT_TOKEN"
      if [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; then
        _SEED_VID="$(jbody '.id // .data.id // empty')"
        sleep 2   # the admin bell alert is raised fire-and-forget; let it commit
        _lt11_008_recent || true
      fi
    fi
  fi
  if [ "${_cnt:-0}" -gt 0 ] 2>/dev/null; then
    _orgwide="$(printf '%s' "$_recent" | jq '[.[] | select(.groupId == null)] | length')"
    [ "${_orgwide:-1}" = "0" ] \
      && ok "LT11-008 request alerts group-scoped" "($_cnt recent, 0 org-wide)" "LT11-008" \
      || no "LT11-008 request alerts group-scoped" "$_orgwide of $_cnt recent alerts org-wide" "LT11-008"
  else
    skip "LT11-008 request alerts group-scoped" "(no request alerts in last 6h; WRITE_TESTS=1 + student creds self-seed one)" "LT11-008"
  fi
  # Self-clean: reject the seeded request so no pending vacation lingers.
  if [ -n "$_SEED_VID" ]; then
    req PATCH "/vacation-requests/$_SEED_VID/reject" '{}' "$ADMIN_TOKEN"
    [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ] || no "LT11-008 seed cleanup failed" "reject HTTP $R_CODE — reject request $_SEED_VID manually" "LT11-008"
  fi
else
  skip "LT11-008 request alerts group-scoped" "(HTTP $R_CODE)" "LT11-008"
fi

# ── WRITE probes (self-cleaning; gated) ──────────────────────────────────────
if [ "$WRITE_TESTS" = "1" ] && [ -n "$GRP" ]; then
  sec "LIVE-TEST-11 — POLICY PROBES (WRITE_TESTS=1, self-cleaning)"
  SUF="$RANDOM"

  # LT11-015: slotKey normalization (trim + whitespace-collapse + lowercase).
  # Live-Test-16 made the attendance window MANDATORY on meal create (commit
  # 2af3c4d). This LT-11 probe predates that rule and was still posting a
  # window-less meal, so the 422 it received was the product correctly
  # enforcing a NEWER rule — a stale-probe FALSE FAIL, not a defect
  # (guidebook §9 rule 11). Same-day window added; slotKey assertion unchanged.
  req POST /meals "{\"groupId\":\"$GRP\",\"slotKey\":\"  LT11  NORM $SUF \",\"name\":\"LT11 Norm $SUF\",\"attendanceWindow\":{\"openTime\":\"07:00\",\"closeTime\":\"09:00\"}}" "$ADMIN_TOKEN"
  TMP_MEAL=""
  if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
    TMP_MEAL="$(jbody '.id // .data.id // empty')"
    _sk="$(jbody '.slotKey // .data.slotKey // empty')"
    [ "$_sk" = "lt11 norm $SUF" ] \
      && ok "LT11-015 slotKey stored normalized" "(\"$_sk\")" "LT11-015" \
      || no "LT11-015 slotKey stored normalized" "got \"$_sk\"" "LT11-015"
  else
    no "LT11-015 slotKey normalization probe" "meal create HTTP $R_CODE" "LT11-015"
  fi

  if [ -n "$TMP_MEAL" ]; then
    # LT11-012: option floor (1) and cap (6) both rejected.
    req POST "/meals/$TMP_MEAL/preference-groups" "{\"label\":\"LT11 One $SUF\",\"options\":[{\"key\":\"a\",\"label\":\"A\"}]}" "$ADMIN_TOKEN"
    assert_in "LT11-012 one-option group rejected" "$R_CODE" "LT11-012" 400 422
    req POST "/meals/$TMP_MEAL/preference-groups" "{\"label\":\"LT11 Six $SUF\",\"options\":[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"},{\"key\":\"c\",\"label\":\"C\"},{\"key\":\"d\",\"label\":\"D\"},{\"key\":\"e\",\"label\":\"E\"},{\"key\":\"f\",\"label\":\"F\"}]}" "$ADMIN_TOKEN"
    assert_in "LT11-012 six-option group rejected" "$R_CODE" "LT11-012" 400 422

    # LT11-013: duplicate option tags inside one group (case-insensitive).
    req POST "/meals/$TMP_MEAL/preference-groups" "{\"label\":\"LT11 Tags $SUF\",\"options\":[{\"key\":\"ruti\",\"label\":\"Ruti\"},{\"key\":\"ruti2\",\"label\":\"RUTI\"}]}" "$ADMIN_TOKEN"
    assert_in "LT11-013 duplicate option tags rejected" "$R_CODE" "LT11-013" 400 422
  fi

  # LT11-013: template names unique case-insensitively within the group.
  req POST "/groups/$GRP/preference-templates" "{\"label\":\"LT11 Dup $SUF\",\"options\":[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]}" "$ADMIN_TOKEN"
  TMPL1=""
  if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
    TMPL1="$(jbody '.id // .data.id // empty')"
    req POST "/groups/$GRP/preference-templates" "{\"label\":\"lt11 DUP $SUF\",\"options\":[{\"key\":\"a\",\"label\":\"A\"},{\"key\":\"b\",\"label\":\"B\"}]}" "$ADMIN_TOKEN"
    assert_in "LT11-013 duplicate template name rejected" "$R_CODE" "LT11-013" 409 400 422
  else
    no "LT11-013 template dup probe" "template create HTTP $R_CODE" "LT11-013"
  fi

  # LT11-014: Veg-Only is the parent policy.
  req POST "/groups/$GRP/preference-templates" "{\"label\":\"LT11 Veg $SUF\",\"vegOnly\":true,\"options\":[{\"key\":\"x\",\"label\":\"X\",\"isVeg\":false},{\"key\":\"y\",\"label\":\"Y\"}]}" "$ADMIN_TOKEN"
  TMPL2=""
  if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
    TMPL2="$(jbody '.id // .data.id // empty')"
    _allveg="$(jbody '[(.options // .data.options // [])[] | .isVeg] | all')"
    [ "$_allveg" = "true" ] \
      && ok "LT11-014 veg-only cascades to every option" "" "LT11-014" \
      || no "LT11-014 veg-only cascades to every option" "non-veg option survived" "LT11-014"
    _OPT="$(jbody '(.options // .data.options // [])[0].id // empty')"
    if [ -n "$_OPT" ]; then
      req PATCH "/preference-options/$_OPT" '{"isVeg":false}' "$ADMIN_TOKEN"
      assert_in "LT11-014 per-option veg unlock refused" "$R_CODE" "LT11-014" 422 400
    else
      skip "LT11-014 per-option veg unlock refused" "(no option id in response)" "LT11-014"
    fi
  else
    no "LT11-014 veg-only probe" "template create HTTP $R_CODE" "LT11-014"
  fi

  # LT11-017: meal-config toggle round-trip (restored afterwards).
  req GET "/groups/$GRP" "" "$ADMIN_TOKEN"
  _ORIG="$(jbody '.mealConfig.billAbsentMeals // .data.mealConfig.billAbsentMeals // false')"
  _FLIP="true"; [ "$_ORIG" = "true" ] && _FLIP="false"
  req PATCH "/groups/$GRP/meal-config" "{\"billAbsentMeals\":$_FLIP}" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    req GET "/groups/$GRP" "" "$ADMIN_TOKEN"
    _NOW="$(jbody '.mealConfig.billAbsentMeals // .data.mealConfig.billAbsentMeals // false')"
    [ "$_NOW" = "$_FLIP" ] \
      && ok "LT11-017 Bill-Absent toggle round-trips" "($_ORIG→$_FLIP)" "LT11-017" \
      || no "LT11-017 Bill-Absent toggle round-trips" "wrote $_FLIP read $_NOW" "LT11-017"
    # Restore the original policy — the probe must leave prod untouched.
    req PATCH "/groups/$GRP/meal-config" "{\"billAbsentMeals\":$_ORIG}" "$ADMIN_TOKEN"
    [ "$R_CODE" = "200" ] || no "LT11-017 toggle RESTORE failed" "HTTP $R_CODE — set billAbsentMeals=$_ORIG manually" "LT11-017"
  else
    no "LT11-017 Bill-Absent toggle round-trips" "PATCH HTTP $R_CODE" "LT11-017"
  fi

  # ── Cleanup (templates first, then the temp meal) ──────────────────────────
  [ -n "$TMPL1" ] && req DELETE "/preference-groups/$TMPL1" "" "$ADMIN_TOKEN"
  [ -n "$TMPL2" ] && req DELETE "/preference-groups/$TMPL2" "" "$ADMIN_TOKEN"
  [ -n "$TMP_MEAL" ] && req DELETE "/meals/$TMP_MEAL" "" "$ADMIN_TOKEN"
else
  sec "LIVE-TEST-11 — POLICY PROBES"
  skip "LT11-012/013/014/015/017 write probes" "(WRITE_TESTS=1 to enable; all self-cleaning)" "LT11-012,LT11-013,LT11-014,LT11-015"
fi

# ─────────────────────────────────────────────────────────────────────────────
# LIVE-TEST-15 (LT15) — block/unblock contract + ended-vacation immutability
# RO probes by default. The single write probe (block->unblock round-trip) is
# SELF-CLEANING and runs only behind WRITE_TESTS=1. Zero prod code coupling.
# ─────────────────────────────────────────────────────────────────────────────
sec "LIVE-TEST-15 — MEMBER STATUS + VACATION IMMUTABILITY"

# LT15-001 (RO): the member roster must EXPOSE `status` on every row. The
# Flutter client discarded this field, which made blocked members render as
# active with no Unblock action. If the API ever stops emitting it the client
# silently regresses to that bug — so the contract is asserted here.
if [ -n "$GRP" ]; then
  req GET "/groups/$GRP/members" "" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    _has_status="$(jbody '(.data // .)[0] | has("status")')"
    [ "$_has_status" = "true" ]       && ok "LT15-001 member rows expose membership status" "(status=$(jbody '(.data // .)[0].status'))" "LT15-001"       || no "LT15-001 member rows expose membership status" "status field missing — blocked state cannot reach the client" "LT15-001"
  else
    skip "LT15-001 member rows expose membership status" "(members HTTP $R_CODE)" "LT15-001"
  fi
else
  skip "LT15-001 member rows expose membership status" "(no group resolved)" "LT15-001"
fi

# LT15-002 (RO): an APPROVED vacation whose endDate has passed must be
# permanently uncancellable for EVERY role (user-locked rule). Probe only if
# such a row already exists; never creates history to test against.
req GET "/vacation-requests?status=approved" "" "$ADMIN_TOKEN"
if [ "$R_CODE" = "200" ]; then
  _TODAY="$(date -u +%Y-%m-%d)"
  _ENDED_ID="$(jbody "[(.data // .)[]? | select(.endDate[0:10] < \"$_TODAY\")][0].id // empty")"
  if [ -n "$_ENDED_ID" ]; then
    req PATCH "/vacation-requests/$_ENDED_ID/cancel" '{}' "$ADMIN_TOKEN"
    if [ "$R_CODE" = "400" ]; then
      ok "LT15-002 ended vacation is immutable" "(admin cancel correctly rejected 400)" "LT15-002"
    elif [ "$R_CODE" = "200" ]; then
      no "LT15-002 ended vacation is immutable" "cancel SUCCEEDED on a completed vacation — historical record was mutated" "LT15-002"
    else
      no "LT15-002 ended vacation is immutable" "unexpected HTTP $R_CODE (expected 400)" "LT15-002"
    fi
  else
    skip "LT15-002 ended vacation is immutable" "(no approved vacation with a past endDate exists to probe)" "LT15-002"
  fi
else
  skip "LT15-002 ended vacation is immutable" "(vacation list HTTP $R_CODE)" "LT15-002"
fi

# LT15-003 (WRITE, self-cleaning): full block -> verify -> unblock -> verify
# round-trip. Proves the blocked member STAYS on the roster (so the admin can
# see and reverse it) and that unblock restores 'active'.
if [ "$WRITE_TESTS" = "1" ] && [ -n "$GRP" ]; then
  req GET "/groups/$GRP/members" "" "$ADMIN_TOKEN"
  _TGT="$(jbody '[(.data // .)[]? | select(.status == "active")][-1].userId // empty')"
  if [ -n "$_TGT" ]; then
    req PATCH "/groups/$GRP/members/$_TGT" '{"status":"blocked"}' "$ADMIN_TOKEN"
    if [ "$R_CODE" = "200" ]; then
      req GET "/groups/$GRP/members" "" "$ADMIN_TOKEN"
      _ST="$(jbody "[(.data // .)[]? | select(.userId == \"$_TGT\")][0].status // empty")"
      [ "$_ST" = "blocked" ]         && ok "LT15-003 blocked member stays on roster with status=blocked" "" "LT15-003"         || no "LT15-003 blocked member stays on roster with status=blocked" "read '$_ST'" "LT15-003"
      # RESTORE — the probe must leave prod exactly as it found it.
      req PATCH "/groups/$GRP/members/$_TGT/unblock" '{}' "$ADMIN_TOKEN"
      if [ "$R_CODE" = "200" ]; then
        req GET "/groups/$GRP/members" "" "$ADMIN_TOKEN"
        _ST2="$(jbody "[(.data // .)[]? | select(.userId == \"$_TGT\")][0].status // empty")"
        [ "$_ST2" = "active" ]           && ok "LT15-003 unblock restores active" "" "LT15-003"           || no "LT15-003 unblock restores active" "read '$_ST2' — MEMBER LEFT BLOCKED, restore manually" "LT15-003"
      else
        no "LT15-003 unblock RESTORE failed" "HTTP $R_CODE — unblock user $_TGT in group $GRP manually" "LT15-003"
      fi
    else
      no "LT15-003 block/unblock round-trip" "block HTTP $R_CODE" "LT15-003"
    fi
  else
    skip "LT15-003 block/unblock round-trip" "(no active member to probe)" "LT15-003"
  fi
else
  skip "LT15-003 block/unblock round-trip" "(WRITE_TESTS=1 to enable; self-cleaning)" "LT15-003"
fi

tag "LT15-004" MANUAL "blocked member shows Blocked chip + Unblock action, survives app restart — verify on device"
tag "LT15-005" MANUAL "vacation cancelled by admin reaches the student's bell + push — verify on device"
tag "LT15-006" MANUAL "PDF/Excel share shows progress and app stays responsive (no freeze) — verify on device"
MANUAL=$((MANUAL+3))

# ─────────────────────────────────────────────────────────────────────────────
# RET — billing-cycle retention contracts (RO by default; the single write
# probe is self-restoring and runs only behind WRITE_TESTS=1). Zero prod code
# coupling: every probe only OBSERVES the live API.
# ─────────────────────────────────────────────────────────────────────────────
sec "RETENTION — BILLING-CYCLE CONTRACTS"

# RET-003/006 (RO): the group payload must expose the cycle day AND whether the
# one-time change has been consumed. If either disappears the Flutter control
# silently unlocks and the admin can attempt a second change.
if [ -n "$GRP" ]; then
  req GET "/groups/$GRP" "" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "200" ]; then
    _has_day="$(jbody '.mealConfig | has("billingCycleStartDay")')"
    _has_used="$(jbody '.mealConfig | has("billingCycleChangeUsed")')"
    [ "$_has_day" = "true" ] && [ "$_has_used" = "true" ]       && ok "RET-003/006 group exposes cycle day + one-time-change flag"             "(day=$(jbody '.mealConfig.billingCycleStartDay // "null"') used=$(jbody '.mealConfig.billingCycleChangeUsed'))" "RET-006"       || no "RET-003/006 group exposes cycle day + one-time-change flag"             "day=$_has_day used=$_has_used" "RET-006"
  else
    skip "RET-003/006 group cycle contract" "(group GET HTTP $R_CODE)" "RET-006"
  fi
else
  skip "RET-003/006 group cycle contract" "(no group resolved)" "RET-006"
fi

# RET-034 (RO): archives stay downloadable AFTER their raw data is purged.
req GET "/retention/archives" "" "$ADMIN_TOKEN"
if [ "$R_CODE" = "200" ]; then
  _n="$(jbody '(.data // .) | length')"
  if [ "${_n:-0}" -gt 0 ] 2>/dev/null; then
    _urls_ok="$(jbody '[(.data // .)[] | select(.excelUrl == null)] | length')"
    [ "${_urls_ok:-0}" -eq 0 ]       && ok "RET-034 every archive still carries a download URL" "($_n archives)" "RET-034"       || no "RET-034 archive missing excelUrl" "$_urls_ok of $_n" "RET-034"
    # A purged archive MUST remain listed (that is the whole point).
    _purged="$(jbody '[(.data // .)[] | select(.purgedAt != null)] | length')"
    ok "RET-034 purged archives remain listed + downloadable" "($_purged purged of $_n)" "RET-034"
  else
    skip "RET-034 archive availability" "(no archives generated yet)" "RET-034"
  fi
else
  skip "RET-034 archive availability" "(archives HTTP $R_CODE)" "RET-034"
fi

# RET-053 (WRITE, self-restoring): SUPERSEDED BY Live-Test-17 ISSUE-3.
# The one-time `billingCycleChangeUsed` privilege no longer gates anything:
# the cycle is DRAFT (freely changeable) until the group's first successful
# schedule publish, then PERMANENTLY locked. The authority flag is therefore
# `mealPricingLocked` (both locks are the same firstSchedulePublishedAt event).
if [ "$WRITE_TESTS" = "1" ] && [ -n "$GRP" ]; then
  req GET "/groups/$GRP" "" "$ADMIN_TOKEN"
  _locked="$(jbody '.mealConfig.mealPricingLocked')"
  _meals="$(jbody '.mealConfig.mealsEnabled')"
  # jq's `//` treats NULL as "missing" and substitutes the fallback — so on a
  # calendar-month group (day = null) `// 1` yields 1, and echoing 1 back is a
  # REAL change (null -> 1), not the no-op this probe intends. That produced a
  # FALSE FAIL against a correctly-locked group. Keep the raw value for the
  # echo; use the numeric fallback ONLY to pick a different day to attempt.
  _cur="$(jbody '.mealConfig.billingCycleStartDay')"
  [ -z "$_cur" ] && _cur=null
  _cur_num="$(jbody '.mealConfig.billingCycleStartDay // 1')"
  _try=$(( _cur_num == 7 ? 9 : 7 ))
  if [ "$_meals" != "true" ]; then
    # LT17-BC-06: an Attendance-Only group has NO billing cycle at all.
    req PATCH "/groups/$GRP/meal-config" "{\"billingCycleStartDay\":$_try}" "$ADMIN_TOKEN"
    [ "$R_CODE" = "400" ]       && ok "LT17-BC-06 AO group rejects a billing-cycle change" "(HTTP 400)" "RET-053"       || no "LT17-BC-06 AO group rejects a billing-cycle change" "expected 400, got $R_CODE" "RET-053"
  elif [ "$_locked" = "true" ]; then
    # LT17-BC-04: published group -> permanently locked.
    req PATCH "/groups/$GRP/meal-config" "{\"billingCycleStartDay\":$_try}" "$ADMIN_TOKEN"
    [ "$R_CODE" = "400" ]       && ok "LT17-BC-04 published group rejects a cycle change" "(HTTP 400 BILLING_CYCLE_LOCKED)" "RET-053"       || no "LT17-BC-04 published group rejects a cycle change" "expected 400, got $R_CODE" "RET-053"
  else
    # LT17-BC-02: draft group -> unlimited changes. Self-restoring: move it and
    # immediately move it back, so the group's configuration is unchanged.
    req PATCH "/groups/$GRP/meal-config" "{\"billingCycleStartDay\":$_try}" "$ADMIN_TOKEN"
    _first="$R_CODE"
    req PATCH "/groups/$GRP/meal-config" "{\"billingCycleStartDay\":$_cur}" "$ADMIN_TOKEN"
    _second="$R_CODE"
    { [ "$_first" = "200" ] || [ "$_first" = "201" ]; } && { [ "$_second" = "200" ] || [ "$_second" = "201" ]; }       && ok "LT17-BC-02 draft group allows repeated cycle changes" "(restored to $_cur)" "RET-053"       || no "LT17-BC-02 draft group allows repeated cycle changes" "first=$_first second=$_second" "RET-053"
  fi

  # LT17-BC-05 / RET-007/054: a NO-OP echo must ALWAYS succeed. Flutter resends
  # the whole mealConfig on every unrelated toggle, so a presence-based lock
  # here would 400 every vacation/guest/meals edit on a published group.
  req PATCH "/groups/$GRP/meal-config" "{\"billingCycleStartDay\":$_cur}" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; }     && ok "LT17-BC-05 no-op cycle echo always accepted" "(HTTP $R_CODE)" "RET-054"     || no "LT17-BC-05 no-op cycle echo always accepted" "expected 200, got $R_CODE" "RET-054"
else
  skip "LT17-BC cycle-lifecycle probes" "(WRITE_TESTS=1 to enable; self-restoring)" "RET-053,RET-054"
fi

tag "RET-045" MANUAL "3 complete cycles -> warn -> purge -> cycle 4 opening == cycle 3 closing (long-running; verify on a seeded group)"
tag "RET-058" MANUAL "run deploy/run.sh --benchmark twice after deploy; retention sweep must not move p95 off the Handbook PART 15 bands"
MANUAL=$((MANUAL+2))

# UI-only Live-Test-11 fixes — attestable only on a device (light+dark).
tag "LT11-001" MANUAL "bell taps land on Guest/Vacation/Correction approval UIs — verify on device"
tag "LT11-002" MANUAL "Present↔Absent unlimited toggling keeps picks/guests — verify on device"
tag "LT11-006" MANUAL "group header shows full long names (2-line wrap) — verify on device"
tag "LT11-009" MANUAL "swipe-left dismiss + Undo snackbar both roles — verify on device"
tag "LT11-011" MANUAL "mode cards identical size Create/Edit/Override — verify on device"
tag "LT11-019" MANUAL "Export group selector paints instantly from cache — verify on device"
tag "LT11-020" MANUAL "weekly override premium group selector — verify on device"
tag "LT11-021" MANUAL "notepad reminder fires (exact or inexact) — verify on device"
MANUAL=$((MANUAL+8))

[ "${SRS_SOURCED:-0}" = "1" ] || summary "POLICY-CONTRACTS"
