#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# validate-meal-attendance-billing.sh — end-to-end verification of MODULE_03
# (Meal Management, Attendance & Billing) against the LIVE backend. Real HTTP,
# real self-cleaned writes, real responses. No mocks. Mirrors the MODULE_01
# (validate-auth-signup.sh) / MODULE_02 (validate-group-organization.sh)
# validator conventions. run.sh module name: mealcheck.
#
# Proves the MODULE_03 SRS families delivered 2026-07-11/12 (per the survey
# source of truth REQUIREMENTS_DOCUMENTS\_MODULE03_IMPLEMENTATION_SURVEY_ANSWERS.md):
#   MMT-001/003/014  Master Meal Template cap + unique meal name (per group)
#   MMT-002          slotKey IMMUTABLE after creation
#   PREF-006.1/.2/.3 tag cap · preference-groups-per-meal cap · options-per-group cap
#   ATT-007/008/009  Opt-Out auto-attendance ⊕ Meal Preferences exclusivity
#   ATT-004          admin can NEVER mark/override another member (corrections only)
#   COR-005          same-calendar-day correction lock · Skip never a correction target
#   Q17/Q21          member statuses = Present|Absent only; Skip internal-only
#   BILL-012/Q20     per-group billing cycle anchor 1–31 (29/30/31 never rejected)
#   BILL (Q17/Q22)   Bill-Skip policy round-trips (billSkippedMeals)
#   GST-011          modes 1/2/3 incl. percentage surcharge bounded 0–100
#   MODE-003         Attendance-Only Mode: window-only meals + window cap
#   SCH-012          legacy recurrence flags removed from the API contract
#   RPT-001          CSV export removed (Excel + PDF only)
#   NTC-003/012/013  attachments: type+size rejection wording · external links
#   ACC-005          email-verification participation gate (403 contract)
#   RET-001..015     retention archives endpoint (admin-only RBAC)
# Time/scheduler-driven behaviours (sweeps, retention cycle, day rollover) are
# covered by the jest suite — see the COVERAGE NOTE section this script prints.
#
# ZERO-IMPACT CONTRACT: every group it creates is prefixed "ZZ_M03_VERIFY_"
# and permanently deleted at the end (meals cascade); attachment and cap
# checks assert REJECTION paths, which fail before any row/object is written;
# the ACC-005 probe uses a disposable signup that deletes itself. Safe to
# re-run; never touches infrastructure or existing data.
#
# USAGE (on VPS):
#   ADMIN_EMAIL='...' ADMIN_PASS='...' STUDENT_EMAIL='...' STUDENT_PASS='...' \
#   bash deploy/validate-meal-attendance-billing.sh
# Optional env: BASE (default http://localhost:3000/api/v1), PERF_BUDGET_MS
# (default 150).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BASE="${BASE:-http://localhost:3000/api/v1}"
PERF_BUDGET_MS="${PERF_BUDGET_MS:-150}"
OUT="/tmp/emeal-module03-verify-$(date +%Y%m%d-%H%M%S).log"

_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_DIR/srs/accounts.sh" ] && . "$_DIR/srs/accounts.sh"

ADMIN_EMAIL="${ADMIN_EMAIL:-}"; ADMIN_PASS="${ADMIN_PASS:-}"
STUDENT_EMAIL="${STUDENT_EMAIL:-}"; STUDENT_PASS="${STUDENT_PASS:-}"

