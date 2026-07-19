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
  req POST /meals "{\"groupId\":\"$GRP\",\"slotKey\":\"  LT11  NORM $SUF \",\"name\":\"LT11 Norm $SUF\"}" "$ADMIN_TOKEN"
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