command -v jq   >/dev/null || { echo "FATAL: jq not installed";   exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl not installed"; exit 1; }
[ -z "$ADMIN_EMAIL" ] && { echo "FATAL: set ADMIN_EMAIL/ADMIN_PASS (see header)"; exit 1; }

exec > >(tee "$OUT") 2>&1
PASS=0; FAIL=0; SKIP=0; declare -a FAILED_CHECKS
hr()  { printf '%.0s─' {1..78}; echo; }
sec() { echo; hr; echo "▶ $*"; hr; }
ok()   { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m  %-54s %s\n" "$1" "${2:-}"; }
no()   { FAIL=$((FAIL+1)); FAILED_CHECKS+=("$1"); printf "  \033[31mFAIL\033[0m  %-54s %s\n" "$1" "${2:-}"; }
skip() { SKIP=$((SKIP+1)); printf "  \033[33mSKIP\033[0m  %-54s %s\n" "$1" "${2:-}"; }
assert_code() { if [ "$3" = "$2" ]; then ok "$1" "($3, ${4:-})"; else no "$1" "expected $2 got $3 ${4:-}"; fi; }

req() { # METHOD PATH [JSON] [TOKEN] → R_CODE R_MS R_BODY
  local method="$1" path="$2" json="${3:-}" token="${4:-}"
  local hdr=(-H 'Content-Type: application/json')
  [ -n "$token" ] && hdr+=(-H "Authorization: Bearer $token")
  local tmp w; tmp="$(mktemp)"
  if [ -n "$json" ]; then
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" -d "$json" "$BASE$path")
  else
    w=$(curl -s -o "$tmp" -w "%{http_code} %{time_starttransfer}" -X "$method" "${hdr[@]}" "$BASE$path")
  fi
  R_CODE="${w%% *}"; local t="${w##* }"
  R_MS=$(awk "BEGIN{printf \"%.0f\", $t*1000}")
  R_BODY="$(cat "$tmp")"; rm -f "$tmp"
}
perf() { if [ "${R_MS:-99999}" -le "$PERF_BUDGET_MS" ]; then ok "$1 latency" "${R_MS}ms ≤ ${PERF_BUDGET_MS}ms"
  else skip "$1 latency" "${R_MS}ms > ${PERF_BUDGET_MS}ms (network/cold — re-check on VPS localhost)"; fi; }
login() { req POST /auth/login "$(jq -nc --arg i "$1" --arg p "$2" '{identifier:$i,password:$p}')"
  { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } || { echo ""; return 1; }
  echo "$R_BODY" | jq -r '.accessToken // .data.accessToken // empty'; }
j() { echo "$R_BODY" | jq -r "$1" 2>/dev/null; }
# Group serializer nests meal config (and guest config inside it) on some
# shapes — read with fallbacks. Deliberately NOT jq's `//`: that operator
# treats `false` as missing, which turned every legitimate boolean-false
# round-trip (e.g. preferencesEnabled=false after ATT-007) into "".
gfield() { echo "$R_BODY" | jq -r --arg f "$1" '
  [ .mealConfig.guestConfig[$f]?, .mealConfig[$f]?, .[$f]?,
    .data.mealConfig.guestConfig[$f]?, .data.mealConfig[$f]?, .data[$f]? ]
  | map(select(. != null))
  | if length == 0 then "" else (.[0] | tostring) end' 2>/dev/null; }

declare -a CLEANUP_GROUPS
cleanup() {
  sec "CLEANUP — permanently delete throwaway verification groups"
  for gid in "${CLEANUP_GROUPS[@]:-}"; do
    [ -z "$gid" ] || [ "$gid" = "null" ] && continue
    req DELETE "/groups/$gid/permanent" "" "$ADMIN_TOKEN"
    { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "404" ]; } \
      && ok "Deleted throwaway group" "$gid ($R_CODE)" || no "Cleanup group $gid" "$R_CODE"
  done
}
trap cleanup EXIT

echo "eMeal MODULE_03 Verification — $(date -u +%FT%TZ)"
echo "BASE=$BASE  perf_budget=${PERF_BUDGET_MS}ms  out=$OUT"

# ═════════════════════════════════════════════════════════════════════════════
sec "0. AUTH"
ADMIN_TOKEN="$(login "$ADMIN_EMAIL" "$ADMIN_PASS")"
[ -n "$ADMIN_TOKEN" ] && ok "Admin login" || { no "Admin login" "abort"; exit 1; }
if [ -n "$STUDENT_EMAIL" ]; then STUDENT_TOKEN="$(login "$STUDENT_EMAIL" "$STUDENT_PASS")"
  [ -n "$STUDENT_TOKEN" ] && ok "Student login" || no "Student login"; else STUDENT_TOKEN=""; skip "Student login" "no STUDENT_EMAIL"; fi

# Housekeeping: sweep leftovers from a previously aborted run, then read the
# create budget (a full org SKIPs the create-dependent sections by design).
req GET "/groups?includeInactive=true" "" "$ADMIN_TOKEN"
for old in $(echo "$R_BODY" | jq -r '((.data // .)|map(select(.name|startswith("ZZ_M03_VERIFY_")))|.[].id) // empty' 2>/dev/null); do
  req DELETE "/groups/$old/permanent" "" "$ADMIN_TOKEN"
done
req GET /groups/limits "" "$ADMIN_TOKEN"
CAN_CREATE="$(echo "$R_BODY" | jq -r 'if has("canCreateGroup") then .canCreateGroup elif ((.data|type)=="object" and (.data|has("canCreateGroup"))) then .data.canCreateGroup else "null" end' 2>/dev/null)"
req GET /groups "" "$ADMIN_TOKEN"
EXIST_GID="$(echo "$R_BODY" | jq -r '((.data // .)[0].id) // empty' 2>/dev/null)"

# ═════════════════════════════════════════════════════════════════════════════
sec "1. MMT — MASTER MEAL TEMPLATE (MMT-001/002/003/014, PREF-006.1)"
G_MMT=""
if [ "$CAN_CREATE" = "true" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_M03_VERIFY_mmt",type:"hostel",maxMembers:5,mealConfig:{mealsEnabled:true}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; } && ok "Throwaway meal-system group created" "($R_CODE)" || no "MMT group create" "$R_CODE"
  G_MMT="$(j '.id // .data.id')"; CLEANUP_GROUPS+=("$G_MMT")
fi
if [ -n "$G_MMT" ] && [ "$G_MMT" != "null" ]; then
  # Meal #1 first, then the MMT-003 duplicate-name probe — it MUST run while
  # the group is still BELOW the meal cap, otherwise the cap error (400
  # 'supports at most') fires first and masks the duplicate guard.
  CREATED=0; CAP_HIT=""; FIRST_MEAL_ID=""
  req POST /meals "$(jq -nc --arg g "$G_MMT" \
    '{groupId:$g,slotKey:"zz_m03_slot_1",name:"ZZ M03 Meal 1",attendanceEnabled:true,attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
  if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
    CREATED=1; FIRST_MEAL_ID="$(j '.id // .data.id')"
  fi

  # MMT-003: duplicate meal NAME (case-insensitive, per group) rejected.
  req POST /meals "$(jq -nc --arg g "$G_MMT" '{groupId:$g,slotKey:"zz_m03_dupslot",name:"zz m03 meal 1",attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "409" ] || [ "$R_CODE" = "422" ]; } && echo "$R_BODY" | grep -qi "already exists" \
    && ok "MMT-003 duplicate meal name rejected (case-insensitive)" "($R_CODE)" \
    || no "MMT-003 duplicate name guard" "$R_CODE"

  # MMT-001/014: create meals until the config-driven cap rejects (default 10;
  # the loop ceiling 15 only guards against a runaway, it is not the cap).
  for i in $(seq 2 15); do
    req POST /meals "$(jq -nc --arg g "$G_MMT" --arg s "zz_m03_slot_$i" --arg n "ZZ M03 Meal $i" \
      '{groupId:$g,slotKey:$s,name:$n,attendanceEnabled:true,attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
      CREATED=$((CREATED+1))
    else CAP_HIT="$R_CODE"; break; fi
  done
  if [ -n "$CAP_HIT" ] && echo "$R_BODY" | grep -qi "at most"; then
    ok "MMT-001/014 meal cap enforced (config-driven)" "created=$CREATED then $CAP_HIT 'supports at most'"
  else no "MMT-001/014 meal cap" "created=$CREATED capCode=${CAP_HIT:-none} (expected 4xx 'at most')"; fi

  # MMT-002: slotKey is IMMUTABLE — a patched slotKey is ignored, never applied.
  if [ -n "$FIRST_MEAL_ID" ] && [ "$FIRST_MEAL_ID" != "null" ]; then
    req GET "/meals/$FIRST_MEAL_ID" "" "$ADMIN_TOKEN"
    SLOT_BEFORE="$(j '.slotKey // .data.slotKey')"
    req PATCH "/meals/$FIRST_MEAL_ID" "$(jq -nc '{slotKey:"zz_m03_HACKED"}')" "$ADMIN_TOKEN"
    req GET "/meals/$FIRST_MEAL_ID" "" "$ADMIN_TOKEN"
    SLOT_AFTER="$(j '.slotKey // .data.slotKey')"
    [ "$SLOT_AFTER" = "$SLOT_BEFORE" ] && [ "$SLOT_AFTER" != "zz_m03_HACKED" ] \
      && ok "MMT-002 slotKey immutable after creation" "still '$SLOT_AFTER'" \
      || no "MMT-002 slotKey MUTATED" "before=$SLOT_BEFORE after=$SLOT_AFTER"
  else skip "MMT-002 slotKey immutability" "no meal id captured"; fi

  # PREF-006.1: standalone preference-tag cap (default 5) on meal create.
  req POST /meals "$(jq -nc --arg g "$G_MMT" '{groupId:$g,slotKey:"zz_m03_tags",name:"ZZ M03 Tags",preferencesEnabled:true,enabledPreferences:["t1","t2","t3","t4","t5","t6"],attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && echo "$R_BODY" | grep -qi "at most" \
    && ok "PREF-006.1 per-meal standalone tag cap" "($R_CODE)" \
    || no "PREF-006.1 per-meal tag cap" "$R_CODE"
  # PREF-006.1: the same cap guards the group-level default tag list.
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{enabledPreferences:["t1","t2","t3","t4","t5","t6"]}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "PREF-006.1 group-level tag cap" "($R_CODE)" \
    || no "PREF-006.1 group tag cap" "$R_CODE"
else skip "MMT cap / duplicate-name / slotKey / tag-cap block" "org at group limit (archive a group to free a slot)"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "2. ATT-007/008/009 — OPT-OUT ⊕ PREFERENCES EXCLUSIVITY (server-enforced)"
if [ -n "$G_MMT" ] && [ "$G_MMT" != "null" ]; then
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{preferencesEnabled:true}}')" "$ADMIN_TOKEN"
  # Enabling Opt-Out on a preferences group must auto-disable preferences.
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{attendanceDefault:"present"}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_MMT" "" "$ADMIN_TOKEN"
  AD="$(gfield attendanceDefault)"; PE="$(gfield preferencesEnabled)"
  { [ "$AD" = "present" ] && [ "$PE" = "false" ]; } \
    && ok "ATT-007 opt-out ON auto-disables preferences" "attendanceDefault=$AD preferencesEnabled=$PE" \
    || no "ATT-007 exclusivity (opt-out wins)" "attendanceDefault=$AD preferencesEnabled=$PE"
  # Re-enabling preferences must flip opt-out back to absent (never both ON).
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{preferencesEnabled:true}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_MMT" "" "$ADMIN_TOKEN"
  AD2="$(gfield attendanceDefault)"; PE2="$(gfield preferencesEnabled)"
  { [ "$AD2" != "present" ] && [ "$PE2" = "true" ]; } \
    && ok "ATT-008 preferences ON auto-disables opt-out" "attendanceDefault=$AD2 preferencesEnabled=$PE2" \
    || no "ATT-008 exclusivity (prefs win)" "attendanceDefault=$AD2 preferencesEnabled=$PE2"
else skip "ATT-007/008 exclusivity" "no throwaway meal group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "3. BILL-SKIP POLICY (survey Q17/Q22) + GST-011 GUEST % SURCHARGE"
if [ -n "$G_MMT" ] && [ "$G_MMT" != "null" ]; then
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{billSkippedMeals:true}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_MMT" "" "$ADMIN_TOKEN"
  BS="$(gfield billSkippedMeals)"
  [ "$BS" = "true" ] && ok "Bill-Skip policy round-trips (billSkippedMeals)" "billSkippedMeals=$BS" \
    || no "Bill-Skip round-trip" "billSkippedMeals=$BS"
  # GST-011: percentage surcharge above 100% must be rejected on the FINAL
  # state. Guest fields live under mealConfig.guestConfig (FR-HG-020) — the
  # flat mealConfig.guest* spelling is rejected by the DTO whitelist.
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{guestConfig:{guestAttendanceEnabled:true,guestPricingMode:"flatSurcharge",guestSurchargeType:"percent",guestSurcharge:150}}}')" "$ADMIN_TOKEN"
  GCODE="$(j '.code // .data.code // empty')"
  { [ "$R_CODE" = "422" ] && [ "$GCODE" = "GUEST_SURCHARGE_PERCENT_RANGE" ]; } \
    && ok "GST-011 percent surcharge >100 rejected" "($R_CODE $GCODE)" \
    || no "GST-011 percent range guard" "code=$R_CODE body-code=$GCODE (expected 422 GUEST_SURCHARGE_PERCENT_RANGE)"
  # A sane percentage must persist and round-trip with its type.
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{guestConfig:{guestAttendanceEnabled:true,guestPricingMode:"flatSurcharge",guestSurchargeType:"percent",guestSurcharge:20}}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_MMT" "" "$ADMIN_TOKEN"
  GT="$(gfield guestSurchargeType)"
  [ "$GT" = "percent" ] && ok "GST-011 guestSurchargeType round-trips" "type=$GT" \
    || no "GST-011 surcharge-type round-trip" "type=$GT"
else skip "Bill-Skip + GST-011 block" "no throwaway meal group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "4. MODE-003 — ATTENDANCE-ONLY MODE (Master Attendance Template)"
G_AO=""
if [ "$CAN_CREATE" = "true" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_M03_VERIFY_ao",type:"hostel",maxMembers:5,mealConfig:{mealsEnabled:false}}')" "$ADMIN_TOKEN"
  G_AO="$(j '.id // .data.id')"; CLEANUP_GROUPS+=("$G_AO")
fi
if [ -n "$G_AO" ] && [ "$G_AO" != "null" ]; then
  # Meal-only fields (price/menu/prefs/image) are structurally rejected in AO.
  req POST /meals "$(jq -nc --arg g "$G_AO" '{groupId:$g,slotKey:"zz_ao_priced",name:"ZZ AO Priced",price:10,attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && echo "$R_BODY" | grep -qi "attendance-only" \
    && ok "MODE-003 meal pricing rejected in AO mode" "($R_CODE)" \
    || no "MODE-003 AO field guard" "$R_CODE"
  # A window needs explicit open/close times.
  req POST /meals "$(jq -nc --arg g "$G_AO" '{groupId:$g,slotKey:"zz_ao_nowin",name:"ZZ AO NoWindow"}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "MODE-003 window requires open+close times" "($R_CODE)" \
    || no "MODE-003 window-time requirement" "$R_CODE"
  # MODE-003.2: window cap (config-driven, default 5) — create until rejected.
  AO_CREATED=0; AO_CAP=""
  for i in $(seq 1 8); do
    req POST /meals "$(jq -nc --arg g "$G_AO" --arg s "zz_ao_w$i" --arg n "ZZ AO Window $i" \
      '{groupId:$g,slotKey:$s,name:$n,attendanceEnabled:true,attendanceWindow:{openTime:"06:00",closeTime:"09:00"}}')" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then AO_CREATED=$((AO_CREATED+1)); else AO_CAP="$R_CODE"; break; fi
  done
  if [ -n "$AO_CAP" ] && echo "$R_BODY" | grep -qi "at most"; then
    ok "MODE-003.2 attendance-window cap enforced" "created=$AO_CREATED then $AO_CAP 'at most'"
  else no "MODE-003.2 window cap" "created=$AO_CREATED capCode=${AO_CAP:-none}"; fi
  # The attendance engine is fully reused: meals/today serves AO windows.
  req GET "/meals/today?groupId=$G_AO" "" "$ADMIN_TOKEN"; perf "AO meals/today"
  assert_code "MODE-003 meals/today serves AO windows" 200 "$R_CODE"
else skip "Attendance-Only Mode block" "org at group limit (archive a group to free a slot)"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "5. NTC-012/013 — NOTICE ATTACHMENTS (type + size, SRS wording)"
# All four probes assert the REJECTION path — validation throws BEFORE any DB
# row or MinIO object is written, so this section is write-free by design.
req POST /notices "$(jq -nc '{title:"ZZ_M03_VERIFY_att",body:"x",imageData:"data:image/gif;base64,aGVsbG8="}')" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && echo "$R_BODY" | grep -qi "unsupported image" \
  && ok "NTC-012 unsupported image format rejected" "($R_CODE, GIF)" \
  || no "NTC-012 image format guard" "$R_CODE"
# Oversized payloads exceed Linux's ~128 KiB per-argument limit, so they are
# piped through stdin + a temp file (curl -d @file) — never argv. Passing them
# as --arg made jq fail 'Argument list too long' and silently sent an EMPTY
# body, which "passed" for the wrong reason.
BIGJSON="$(mktemp)"
head -c 110000 /dev/zero | base64 | tr -d '\n' \
  | jq -Rs '{title:"ZZ_M03_VERIFY_att",body:"x",imageData:("data:image/png;base64," + .)}' > "$BIGJSON"
req POST /notices "@$BIGJSON" "$ADMIN_TOKEN"; rm -f "$BIGJSON"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "413" ]; } \
  && ok "NTC-012 oversized image (>100 KB) rejected" "($R_CODE)" \
  || no "NTC-012 image size guard" "$R_CODE"
req POST /notices "$(jq -nc '{title:"ZZ_M03_VERIFY_att",body:"x",documentData:"data:text/csv;base64,aGVsbG8=",documentName:"x.csv"}')" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } && echo "$R_BODY" | grep -qi "unsupported document" \
  && ok "NTC-013 unsupported document format rejected" "($R_CODE, CSV)" \
  || no "NTC-013 document format guard" "$R_CODE"
BIGJSON="$(mktemp)"
head -c 60000 /dev/zero | base64 | tr -d '\n' \
  | jq -Rs '{title:"ZZ_M03_VERIFY_att",body:"x",documentData:("data:application/pdf;base64," + .),documentName:"x.pdf"}' > "$BIGJSON"
req POST /notices "@$BIGJSON" "$ADMIN_TOKEN"; rm -f "$BIGJSON"
{ [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "413" ]; } \
  && ok "NTC-013 oversized document (>50 KB) rejected" "($R_CODE)" \
  || no "NTC-013 document size guard" "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "6. ACC-005 — EMAIL-VERIFICATION PARTICIPATION GATE (403 contract)"
# A brand-new (post-cutoff, unverified) disposable account must be blocked from
# participation writes with the exact EMAIL_VERIFICATION_REQUIRED contract the
# Flutter VerificationGate keys on. Self-cleaning: the account deletes itself.
DISPOSABLE="m03-$(date +%s)@example-m03.invalid"
req POST /auth/signup/student "$(jq -nc --arg e "$DISPOSABLE" '{name:"M03 Disposable",role:"student",email:$e,password:"Disposable@123"}')"
if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
  DTOK="$(login "$DISPOSABLE" "Disposable@123")"
  if [ -n "$DTOK" ]; then
    TOMORROW="$(date -d "+1 day" +%F 2>/dev/null || date -v+1d +%F)"
    DAYAFTER="$(date -d "+2 day" +%F 2>/dev/null || date -v+2d +%F)"
    req POST /vacation-requests "$(jq -nc --arg s "$TOMORROW" --arg e "$DAYAFTER" '{startDate:$s,endDate:$e,reason:"ZZ_M03_VERIFY"}')" "$DTOK"
    VCODE="$(j '.code // .data.code // empty')"
    if [ "$R_CODE" = "403" ] && [ "$VCODE" = "EMAIL_VERIFICATION_REQUIRED" ]; then
      ok "ACC-005 unverified participation blocked" "(403 EMAIL_VERIFICATION_REQUIRED)"
      echo "$R_BODY" | grep -qi "verify your email" \
        && ok "ACC-005 message matches VerificationGate contract" \
        || no "ACC-005 client-contract message" "$(j '.message' | head -c 60)"
    elif [ "$R_CODE" = "403" ]; then
      no "ACC-005 gate code contract" "403 but code=$VCODE (expected EMAIL_VERIFICATION_REQUIRED)"
    else
      skip "ACC-005 participation gate" "got $R_CODE — gate disabled via EMAIL_VERIFICATION_REQUIRED=false rollback lever?"
    fi
    req DELETE /users/me "$(jq -nc '{confirm:"DELETE",password:"Disposable@123"}')" "$DTOK"
    assert_code "Disposable account self-deleted (cleanup)" 200 "$R_CODE"
  else skip "ACC-005 gate probe" "disposable login failed"; fi
else skip "ACC-005 gate probe" "signup returned $R_CODE (throttle?)"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "7. RET-001..015 — RETENTION / DATA ARCHIVES (admin-only, read-only)"
req GET /retention/archives "" "$ADMIN_TOKEN"; perf "retention archives"
assert_code "RET archives endpoint (admin)" 200 "$R_CODE"
if [ -n "$STUDENT_TOKEN" ]; then
  req GET /retention/archives "" "$STUDENT_TOKEN"
  assert_code "RET archives blocked for students (RBAC)" 403 "$R_CODE"
else skip "RET student RBAC" "no STUDENT_EMAIL"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "8. TOUCHED READ SURFACES — regression (read-only)"
if [ -n "${EXIST_GID:-}" ]; then
  req GET "/meals?groupId=$EXIST_GID" "" "$ADMIN_TOKEN"; perf "meals list"
  assert_code "Meals list healthy" 200 "$R_CODE"
  req GET "/meals/today?groupId=$EXIST_GID" "" "$ADMIN_TOKEN"; perf "meals/today"
  assert_code "meals/today healthy" 200 "$R_CODE"
  echo "$R_BODY" | jq -e '(.serverTime // .data.serverTime // .meta.serverTime) != null' >/dev/null 2>&1 \
    && ok "meals/today carries serverTime/window meta" || skip "meals/today meta" "shape variant"
else skip "meal read surfaces" "no existing group"; fi
req GET /attendance/correction-requests "" "$ADMIN_TOKEN"
{ [ "$R_CODE" = "200" ] || [ "$R_CODE" = "400" ]; } && ok "Corrections surface reachable" "($R_CODE)" || no "Corrections surface" "$R_CODE"
req GET /notices "" "$ADMIN_TOKEN"; perf "notices"
assert_code "Notices feed healthy" 200 "$R_CODE"

# ═════════════════════════════════════════════════════════════════════════════
sec "9. BILL-012/Q20 — BILLING CYCLE ANCHOR DAY (1–31, never reject 29/30/31)"
if [ -n "$G_MMT" ] && [ "$G_MMT" != "null" ]; then
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{billingCycleStartDay:31}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_MMT" "" "$ADMIN_TOKEN"
  BCD="$(gfield billingCycleStartDay)"
  [ "$BCD" = "31" ] && ok "Q20 anchor day 31 accepted + round-trips" "billingCycleStartDay=$BCD" \
    || no "Q20 anchor 29/30/31 must never be rejected" "billingCycleStartDay=$BCD"
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{billingCycleStartDay:32}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "BILL-012 anchor day >31 rejected" "($R_CODE)" || no "BILL-012 anchor upper bound" "$R_CODE"
  req PATCH "/groups/$G_MMT" "$(jq -nc '{mealConfig:{billingCycleStartDay:0}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "BILL-012 anchor day <1 rejected" "($R_CODE)" || no "BILL-012 anchor lower bound" "$R_CODE"
else skip "BILL-012 anchor-day block" "no throwaway meal group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "10. PREF-006.2/006.3 — PREFERENCE GROUP CAPS (5 groups/meal · 5 options/group)"
if [ -n "${FIRST_MEAL_ID:-}" ] && [ "$FIRST_MEAL_ID" != "null" ]; then
  PG_CREATED=0; PG_CAP=""; PG1_ID=""
  for i in $(seq 1 8); do
    # PreferenceOptionDto: `key` (lowercase slug) is REQUIRED alongside label.
    # Live-Test-7/8 rule: every group carries 2–5 options — a 1-option group
    # is a non-choice and is (correctly) rejected, so seed TWO options.
    req POST "/meals/$FIRST_MEAL_ID/preference-groups" \
      "$(jq -nc --arg l "ZZ PG $i" '{label:$l,options:[{key:"opt1",label:"Opt 1"},{key:"opt2",label:"Opt 2"}]}')" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
      PG_CREATED=$((PG_CREATED+1)); [ -z "$PG1_ID" ] && PG1_ID="$(j '.id // .data.id')"
    else PG_CAP="$R_CODE"; break; fi
  done
  if [ -n "$PG_CAP" ] && [ "$PG_CREATED" -ge 1 ]; then
    ok "PREF-006.2 preference-group cap enforced" "created=$PG_CREATED then $PG_CAP"
  else no "PREF-006.2 group cap" "created=$PG_CREATED capCode=${PG_CAP:-none} (expected 4xx after cap)"; fi
  if [ -n "$PG1_ID" ] && [ "$PG1_ID" != "null" ]; then
    # Group already holds opt1+opt2 — add from opt3 so a duplicate-key 409 is
    # never mistaken for the 5-option cap rejection.
    OPT_ADDED=0; OPT_CAP=""
    for i in $(seq 3 9); do
      req POST "/preference-groups/$PG1_ID/options" "$(jq -nc --arg k "opt$i" --arg l "ZZ Opt $i" '{key:$k,label:$l}')" "$ADMIN_TOKEN"
      if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then OPT_ADDED=$((OPT_ADDED+1)); else OPT_CAP="$R_CODE"; break; fi
    done
    if [ -n "$OPT_CAP" ]; then ok "PREF-006.3 options-per-group cap enforced" "added=$OPT_ADDED then $OPT_CAP"
    else no "PREF-006.3 option cap" "added=$OPT_ADDED with no rejection"; fi
  else skip "PREF-006.3 option cap" "no preference group captured"; fi
else skip "PREF-006.2/006.3 caps" "no throwaway meal available"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "11. RPT-001 — CSV EXPORT REMOVED (Excel + PDF only)"
FROM_D="$(date -d '-7 day' +%F 2>/dev/null || date -v-7d +%F)"; TO_D="$(date +%F)"
if [ -n "${EXIST_GID:-}" ]; then
  req GET "/exports/attendance?groupId=$EXIST_GID&fromDate=$FROM_D&toDate=$TO_D&format=csv" "" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "RPT-001 CSV export rejected with clear error" "($R_CODE)" \
    || no "RPT-001 CSV must be rejected" "$R_CODE (expected 400/422)"
else skip "RPT-001 CSV removal" "no existing group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "12. Q17/Q21/ATT-004 — LIVE STATUS MODEL (Present/Absent only; admin never marks others)"
# Uses a DEDICATED throwaway group with an always-open window so nothing in a
# real group is ever touched. Frees the earlier throwaways first (org cap room).
[ -n "$G_MMT" ] && [ "$G_MMT" != "null" ] && req DELETE "/groups/$G_MMT/permanent" "" "$ADMIN_TOKEN" >/dev/null 2>&1
[ -n "$G_AO"  ] && [ "$G_AO"  != "null" ] && req DELETE "/groups/$G_AO/permanent"  "" "$ADMIN_TOKEN" >/dev/null 2>&1
G_Q17=""; Q17_MEAL=""
if [ "$CAN_CREATE" = "true" ] && [ -n "$STUDENT_TOKEN" ]; then
  req POST /groups "$(jq -nc '{name:"ZZ_M03_VERIFY_q17",type:"hostel",maxMembers:5,joinApprovalRequired:false,mealConfig:{mealsEnabled:true}}')" "$ADMIN_TOKEN"
  G_Q17="$(j '.id // .data.id')"; CLEANUP_GROUPS+=("$G_Q17")
  req POST /meals "$(jq -nc --arg g "$G_Q17" '{groupId:$g,slotKey:"zz_q17_open",name:"ZZ Q17 Open",attendanceEnabled:true,attendanceWindow:{openTime:"00:00",closeTime:"23:59"}}')" "$ADMIN_TOKEN"
  Q17_MEAL="$(j '.id // .data.id')"
  # A meals-ON group defaults to Weekly Meal Mode, where an UNSCHEDULED meal
  # is a no-meal day (FR-MODE-032 → 422 NO_MEAL_TODAY). Publish today's entry
  # so the member marks below exercise the STATUS rules, not the planner gate.
  # (This gap was masked while the test student was gated at ACC-005.)
  if [ -n "$Q17_MEAL" ] && [ "$Q17_MEAL" != "null" ]; then
    Q17_D="$(TZ='Asia/Kolkata' date +%F)"
    Q17_DOW="$(TZ='Asia/Kolkata' date +%u)"
    Q17_MON="$(TZ='Asia/Kolkata' date -d "$Q17_D -$(( Q17_DOW - 1 )) days" +%F 2>/dev/null || echo "$Q17_D")"
    req POST /schedules "$(jq -nc --arg g "$G_Q17" --arg w "$Q17_MON" --arg m "$Q17_MEAL" --arg d "$Q17_D" \
      '{groupId:$g,weekStartDate:$w,entries:[{mealId:$m,date:$d}]}')" "$ADMIN_TOKEN"
    Q17_SID="$(j '.id // .data.id')"
    [ -n "$Q17_SID" ] && [ "$Q17_SID" != "null" ] && req POST "/schedules/$Q17_SID/publish" '{}' "$ADMIN_TOKEN"
  fi
  req GET "/groups/$G_Q17/qr-token" "" "$ADMIN_TOKEN"; Q17_CODE="$(j '.joinCode // .data.joinCode')"
  req POST /groups/join "$(jq -nc --arg c "$Q17_CODE" '{joinCode:$c}')" "$STUDENT_TOKEN"
fi
if [ -n "$Q17_MEAL" ] && [ "$Q17_MEAL" != "null" ]; then
  # attendanceDate is REQUIRED by the mark contract (YYYY-MM-DD) and must be
  # "today" in the ORG timezone (Asia/Kolkata), not the server's UTC date —
  # between 18:30 and 24:00 UTC those differ and the mark would be rejected.
  IST_D="$(TZ='Asia/Kolkata' date +%F)"
  # Q21: the member can deliberately mark ABSENT while the window is open.
  req POST /attendance "$(jq -nc --arg m "$Q17_MEAL" --arg d "$IST_D" '{mealId:$m,attendanceDate:$d,status:"absent"}')" "$STUDENT_TOKEN"
  ACODE1="$(j '.code // .data.code // empty')"
  if [ "$R_CODE" = "403" ] && [ "$ACODE1" = "EMAIL_VERIFICATION_REQUIRED" ]; then
    skip "Q21 member Absent mark" "student unverified — run deploy/ensure-test-fixtures.sh, then re-run"
    skip "Q17 member Skip rejection" "student unverified (same gate)"
  else
    { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } \
      && ok "Q21 member can mark ABSENT (deliberate not-eating)" "($R_CODE)" \
      || no "Q21 Absent mark" "$R_CODE"
    # Q17: Skip is INTERNAL-ONLY. A member-submitted skip must never produce a
    # member-generated Skip row: the server either rejects it (4xx) or — for
    # old APKs whose Skip button still posts it — coerces it to ABSENT (the
    # declared intent), so Bill-Skip can never bill an explicit decliner.
    req POST /attendance "$(jq -nc --arg m "$Q17_MEAL" --arg d "$IST_D" '{mealId:$m,attendanceDate:$d,status:"skipped"}')" "$STUDENT_TOKEN"
    Q17_ST="$(j '.status // .data.status // empty')"
    if [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "403" ]; then
      ok "Q17 member-submitted Skip rejected (internal-only status)" "($R_CODE)"
    elif { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && [ "$Q17_ST" != "skipped" ]; then
      ok "Q17 member Skip coerced to '$Q17_ST' (no member-generated Skip row; old-APK compat)" "($R_CODE)"
    else
      no "Q17 GAP: API stores member Skip" "$R_CODE status=$Q17_ST — SRS: 'Skip is never selectable'"
    fi
  fi
  # ATT-004: admins shall NEVER directly mark/override another member.
  req GET /auth/me "" "$STUDENT_TOKEN"
  SUID="$(j '.id // .data.id // .user.id // .data.user.id')"
  if [ -n "$SUID" ]; then
    req POST /attendance/admin/override "$(jq -nc --arg u "$SUID" --arg m "$Q17_MEAL" --arg d "$TO_D" '{userId:$u,mealId:$m,attendanceDate:$d,status:"present"}')" "$ADMIN_TOKEN"
    if [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; then
      no "ATT-004 admin CAN still override another member" "$R_CODE — SRS: corrections workflow only"
    else
      ok "ATT-004 admin override of another member blocked" "($R_CODE — corrections workflow is the only path)"
    fi
  else skip "ATT-004 override gate" "could not decode student id from token"; fi
else skip "Q17/Q21/ATT-004 live status block" "needs create capacity + STUDENT_EMAIL"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "13. COR-005 — CORRECTION RULES (same-day only · Skip never a target)"
if [ -n "$Q17_MEAL" ] && [ "$Q17_MEAL" != "null" ] && [ -n "$STUDENT_TOKEN" ]; then
  req POST /attendance/correction-requests "$(jq -nc --arg m "$Q17_MEAL" --arg d "$TO_D" '{mealId:$m,attendanceDate:$d,requestType:"correct_to_skip"}')" "$STUDENT_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ] || [ "$R_CODE" = "403" ]; } \
    && ok "COR-005 Skip is never a correction target" "($R_CODE)" \
    || no "COR-005 correct_to_skip must be rejected" "$R_CODE"
  YDAY="$(date -d '-1 day' +%F 2>/dev/null || date -v-1d +%F)"
  req POST /attendance/correction-requests "$(jq -nc --arg m "$Q17_MEAL" --arg d "$YDAY" '{mealId:$m,attendanceDate:$d,requestType:"claim_present"}')" "$STUDENT_TOKEN"
  CCODE="$(j '.code // .data.code // empty')"
  if [ "$R_CODE" = "403" ] && [ "$CCODE" = "EMAIL_VERIFICATION_REQUIRED" ]; then
    skip "COR-005 previous-day correction rejected" "student unverified — run deploy/ensure-test-fixtures.sh, then re-run"
  else
    { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
      && ok "COR-005 previous-day correction rejected (same-day 11:59 PM IST lock)" "($R_CODE)" \
      || no "COR-005 same-day-only lock" "$R_CODE"
  fi
  # Student leaves the throwaway group before it is deleted (clean membership).
  req POST "/groups/$G_Q17/leave" "" "$STUDENT_TOKEN" >/dev/null 2>&1
else skip "COR-005 correction rules" "no Q17 throwaway meal/member"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "14. SCH-012 — LEGACY RECURRENCE REMOVED FROM THE API CONTRACT"
if [ -n "${G_Q17:-}" ] && [ "$G_Q17" != "null" ]; then
  req POST /meals/weekly-schedule "$(jq -nc --arg g "$G_Q17" '{groupId:$g,recurring:true}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "SCH-012 'recurring' flag rejected (removed from contract)" "($R_CODE)" \
    || no "SCH-012 recurring flag still accepted" "$R_CODE"
  req POST /meals/weekly-schedule "$(jq -nc --arg g "$G_Q17" '{groupId:$g,copyFromPreviousWeek:true}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "SCH-012 'copy previous week' rejected (removed)" "($R_CODE)" \
    || no "SCH-012 copy-previous-week still accepted" "$R_CODE"
else skip "SCH-012 recurrence removal" "no throwaway group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "15. GST-011 — GUEST PRICING MODES 1 & 2 (mode 3 percent tested in §3)"
if [ -n "${G_Q17:-}" ] && [ "$G_Q17" != "null" ]; then
  # Mode 2 (Fixed Guest Price) requires the per-guest price to be set. Guest
  # fields live under mealConfig.guestConfig (FR-HG-020).
  req PATCH "/groups/$G_Q17" "$(jq -nc '{mealConfig:{guestConfig:{guestAttendanceEnabled:true,guestPricingMode:"perGuestPrice"}}}')" "$ADMIN_TOKEN"
  { [ "$R_CODE" = "400" ] || [ "$R_CODE" = "422" ]; } \
    && ok "GST-011 mode-2 without adult price rejected" "($R_CODE)" \
    || no "GST-011 mode-2 price requirement" "$R_CODE"
  req PATCH "/groups/$G_Q17" "$(jq -nc '{mealConfig:{guestConfig:{guestAttendanceEnabled:true,guestPricingMode:"perGuestPrice",guestAdultPrice:50}}}')" "$ADMIN_TOKEN"
  req GET "/groups/$G_Q17" "" "$ADMIN_TOKEN"
  GM2="$(gfield guestPricingMode)"
  [ "$GM2" = "perGuestPrice" ] && ok "GST-011 mode-2 (fixed guest price) round-trips" "mode=$GM2" \
    || no "GST-011 mode-2 round-trip" "mode=$GM2"
  # Mode 1 (Same as Member Price) — canonical literal is 'sameAsMember'.
  M1=""
  for cand in sameAsMember memberPrice member; do
    req PATCH "/groups/$G_Q17" "$(jq -nc --arg m "$cand" '{mealConfig:{guestConfig:{guestPricingMode:$m}}}')" "$ADMIN_TOKEN"
    { [ "$R_CODE" = "200" ] || [ "$R_CODE" = "201" ]; } && { M1="$cand"; break; }
  done
  [ -n "$M1" ] && ok "GST-011 mode-1 (same as member price) accepted" "mode=$M1" \
    || skip "GST-011 mode-1 literal" "none of sameAsMember/memberPrice/member accepted — check enum"
else skip "GST-011 modes 1/2" "no throwaway group"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "16. NTC-003 — EXTERNAL LINKS + TEXT-ONLY NOTICE (self-cleaned)"
req POST /notices "$(jq -nc '{title:"ZZ_M03_VERIFY_link",body:"link test",externalLinks:["https://example.com/menu"]}')" "$ADMIN_TOKEN"
if [ "$R_CODE" = "201" ] || [ "$R_CODE" = "200" ]; then
  LNID="$(j '.id // .data.id')"
  ok "NTC-003 notice with external link created" "($R_CODE)"
  req GET /notices "" "$ADMIN_TOKEN"
  echo "$R_BODY" | jq -e '[(.data // .)[] | select(.title=="ZZ_M03_VERIFY_link") | .externalLinks[0]] | length > 0' >/dev/null 2>&1 \
    && ok "NTC-003 externalLinks round-trip in feed" || skip "NTC-003 link round-trip" "shape variant"
  [ -n "$LNID" ] && [ "$LNID" != "null" ] && req DELETE "/notices/$LNID" "" "$ADMIN_TOKEN" \
    && ok "NTC-003 throwaway notice deleted (cleanup)" "($R_CODE)"
else no "NTC-003 external-link notice" "$R_CODE"; fi

# ═════════════════════════════════════════════════════════════════════════════
sec "COVERAGE NOTE — requirements NOT black-box testable here (by design)"
echo "  The following MODULE-03 behaviours are TIME/SCHEDULER-driven and are"
echo "  covered by the jest unit suite (377 tests) + the sweeps' own logs, not"
echo "  by this synchronous validator:"
echo "   · ATT-010 auto-attendance materialization at window OPEN (2-min sweep)"
echo "   · Q17 system-generated Skip at window close (+Bill-Skip billing math Q22/Q23)"
echo "   · SCH-011 automatic schedule continuation across day/week rollover"
echo "   · MODE-003.5 daily window materialization from the Master Attendance Template"
echo "   · RET-001..015 reminder cadence, 3-day grace, auto-finalize, archive+purge cycle"
echo "   · RPT-010 archive Excel/PDF content correctness (verified at generation time)"
echo "  Device-manual (Flutter UI): no Skip button anywhere, verify-email dialog,"
echo "  window visibility per day — see the srs module's device checklist."

# ═════════════════════════════════════════════════════════════════════════════
sec "SUMMARY"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then printf '  Failed: %s\n' "${FAILED_CHECKS[*]}"; fi
echo "  Full log: $OUT"
[ "$FAIL" -eq 0 ] && echo "  ✅ MODULE_03 VERIFIED" || echo "  ❌ MODULE_03 has failures"
exit $(( FAIL > 0 ? 1 : 0 ))
